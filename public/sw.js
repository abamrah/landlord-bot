/**
 * Service Worker for browser push notifications.
 * Handles incoming push events and notification clicks.
 */

/* eslint-env serviceworker */
/* global self, clients */

self.addEventListener("push", function (event) {
  var data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: "New Notification", body: event.data ? event.data.text() : "" };
  }

  var title = data.title || "AI Agent Notification";
  var options = {
    body: data.body || "",
    icon: "/logo.svg",
    badge: "/logo.svg",
    tag: data.type || "general",
    data: data.data || {},
    actions: [
      { action: "view", title: "View" },
      { action: "dismiss", title: "Dismiss" },
    ],
    requireInteraction: data.type === "maintenance" || data.type === "approval_request",
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", function (event) {
  event.notification.close();

  if (event.action === "dismiss") return;

  // Open or focus the dashboard
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (clientList) {
      // Try to focus an existing dashboard window
      for (var i = 0; i < clientList.length; i++) {
        var client = clientList[i];
        if (client.url.includes("/dashboard") && "focus" in client) {
          return client.focus();
        }
      }
      // Open a new window
      if (clients.openWindow) {
        return clients.openWindow("/dashboard");
      }
    })
  );
});

self.addEventListener("install", function () {
  self.skipWaiting();
});

self.addEventListener("activate", function (event) {
  event.waitUntil(self.clients.claim());
});
