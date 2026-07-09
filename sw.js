/* Repostaje Camper — service worker (offline shell) */
const CACHE = 'repostaje-camper-v1';
const SHELL = [
  './',
  './index.html',
  './app.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL).catch(()=>{})).then(()=>self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Datos de precios / APIs externas: red primero, sin cachear (los datos se guardan en localStorage).
  const isApi = /sedeaplicaciones\.minetur|nominatim\.openstreetmap|router\.project-osrm/.test(url.host);
  const isTile = /tile\.openstreetmap\.org/.test(url.host);
  if (isApi) { return; } // dejar pasar a la red tal cual

  // Tiles del mapa: cache-first con relleno (mapa parcial offline si ya se visitó).
  if (isTile) {
    e.respondWith(caches.open(CACHE).then(async c => {
      const hit = await c.match(req); if (hit) return hit;
      try { const res = await fetch(req); if (res.ok) c.put(req, res.clone()); return res; } catch(_){ return hit || Response.error(); }
    }));
    return;
  }

  // Shell de la app: cache-first con actualización en segundo plano.
  e.respondWith(caches.open(CACHE).then(async c => {
    const hit = await c.match(req, {ignoreSearch:false});
    const net = fetch(req).then(res => { if (res && res.ok) c.put(req, res.clone()); return res; }).catch(()=>null);
    return hit || net || fetch(req);
  }));
});
