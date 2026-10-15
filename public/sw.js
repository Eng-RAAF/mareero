// Mareero service worker — keeps the app's own files on this computer so it opens without internet.
// Business data is not stored here; the app saves query results itself (src/lib/convex.js).
const CACHE = "mareero-app-v1";
const SHELL = ["/", "/favicon.svg", "/manifest.webmanifest", "/icon-192.png", "/icon-512.png", "/icon-maskable-512.png", "/apple-touch-icon.png"];
const FONT_HOSTS = ["fonts.googleapis.com", "fonts.gstatic.com"];

// Hashed build files referenced by index.html (/assets/index-abc123.js, …)
function assetsIn(html) {
  return [...new Set([...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]))];
}

// Store a fresh index.html with its build files, and drop build files from older versions
async function refreshShell(indexResponse) {
  const cache = await caches.open(CACHE);
  const html = await indexResponse.clone().text();
  const assets = assetsIn(html);
  await Promise.all(
    assets.map(async (a) => {
      if (!(await cache.match(a, { ignoreVary: true }))) await cache.add(a);
    }),
  );
  await cache.put("/", indexResponse);
  const keep = new Set(assets.map((a) => new URL(a, self.location.origin).href));
  for (const req of await cache.keys()) {
    const u = new URL(req.url);
    if (u.origin === self.location.origin && u.pathname.startsWith("/assets/") && !keep.has(u.href)) {
      await cache.delete(req);
    }
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await Promise.all(SHELL.slice(1).map((u) => cache.add(u).catch(() => {})));
      await refreshShell(await fetch("/", { cache: "no-cache" }));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
      await self.clients.claim();
    })(),
  );
});

async function cacheFirst(request) {
  const hit = await caches.match(request, { ignoreVary: true });
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok || res.type === "opaque") (await caches.open(CACHE)).put(request, res.clone());
  return res;
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request, { ignoreVary: true });
  const fresh = fetch(request)
    .then((res) => {
      if (res.ok || res.type === "opaque") cache.put(request, res.clone());
      return res;
    })
    .catch(() => hit);
  return hit || fresh;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);

  // Page loads (any route — it's a single-page app): network first, saved copy when offline
  if (request.mode === "navigate") {
    event.respondWith(
      fetch("/", { cache: "no-cache" })
        .then((res) => {
          if (res.ok) event.waitUntil(refreshShell(res.clone()));
          return res;
        })
        .catch(async () => (await caches.match("/", { ignoreVary: true })) || Response.error()),
    );
    return;
  }

  if (url.origin === self.location.origin) {
    if (url.pathname.startsWith("/assets/")) event.respondWith(cacheFirst(request));
    else if (SHELL.includes(url.pathname)) event.respondWith(staleWhileRevalidate(request));
    return;
  }

  if (FONT_HOSTS.includes(url.hostname)) event.respondWith(staleWhileRevalidate(request));
  // Everything else (Convex API, sign-in) goes straight to the network
});
