/* Toki's service worker. It shows game invites that arrive while Toki is closed (push
   notifications) and opens the game when one is tapped. It caches nothing and leaves every
   request alone. */
self.addEventListener("install", function () { self.skipWaiting(); });
self.addEventListener("activate", function (e) { e.waitUntil(self.clients.claim()); });

/* Only pages on Toki itself are opened. */
function page(url) {
  return typeof url === "string" && url.charAt(0) === "/" && url.charAt(1) !== "/" && url.charAt(1) !== "\\" ? url : "/notifications";
}

self.addEventListener("push", function (e) {
  var d = {};
  try { d = (e.data && e.data.json()) || {}; } catch (err) { /* not ours: shown as a plain "Toki" */ }
  e.waitUntil(self.registration.showNotification(String(d.title || "Toki"), {
    body: String(d.body || ""),
    icon: "/icon-192.png",
    tag: String(d.tag || "toki"),
    renotify: true,
    data: { url: page(d.url) }
  }));
});

self.addEventListener("notificationclick", function (e) {
  e.notification.close();
  var url = page(e.notification.data && e.notification.data.url);
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (list) {
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if ("focus" in c) {
        /* Toki is open: it goes to the page itself, without loading again. */
        c.postMessage({ toki: "open", url: url });
        return c.focus();
      }
    }
    return self.clients.openWindow(url);
  }));
});
