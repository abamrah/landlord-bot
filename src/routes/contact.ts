import { Router } from "express";
import nodemailer from "nodemailer";
import { z } from "zod";

const router = Router();

const contactSchema = z.object({
  name: z.string().trim().min(2, "Name is required").max(120),
  phone: z.string().trim().min(7, "Phone is required").max(40),
  email: z.string().trim().email("Valid email is required").max(254),
  message: z.string().trim().max(5000).optional().default(""),
});

function buildMailtoLink(data: { name: string; phone: string; email: string; message?: string }, to: string): string {
  const subject = `[DataNest Inquiry] ${data.name} (${data.email})`;
  const body = [
    "New inquiry from DataNest contact form",
    "",
    `Name: ${data.name}`,
    `Phone: ${data.phone}`,
    `Email: ${data.email}`,
    "",
    "Message:",
    data.message || "(no message provided)",
  ].join("\n");

  return `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

function getSmtpConfig() {
  const host = process.env.SMTP_HOST || "smtp.gmail.com";
  const port = Number(process.env.SMTP_PORT || 587);
  const secure = String(process.env.SMTP_SECURE || "false").toLowerCase() === "true";
  const user = process.env.SMTP_USER || "";
  const pass = process.env.SMTP_PASS || "";
  const to = process.env.CONTACT_EMAIL_TO || "arsh.bamrah27@gmail.com";
  const from = process.env.CONTACT_EMAIL_FROM || user || "no-reply@datanest.ca";

  return { host, port, secure, user, pass, to, from };
}

router.post("/", async (req, res) => {
  const parsed = contactSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({
      ok: false,
      error: parsed.error.issues[0]?.message || "Invalid contact payload",
    });
  }

  const cfg = getSmtpConfig();
  if (!cfg.user || !cfg.pass) {
    return res.json({
      ok: true,
      mode: "mailto",
      mailtoUrl: buildMailtoLink(parsed.data, cfg.to),
      message: "Email service is not configured. Opening your email client as fallback.",
    });
  }

  const transporter = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: {
      user: cfg.user,
      pass: cfg.pass,
    },
  });

  const data = parsed.data;
  const subject = `[DataNest Inquiry] ${data.name} (${data.email})`;

  const text = [
    "New inquiry from DataNest contact form",
    "",
    `Name: ${data.name}`,
    `Phone: ${data.phone}`,
    `Email: ${data.email}`,
    "",
    "Message:",
    data.message || "(no message provided)",
  ].join("\n");

  const html = `
    <div style="font-family:Arial,sans-serif;line-height:1.6;color:#111">
      <h2 style="margin:0 0 12px">New inquiry from DataNest contact form</h2>
      <p><strong>Name:</strong> ${escapeHtml(data.name)}</p>
      <p><strong>Phone:</strong> ${escapeHtml(data.phone)}</p>
      <p><strong>Email:</strong> ${escapeHtml(data.email)}</p>
      <p><strong>Message:</strong></p>
      <p style="white-space:pre-wrap">${escapeHtml(data.message || "(no message provided)")}</p>
    </div>
  `;

  try {
    await transporter.sendMail({
      from: cfg.from,
      to: cfg.to,
      replyTo: data.email,
      subject,
      text,
      html,
    });

    return res.json({ ok: true });
  } catch (error) {
    console.error("Contact email send failed:", error);
    return res.status(502).json({ ok: false, error: "Failed to send inquiry email." });
  }
});

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export default router;
