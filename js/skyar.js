// Sky view: the live camera with the sun's path, the moon's path and phase, and the Milky Way drawn
// over it, at any time you scrub to. Uses the camera, the motion sensors and the compass; without
// them (a computer, or sensors refused) you drag to look around a drawn sky instead.
import { esc, fmtTime, toast, getPosition, compass } from './util.js?v=7.1';

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
const coreAt = (d, lat, lon) => raDecToAltAz(CORE.ra, CORE.dec, d, lat, lon);

// Magnetic declination, roughly, from reference points around Australia and New Zealand (degrees east).
// Calibrating on the sun or moon replaces this with a measured correction.
const DECL = [[-31.95, 115.86, -0.9], [-34.93, 138.6, 8.0], [-37.81, 144.96, 11.7], [-33.87, 151.21, 12.9], [-27.47, 153.03, 11.2],
  [-42.88, 147.33, 15.5], [-12.46, 130.84, 3.9], [-16.92, 145.77, 7.6], [-23.7, 133.88, 5.2], [-35.28, 149.13, 12.4],
  [-36.85, 174.76, 20.0], [-43.53, 172.63, 24.0], [-20.73, 139.49, 6.6], [-19.26, 146.82, 8.0], [-38.15, 144.36, 11.4]];
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
  S = {
    root, q, video: q('.sa-video'), canvas: q('.sa-canvas'), ctx: q('.sa-canvas').getContext('2d'),
    lat: opts.lat ?? null, lon: opts.lon ?? null, place: opts.name || null,
    layers: { sun: true, moon: true, mw: true, grid: true, ...(opts.layers || {}) },
    focus: opts.focus || null,          // 'moon' | 'sun' | 'core': open looking for it
    fov: Number(localStorage.getItem('tidelight:arFov')) || LENS_FOV,
    day: dayStart(start), minute: minuteOfWindow(start),
    basis: null, smooth: null, sensors: false, absolute: false, compassOffset: null, untrustedFrames: 0, jumpFrames: 0,
    manual: { az: 180, alt: 15 }, decl: 0, userCorr: Number(localStorage.getItem('tidelight:arCorr')) || 0, corrSet: !!localStorage.getItem('tidelight:arCorr'),
    calibrating: false, raf: 0, stream: null, cache: null, listeners: [],
  };
  // layers & lens
  root.querySelectorAll('[data-layer]').forEach(cb => { cb.checked = S.layers[cb.dataset.layer]; cb.onchange = () => { S.layers[cb.dataset.layer] = cb.checked; }; });
  const fovIn = q('[data-fov]'); fovIn.value = S.fov; q('[data-fovv]').textContent = S.fov;
  fovIn.oninput = () => { S.fov = Number(fovIn.value); q('[data-fovv]').textContent = S.fov; try { localStorage.setItem('tidelight:arFov', S.fov); } catch {} };
  root.addEventListener('click', onClick);
  const sl = q('.sa-slider');
  sl.value = S.minute;
  sl.oninput = () => { S.minute = Number(sl.value); S.cache = null; updateTimeUI(); };
  q('.sa-datepick').onchange = e => { const [y, m, d] = e.target.value.split('-').map(Number); if (y) { S.day = new Date(y, m - 1, d, 12); S.cache = null; updateTimeUI(); } };
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

function dayStart(d) { const x = new Date(d); if (x.getHours() < 12) x.setDate(x.getDate() - 1); x.setHours(12, 0, 0, 0); return x; }   // the night's window runs noon to noon
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
  const hm = d => fmtTime(d.getTime() / 1000, -d.getTimezoneOffset() * 60).replace(':00', '');

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
    const band = P.band.map(b => (b.alt > -5 ? proj(b.az, b.alt) : null));
    line(band, 'rgba(190,200,255,.10)', 54);
    line(band, 'rgba(210,215,255,.16)', 22);
    line(band, 'rgba(225,228,255,.35)', 1.5, [2, 5]);
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
  S.q('.sa-time').textContent = fmtTime(d.getTime() / 1000, -d.getTimezoneOffset() * 60);
  S.q('.sa-date').textContent = d.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  S.q('.sa-slider').value = S.minute;
  S.q('.sa-slider').style.setProperty('--val', `${(S.minute / (MIN_DAY - 5) * 100).toFixed(1)}%`);
  const dd = new Date(S.day); S.q('.sa-datepick').value = `${dd.getFullYear()}-${String(dd.getMonth() + 1).padStart(2, '0')}-${String(dd.getDate()).padStart(2, '0')}`;
  if (S.lat == null || !window.SunCalc) return;
  // the night's moments, to jump to
  const SC = window.SunCalc, t0 = S.day, t1 = new Date(S.day.getTime() + 864e5);
  const ev = [];
  const T0 = SC.getTimes(t0, S.lat, S.lon), T1 = SC.getTimes(t1, S.lat, S.lon);
  const inWin = x => x instanceof Date && !isNaN(x) && x >= t0 && x < t1;
  const add = (x, l) => { if (inWin(x)) ev.push([x, l]); };
  add(T0.sunset, 'Sunset'); add(T0.night, 'Dark'); add(T1.nightEnd, 'First light'); add(T1.sunrise, 'Sunrise');
  for (const day of [t0, t1]) { const m = SC.getMoonTimes(day, S.lat, S.lon); add(m.rise, 'Moonrise'); add(m.set, 'Moonset'); }
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
  box.innerHTML = ev.map(([x, l]) => `<button class="sa-chip" data-at="${x.getTime()}">${esc(l)} <b class="num">${fmtTime(x.getTime() / 1000, -x.getTimezoneOffset() * 60)}</b></button>`).join('');
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
  g.fillText(`${d.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' })}, ${fmtTime(d.getTime() / 1000, -d.getTimezoneOffset() * 60)}  ·  Sky view, Tidelight`, 14, H - 17);
  const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.9));
  if (!blob) return toast('Couldn\'t take the snapshot.');
  const file = new File([blob], `sky-view-${d.toISOString().slice(0, 16).replace(':', '')}.jpg`, { type: 'image/jpeg' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) { navigator.share({ files: [file], title: 'Sky view' }).catch(() => {}); return; }
  const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = file.name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  toast('Snapshot saved.');
}
