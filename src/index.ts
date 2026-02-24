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
