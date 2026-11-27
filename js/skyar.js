// Sky view: the live camera with the sun's path, the moon's path and phase, and the Milky Way drawn
// over it, at any time you scrub to. Uses the camera, the motion sensors and the compass; without
// them (a computer, or sensors refused) you drag to look around a drawn sky instead.
import { esc, fmtTime, toast, getPosition, compass, tzOffset, deviceOffset } from './util.js?v=7.4.2';

const D2R = Math.PI / 180, R2D = 180 / Math.PI;
const LENS_FOV = 67;                       // phone main camera, degrees across the long side of the frame
const MIN_DAY = 24 * 60;

/* ---------- where things are in the sky ---------- */
const azOf = rad => (rad * R2D + 180 + 360) % 360;   // SunCalc azimuth (from south, west +) to compass bearing
function sunAt(d, lat, lon) { const p = window.SunCalc.getPosition(d, lat, lon); return { az: azOf(p.azimuth), alt: p.altitude * R2D }; }
function moonAt(d, lat, lon) { const p = window.SunCalc.getMoonPosition(d, lat, lon); return { az: azOf(p.azimuth), alt: p.altitude * R2D }; }
// Right ascension / declination (degrees) to compass bearing and altitude.
function raDecToAltAz(ra, dec, d, lat, lon) {
  const days = d.getTime() / 864e5 - 10957.5;
  const lst = (280.16 + 360.9856235 * days + lon) * D2R;
  const H = lst - ra * D2R, de = dec * D2R, phi = lat * D2R;
  const alt = Math.asin(Math.sin(phi) * Math.sin(de) + Math.cos(phi) * Math.cos(de) * Math.cos(H));
  const az = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(phi) - Math.tan(de) * Math.cos(phi));
  return { az: (az * R2D + 180 + 360) % 360, alt: alt * R2D };
}
// Galactic longitude/latitude to RA/Dec (J2000). The core is l = 0.
function galToEq(l, b) {
  const L = l * D2R, B = b * D2R;
  const raNGP = 192.85948 * D2R, decNGP = 27.12825 * D2R, lNCP = 122.93192 * D2R;
  const sinDec = Math.sin(B) * Math.sin(decNGP) + Math.cos(B) * Math.cos(decNGP) * Math.cos(lNCP - L);
  const dec = Math.asin(sinDec);
  const y = Math.cos(B) * Math.sin(lNCP - L);
  const x = Math.sin(B) * Math.cos(decNGP) - Math.cos(B) * Math.sin(decNGP) * Math.cos(lNCP - L);
  return { ra: ((raNGP + Math.atan2(y, x)) * R2D + 360) % 360, dec: dec * R2D };
}
const CORE = galToEq(0, 0);

/* ---------- the Milky Way's shape ---------- */
// How wide (degrees either side of the plane) and how bright the band looks along galactic longitude l,
// roughly as it does to the eye from a dark site: broad and bright through Sagittarius and Scorpius,
// bright patches in Cygnus, Scutum and Carina, thin and faint towards Auriga.
const wrapL = l => ((l + 540) % 360) - 180;
const bump = (l, at, w) => Math.exp(-((wrapL(l - at) / w) ** 2));
const mwBright = l => Math.min(1, 0.22 + 0.78 * bump(l, 0, 32) + 0.42 * bump(l, 78, 14) + 0.32 * bump(l, 27, 8) + 0.36 * bump(l, -72, 13) + 0.18 * bump(l, -50, 18));
const mwWidth = l => 5 + 11 * bump(l, 0, 28) + 4 * bump(l, 78, 18) + 3 * bump(l, -72, 16);
// Dark lanes: the Great Rift (Cygnus down through Aquila to Ophiuchus, just north of the plane) and the Coalsack.
const RIFT = []; for (let l = 2; l <= 86; l += 2) RIFT.push([l, 1.6 + 1.2 * bump(l, 45, 30), (1.2 + 1.6 * bump(l, 30, 22)) * Math.sin(Math.PI * (l - 2) / 84)]);   // [l, centre b, half width], fading out at both ends
// Landmarks people look for. g: galactic [l, b]; or q: equatorial [RA, Dec] degrees (J2000).
const MW_SPOTS = [
  { n: 'Sagittarius Star Cloud', g: [1.5, -4], kind: 'cloud' },
  { n: 'Lagoon Nebula', g: [6.0, -1.2], kind: 'neb' },
  { n: 'Scutum Star Cloud', g: [27, -2.5], kind: 'cloud' },
  { n: 'Great Rift', g: [32, 3], kind: 'dark' },
  { n: 'Dark Horse', g: [358, 5.5], kind: 'dark' },
  { n: 'Antares, Rho Ophiuchi', q: [247.35, -26.43], kind: 'star' },
  { n: 'Carina Nebula', g: [287.6, -0.6], kind: 'neb' },
  { n: 'Southern Cross', q: [187.5, -60.0], kind: 'star' },
  { n: 'Coalsack', g: [301, -1], kind: 'dark' },
  { n: 'Alpha & Beta Centauri', q: [215.4, -60.6], kind: 'star' },
  { n: 'Large Magellanic Cloud', q: [80.9, -69.8], kind: 'gal' },
  { n: 'Small Magellanic Cloud', q: [13.2, -72.8], kind: 'gal' },
  { n: 'Cygnus, Northern Cross', g: [78, 2], kind: 'cloud' },
  { n: 'North America Nebula', g: [85.5, -1], kind: 'neb' },
  { n: 'Andromeda Galaxy', q: [10.68, 41.27], kind: 'gal' },
  { n: 'Galactic anticentre', g: [180, 0], kind: 'faint' },
];
for (const sp of MW_SPOTS) { const e = sp.g ? galToEq(sp.g[0], sp.g[1]) : { ra: sp.q[0], dec: sp.q[1] }; sp.ra = e.ra; sp.dec = e.dec; }
const COALSACK = galToEq(301, -1);
const coreAt = (d, lat, lon) => raDecToAltAz(CORE.ra, CORE.dec, d, lat, lon);

// Magnetic declination, roughly, from reference points around Australia and New Zealand (degrees east).
// Calibrating on the sun or moon replaces this with a measured correction.
const DECL = [[-31.95, 115.86, -0.9], [-34.93, 138.6, 8.0], [-37.81, 144.96, 11.7], [-33.87, 151.21, 12.9], [-27.47, 153.03, 11.2],
  [-42.88, 147.33, 15.5], [-12.46, 130.84, 3.9], [-16.92, 145.77, 7.6], [-23.7, 133.88, 5.2], [-35.28, 149.13, 12.4],
  [-36.85, 174.76, 20.0], [-43.53, 172.63, 24.0], [-20.73, 139.49, 6.6], [-19.26, 146.82, 8.0], [-38.15, 144.36, 11.4],
  // further afield, for travellers (rounded; calibrating on the sun or moon is still the way to be exact)
  [43.65, -79.38, -10.0], [45.5, -73.57, -13.5], [44.65, -63.57, -16.5], [47.56, -52.71, -18.5], [49.9, -97.14, 1.5],
  [51.05, -114.07, 13.5], [53.55, -113.49, 13.9], [49.28, -123.12, 15.5], [60.72, -135.06, 18.0], [62.45, -114.37, 15.0],
  [61.2, -149.9, 14.5], [47.6, -122.33, 15.0], [37.77, -122.42, 12.9], [34.05, -118.24, 11.5], [39.74, -104.99, 7.5],
  [32.78, -96.8, 2.5], [41.88, -87.63, -3.5], [40.71, -74.0, -12.7], [25.76, -80.19, -6.5], [19.43, -99.13, 4.0], [21.3, -157.86, 9.0],
  [51.5, -0.13, 1.0], [48.86, 2.35, 1.8], [52.52, 13.4, 4.5], [40.4, -3.7, 0.5], [41.9, 12.5, 4.0], [59.9, 10.75, 4.0], [64.15, -21.94, -10.0],
  [-33.9, 18.4, -25.5], [-26.2, 28.05, -19.0], [35.68, 139.69, -8.0], [1.35, 103.8, 0.2], [-8.65, 115.2, 1.0], [28.6, 77.2, 1.0],
  [25.2, 55.3, 2.0], [-33.45, -70.67, 0.0], [-34.6, -58.4, -9.0], [-12.05, -77.04, -2.0], [-22.9, -43.2, -23.0]];
function declinationAt(lat, lon) {
  let wsum = 0, v = 0, nearest = Infinity;
  for (const [a, b, d] of DECL) {
    const km = Math.hypot((lat - a) * 111, (lon - b) * 111 * Math.cos(lat * D2R));
    nearest = Math.min(nearest, km);
    const w = 1 / Math.max(1, km) ** 2; wsum += w; v += w * d;
  }
  return nearest < 2500 ? { deg: v / wsum, known: true } : { deg: 0, known: false };
}

/* ---------- vectors ---------- */
const vec = (az, alt) => { const A = az * D2R, h = alt * D2R; return [Math.sin(A) * Math.cos(h), Math.cos(A) * Math.cos(h), Math.sin(h)]; };   // east, north, up
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = a => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const mix = (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];

// The phone's axes in the world (east, north, up), from the W3C orientation angles.
function deviceBasis(alpha, beta, gamma) {
  const a = alpha * D2R, b = beta * D2R, g = gamma * D2R;
  const cA = Math.cos(a), sA = Math.sin(a), cB = Math.cos(b), sB = Math.sin(b), cG = Math.cos(g), sG = Math.sin(g);
  const x = [cA * cG - sA * sB * sG, cG * sA + cA * sB * sG, -cB * sG];
  const y = [-cB * sA, cA * cB, sB];
  const z = [cG * sA * sB + cA * sG, sA * sG - cA * cG * sB, cB * cG];
  return { x, y, z };
}

/* ---------- state ---------- */
let S = null;   // the open view

export async function openSkyAR(opts = {}) {
  if (S) closeSkyAR();
  const root = document.createElement('div');
  root.className = 'skyar';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'Sky view');
  root.innerHTML = `
    <video class="sa-video" playsinline muted autoplay></video>
    <canvas class="sa-canvas" aria-hidden="true"></canvas>
    <div class="sa-ring" aria-hidden="true"></div>
    <header class="sa-top">
      <button class="sa-btn round" data-sa="close" aria-label="Close Sky view"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
      <div class="sa-title"><b>Sky view</b><small class="sa-point" aria-live="off">–</small></div>
      <button class="sa-btn" data-sa="layers" aria-expanded="false">Layers</button>
    </header>
    <div class="sa-layers" hidden>
      <label><input type="checkbox" data-layer="sun" checked> Sun</label>
      <label><input type="checkbox" data-layer="moon" checked> Moon</label>
      <label><input type="checkbox" data-layer="mw" checked> Milky Way</label>
      <label><input type="checkbox" data-layer="mwnames" checked> Milky Way names</label>
      <label><input type="checkbox" data-layer="grid" checked> Grid</label>
      <label class="sa-fov"><span>Lens field of view <b class="num"><span data-fovv></span>°</b></span><input type="range" min="40" max="110" step="1" data-fov></label>
      <p class="sa-hint" data-decl></p>
    </div>
    <div class="sa-banner" hidden></div>
    <section class="sa-panel">
      <div class="sa-when"><b class="sa-time num">–</b><span class="sa-date">–</span></div>
      <input class="sa-slider" type="range" min="0" max="${MIN_DAY - 5}" step="5" aria-label="Time">
      <div class="sa-events"></div>
      <div class="sa-row">
        <button class="sa-btn" data-sa="prev" aria-label="Day before">‹</button>
        <input class="sa-datepick" type="date" aria-label="Date">
        <button class="sa-btn" data-sa="next" aria-label="Day after">›</button>
        <button class="sa-btn" data-sa="now">Now</button>
      </div>
      <div class="sa-row">
        <button class="sa-btn" data-sa="cal">Calibrate</button>
        <button class="sa-btn primary" data-sa="snap">Snapshot</button>
      </div>
    </section>
    <div class="sa-start">
      <h2>Sky view</h2>
      <p>Hold your phone up to see where the sun, the moon and the Milky Way will be, drawn over the camera. Scrub the time to see them move.</p>
      <p class="small">It needs your camera, motion sensors and location. Nothing is recorded.</p>
      <button class="btn primary" data-sa="start">Start</button>
      <button class="btn" data-sa="close">Not now</button>
    </div>`;
  document.body.appendChild(root);
  document.body.classList.add('skyar-open');
  const q = sel => root.querySelector(sel);
  const now = new Date();
  const start = opts.time ? new Date(opts.time * 1000) : now;
  zone = opts.tz || null;   // the place's time zone (a spot far away); otherwise the phone's
  S = {
    root, q, video: q('.sa-video'), canvas: q('.sa-canvas'), ctx: q('.sa-canvas').getContext('2d'),
    lat: opts.lat ?? null, lon: opts.lon ?? null, place: opts.name || null,
    layers: { sun: true, moon: true, mw: true, mwnames: localStorage.getItem('tidelight:arMwNames') !== '0', grid: true, ...(opts.layers || {}) },
    focus: opts.focus || null,          // 'moon' | 'sun' | 'core': open looking for it
    fov: Number(localStorage.getItem('tidelight:arFov')) || LENS_FOV,
    day: dayStart(start), minute: minuteOfWindow(start),
    basis: null, smooth: null, sensors: false, absolute: false, compassOffset: null, untrustedFrames: 0, jumpFrames: 0,
    manual: { az: 180, alt: 15 }, decl: 0, userCorr: Number(localStorage.getItem('tidelight:arCorr')) || 0, corrSet: !!localStorage.getItem('tidelight:arCorr'),
    calibrating: false, raf: 0, stream: null, cache: null, listeners: [],
  };
  // layers & lens
  root.querySelectorAll('[data-layer]').forEach(cb => { cb.checked = S.layers[cb.dataset.layer]; cb.onchange = () => { S.layers[cb.dataset.layer] = cb.checked; if (cb.dataset.layer === 'mwnames') { try { localStorage.setItem('tidelight:arMwNames', cb.checked ? '1' : '0'); } catch {} } }; });
  const fovIn = q('[data-fov]'); fovIn.value = S.fov; q('[data-fovv]').textContent = S.fov;
  fovIn.oninput = () => { S.fov = Number(fovIn.value); q('[data-fovv]').textContent = S.fov; try { localStorage.setItem('tidelight:arFov', S.fov); } catch {} };
  root.addEventListener('click', onClick);
  const sl = q('.sa-slider');
  sl.value = S.minute;
  sl.oninput = () => { S.minute = Number(sl.value); S.cache = null; updateTimeUI(); };
  q('.sa-datepick').onchange = e => { const [y, m, d] = e.target.value.split('-').map(Number); if (y) { const noon = Date.UTC(y, m - 1, d, 12) / 1000; S.day = new Date((noon - offAt(noon)) * 1000); S.cache = null; updateTimeUI(); } };
  // drag to look (no sensors), and to fine-tune after calibrating
  let drag = null;
  S.canvas.addEventListener('pointerdown', e => { if (!S.sensors) { drag = { x: e.clientX, y: e.clientY, az: S.manual.az, alt: S.manual.alt }; S.canvas.setPointerCapture(e.pointerId); } });
  S.canvas.addEventListener('pointermove', e => {
    if (!drag) return;
    const k = S.fov / Math.max(innerWidth, innerHeight);
    S.manual.az = (drag.az - (e.clientX - drag.x) * k + 360) % 360;
    S.manual.alt = Math.max(-30, Math.min(85, drag.alt + (e.clientY - drag.y) * k));
  });
  S.canvas.addEventListener('pointerup', () => { drag = null; });
  updateTimeUI();
  if (opts.autostart) startAR();
}

// Times are shown in the place's own time zone: the phone's when you're standing there, the spot's
// when you open Sky view for a spot somewhere else.
let zone = null;
const offAt = sec => tzOffset(zone, sec) ?? deviceOffset(sec);
const hhmm = d => fmtTime(d.getTime() / 1000, offAt(d.getTime() / 1000));
const localDay = d => new Date((d.getTime() / 1000 + offAt(d.getTime() / 1000)) * 1000);   // read with getUTC*
function dayStart(d) {   // the night's window runs noon to noon, local to the place
  const sec = d.getTime() / 1000, off = offAt(sec);
  let mid = Math.floor((sec + off) / 86400) * 86400 - off;
  if (sec - mid < 12 * 3600) mid -= 86400;
  return new Date((mid + 12 * 3600) * 1000);
}
function minuteOfWindow(d) { return Math.max(0, Math.min(MIN_DAY - 5, Math.round((d - dayStart(d)) / 60000 / 5) * 5)); }
const selTime = () => new Date(S.day.getTime() + S.minute * 60000);

async function onClick(e) {
  const b = e.target.closest('[data-sa]');
  if (!b) return;
  const act = b.dataset.sa;
  if (act === 'close') return closeSkyAR();
  if (act === 'start') return startAR();
  if (act === 'layers') { const p = S.q('.sa-layers'); p.hidden = !p.hidden; b.setAttribute('aria-expanded', String(!p.hidden)); return; }
  if (act === 'now') { const n = new Date(); S.day = dayStart(n); S.minute = minuteOfWindow(n); S.cache = null; updateTimeUI(); return; }
  if (act === 'prev' || act === 'next') { S.day = new Date(S.day.getTime() + (act === 'next' ? 864e5 : -864e5)); S.cache = null; updateTimeUI(); return; }
  if (act === 'cal') return calibrate();
  if (act === 'setcal') return setCalibration();
  if (act === 'resetcal') { S.userCorr = 0; S.corrSet = false; try { localStorage.removeItem('tidelight:arCorr'); } catch {} hideBanner(); toast('Calibration cleared.'); return; }
  if (act === 'snap') return snapshot();
  const ev = e.target.closest('[data-at]');
  if (ev) { const d = new Date(Number(ev.dataset.at)); S.day = dayStart(d); S.minute = minuteOfWindow(d); S.cache = null; updateTimeUI(); }
}
// event chips are buttons with data-at, routed here too
function onEventChip(e) { const ev = e.target.closest('[data-at]'); if (!ev) return; const d = new Date(Number(ev.dataset.at)); S.day = dayStart(d); S.minute = minuteOfWindow(d); S.cache = null; updateTimeUI(); }

async function startAR() {
  const start = S.q('.sa-start');
  start.querySelector('[data-sa="start"]').disabled = true;
  // 1. motion sensors (iOS asks, and must be asked from the tap)
  let motionOK = true;
  try {
    if (window.DeviceOrientationEvent && typeof DeviceOrientationEvent.requestPermission === 'function') {
      motionOK = (await DeviceOrientationEvent.requestPermission()) === 'granted';
    }
  } catch { motionOK = false; }
  // 2. camera
  try {
    S.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
    S.video.srcObject = S.stream;
    await S.video.play().catch(() => {});
  } catch { S.root.classList.add('no-camera'); }
  // 3. where you are
  if (S.lat == null) {
    try { const p = await getPosition(); S.lat = p.lat; S.lon = p.lon; }
    catch (err) { toast(`${err.message} Using home instead.`, 4000); const home = JSON.parse(localStorage.getItem('tidelight:v1') || '{}')?.settings?.home; if (home) { S.lat = home.lat; S.lon = home.lon; } else { S.lat = -37.81; S.lon = 144.96; } }
  }
  const dc = declinationAt(S.lat, S.lon);
  S.decl = dc.deg;
  S.q('[data-decl]').textContent = dc.known
    ? `Compass corrected by ${S.decl >= 0 ? '+' : ''}${S.decl.toFixed(1)}° for magnetic north here.${S.corrSet ? ' Plus your calibration.' : ' Calibrate on the sun or moon for best accuracy.'}`
    : 'Calibrate on the sun or moon: the compass correction for this area isn\'t known.';
  start.remove();
  S.cache = null; updateTimeUI();
  listenSensors();   // always listen: some browsers send readings even when the permission prompt says no
  // if no sensor data turns up, fall back to drag-to-look
  setTimeout(() => {
    if (!S || S.sensors) return;
    S.root.classList.add('manual');
    if (S.focus) { const t = focusTarget(); if (t) { S.manual.az = t.az; S.manual.alt = Math.max(5, Math.min(60, t.alt)); } }
    const why = !motionOK ? 'Motion access was turned off, so the view can\'t follow your phone.' : 'No motion sensors here.';
    showBanner(`${S.root.classList.contains('no-camera') ? 'No camera, so this is a drawn sky. ' : ''}${why} Drag to look around.`, 5000);
  }, 1500);
  loop();
}

function listenSensors() {
  const onOri = e => {
    if (e.beta == null || e.gamma == null) return;
    let alpha = e.alpha ?? 0;
    if (e.webkitCompassHeading != null && !isNaN(e.webkitCompassHeading)) {
      // iOS: alpha is the gyro (smooth, but starts wherever the phone was); webkitCompassHeading is magnetic.
      // Keep a slowly-smoothed offset between them, but only learn it while the compass can be trusted:
      // with the camera tipped well up (screen facing the ground) iOS's heading wobbles and can flip 180°,
      // which used to drag the whole sky round. Up there we just ride the gyro on the last good offset.
      const camAlt = Math.asin(Math.max(-1, Math.min(1, Math.cos(e.beta * D2R) * Math.cos(e.gamma * D2R)))) / D2R * -1;
      const acc = e.webkitCompassAccuracy;
      const trusted = camAlt < 45 && camAlt > -75 && !(acc < 0) && !(acc > 35);
      const want = (360 - e.webkitCompassHeading - alpha + 720) % 360;
      if (S.compassOffset == null) {
        if (trusted || S.untrustedFrames++ > 90) S.compassOffset = want;   // first fix (or give up waiting after ~1.5 s)
        else return;
      } else if (trusted) {
        const d = ((want - S.compassOffset + 540) % 360) - 180;
        if (Math.abs(d) > 25) {
          // a big jump: believe it only if it holds for a moment (a real recalibration), not a single glitch
          S.jumpFrames = (S.jumpFrames || 0) + 1;
          if (S.jumpFrames > 30) { S.compassOffset = want; S.jumpFrames = 0; }
        } else {
          S.jumpFrames = 0;
          S.compassOffset = (S.compassOffset + d * 0.02 + 360) % 360;
        }
      }
      alpha = alpha + S.compassOffset;
    } else if (S.absolute && !e.absolute) {
      return;   // Android sends both; once we have the absolute stream, ignore the relative one so they don't fight
    } else if (!e.absolute && !S.absolute) {
      return;   // a relative-only alpha can't point anywhere real
    }
    S.sensors = true; S.root.classList.remove('manual');
    S.basis = deviceBasis(alpha, e.beta, e.gamma);
  };
  const onAbs = e => { S.absolute = true; onOri({ ...e, absolute: true, alpha: e.alpha, beta: e.beta, gamma: e.gamma }); };
  window.addEventListener('deviceorientationabsolute', onAbs);
  window.addEventListener('deviceorientation', onOri);
  S.listeners.push(['deviceorientationabsolute', onAbs], ['deviceorientation', onOri]);
}

export function closeSkyAR() {
  if (!S) return;
  cancelAnimationFrame(S.raf);
  S.listeners.forEach(([t, f]) => window.removeEventListener(t, f));
  if (S.stream) S.stream.getTracks().forEach(t => t.stop());
  S.root.remove();
  document.body.classList.remove('skyar-open');
  S = null;
}

/* ---------- the camera's frame in the world ---------- */
// right, up and forward (into the scene), east/north/up, with the compass corrected.
function cameraFrame() {
  let right, up, fwd;
  if (S.sensors && S.basis) {
    const { x, y, z } = S.basis;
    const ang = (screen.orientation?.angle ?? window.orientation ?? 0) * D2R;
    right = [x[0] * Math.cos(ang) - y[0] * Math.sin(ang), x[1] * Math.cos(ang) - y[1] * Math.sin(ang), x[2] * Math.cos(ang) - y[2] * Math.sin(ang)];
    up = [x[0] * Math.sin(ang) + y[0] * Math.cos(ang), x[1] * Math.sin(ang) + y[1] * Math.cos(ang), x[2] * Math.sin(ang) + y[2] * Math.cos(ang)];
    fwd = [-z[0], -z[1], -z[2]];
    // smooth out sensor jitter, then square the axes up again
    if (S.smooth) { fwd = norm(mix(S.smooth.fwd, fwd, 0.22)); up = norm(mix(S.smooth.up, up, 0.22)); }
    right = norm(cross(fwd, up)); up = norm(cross(right, fwd));
    S.smooth = { fwd, up };
    // compass correction: rotate the frame about the vertical by the declination and your calibration
    const c = (S.decl + S.userCorr) * D2R;
    const rot = v => [v[0] * Math.cos(c) + v[1] * Math.sin(c), -v[0] * Math.sin(c) + v[1] * Math.cos(c), v[2]];
    return { right: rot(right), up: rot(up), fwd: rot(fwd) };
  }
  fwd = vec(S.manual.az, S.manual.alt);
  right = norm(cross(fwd, [0, 0, 1]));
  up = norm(cross(right, fwd));
  return { right, up, fwd };
}
const pointing = f => ({ az: (Math.atan2(f.fwd[0], f.fwd[1]) * R2D + 360) % 360, alt: Math.asin(Math.max(-1, Math.min(1, f.fwd[2]))) * R2D });

/* ---------- drawing ---------- */
function loop() {
  if (!S) return;
  draw();
  S.raf = requestAnimationFrame(loop);
}
function computePaths() {
  const { lat, lon } = S;
  const t0 = S.day.getTime(), sel = selTime();
  const SC = window.SunCalc;
  const out = { sun: [], moon: [], core: [], band: [] };
  for (let m = 0; m <= MIN_DAY; m += 10) {
    const d = new Date(t0 + m * 60000);
    const hour = m % 60 === 0;
    out.sun.push({ ...sunAt(d, lat, lon), d, hour });
    out.moon.push({ ...moonAt(d, lat, lon), d, hour });
    out.core.push({ ...coreAt(d, lat, lon), d, hour });
  }
  for (let l = -180; l <= 180; l += 3) { const eq = galToEq(l, 0); out.band.push({ ...raDecToAltAz(eq.ra, eq.dec, sel, lat, lon), l }); }
  // the band's edges at three depths (for a soft falloff), the dark lanes, and the landmarks
  const at = (l, b) => { const eq = galToEq(l, b); return raDecToAltAz(eq.ra, eq.dec, sel, lat, lon); };
  // Each layer is one continuous shape (no joins to show): the whole band at five depths for a soft
  // edge, plus the bright regions as extra shapes that taper away at their ends.
  const strip = (from, to, wfn, alpha) => { const up = [], dn = []; for (let l = from; l <= to; l += 2) { const w = wfn(l); up.push(at(l, w)); dn.push(at(l, -w)); } return { up, dn, alpha }; };
  const taper = (l, from, to) => Math.sin(Math.PI * Math.min(1, Math.max(0, (l - from) / (to - from))));
  out.strips = [
    ...[1.15, 0.9, 0.68, 0.48, 0.28].map(k => strip(-180, 180, l => mwWidth(l) * k, 0.022)),
    strip(-42, 42, l => 13 * taper(l, -42, 42), 0.05), strip(-22, 22, l => 8 * taper(l, -22, 22), 0.05), strip(-4, 9, l => 6 * taper(l, -4, 9), 0.04),
    strip(58, 98, l => 7 * taper(l, 58, 98), 0.05), strip(-96, -52, l => 6 * taper(l, -96, -52), 0.045), strip(21, 34, l => 4.5 * taper(l, 21, 34), 0.045),
  ];
  out.rift = RIFT.map(([l, b, w]) => ({ l, up: at(l, b + w), dn: at(l, b - w) }));
  out.coalsack = raDecToAltAz(COALSACK.ra, COALSACK.dec, sel, lat, lon);
  out.mwSpots = MW_SPOTS.map(sp => ({ ...sp, ...raDecToAltAz(sp.ra, sp.dec, sel, lat, lon) }));
  out.selSun = sunAt(sel, lat, lon); out.selMoon = moonAt(sel, lat, lon); out.selCore = coreAt(sel, lat, lon);
  out.illum = SC.getMoonIllumination(sel);
  out.sunDark = out.selSun.alt < -18;
  return out;
}
function draw() {
  const c = S.canvas, g = S.ctx;
  const dpr = Math.min(2, devicePixelRatio || 1), W = innerWidth, H = innerHeight;
  if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); c.style.width = W + 'px'; c.style.height = H + 'px'; }
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  if (S.lat == null) return;
  if (!S.cache) S.cache = computePaths();
  const P = S.cache;
  const f = cameraFrame();
  const pt = pointing(f);
  S.q('.sa-point').textContent = `${Math.round(pt.az)}° ${compass(pt.az)}, ${pt.alt >= 0 ? '' : '−'}${Math.abs(Math.round(pt.alt))}° ${pt.alt >= 0 ? 'up' : 'down'}`;
  // the camera image covers the screen: work out its focal length in screen pixels
  const vw = S.video.videoWidth || 0, vh = S.video.videoHeight || 0;
  let fpx;
  if (vw && vh && !S.root.classList.contains('no-camera')) {
    const scale = Math.max(W / vw, H / vh);
    fpx = (Math.max(vw, vh) * scale / 2) / Math.tan(S.fov / 2 * D2R);
  } else fpx = (Math.max(W, H) / 2) / Math.tan(S.fov / 2 * D2R);
  const cx = W / 2, cy = H / 2;
  const proj = (az, alt) => {
    const w = vec(az, alt);
    const z = dot(w, f.fwd);
    if (z <= 0.02) return null;
    return { x: cx + fpx * dot(w, f.right) / z, y: cy - fpx * dot(w, f.up) / z, z };
  };
  const inView = p => p && p.x > -200 && p.x < W + 200 && p.y > -200 && p.y < H + 200;
  const line = (pts, style, width, dash) => {
    g.save(); g.strokeStyle = style; g.lineWidth = width; g.lineJoin = 'round'; g.lineCap = 'round'; if (dash) g.setLineDash(dash);
    g.beginPath(); let pen = false, last = null;
    for (const p of pts) {
      if (!p || (last && Math.hypot(p.x - last.x, p.y - last.y) > W)) { pen = false; last = p; continue; }
      if (!pen) { g.moveTo(p.x, p.y); pen = true; } else g.lineTo(p.x, p.y);
      last = p;
    }
    g.stroke(); g.restore();
  };
  const label = (t, x, y, opt = {}) => {
    g.save(); g.font = `${opt.weight || 600} ${opt.size || 12}px Manrope, system-ui, sans-serif`; g.textAlign = opt.align || 'left'; g.textBaseline = 'middle';
    g.lineWidth = 3; g.strokeStyle = 'rgba(0,0,0,.55)'; g.strokeText(t, x, y); g.fillStyle = opt.color || '#F4EFE7'; g.fillText(t, x, y); g.restore();
  };
  const hm = d => hhmm(d).replace(':00', '');

  // grid: the horizon, altitude rings, compass points
  if (S.layers.grid) {
    const hz = []; for (let a = 0; a <= 360; a += 2) hz.push(proj(a, 0));
    line(hz, 'rgba(255,255,255,.75)', 2);
    for (const alt of [30, 60]) { const r = []; for (let a = 0; a <= 360; a += 3) r.push(proj(a, alt)); line(r, 'rgba(255,255,255,.22)', 1, [4, 6]); }
    for (let a = 0; a < 360; a += 15) {
      const p = proj(a, 0), p2 = proj(a, a % 45 === 0 ? 2.2 : 1.1);
      if (!p || !p2 || !inView(p)) continue;
      g.save(); g.strokeStyle = 'rgba(255,255,255,.75)'; g.lineWidth = 1.5; g.beginPath(); g.moveTo(p.x, p.y); g.lineTo(p2.x, p2.y); g.stroke(); g.restore();
      if (a % 45 === 0) label(compass(a), p.x, p.y + 16, { align: 'center', size: 15, weight: 700 });
      else label(`${a}°`, p.x, p.y + 14, { align: 'center', size: 10, color: 'rgba(244,239,231,.75)' });
    }
    for (const alt of [30, 60]) { const p = proj(pt.az, alt); if (p && inView(p)) label(`${alt}°`, p.x + 6, p.y - 8, { size: 10, color: 'rgba(244,239,231,.6)' }); }
  }
  // the Milky Way: a soft band along the galactic plane, the core, and the core's path through the night
  if (S.layers.mw) {
    // The band itself: soft layers whose width and brightness follow the real Milky Way. It's drawn
    // brighter once it's properly dark, the way it actually appears.
    const dark = P.sunDark ? 1 : P.selSun.alt < -6 ? 0.7 : 0.45;
    // Drawn small on a hidden canvas, then scaled up: the scaling blurs it into a smooth glow
    // with no seams between the pieces (and it's quicker to draw).
    const K = 5, ow = Math.ceil(W / K), oh = Math.ceil(H / K);
    const off = S.mwCanvas || (S.mwCanvas = document.createElement('canvas'));
    if (off.width !== ow || off.height !== oh) { off.width = ow; off.height = oh; }
    const o = off.getContext('2d');
    o.setTransform(1, 0, 0, 1, 0, 0); o.clearRect(0, 0, ow, oh); o.setTransform(1 / K, 0, 0, 1 / K, 0, 0);
    const quad = (pts, col) => { o.fillStyle = col; o.beginPath(); o.moveTo(pts[0].x, pts[0].y); for (let i = 1; i < pts.length; i++) o.lineTo(pts[i].x, pts[i].y); o.closePath(); o.fill(); };
    for (const st of P.strips) {
      // split into runs that are all in front of the camera, and fill each run as one shape
      o.fillStyle = `rgba(206,212,255,${(st.alpha * dark).toFixed(4)})`;
      let run = [];
      const flush = () => {
        if (run.length > 1) { o.beginPath(); run.forEach(([u], i) => (i ? o.lineTo(u.x, u.y) : o.moveTo(u.x, u.y))); for (let i = run.length - 1; i >= 0; i--) o.lineTo(run[i][1].x, run[i][1].y); o.closePath(); o.fill(); }
        run = [];
      };
      for (let i = 0; i < st.up.length; i++) {
        const a = st.up[i], d = st.dn[i];
        const pa = a.alt > -6 ? proj(a.az, a.alt) : null, pd = d.alt > -6 ? proj(d.az, d.alt) : null;
        const prev = run[run.length - 1];
        if (!pa || !pd || (prev && Math.hypot(pa.x - prev[0].x, pa.y - prev[0].y) > W)) { flush(); if (!pa || !pd) continue; }
        run.push([pa, pd]);
      }
      flush();
    }
    // the dark lanes, cut out of the glow
    o.globalCompositeOperation = 'destination-out';
    { const ups = P.rift.map(r => (r.up.alt > -3 ? proj(r.up.az, r.up.alt) : null)), dns = P.rift.map(r => (r.dn.alt > -3 ? proj(r.dn.az, r.dn.alt) : null));
      o.fillStyle = 'rgba(0,0,0,.4)'; o.beginPath(); let n = 0;
      ups.forEach((u, i) => { if (u && dns[i]) { n ? o.lineTo(u.x, u.y) : o.moveTo(u.x, u.y); n++; } });
      for (let i = dns.length - 1; i >= 0; i--) if (ups[i] && dns[i]) o.lineTo(dns[i].x, dns[i].y);
      if (n > 1) { o.closePath(); o.fill(); } }
    const cs = P.coalsack.alt > -2 ? proj(P.coalsack.az, P.coalsack.alt) : null;
    if (cs && inView(cs)) { const r = fpx * Math.tan(3.2 * D2R); o.fillStyle = 'rgba(0,0,0,.6)'; o.beginPath(); o.ellipse(cs.x, cs.y, r, r * 0.8, 0, 0, Math.PI * 2); o.fill(); }
    o.globalCompositeOperation = 'source-over';
    g.save(); g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high'; g.drawImage(off, 0, 0, ow * K, oh * K); g.restore();
    const band = P.band.map(b => (b.alt > -5 ? proj(b.az, b.alt) : null));
    line(band, 'rgba(225,228,255,.28)', 1.2, [2, 6]);   // the plane itself, faint
    // the landmarks, named (Layers, Milky Way names)
    if (S.layers.mwnames) {
      const placed = [];
      const cq0 = proj(P.selCore.az, P.selCore.alt);   // the core's own label is drawn below: keep clear of it
      if (cq0 && inView(cq0)) placed.push({ l: cq0.x - 70, y: cq0.y - 26, w: 140 });
      const ICON = { cloud: 'rgba(235,236,255,.95)', neb: '#FFB3C7', dark: 'rgba(160,165,200,.95)', star: '#FFE6B0', gal: '#C9F0FF', faint: 'rgba(210,215,255,.75)' };
      for (const sp of P.mwSpots) {
        if (sp.alt < 2) continue;
        const q = proj(sp.az, sp.alt);
        if (!q || q.x < 10 || q.x > W - 10 || q.y < 70 || q.y > H - 150) continue;
        const col = ICON[sp.kind];
        g.save(); g.strokeStyle = col; g.lineWidth = 1.6; g.shadowColor = 'rgba(0,0,0,.6)'; g.shadowBlur = 4;
        if (sp.kind === 'dark') { g.setLineDash([3, 3]); g.beginPath(); g.arc(q.x, q.y, 7, 0, Math.PI * 2); g.stroke(); }
        else if (sp.kind === 'star') { g.beginPath(); for (const [dx, dy] of [[0, -7], [0, 7], [-7, 0], [7, 0]]) { g.moveTo(q.x, q.y); g.lineTo(q.x + dx, q.y + dy); } g.stroke(); }
        else { g.beginPath(); g.ellipse(q.x, q.y, sp.kind === 'gal' ? 9 : 7, sp.kind === 'gal' ? 5 : 7, sp.kind === 'gal' ? -0.5 : 0, 0, Math.PI * 2); g.stroke(); }
        g.restore();
        if (cq0 && Math.hypot(q.x - cq0.x, q.y - cq0.y) < 64) continue;   // right on the core: its label covers it
        // keep names from piling on top of each other: try the right, then the left, then below
        g.save(); g.font = '600 11px Manrope, system-ui, sans-serif'; const tw = g.measureText(sp.n).width; g.restore();
        const tries = [[q.x + 11, q.y - 10, 'left'], [q.x - 11, q.y - 10, 'right'], [q.x, q.y + 18, 'center']];
        const box = ([x, y, al]) => ({ l: al === 'left' ? x : al === 'right' ? x - tw : x - tw / 2, y });
        const free = tries.find(tr => { const b = box(tr); return b.l > 4 && b.l + tw < W - 4 && !placed.some(p => b.l < p.l + p.w + 6 && b.l + tw + 6 > p.l && Math.abs(b.y - p.y) < 15); });
        if (!free) continue;
        placed.push({ ...box(free), w: tw });
        label(sp.n, free[0], free[1], { size: 11, color: col, weight: 600, align: free[2] });
      }
    }
    const cpath = P.core.map(p => (p.alt > -2 ? proj(p.az, p.alt) : null));
    line(cpath, 'rgba(170,160,255,.55)', 2, [6, 5]);
    P.core.forEach((p, i) => { if (!p.hour || p.alt < 0 || i % 12) return; const q = proj(p.az, p.alt); if (q && inView(q)) { dotAt(g, q.x, q.y, 3, 'rgba(200,190,255,.9)'); label(hm(p.d), q.x + 7, q.y - 8, { size: 10, color: '#D8D2FF' }); } });
    const cq = proj(P.selCore.az, P.selCore.alt);
    if (cq && inView(cq)) {
      const glow = g.createRadialGradient(cq.x, cq.y, 0, cq.x, cq.y, 34);
      glow.addColorStop(0, P.sunDark ? 'rgba(255,236,210,.85)' : 'rgba(255,236,210,.45)'); glow.addColorStop(1, 'rgba(255,236,210,0)');
      g.fillStyle = glow; g.beginPath(); g.arc(cq.x, cq.y, 34, 0, Math.PI * 2); g.fill();
      label(P.selCore.alt > 0 ? 'Milky Way core' : 'Core (below the horizon)', cq.x, cq.y - 26, { align: 'center', size: 12, color: '#F1E9FF' });
    }
  }
  // the sun: its path through the day, hour marks, and where it is at the chosen time
  if (S.layers.sun) {
    const spath = P.sun.map(p => (p.alt > -12 ? proj(p.az, p.alt) : null));
    line(spath, 'rgba(255,196,110,.85)', 3);
    P.sun.forEach(p => { if (!p.hour || p.alt < -8) return; const q = proj(p.az, p.alt); if (q && inView(q)) { dotAt(g, q.x, q.y, 3.5, '#FFD08A'); label(hm(p.d), q.x + 8, q.y - 9, { size: 11, color: '#FFE2B6' }); } });
    const s = proj(P.selSun.az, P.selSun.alt);
    if (s && inView(s)) {
      const glow = g.createRadialGradient(s.x, s.y, 0, s.x, s.y, 30); glow.addColorStop(0, 'rgba(255,214,140,.9)'); glow.addColorStop(1, 'rgba(255,214,140,0)');
      g.fillStyle = glow; g.beginPath(); g.arc(s.x, s.y, 30, 0, Math.PI * 2); g.fill();
      dotAt(g, s.x, s.y, 11, '#FFE7B8');
    }
  }
  // the moon: its path, hour marks, rise and set, and its phase at the chosen time
  if (S.layers.moon) {
    const mpath = P.moon.map(p => (p.alt > -6 ? proj(p.az, p.alt) : null));
    line(mpath, 'rgba(200,226,240,.85)', 3);
    P.moon.forEach((p, i) => {
      if (p.hour && p.alt > -3) { const q = proj(p.az, p.alt); if (q && inView(q)) { dotAt(g, q.x, q.y, 3.5, '#DDEFF8'); label(hm(p.d), q.x + 8, q.y - 9, { size: 11, color: '#E4F2FA' }); } }
      const prev = P.moon[i - 1];
      if (prev && (prev.alt < 0) !== (p.alt < 0)) { const q = proj(p.az, 0); if (q && inView(q)) label(`${p.alt >= 0 ? 'Moonrise' : 'Moonset'} ${hm(p.d)}`, q.x, q.y - 22, { align: 'center', size: 12, weight: 700, color: '#E4F2FA' }); }
    });
    const m = proj(P.selMoon.az, P.selMoon.alt);
    if (m && inView(m)) {
      // light the side that faces the sun
      const mv = vec(P.selMoon.az, P.selMoon.alt), sv = vec(P.selSun.az, P.selSun.alt);
      const t = norm([sv[0] - dot(sv, mv) * mv[0], sv[1] - dot(sv, mv) * mv[1], sv[2] - dot(sv, mv) * mv[2]]);
      const ang = Math.atan2(-dot(t, f.up), dot(t, f.right));
      drawMoon(g, m.x, m.y, 16, P.illum.fraction, ang);
      label(`${Math.round(P.illum.fraction * 100)}%`, m.x, m.y + 28, { align: 'center', size: 11, color: '#E4F2FA' });
    }
  }
  // calibration target hint
  if (S.calibrating) {
    const t = calTarget();
    S.q('.sa-banner').querySelector('b').textContent = t ? `${Math.round(t.az)}° ${compass(t.az)}, ${Math.round(t.alt)}° up` : '';
  }
  // off-screen arrow towards the thing you're looking for
  if (S.focus) {
    const t = focusTarget();
    if (t) {
      const p = proj(t.az, t.alt);
      if (!p || !inView(p) || p.x < 0 || p.x > W || p.y < 0 || p.y > H) {
        const w = vec(t.az, t.alt);
        const ax = dot(w, f.right), ay = dot(w, f.up);
        const a = Math.atan2(-ay, ax);
        const R = Math.min(W, H) * 0.36;
        const x = cx + Math.cos(a) * R, y = cy + Math.sin(a) * R;
        g.save(); g.translate(x, y); g.rotate(a); g.fillStyle = 'rgba(244,239,231,.9)';
        g.beginPath(); g.moveTo(14, 0); g.lineTo(-8, -9); g.lineTo(-8, 9); g.closePath(); g.fill(); g.restore();
        label(S.focus === 'moon' ? 'Moon' : S.focus === 'sun' ? 'Sun' : 'Core', x, y + 20, { align: 'center', size: 12, weight: 700 });
      }
    }
  }
}
function dotAt(g, x, y, r, col) { g.save(); g.fillStyle = col; g.shadowColor = 'rgba(0,0,0,.5)'; g.shadowBlur = 4; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill(); g.restore(); }
// The moon's phase: the lit fraction, turned so the lit limb faces the sun.
function drawMoon(g, x, y, r, frac, ang) {
  g.save(); g.translate(x, y); g.rotate(ang);
  g.shadowColor = 'rgba(0,0,0,.6)'; g.shadowBlur = 8;
  g.fillStyle = 'rgba(40,46,56,.92)'; g.beginPath(); g.arc(0, 0, r, 0, Math.PI * 2); g.fill();
  g.shadowBlur = 0;
  const rx = r * (1 - 2 * frac);
  g.fillStyle = '#F2EEE4'; g.beginPath();
  g.moveTo(0, -r); g.arc(0, 0, r, -Math.PI / 2, Math.PI / 2, false);
  g.ellipse(0, 0, Math.abs(rx), r, 0, Math.PI / 2, -Math.PI / 2, rx > 0);
  g.fill();
  g.strokeStyle = 'rgba(255,255,255,.35)'; g.lineWidth = 1; g.beginPath(); g.arc(0, 0, r, 0, Math.PI * 2); g.stroke();
  g.restore();
}

/* ---------- time panel ---------- */
function updateTimeUI() {
  if (!S) return;
  const d = selTime();
  S.q('.sa-time').textContent = hhmm(d);
  S.q('.sa-date').textContent = d.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: zone || undefined });
  S.q('.sa-slider').value = S.minute;
  S.q('.sa-slider').style.setProperty('--val', `${(S.minute / (MIN_DAY - 5) * 100).toFixed(1)}%`);
  const dd = localDay(S.day); S.q('.sa-datepick').value = `${dd.getUTCFullYear()}-${String(dd.getUTCMonth() + 1).padStart(2, '0')}-${String(dd.getUTCDate()).padStart(2, '0')}`;
  if (S.lat == null || !window.SunCalc) return;
  // the night's moments, to jump to
  const SC = window.SunCalc, t0 = S.day, t1 = new Date(S.day.getTime() + 864e5);
  const ev = [];
  const T0 = SC.getTimes(t0, S.lat, S.lon), T1 = SC.getTimes(t1, S.lat, S.lon);
  const inWin = x => x instanceof Date && !isNaN(x) && x >= t0 && x < t1;
  const add = (x, l) => { if (inWin(x)) ev.push([x, l]); };
  add(T0.sunset, 'Sunset'); add(T0.night, 'Dark'); add(T1.nightEnd, 'First light'); add(T1.sunrise, 'Sunrise');
  for (const day of [t0, t1, new Date(t1.getTime() + 864e5)]) { const m = SC.getMoonTimes(day, S.lat, S.lon, true); add(m.rise, 'Moonrise'); add(m.set, 'Moonset'); }
  // core rise and its highest point in the dark
  let best = null, rise = null, prev = null;
  for (let k = 0; k <= MIN_DAY; k += 10) {
    const x = new Date(t0.getTime() + k * 60000), a = coreAt(x, S.lat, S.lon).alt;
    if (prev != null && prev < 0 && a >= 0) rise = x;
    if (SC.getPosition(x, S.lat, S.lon).altitude * R2D < -18 && (!best || a > best.a)) best = { x, a };
    prev = a;
  }
  if (rise) ev.push([rise, 'Core rises']);
  if (best && best.a > 5) ev.push([best.x, 'Core highest in the dark']);
  ev.sort((a, b) => a[0] - b[0]);
  const box = S.q('.sa-events');
  box.innerHTML = ev.map(([x, l]) => `<button class="sa-chip" data-at="${x.getTime()}">${esc(l)} <b class="num">${hhmm(x)}</b></button>`).join('');
  box.onclick = onEventChip;
}

/* ---------- calibration ---------- */
// Point the ring at the sun (or the moon), tap Set: the gap between where the compass says you're
// pointing and where the sun really is becomes the correction.
function calTarget() {
  if (S.lat == null) return null;
  const now = new Date();
  const s = sunAt(now, S.lat, S.lon); if (s.alt > 2) return { ...s, name: 'sun' };
  const m = moonAt(now, S.lat, S.lon); if (m.alt > 2) return { ...m, name: 'moon' };
  return null;
}
function calibrate() {
  if (!S.sensors) { toast('Calibration needs the phone\'s motion sensors.'); return; }
  const t = calTarget();
  if (!t) { toast('Neither the sun nor the moon is up right now, so there\'s nothing to calibrate on.', 4000); return; }
  S.calibrating = true;
  showBanner(`Point the centre ring at the ${t.name} <span class="sa-muted">(right now it's at <b></b>)</span>, then tap Set. <span class="sa-row"><button class="sa-btn primary" data-sa="setcal">Set</button>${S.corrSet ? '<button class="sa-btn" data-sa="resetcal">Clear calibration</button>' : ''}</span>`, 0, true);
  S.root.classList.add('calibrating');
}
function setCalibration() {
  const t = calTarget();
  if (!t) return;
  // pointing without the user correction, so the new correction replaces the old one
  const saved = S.userCorr; S.userCorr = 0;
  const p = pointing(cameraFrame()); S.userCorr = saved;
  const corr = ((t.az - p.az + 540) % 360) - 180;
  S.userCorr = corr; S.corrSet = true;
  try { localStorage.setItem('tidelight:arCorr', String(corr)); } catch {}
  S.calibrating = false; S.root.classList.remove('calibrating'); hideBanner();
  toast(`Calibrated: ${corr >= 0 ? '+' : ''}${corr.toFixed(1)}° on the ${t.name}.`, 3000);
}
let bannerTimer = 0;
function showBanner(html, ms = 3000, isHtml = false) {
  const b = S.q('.sa-banner'); clearTimeout(bannerTimer);
  if (isHtml) b.innerHTML = html; else b.textContent = html;
  b.hidden = false;
  if (ms) bannerTimer = setTimeout(() => { if (S) b.hidden = true; }, ms);
}
function hideBanner() { if (S) { S.q('.sa-banner').hidden = true; S.calibrating = false; S.root.classList.remove('calibrating'); } }
function focusTarget() {
  if (!S.cache) return null;
  return S.focus === 'moon' ? S.cache.selMoon : S.focus === 'sun' ? S.cache.selSun : S.focus === 'core' ? S.cache.selCore : null;
}

/* ---------- snapshot ---------- */
async function snapshot() {
  const W = innerWidth, H = innerHeight, dpr = Math.min(2, devicePixelRatio || 1);
  const c = document.createElement('canvas'); c.width = Math.round(W * dpr); c.height = Math.round(H * dpr);
  const g = c.getContext('2d');
  const v = S.video;
  if (v.videoWidth && !S.root.classList.contains('no-camera')) {
    const s = Math.max(c.width / v.videoWidth, c.height / v.videoHeight);
    g.drawImage(v, (c.width - v.videoWidth * s) / 2, (c.height - v.videoHeight * s) / 2, v.videoWidth * s, v.videoHeight * s);
  } else { const sky = g.createLinearGradient(0, 0, 0, c.height); sky.addColorStop(0, '#0B1022'); sky.addColorStop(1, '#2B3560'); g.fillStyle = sky; g.fillRect(0, 0, c.width, c.height); }
  g.drawImage(S.canvas, 0, 0, c.width, c.height);
  // a caption
  const d = selTime();
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.font = '600 13px Manrope, system-ui, sans-serif'; g.fillStyle = 'rgba(0,0,0,.45)'; g.fillRect(0, H - 34, W, 34);
  g.fillStyle = '#F4EFE7'; g.textBaseline = 'middle';
  g.fillText(`${d.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', timeZone: zone || undefined })}, ${hhmm(d)}  ·  Sky view, Tidelight`, 14, H - 17);
  const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.9));
  if (!blob) return toast('Couldn\'t take the snapshot.');
  const file = new File([blob], `sky-view-${d.toISOString().slice(0, 16).replace(':', '')}.jpg`, { type: 'image/jpeg' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) { navigator.share({ files: [file], title: 'Sky view' }).catch(() => {}); return; }
  const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = file.name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  toast('Snapshot saved.');
}
