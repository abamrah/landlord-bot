import { Router } from "express";
import { z } from "zod";

const router = Router();

const CONTACT_TO_EMAIL = "arsh.bamrah27@gmail.com";

const contactSchema = z.object({
  name: z.string().trim().min(2, "Name is required").max(120),
  phone: z.string().trim().min(7, "Phone is required").max(40),
  email: z.string().trim().email("Valid email is required").max(254),
  message: z.string().trim().max(5000).optional().default(""),
});

function buildEmailText(data: { name: string; phone: string; email: string; message?: string }) {
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
  return { subject, text };
}

async function sendViaFormspree(data: { name: string; phone: string; email: string; message?: string }): Promise<void> {
  const formId = process.env.FORMSPREE_FORM_ID || "";
  const endpoint = process.env.FORMSPREE_ENDPOINT || (formId ? `https://formspree.io/f/${formId}` : "");

  if (!endpoint) {
    throw new Error("Formspree is not configured. Set FORMSPREE_FORM_ID or FORMSPREE_ENDPOINT.");
  }

  const { subject, text } = buildEmailText(data);

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
    body: JSON.stringify({
      name: data.name,
      phone: data.phone,
      email: data.email,
      message: data.message || "",
      subject,
      inquiry_text: text,
      _replyto: data.email,
      _subject: subject,
      contact_to: CONTACT_TO_EMAIL,
    }),
  });

  if (!response.ok) {
    const payload = await response.text();
    throw new Error(`Formspree request failed (${response.status}): ${payload.slice(0, 200)}`);
  }
}

router.post("/", async (req, res) => {
  const parsed = contactSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: parsed.error.issues[0]?.message || "Invalid input" });
  }

  try {
    await sendViaFormspree(parsed.data);
    return res.json({ ok: true });
  } catch (error) {
    console.error("Formspree contact submit failed:", error);
    return res.status(503).json({
      ok: false,
      error: "Unable to send inquiry. Configure Formspree by setting FORMSPREE_FORM_ID (or FORMSPREE_ENDPOINT) in Railway variables.",
    });
  }
});

export default router;

