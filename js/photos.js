// Spot photos live in IndexedDB (much roomier than localStorage), on this device only.
import { uid } from './util.js?v=1.6';

const DB_NAME = 'tidelight';
const STORE = 'photos';
const MAX_SIDE = 1600;     // resized on import: sharp on a phone, a few hundred KB each
const QUALITY = 0.84;

let dbPromise = null;
const urls = new Map();    // photo id -> object URL for <img src>

function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function run(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    const out = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(out && 'result' in out ? out.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Photo storage was full or blocked'));
  });
}

// Load every stored photo into memory as object URLs, so views can render synchronously.
export async function loadAllPhotos() {
  try {
    const d = await db();
    await new Promise((resolve, reject) => {
      const t = d.transaction(STORE, 'readonly');
      const req = t.objectStore(STORE).openCursor();
      req.onsuccess = () => {
        const c = req.result;
        if (c) { if (!urls.has(c.key)) urls.set(c.key, URL.createObjectURL(c.value)); c.continue(); }
      };
      t.oncomplete = resolve;
      t.onerror = () => reject(t.error);
    });
  } catch (e) {
    console.warn('Photos unavailable:', e);
  }
}

export const photoUrl = id => (id ? urls.get(id) || null : null);
export const coverUrl = spot => photoUrl(spot?.photos?.[0]);

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve({ img, url });
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error(`Couldn't open ${file.name}. Try a JPEG or PNG.`)); };
    img.src = url;
  });
}

async function resizeToBlob(file) {
  const { img, url } = await loadImage(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement('canvas');
  c.width = Math.round(img.naturalWidth * scale);
  c.height = Math.round(img.naturalHeight * scale);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  URL.revokeObjectURL(url);
  return new Promise((resolve, reject) =>
    c.toBlob(b => (b ? resolve(b) : reject(new Error('Could not process the image'))), 'image/jpeg', QUALITY));
}

export async function addPhotoFile(file) {
  const blob = await resizeToBlob(file);
  const id = uid();
  await run('readwrite', s => s.put(blob, id));
  urls.set(id, URL.createObjectURL(blob));
  return id;
}

export async function deletePhotos(ids = []) {
  if (!ids.length) return;
  await run('readwrite', s => { ids.forEach(id => s.delete(id)); });
  ids.forEach(id => { const u = urls.get(id); if (u) URL.revokeObjectURL(u); urls.delete(id); });
}

export async function clearPhotos() {
  await run('readwrite', s => s.clear());
  urls.forEach(u => URL.revokeObjectURL(u));
  urls.clear();
}

const blobToDataUrl = blob => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(r.result);
  r.onerror = () => reject(r.error);
  r.readAsDataURL(blob);
});

// For backups: { id: dataURL }
export async function exportPhotos(ids) {
  const out = {};
  for (const id of ids) {
    const blob = await run('readonly', s => s.get(id));
    if (blob) out[id] = await blobToDataUrl(blob);
  }
  return out;
}

export async function importPhotos(map = {}) {
  for (const [id, dataUrl] of Object.entries(map)) {
    const blob = await (await fetch(dataUrl)).blob();
    await run('readwrite', s => s.put(blob, id));
    const old = urls.get(id); if (old) URL.revokeObjectURL(old);
    urls.set(id, URL.createObjectURL(blob));
  }
}
