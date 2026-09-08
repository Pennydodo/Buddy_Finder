/* ============================================================
   Service worker.

   Three jobs:
     1. Keep the app itself openable with no signal.
     2. Cache the CDN libraries, so a dead connection at the gate
        doesn't leave you staring at a blank screen.
     3. Hoard map tiles you have actually looked at, so the map
        still draws when the network gives up.

   Positions themselves are never cached here — stale coordinates
   are worse than none, and that freshness logic lives in the app.
   ============================================================ */

const VERSION = "v1";
const SHELL_CACHE = `bf-shell-${VERSION}`;
const LIB_CACHE = `bf-lib-${VERSION}`;
const TILE_CACHE = "bf-tiles";          // deliberately unversioned: tiles outlive releases
const TILE_LIMIT = 1500;

const SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./manifest.webmanifest",
  "./js/app.js",
  "./js/config.js",
  "./js/crypto.js",
  "./js/geo.js",
  "./js/compass.js",
  "./js/map.js",
  "./js/transport.js",
  "./icons/icon-192.png",
  "./icons/icon-512.png"
];

const LIB_HOSTS = ["unpkg.com", "cdn.jsdelivr.net", "www.gstatic.com"];
const TILE_HOSTS = ["tile.openstreetmap.org", "server.arcgisonline.com"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(
        names
          .filter((n) => n.startsWith("bf-") && n !== SHELL_CACHE && n !== LIB_CACHE && n !== TILE_CACHE)
          .map((n) => caches.delete(n))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  let url;
  try { url = new URL(req.url); } catch { return; }

  // Never touch the database connection — it must always be live.
  if (url.hostname.endsWith("firebaseio.com") || url.hostname.endsWith("googleapis.com")) return;

  if (TILE_HOSTS.includes(url.hostname)) {
    event.respondWith(cacheFirst(req, TILE_CACHE, TILE_LIMIT));
    return;
  }

  if (LIB_HOSTS.includes(url.hostname)) {
    event.respondWith(cacheFirst(req, LIB_CACHE));
    return;
  }

  if (url.origin === self.location.origin) {
    event.respondWith(staleWhileRevalidate(req, SHELL_CACHE));
  }
});

/** Cached copy wins; otherwise fetch and file it away. */
async function cacheFirst(req, cacheName, limit) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit) return hit;
  try {
    const res = await fetch(req);
    // Opaque responses (cross-origin images) are still worth keeping.
    if (res && (res.ok || res.type === "opaque")) {
      await cache.put(req, res.clone());
      if (limit) trim(cacheName, limit);
    }
    return res;
  } catch (err) {
    return hit || Response.error();
  }
}

/** Serve instantly from cache, refresh in the background. */
async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  const network = fetch(req)
    .then((res) => {
      if (res && res.ok) cache.put(req, res.clone());
      return res;
    })
    .catch(() => null);

  if (hit) return hit;
  const res = await network;
  if (res) return res;

  // Navigations fall back to the cached shell, so deep links still open.
  if (req.mode === "navigate") {
    const shell = await cache.match("./index.html");
    if (shell) return shell;
  }
  return Response.error();
}

/** Evict oldest-first once the tile hoard gets too big. */
async function trim(cacheName, limit) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  if (keys.length <= limit) return;
  for (const key of keys.slice(0, keys.length - limit)) await cache.delete(key);
}
