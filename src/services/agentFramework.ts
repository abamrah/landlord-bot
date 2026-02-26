/**
 * agentFramework.ts — Generic agentic tool-use loop.
 *
 * Instead of linear prompt→response, the LLM receives a system prompt, tools,
 * and the user query. It then plans+acts in a loop: it emits tool calls,
 * we execute them, feed observations back, and the LLM continues until it
 * produces a final answer.
 *
 * This is a ReAct-style (Reason+Act) agent loop using Gemini function calling.
 * Provider-agnostic / domain-agnostic — used by any vertical plugin.
 */

import { vertexAI, defaultModel } from "../config/gemini";
import { ToolDefinition, ToolRegistry } from "./toolRegistry";
import { db } from "../config/database";
import { MAX_OUTPUT_TOKENS, MAX_TOTAL_TOKENS } from "./llmGuardrails";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const isDbEnabled = Boolean(process.env.DATABASE_URL);

/**
 * Strip large binary / blob fields from a tool result before sending it
 * back to the LLM as a function response. This prevents base64-encoded
 * PDFs, raw reports, and other bulky data from consuming tokens.
 * The original result is kept intact in step.toolResults for the caller.
 */
function sanitizeForLLM(result: unknown): unknown {
    if (result === null || result === undefined || typeof result !== "object") {
        return result;
    }

    // Fields that should be stripped (large binary/blob data)
    const STRIP_KEYS = new Set([
        "pdfBase64", "pdf", "base64", "rawReport", "rawData",
        "receiptData", "imageBase64", "fileData",
    ]);

    // Max string length to keep (anything bigger gets summarized)
    const MAX_STRING_LEN = 2000;

    if (Array.isArray(result)) {
        return result.map((item) => sanitizeForLLM(item));
    }

    const cleaned: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(result as Record<string, unknown>)) {
        if (STRIP_KEYS.has(key)) {
            // Replace with a short note so the LLM knows the data exists
            cleaned[key] = "[binary data generated — available for download]";
            continue;
        }
        if (typeof value === "string" && value.length > MAX_STRING_LEN) {
            cleaned[key] = value.slice(0, MAX_STRING_LEN) + `... [truncated, ${value.length} chars total]`;
            continue;
        }
        if (typeof value === "object" && value !== null) {
            cleaned[key] = sanitizeForLLM(value);
            continue;
        }
        cleaned[key] = value;
    }
    return cleaned;
}

export type AgentMessage = {
    role: "user" | "model" | "tool";
    content?: string;
    toolCalls?: ToolCall[];
    toolResults?: ToolResult[];
};

export type ToolCall = {
    id: string;
    name: string;
    args: Record<string, unknown>;
};

export type ToolResult = {
    callId: string;
    name: string;
    result: unknown;
    error?: string;
};

export type AgentRunResult = {
    finalAnswer: string;
    steps: AgentStep[];
    toolCallCount: number;
    totalTokensEstimate: number;
};

export type AgentStep = {
    thought?: string;
    toolCalls?: ToolCall[];
    toolResults?: ToolResult[];
    observation?: string;
};

type GeminiFunctionDeclaration = {
    name: string;
    description: string;
    parameters: {
        type: string;
        properties: Record<string, unknown>;
        required?: string[];
    };
};

function toolDefsToGemini(tools: ToolDefinition[]): GeminiFunctionDeclaration[] {
    return tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: {
            type: "object",
            properties: t.parameters,
            required: t.required || [],
        },
    }));
}

/**
 * Main agent loop. Runs up to `maxIterations` plan→act→observe cycles.
 */
export async function runAgent(opts: {
    systemPrompt: string;
    userMessage: string;
    tools: ToolRegistry;
    context?: Record<string, unknown>;        // accountId, contactId, etc injected into every tool call
    maxIterations?: number;
    model?: string;
    /** Optional inline media (images/audio/video) to include in the first message */
    mediaParts?: Array<{ base64: string; mimeType: string }>;
    /** Task type label for usage tracking (e.g., "tenant-message", "landlord-assistant") */
    taskType?: string;
}): Promise<AgentRunResult> {
    const maxIter = opts.maxIterations ?? 8;
    const modelName = opts.model ?? defaultModel;
    const steps: AgentStep[] = [];
    let toolCallCount = 0;
    let totalPromptTokens = 0;
    let totalResponseTokens = 0;
    const startTime = Date.now();

    if (!vertexAI) {
        return {
            finalAnswer: "AI model not configured. Please set GOOGLE_API_KEY.",
            steps: [],
            toolCallCount: 0,
            totalTokensEstimate: 0,
        };
    }

    const model = vertexAI.getGenerativeModel({ model: modelName });

    // Build Gemini function declarations from registry
    const toolDefs = opts.tools.listEnabled();
    const geminiTools = toolDefsToGemini(toolDefs);

    // Build conversation history
    const contents: Array<{ role: string; parts: any[] }> = [];

    // System instruction is injected as the first user turn with a preamble
    // Include multimodal media parts (images, audio, video, PDFs) alongside text
    const userParts: any[] = [
        { text: `${opts.systemPrompt}\n\n---\nUser request: ${opts.userMessage}` },
    ];
    if (opts.mediaParts?.length) {
        for (const media of opts.mediaParts) {
            // PDFs must go through the File API — inlineData gives "document has no pages"
            if (media.mimeType === "application/pdf") {
                try {
                    const filePart = await uploadPdfToFileApi(media.base64);
                    userParts.push(filePart);
                } catch (uploadErr) {
                    // eslint-disable-next-line no-console
                    console.warn("[Agent] PDF File API upload failed, falling back to inlineData", uploadErr);
                    userParts.push({ inlineData: { data: media.base64, mimeType: media.mimeType } });
                }
            } else {
                userParts.push({ inlineData: { data: media.base64, mimeType: media.mimeType } });
            }
        }
    }
    contents.push({ role: "user", parts: userParts });

    for (let iteration = 0; iteration < maxIter; iteration++) {
        // Token budget guard — stop if we've consumed too many tokens
        const consumedTokens = totalPromptTokens + totalResponseTokens;
        if (consumedTokens > MAX_TOTAL_TOKENS) {
            console.warn(`[AgentFramework] Token budget exceeded (${consumedTokens}/${MAX_TOTAL_TOKENS}). Stopping.`);
            const durationMs = Date.now() - startTime;
            logAgentUsage(opts.context?.landlordId as string, modelName, totalPromptTokens, totalResponseTokens, toolCallCount, durationMs, opts.taskType);
            return {
                finalAnswer: steps.map(s => s.thought).filter(Boolean).join("\n") || "I've used my processing budget for this request. Here's what I found so far.",
                steps,
                toolCallCount,
                totalTokensEstimate: consumedTokens,
            };
        }

        // Call Gemini with tools
        let result: any;
        const maxRetries = 3;
        let lastErr: Error | null = null;
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                result = await model.generateContent({
                    contents,
                    tools: geminiTools.length > 0 ? [{ functionDeclarations: geminiTools }] : undefined,
                    generationConfig: { maxOutputTokens: MAX_OUTPUT_TOKENS },
                } as any);
                lastErr = null;
                break;
            } catch (err) {
                lastErr = err as Error;
                const errMsg = lastErr.message || String(err);
                const isRetryable = /503|429|high demand|overloaded|rate.?limit/i.test(errMsg);
                if (isRetryable && attempt < maxRetries) {
                    const backoff = 800 * Math.pow(2, attempt - 1);
                    console.warn(`[AgentFramework] LLM call failed (attempt ${attempt}/${maxRetries}), retrying in ${backoff}ms:`, errMsg);
                    await new Promise(r => setTimeout(r, backoff));
                    continue;
                }
                console.warn(`[AgentFramework] LLM call failed (attempt ${attempt}/${maxRetries}, giving up):`, errMsg);
                return {
                    finalAnswer: `Agent error: ${errMsg}`,
                    steps,
                    toolCallCount,
                    totalTokensEstimate: 0,
                };
            }
        }

        const candidate = result.response?.candidates?.[0];
        const parts = candidate?.content?.parts || [];

        // Track token usage from Gemini response
        const usage = result.response?.usageMetadata;
        if (usage) {
            totalPromptTokens += usage.promptTokenCount || 0;
            totalResponseTokens += usage.candidatesTokenCount || 0;
        }

        // Extract text parts and function call parts
        const textParts = parts
            .filter((p: any) => p.text)
            .map((p: any) => p.text)
            .join("");

        const functionCalls = parts.filter((p: any) => p.functionCall);

        // No function calls → this is the final answer
        if (functionCalls.length === 0) {
            steps.push({ thought: textParts });
            const totalTokens = totalPromptTokens + totalResponseTokens;
            const durationMs = Date.now() - startTime;
            // Persist usage to DB
            logAgentUsage(opts.context?.landlordId as string, modelName, totalPromptTokens, totalResponseTokens, toolCallCount, durationMs, opts.taskType);
            return {
                finalAnswer: textParts || "",
                steps,
                toolCallCount,
                totalTokensEstimate: totalTokens,
            };
        }

        // Process function calls
        const step: AgentStep = {
            thought: textParts || undefined,
            toolCalls: [],
            toolResults: [],
        };

        // Add model's response (with function calls) to conversation
        contents.push({
            role: "model",
            parts,
        });

        // Execute each tool call and collect results
        const functionResponseParts: any[] = [];

        for (const fc of functionCalls) {
            const callName = fc.functionCall.name;
            const callArgs = fc.functionCall.args || {};
            const callId = `call_${iteration}_${callName}_${Date.now()}`;

            // Inject context (landlordId, etc.) into every tool call
            const enrichedArgs = { ...callArgs, ...(opts.context || {}) };

            const toolCall: ToolCall = { id: callId, name: callName, args: enrichedArgs };
            step.toolCalls!.push(toolCall);
            toolCallCount++;

            // Execute the tool
            let toolResult: unknown;
            let toolError: string | undefined;

            try {
                const handler = opts.tools.get(callName);
                if (!handler) {
                    toolError = `Unknown tool: ${callName}`;
                    toolResult = { error: toolError };
                } else {
                    toolResult = await handler.execute(enrichedArgs);
                }
            } catch (err) {
                toolError = (err as Error).message || String(err);
                toolResult = { error: toolError };
            }

            step.toolResults!.push({ callId, name: callName, result: toolResult, error: toolError });

            // Build Gemini function response part — strip large binary fields
            // (pdfBase64, rawReport, etc.) to avoid burning tokens. The full
            // result is preserved in step.toolResults for the caller.
            const geminiResponse = sanitizeForLLM(toolResult);

            functionResponseParts.push({
                functionResponse: {
                    name: callName,
                    response: typeof geminiResponse === "object" && geminiResponse !== null
                        ? geminiResponse
                        : { result: String(geminiResponse ?? "") },
                },
            });
        }

        // Add tool results back to conversation
        contents.push({
            role: "user",
            parts: functionResponseParts,
        });

        steps.push(step);
    }

    // Max iterations reached — extract whatever we have
    const totalTokens = totalPromptTokens + totalResponseTokens;
    const durationMs = Date.now() - startTime;
    logAgentUsage(opts.context?.landlordId as string, modelName, totalPromptTokens, totalResponseTokens, toolCallCount, durationMs, opts.taskType);
    return {
        finalAnswer: "Agent reached maximum iterations. Partial result available in steps.",
        steps,
        toolCallCount,
        totalTokensEstimate: totalTokens,
    };
}

/** Persist usage metrics to the database (fire-and-forget) */
function logAgentUsage(
    landlordId: string | undefined,
    model: string,
    promptTokens: number,
    responseTokens: number,
    toolCalls: number,
    durationMs: number,
    taskType?: string,
) {
    if (!isDbEnabled || (!promptTokens && !responseTokens)) return;
    db.agentUsage.create({
        data: {
            landlordId: landlordId || null,
            model,
            promptTokens,
            responseTokens,
            totalTokens: promptTokens + responseTokens,
            toolCalls,
            durationMs,
            taskType: taskType || null,
        },
    }).catch((err: any) => console.warn("logAgentUsage failed", err));
}

// ═══════════════════════════════════════════════════════════
//  PDF UPLOAD VIA GOOGLE AI FILE API
// ═══════════════════════════════════════════════════════════

/**
 * Upload a base64-encoded PDF to the Google AI File API and return a
 * `fileData` part that can be used in Gemini content.  The File API
 * handles PDFs much more reliably than inlineData (which often errors
 * with "The document has no pages").
 */
async function uploadPdfToFileApi(base64: string): Promise<any> {
    const apiKey =
        process.env.GOOGLE_API_KEY ||
        process.env.GEMINI_API_KEY ||
        process.env.GENERATIVE_AI_API_KEY ||
        "";
    if (!apiKey) throw new Error("No Google API key configured");

    const { GoogleAIFileManager } = require("@google/generative-ai/server");
    const fileManager = new GoogleAIFileManager(apiKey);

    // Write base64 to a temp file (the SDK needs a file path)
    const tmpDir = os.tmpdir();
    const tmpFile = path.join(tmpDir, `agent-pdf-${Date.now()}.pdf`);
    const buffer = Buffer.from(base64, "base64");
    fs.writeFileSync(tmpFile, buffer);

    try {
        const uploadResult = await fileManager.uploadFile(tmpFile, {
            mimeType: "application/pdf",
            displayName: `agent-upload-${Date.now()}.pdf`,
        });

        // Return a fileData part that Gemini understands
        return {
            fileData: {
                mimeType: uploadResult.file.mimeType,
                fileUri: uploadResult.file.uri,
            },
        };
    } finally {
        // Clean up temp file
        try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
    }
}
