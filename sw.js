// Hält nur die App-Hülle offline vor; Fahrplandaten kommen immer live.
const CACHE = 'mvv4dummies-v3';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'manifest.webmanifest', 'icon.svg', 'apple-touch-icon.png', 'vendor/leaflet/leaflet.js', 'vendor/leaflet/leaflet.css'];

// Neue Version sofort übernehmen, nicht erst wenn die App ganz geschlossen war.
self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
});
self.addEventListener('activate', (e) => e.waitUntil(
  caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()),
));
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;
  // Netz zuerst, damit Updates sofort ankommen; Cache nur als Rückfall.
  // no-cache: am Server nachfragen, statt bis zu 10 min die alte Datei aus dem Browser-Cache zu nehmen.
  e.respondWith(fetch(e.request, { cache: 'no-cache' }).then((res) => {
    const copy = res.clone();
    caches.open(CACHE).then((c) => c.put(e.request, copy));
    return res;
  }).catch(() => caches.match(e.request, { ignoreSearch: true })));
});
