// Tidelight offline support.
// - The app itself (HTML, JS, CSS, icons, fonts, libraries) is cached so it opens with no reception.
// - Forecast, tide and aurora data: network first, falling back to the last saved copy.
// - Map tiles you've viewed are kept for offline use; live radar is never cached.
// Bump VERSION with each release (matches APP_VERSION in js/app.js).
const VERSION = '5.9';
const SHELL = `tidelight-shell-${VERSION}`;
const DATA = 'tidelight-data';
const TILES = 'tidelight-tiles';
const MAX_TILES = 600;

const SHELL_FILES = ['./', './index.html', './manifest.webmanifest', './icons/icon.svg', './icons/icon-180.png', './icons/icon-192.png'];
const DATA_HOSTS = ['open-meteo.com', 'services.swpc.noaa.gov', 'api.rainviewer.com'];
const LIB_HOSTS = ['cdnjs.cloudflare.com', 'cdn.jsdelivr.net', 'fonts.googleapis.com', 'fonts.gstatic.com', 'tysonwaldron.com'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(SHELL).then(c => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith('tidelight-shell-') && k !== SHELL).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

const matches = (host, list) => list.some(h => host === h || host.endsWith('.' + h));

// Network first, but never wait forever: if a saved copy exists and the network hasn't answered
// within `timeout` ms, use the saved copy (the fresh response still updates the cache when it arrives).
async function networkFirst(req, cacheName, timeout = 0) {
  const cache = await caches.open(cacheName);
  const net = fetch(req).then(res => {
    if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
    return res;
  });
  const hit = await cache.match(req);
  if (!hit) return net;                       // nothing saved yet: the page's own time limit applies
  if (!timeout) { try { return await net; } catch { return hit; } }
  const slow = new Promise(resolve => setTimeout(() => resolve(null), timeout));
  try { return (await Promise.race([net, slow])) || hit; } catch { return hit; }
}

async function cacheFirst(req, cacheName, trim) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res && (res.ok || res.type === 'opaque')) {
    await cache.put(req, res.clone());
    if (trim) trimCache(cache, trim);
  }
  return res;
}

async function trimCache(cache, max) {
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - max; i++) await cache.delete(keys[i]);
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.hostname === 'api.anthropic.com' || url.hostname.includes('tilecache.rainviewer.com')) return; // live only

  if (url.origin === self.location.origin) {
    if (req.mode === 'navigate') {
      event.respondWith(networkFirst(req, SHELL).catch(() => caches.match('./index.html')));
    } else {
      // JS/CSS carry a ?v= version tag, so a cached copy is always the right one for that version.
      event.respondWith(cacheFirst(req, SHELL));
    }
    return;
  }
  if (matches(url.hostname, DATA_HOSTS)) { event.respondWith(networkFirst(req, DATA, 8000)); return; }
  if (url.hostname === 'tile.openstreetmap.org') { event.respondWith(cacheFirst(req, TILES, MAX_TILES)); return; }
  if (matches(url.hostname, LIB_HOSTS)) { event.respondWith(cacheFirst(req, SHELL)); return; }
});

/* ---------- Alerts: show push notifications and open the app when tapped ---------- */
self.addEventListener('push', event => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch { d = { body: event.data ? event.data.text() : '' }; }
  event.waitUntil(self.registration.showNotification(d.title || 'Tidelight', {
    body: d.body || '',
    tag: d.tag || undefined,
    icon: './icons/icon-192.png',
    badge: './icons/icon-192.png',
    data: { url: d.url || './' },
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || './', self.registration.scope).href;
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) {
      if (w.url.startsWith(self.registration.scope)) {
        await w.focus();
        if (target.includes('#')) w.postMessage({ type: 'open', url: target });   // e.g. a crewmate's spot
        return;
      }
    }
    await self.clients.openWindow(target);
  })());
});
