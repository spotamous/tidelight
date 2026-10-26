// Tidelight offline support.
// - The app itself (HTML, JS, CSS, icons, fonts, libraries) is cached so it opens with no reception.
// - Forecast, tide and aurora data: network first, falling back to the last saved copy.
// - Map tiles you've viewed are kept for offline use; live radar is never cached.
// Bump VERSION with each release (matches APP_VERSION in js/app.js).
const VERSION = '2.3';
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

async function networkFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(req);
    if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
    return res;
  } catch (e) {
    const hit = await cache.match(req);
    if (hit) return hit;
    throw e;
  }
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
  if (matches(url.hostname, DATA_HOSTS)) { event.respondWith(networkFirst(req, DATA)); return; }
  if (url.hostname === 'tile.openstreetmap.org') { event.respondWith(cacheFirst(req, TILES, MAX_TILES)); return; }
  if (matches(url.hostname, LIB_HOSTS)) { event.respondWith(cacheFirst(req, SHELL)); return; }
});
