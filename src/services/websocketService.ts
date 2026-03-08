/**
 * websocketService.ts — WebSocket server for real-time notifications.
 *
 * Provides:
 *  - JWT-authenticated WebSocket connections per landlord
 *  - Real-time notification broadcast to connected landlords
 *  - Notification persistence to database
 *  - Browser push notification dispatch via web-push
 */

import { Server as HTTPServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { verifyToken } from "../middleware/auth";
import { db } from "../config/database";

// ═══════════════════════════════════════════════════════════
//  CONNECTION MANAGEMENT
// ═══════════════════════════════════════════════════════════

/** Map of landlordId → Set of active WebSocket connections */
const connections = new Map<string, Set<WebSocket>>();

/** Get count of active connections for a landlord */
export function getConnectionCount(landlordId: string): number {
  return connections.get(landlordId)?.size || 0;
}

// ═══════════════════════════════════════════════════════════
//  NOTIFICATION TYPES
// ═══════════════════════════════════════════════════════════

export type NotificationType =
  | "maintenance"
  | "approval_request"
  | "contractor"
  | "lease"
  | "utility"
  | "system"
  | "info"
  | "TENANT_MESSAGE";

export interface NotificationPayload {
  type: NotificationType;
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

// ═══════════════════════════════════════════════════════════
//  WEBSOCKET SERVER INITIALIZATION
// ═══════════════════════════════════════════════════════════

let wss: WebSocketServer | null = null;

/**
 * Initialize the WebSocket server, attaching it to the existing HTTP server.
 * Clients connect to ws://host/ws?token=JWT_TOKEN
 */
export function initWebSocket(server: HTTPServer): WebSocketServer {
  wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (ws, req) => {
    // Extract JWT from query string
    const url = new URL(req.url || "", `http://${req.headers.host}`);
    const token = url.searchParams.get("token");

    if (!token) {
      ws.close(4001, "Missing token");
      return;
    }

    const decoded = verifyToken(token);
    if (!decoded) {
      ws.close(4003, "Invalid token");
      return;
    }

    const landlordId = decoded.landlordId;

    // Register connection
    if (!connections.has(landlordId)) {
      connections.set(landlordId, new Set());
    }
    connections.get(landlordId)!.add(ws);

    // eslint-disable-next-line no-console
    console.info("[WS] Client connected", { landlordId, total: connections.get(landlordId)!.size });

    // Send initial connection acknowledgment
    ws.send(JSON.stringify({ type: "connected", landlordId }));

    // Handle client messages (ping/pong, mark-read, etc.)
    ws.on("message", async (raw) => {
      try {
        const msg = JSON.parse(raw.toString());

        if (msg.type === "ping") {
          ws.send(JSON.stringify({ type: "pong" }));
          return;
        }

        if (msg.type === "mark_read" && msg.notificationId) {
          await db.notification.updateMany({
            where: { id: msg.notificationId, landlordId },
            data: { read: true },
          });
          ws.send(JSON.stringify({ type: "read_ack", notificationId: msg.notificationId }));
          return;
        }

        if (msg.type === "mark_all_read") {
          await db.notification.updateMany({
            where: { landlordId, read: false },
            data: { read: true },
          });
          ws.send(JSON.stringify({ type: "all_read_ack" }));
          return;
        }
      } catch {
        // Ignore malformed messages
      }
    });

    // Cleanup on disconnect
    ws.on("close", () => {
      const set = connections.get(landlordId);
      if (set) {
        set.delete(ws);
        if (set.size === 0) connections.delete(landlordId);
      }
      // eslint-disable-next-line no-console
      console.info("[WS] Client disconnected", { landlordId, remaining: connections.get(landlordId)?.size || 0 });
    });

    ws.on("error", (err) => {
      // eslint-disable-next-line no-console
      console.warn("[WS] Connection error", { landlordId, error: err.message });
    });
  });

  // eslint-disable-next-line no-console
  console.info("[WS] WebSocket server initialized on /ws");

  return wss;
}

// ═══════════════════════════════════════════════════════════
//  BROADCAST & NOTIFICATION CREATION
// ═══════════════════════════════════════════════════════════

/**
 * Broadcast a raw message to all connected WebSocket clients for a landlord.
 * Does NOT persist — use createNotification() for persistent notifications.
 */
export function broadcastToLandlord(landlordId: string, message: Record<string, unknown>): void {
  const set = connections.get(landlordId);
  if (!set || set.size === 0) return;

  const payload = JSON.stringify(message);
  for (const ws of set) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
    }
  }
}

/**
 * Create a persistent notification, broadcast it via WebSocket,
 * and send browser push notifications to all subscribed devices.
 */
export async function createNotification(
  landlordId: string,
  notification: NotificationPayload,
): Promise<void> {
  // 1. Persist to database
  try {
    await db.notification.create({
      data: {
        landlordId,
        type: notification.type,
        title: notification.title,
        body: notification.body,
        data: notification.data ? JSON.parse(JSON.stringify(notification.data)) : undefined,
        read: false,
      },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[WS] Failed to persist notification", err);
  }

  // 2. Broadcast via WebSocket
  broadcastToLandlord(landlordId, {
    type: "notification",
    notification: {
      type: notification.type,
      title: notification.title,
      body: notification.body,
      data: notification.data,
      createdAt: new Date().toISOString(),
      read: false,
    },
  });

  // 3. Send browser push notifications
  try {
    await sendPushNotifications(landlordId, notification);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[WS] Push notification failed (non-critical)", (err as Error).message);
  }
}

// ═══════════════════════════════════════════════════════════
//  BROWSER PUSH NOTIFICATIONS
// ═══════════════════════════════════════════════════════════

/**
 * Send push notifications to all subscribed devices for a landlord.
 * Uses the web-push library with VAPID credentials.
 */
async function sendPushNotifications(
  landlordId: string,
  notification: NotificationPayload,
): Promise<void> {
  const vapidPublicKey = process.env.VAPID_PUBLIC_KEY;
  const vapidPrivateKey = process.env.VAPID_PRIVATE_KEY;
  const vapidEmail = process.env.VAPID_EMAIL || "mailto:admin@example.com";

  if (!vapidPublicKey || !vapidPrivateKey) return; // Push not configured

  let webpush: any;
  try {
    webpush = require("web-push");
  } catch {
    return; // web-push not installed
  }

  webpush.setVapidDetails(vapidEmail, vapidPublicKey, vapidPrivateKey);

  const subscriptions = await db.pushSubscription.findMany({
    where: { landlordId },
  });

  if (!subscriptions.length) return;

  const payload = JSON.stringify({
    title: notification.title,
    body: notification.body,
    type: notification.type,
    data: notification.data,
  });

  const results = await Promise.allSettled(
    subscriptions.map(async (sub) => {
      try {
        await webpush.sendNotification(
          {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.p256dh, auth: sub.auth },
          },
          payload,
        );
      } catch (err: any) {
        // If subscription is expired or invalid, remove it
        if (err?.statusCode === 410 || err?.statusCode === 404) {
          await db.pushSubscription.delete({ where: { id: sub.id } }).catch(() => { });
        }
        throw err;
      }
    }),
  );

  const failed = results.filter((r) => r.status === "rejected").length;
  if (failed > 0) {
    // eslint-disable-next-line no-console
    console.warn(`[WS] ${failed}/${subscriptions.length} push notifications failed`);
  }
}

// ═══════════════════════════════════════════════════════════
//  EXPORTS
// ═══════════════════════════════════════════════════════════

export default {
  initWebSocket,
  broadcastToLandlord,
  createNotification,
  getConnectionCount,
};
