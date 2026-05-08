import { Router } from "express";
import nodemailer from "nodemailer";
import { Resend } from "resend";
import { z } from "zod";

const router = Router();

const CONTACT_TO_EMAIL = "arsh.bamrah27@gmail.com";

const contactSchema = z.object({
  name: z.string().trim().min(2, "Name is required").max(120),
  phone: z.string().trim().min(7, "Phone is required").max(40),
  email: z.string().trim().email("Valid email is required").max(254),
  message: z.string().trim().max(5000).optional().default(""),
});

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function buildEmailContent(data: { name: string; phone: string; email: string; message?: string }) {
  const subject = `[DataNest Inquiry] ${data.name} — ${data.email}`;
  const text = [
    "New inquiry from DataNest contact form",
    "",
    `Name:    ${data.name}`,
    `Phone:   ${data.phone}`,
    `Email:   ${data.email}`,
    "",
    "Message:",
    data.message || "(no message provided)",
  ].join("\n");
  const html = `
    <div style="font-family:Arial,sans-serif;line-height:1.7;color:#111;max-width:520px">
      <h2 style="margin:0 0 16px;color:#00a07a">New DataNest Inquiry</h2>
      <p><strong>Name:</strong> ${escapeHtml(data.name)}</p>
      <p><strong>Phone:</strong> ${escapeHtml(data.phone)}</p>
      <p><strong>Email:</strong> <a href="mailto:${escapeHtml(data.email)}">${escapeHtml(data.email)}</a></p>
      <hr style="margin:16px 0;border:none;border-top:1px solid #ddd"/>
      <p><strong>Message:</strong></p>
      <p style="white-space:pre-wrap;background:#f5f5f5;padding:12px;border-radius:6px">${escapeHtml(data.message || "(no message provided)")}</p>
    </div>`;
  return { subject, text, html };
}

// ── Try Resend (free, REST-based) ───────────────────────────
async function sendViaResend(data: { name: string; phone: string; email: string; message?: string }): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY || "";
  if (!apiKey) throw new Error("RESEND_API_KEY not set");

  const resend = new Resend(apiKey);
  const { subject, html, text } = buildEmailContent(data);

  const result = await resend.emails.send({
    from: "DataNest Contact <onboarding@resend.dev>",
    to: [CONTACT_TO_EMAIL],
    replyTo: data.email,
    subject,
    html,
    text,
  });

  if (result.error) throw new Error(result.error.message);
}

// ── Fall back to SMTP (nodemailer) ──────────────────────────
async function sendViaSmtp(data: { name: string; phone: string; email: string; message?: string }): Promise<void> {
  const host = process.env.SMTP_HOST || "smtp.gmail.com";
  const port = Number(process.env.SMTP_PORT || 587);
  const secure = String(process.env.SMTP_SECURE || "false").toLowerCase() === "true";
  const user =
    process.env.SMTP_USER || process.env.SMTP_USERNAME ||
    process.env.EMAIL_USER || process.env.GMAIL_USER || "";
  const pass =
    process.env.SMTP_PASS || process.env.SMTP_PASSWORD ||
    process.env.EMAIL_PASS || process.env.GMAIL_PASS ||
    process.env.GMAIL_APP_PASSWORD || "";

  if (!user || !pass) throw new Error("SMTP credentials not set");

  const from = process.env.CONTACT_EMAIL_FROM || user;
  const { subject, html, text } = buildEmailContent(data);

  const transporter = nodemailer.createTransport({ host, port, secure, auth: { user, pass } });
  await transporter.sendMail({ from, to: CONTACT_TO_EMAIL, replyTo: data.email, subject, text, html });
}

router.post("/", async (req, res) => {
  const parsed = contactSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: parsed.error.issues[0]?.message || "Invalid input" });
  }

  const data = parsed.data;

  // Try Resend first, then SMTP
  const errors: string[] = [];

  try {
    await sendViaResend(data);
    return res.json({ ok: true });
  } catch (e1) {
    errors.push(`Resend: ${(e1 as Error).message}`);
  }

  try {
    await sendViaSmtp(data);
    return res.json({ ok: true });
  } catch (e2) {
    errors.push(`SMTP: ${(e2 as Error).message}`);
  }

  console.error("All contact email transports failed:", errors);
  return res.status(503).json({
    ok: false,
    error: "Unable to send email. Please set RESEND_API_KEY in Railway environment variables. Get a free key at resend.com.",
  });
});

export default router;

