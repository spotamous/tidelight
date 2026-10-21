export const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));

export function haversineKm(a, b) {
  const R = 6371, toRad = d => d * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Times are unix seconds; offset is the spot's UTC offset in seconds, so times show in the spot's local time.
function shifted(t, offset) { return new Date((t + (offset || 0)) * 1000); }

export function fmtTime(t, offset) {
  if (t == null || isNaN(t)) return '–';
  const d = shifted(t, offset);
  let h = d.getUTCHours(); const m = d.getUTCMinutes();
  const ap = h >= 12 ? 'pm' : 'am';
  h = h % 12 || 12;
  return `${h}:${String(m).padStart(2, '0')}${ap}`;
}

export function dayKey(t, offset) {
  const d = shifted(t, offset);
  return `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
}

export function fmtDay(t, offset) {
  const now = Date.now() / 1000;
  const k = dayKey(t, offset);
  if (k === dayKey(now, offset)) return 'Today';
  if (k === dayKey(now + 86400, offset)) return 'Tomorrow';
  if (k === dayKey(now - 86400, offset)) return 'Yesterday';
  const d = shifted(t, offset);
  return `${WD[d.getUTCDay()]} ${d.getUTCDate()} ${MON[d.getUTCMonth()]}`;
}

export function fmtDate(ms) {
  const d = new Date(ms);
  return `${d.getDate()} ${MON[d.getMonth()]} ${d.getFullYear()}`;
}

export function compass(deg) {
  const dirs = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  return dirs[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16];
}

export function angleDiff(a, b) {
  const d = Math.abs(((a - b) % 360 + 540) % 360 - 180);
  return d;
}

export const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

export function uid() {
  return Math.random().toString(36).slice(2, 9) + Date.now().toString(36);
}

export function downloadFile(name, text, type = 'text/plain') {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

let toastTimer;
export function toast(msg, ms = 2600) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

export function getPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('This browser has no location access.'));
    navigator.geolocation.getCurrentPosition(
      p => resolve({ lat: p.coords.latitude, lon: p.coords.longitude }),
      e => reject(new Error(e.code === 1 ? 'Location permission was denied. Allow it in your browser settings.' : 'Could not get your location.')),
      { enableHighAccuracy: true, timeout: 15000 }
    );
  });
}
