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

async function sendViaFormSubmit(data: { name: string; phone: string; email: string; message?: string }): Promise<void> {
  const subject = `[DataNest Inquiry] ${data.name} — ${data.email}`;

  const response = await fetch(`https://formsubmit.co/ajax/${CONTACT_TO_EMAIL}`, {
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
      _subject: subject,
      _replyto: data.email,
      _captcha: "false",
    }),
  });

  if (!response.ok) {
    const payload = await response.text();
    throw new Error(`FormSubmit request failed (${response.status}): ${payload.slice(0, 200)}`);
  }
}

router.post("/", async (req, res) => {
  const parsed = contactSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: parsed.error.issues[0]?.message || "Invalid input" });
  }

  try {
    await sendViaFormSubmit(parsed.data);
    return res.json({ ok: true });
  } catch (error) {
    console.error("FormSubmit contact submit failed:", error);
    return res.status(503).json({
      ok: false,
      error: "Unable to send inquiry. Please try again later.",
    });
  }
});

export default router;

