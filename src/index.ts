import dotenv from "dotenv";
import express from "express";
import http from "http";
import path from "path";
import bodyParser from "body-parser";
import morgan from "morgan";
import webhooksRouter from "./routes/webhooks";
import apiRouter from "./routes/api";
import adminRouter from "./routes/admin";
import authRouter from "./routes/auth";
import maintenanceRouter from "./routes/maintenance";
import maintenanceListRouter from "./routes/maintenance-list";
import { runDueReminders, runFollowUpNudges } from "./services/reminderService";
import { handleWebhook as handleStripeWebhook } from "./services/stripeService";
import { handleRentWebhookEvent } from "./services/rentCollectionService";
import { handleCertnWebhook, handleSingleKeyWebhook } from "./services/screeningService";
import { registerPlugin, initializePlugins } from "./services/verticalPlugin";
import { propertyManagementPlugin } from "./verticals/property-management";
import { apiRateLimit, authRateLimit } from "./services/rateLimiter";
import { sendLeaseExpiryAlerts } from "./services/leaseExpiryService";
import { requireAuth } from "./middleware/auth";
import { initWebSocket } from "./services/websocketService";

dotenv.config();

// ── Register vertical plugins ───────────────────────────
registerPlugin(propertyManagementPlugin);

const app = express();
const server = http.createServer(app);
const port = process.env.PORT || 3000;

// Initialize WebSocket server
initWebSocket(server);

// Stripe webhooks need raw body
app.post("/webhooks/stripe", express.raw({ type: "application/json" }), async (req, res) => {
  const signature = req.headers["stripe-signature"] as string || "";
  const result = await handleStripeWebhook(req.body, signature);

  // Also pass to rent collection handler for Connect events
  try {
    const Stripe = require("stripe");
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: "2024-12-18.acacia" });
    const event = stripe.webhooks.constructEvent(req.body, signature, process.env.STRIPE_WEBHOOK_SECRET || "");
    await handleRentWebhookEvent(event);
  } catch { /* rent handler is best-effort */ }

  res.json(result);
});

app.use(bodyParser.json({ limit: "50mb" }));
app.use(bodyParser.urlencoded({ extended: true, limit: "50mb" }));
app.use(morgan("dev"));

app.use(express.static(path.join(process.cwd(), "public")));

// Serve pages
app.get("/dashboard", (_req, res) => {
  res.sendFile(path.join(process.cwd(), "public", "dashboard.html"));
});
app.get("/login", (_req, res) => {
  res.sendFile(path.join(process.cwd(), "public", "login.html"));
});
app.get("/signup", (_req, res) => {
  res.sendFile(path.join(process.cwd(), "public", "login.html"));
});
app.get("/onboarding", (_req, res) => {
  res.sendFile(path.join(process.cwd(), "public", "onboarding.html"));
});

// ── Public tenant payment pages (no auth) ──
app.get("/pay/success", (_req, res) => {
  res.sendFile(path.join(process.cwd(), "public", "pay-success.html"));
});
app.get("/pay/cancelled", (_req, res) => {
  res.sendFile(path.join(process.cwd(), "public", "pay-cancelled.html"));
});

// ── Screening webhooks (no auth — signed by providers) ──
app.post("/webhooks/certn", express.json(), async (req, res) => {
  try {
    const result = await handleCertnWebhook(req.body);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});
app.post("/webhooks/singlekey", express.json(), async (req, res) => {
  try {
    const result = await handleSingleKeyWebhook(req.body);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// API routes
app.use("/auth", authRateLimit, authRouter);
app.use("/webhooks", webhooksRouter);
app.use("/api", apiRateLimit, apiRouter);
app.use("/admin", apiRateLimit, adminRouter);
app.use("/maintenance/list", apiRateLimit, requireAuth, maintenanceListRouter);
app.use("/maintenance", apiRateLimit, requireAuth, maintenanceRouter);

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

server.listen(port, async () => {
  // Initialize all registered vertical plugins
  await initializePlugins();
  // eslint-disable-next-line no-console
  console.log(`AI Agent listening on port ${port}`);

  // Sync Evolution API instance settings (groupsIgnore=false, readMessages=true)
  // Run after a short delay to let DB connections settle
  setTimeout(async () => {
    try {
      const { syncAllInstanceSettings } = require("./services/whatsappService");
      await syncAllInstanceSettings();
    } catch (err) {
      console.warn("Evolution instance sync failed (non-blocking):", (err as Error).message);
    }
  }, 5000);

  // Periodic Evolution API health check — every 5 minutes
  // Checks all instances and attempts reconnect if disconnected
  const EVOLUTION_HEALTH_CHECK_MS = 5 * 60 * 1000;
  setInterval(async () => {
    try {
      const { healthCheckAllInstances } = require("./services/whatsappService");
      await healthCheckAllInstances();
    } catch (err) {
      console.warn("[HealthCheck] Evolution health check failed (non-blocking):", (err as Error).message);
    }
  }, EVOLUTION_HEALTH_CHECK_MS);
});

const REMINDER_POLL_MS = 30 * 1000;
setInterval(() => {
  runDueReminders().catch((err) => {
    // eslint-disable-next-line no-console
    console.warn("Reminder run failed", err);
  });
  // Check for 48hr follow-up nudges alongside reminders
  runFollowUpNudges().catch((err) => {
    // eslint-disable-next-line no-console
    console.warn("Follow-up nudge failed", err);
  });
}, REMINDER_POLL_MS);

// ── Lease expiry check — runs daily at midnight ──
const LEASE_CHECK_MS = 24 * 60 * 60 * 1000;
// Run once on startup (after a slight delay to let DB connect)
setTimeout(() => {
  sendLeaseExpiryAlerts().catch((err) => {
    console.warn("Lease expiry check failed", err);
  });
}, 10 * 1000);
// Then run every 24h
setInterval(() => {
  sendLeaseExpiryAlerts().catch((err) => {
    console.warn("Lease expiry check failed", err);
  });
}, LEASE_CHECK_MS);
