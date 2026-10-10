const CACHE = "cave-shell-__BUILD_HASH__";
const SHELL = ["./", "./cave.js", "./manifest.json"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL))
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => (k === "cave-v1" || k.startsWith("cave-shell-")) && k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  // Never cache GIS, tokens or Drive API responses, only the versioned app shell.
  if (new URL(req.url).origin !== self.location.origin || req.method !== "GET") return;
  const shellUrl = req.mode === "navigate" ? new URL('./', self.registration.scope).href : req.url;
  event.respondWith(
    caches.open(CACHE).then(cache => cache.match(shellUrl)).then(cached => cached || fetch(req))
  );
});
