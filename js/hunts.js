// Extra things to hunt for at a spot, beyond sunrise/sunset colour.
// Each scorer returns { score 0–100, factors: [{k: good|bad|neutral, t}], ...extras } or null when not applicable.
import { clamp, compass, fmtTime, angleDiff } from './util.js?v=2.8';

export const HUNT_ORDER = ['colour', 'fog', 'storm', 'lightning', 'rainbow', 'aurora', 'astro'];
export const NIGHT_HUNTS = ['aurora', 'astro'];   // scored as their own "Night" session
export const HUNT_LABEL = { colour: 'Colour', fog: 'Fog', storm: 'Storm', lightning: 'Lightning', rainbow: 'Rainbow', aurora: 'Aurora', astro: 'Milky Way' };
export const HUNT_VERB = { colour: 'colour', fog: 'fog', storm: 'storms', lightning: 'lightning', rainbow: 'a rainbow', aurora: 'aurora', astro: 'the Milky Way' };
export const huntsOf = spot => (spot.hunts && spot.hunts.length ? spot.hunts : ['colour']);

const THUNDER = c => c === 95 || c === 96 || c === 99;
const SHOWERY = c => (c >= 80 && c <= 82) || (c >= 61 && c <= 65) || THUNDER(c);

function win(hours, from, to) {
  const out = [];
  for (let i = Math.max(0, from); i <= Math.min(hours.length - 1, to); i++) out.push(hours[i]);
  return out;
}
const vals = (arr, k) => arr.map(h => h[k]).filter(v => v != null);
const avg = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const sum = a => a.reduce((x, y) => x + y, 0);

/* ---------- Fog (sunrise only): radiation fog ingredients ---------- */
export function fogScore(hours, idx, spot, elevation) {
  const h = hours[idx];
  if (h.temp == null || h.dew == null) return null;
  const night = win(hours, idx - 6, idx - 1);
  const spread = h.temp - h.dew;
  const rh = h.rh ?? 0;
  const wind = avg(vals(night, 'wind')) ?? h.wind ?? 0;
  const cloudNight = avg(vals(night, 'total')) ?? 50;
  const vis = h.vis;
  const rain24 = sum(vals(win(hours, idx - 24, idx), 'precip'));

  const s1 = clamp((3 - spread) / 3);              // dew point gap closing
  const s2 = clamp((rh - 85) / 12);                // near-saturated air
  const s3 = 1 - clamp((wind - 3) / 10);           // calm night
  const s4 = 1 - clamp((cloudNight - 30) / 60);    // clear night = ground cools
  const s5 = vis == null ? 0.3 : vis < 1000 ? 1 : vis < 5000 ? 0.6 : 0.15;
  let score = 100 * (0.3 * s1 + 0.2 * s2 + 0.2 * s3 + 0.15 * s4 + 0.15 * s5) + (rain24 > 0.5 ? 8 : 0);

  const f = [];
  if (spread <= 1.5) f.push({ k: 'good', t: `Air near saturation at dawn: only ${spread.toFixed(1)}° between temperature and dew point` });
  else if (spread >= 4) f.push({ k: 'bad', t: `Dry air at dawn: ${spread.toFixed(1)}° between temperature and dew point` });
  else f.push({ k: 'neutral', t: `Temperature ${spread.toFixed(1)}° above dew point at dawn` });
  if (wind <= 6) f.push({ k: 'good', t: 'Calm overnight, so fog can settle' });
  else if (wind >= 12) f.push({ k: 'bad', t: `Breezy overnight (${Math.round(wind)} km/h) mixes fog away` });
  if (cloudNight <= 35) f.push({ k: 'good', t: 'Clear night for the ground to cool' });
  else if (cloudNight >= 75) f.push({ k: 'bad', t: 'Cloudy night keeps the ground warm' });
  if (vis != null && vis < 1000) f.push({ k: 'good', t: `Forecast visibility ${(vis / 1000).toFixed(1)} km` });
  if (rain24 > 0.5) f.push({ k: 'good', t: 'Recent rain adds moisture' });

  if (spot.fogMode === 'above') {
    if (elevation != null && elevation < 150) {
      score *= 0.6;
      f.push({ k: 'bad', t: `Spot sits at about ${Math.round(elevation)} m, low for looking down on fog` });
    } else if (elevation != null) {
      f.push({ k: 'good', t: `Raised spot (about ${Math.round(elevation)} m) for looking down on valley fog` });
    }
    if (vis != null && vis < 1000) { score *= 0.8; f.push({ k: 'neutral', t: 'The fog may reach the lookout itself' }); }
  }
  return { score: Math.round(clamp(score, 0, 100)), factors: f, spread };
}

/* ---------- Storms: instability + trigger near the session ---------- */
function stormAt(h) {
  const c = h.cape != null ? clamp((h.cape - 200) / 1800) : 0;
  const li = h.li != null ? clamp(-h.li / 6) : c;
  const th = THUNDER(h.code) ? 1 : SHOWERY(h.code) ? 0.3 : 0;
  const cinF = h.cin != null ? 1 - 0.5 * clamp((Math.abs(h.cin) - 50) / 200) : 1;
  return clamp(0.4 * c + 0.25 * li + 0.35 * th) * cinF;
}

function stormFactors(h) {
  const f = [];
  if (h.cape != null) {
    if (h.cape >= 1000) f.push({ k: 'good', t: `Very unstable air (storm energy ${Math.round(h.cape)} J/kg)` });
    else if (h.cape >= 300) f.push({ k: 'neutral', t: `Some storm energy (${Math.round(h.cape)} J/kg)` });
    else f.push({ k: 'bad', t: 'Stable air: little fuel for storms' });
  }
  if (THUNDER(h.code)) f.push({ k: 'good', t: 'Thunderstorms in the forecast' });
  else if (SHOWERY(h.code)) f.push({ k: 'neutral', t: 'Showers forecast, storms possible' });
  if (h.gust != null && h.gust >= 50) f.push({ k: 'neutral', t: `Strong gusts to ${Math.round(h.gust)} km/h` });
  return f;
}

export function stormScore(hours, idx, type) {
  const w = type === 'sunset' ? win(hours, idx - 4, idx + 2) : win(hours, idx - 2, idx + 2);
  let best = -1, bh = null;
  for (const h of w) { const s = stormAt(h); if (s > best) { best = s; bh = h; } }
  if (!bh) return null;
  return { score: Math.round(100 * best), factors: stormFactors(bh), peak: bh.t };
}

/* ---------- Lightning: storm potential in darkness, when it's easiest to shoot ---------- */
export function lightningScore(hours, idx, type) {
  const w = type === 'sunset' ? win(hours, idx + 1, idx + 5) : win(hours, idx - 4, idx - 1);
  let best = -1, bh = null;
  for (const h of w) {
    const c = h.cape != null ? clamp((h.cape - 200) / 1800) : 0;
    const li = h.li != null ? clamp(-h.li / 6) : c;
    const s = clamp(0.55 * (THUNDER(h.code) ? 1 : 0) + 0.3 * c + 0.15 * li);
    if (s > best) { best = s; bh = h; }
  }
  if (!bh) return null;
  const f = stormFactors(bh);
  f.unshift({ k: 'neutral', t: type === 'sunset' ? 'Looks at the hours after dark' : 'Looks at the dark hours before dawn' });
  return { score: Math.round(100 * best), factors: f, peak: bh.t, from: w[0].t, to: w[w.length - 1].t };
}

/* ---------- Rainbows: showers + breaks + sun below 42° ---------- */
export function rainbowScore(hours, idx, type, spot) {
  if (!window.SunCalc) return null;
  const w = type === 'sunset' ? win(hours, idx - 3, idx) : win(hours, idx, idx + 3);
  let best = -1, bh = null, bAz = null;
  for (const h of w) {
    const pos = window.SunCalc.getPosition(new Date(h.t * 1000), spot.lat, spot.lon);
    const alt = pos.altitude * 180 / Math.PI;
    if (alt <= 0.5 || alt >= 42) continue;
    const pp = h.pp ?? 0;
    const showers = SHOWERY(h.code) ? 1 : clamp((pp - 15) / 50) * ((h.precip ?? 0) > 0.1 ? 1 : 0.6);
    const gaps = 1 - clamp(((h.total ?? 50) - 55) / 40);
    const low = 1 - clamp(((h.low ?? 0) - 60) / 40);
    const s = showers * gaps * low;
    if (s > best) { best = s; bh = h; bAz = (pos.azimuth * 180 / Math.PI + 180 + 360) % 360; }
  }
  if (!bh) return { score: 0, factors: [{ k: 'bad', t: 'Sun is too high or below the horizon for a rainbow then' }] };
  const look = (bAz + 180) % 360;
  const f = [];
  if (SHOWERY(bh.code) || (bh.pp ?? 0) >= 35) f.push({ k: 'good', t: 'Showers about' }); else f.push({ k: 'bad', t: 'Not much rain around' });
  if ((bh.total ?? 50) <= 80) f.push({ k: 'good', t: 'Breaks in the cloud for the sun' }); else f.push({ k: 'bad', t: 'Too much cloud for the sun to break through' });
  f.push({ k: 'neutral', t: `Look ${compass(look)} (${Math.round(look)}°), with the sun behind you` });
  return { score: Math.round(100 * best), factors: f, peak: bh.t, look };
}

/* ---------- combine ---------- */
export function computeHunts({ spot, data, idx, type, colour }) {
  const sel = huntsOf(spot);
  const out = {};
  if (sel.includes('colour')) out.colour = colour;
  if (sel.includes('fog') && type === 'sunrise') { const r = fogScore(data.hours, idx, spot, data.elevation); if (r) out.fog = r; }
  if (sel.includes('storm')) { const r = stormScore(data.hours, idx, type); if (r) out.storm = r; }
  if (sel.includes('lightning')) { const r = lightningScore(data.hours, idx, type); if (r) out.lightning = r; }
  if (sel.includes('rainbow')) { const r = rainbowScore(data.hours, idx, type, spot); if (r) out.rainbow = r; }
  return out;
}

/* =================== Night hunts =================== */

const RAD = Math.PI / 180;
let KP = [];                                   // [{ t, kp }] from NOAA SWPC
export function setKp(list) { KP = Array.isArray(list) ? list : []; }
export const hasKp = () => KP.length > 0;
function kpAt(t) {
  for (const r of KP) if (t >= r.t && t < r.t + 3 * 3600) return r.kp;
  return null;
}

// Geomagnetic latitude using a dipole approximation (north geomagnetic pole ~80.8°N, 72.7°W).
export function geomagLat(lat, lon) {
  const pl = 80.8 * RAD, pn = -72.7 * RAD, p = lat * RAD, l = lon * RAD;
  return Math.asin(Math.sin(p) * Math.sin(pl) + Math.cos(p) * Math.cos(pl) * Math.cos(l - pn)) / RAD;
}
// Rough Kp needed for a camera to catch aurora low on the horizon.
// Calibrated so Melbourne (~45° geomagnetic) needs about Kp 5.5 and Hobart (~49.5°) about Kp 4.
export function kpNeeded(lat, lon) {
  return Math.min(9, Math.max(1, 5.5 - 0.3125 * (Math.abs(geomagLat(lat, lon)) - 44.7)));
}

function sunAlt(t, spot) { return window.SunCalc.getPosition(new Date(t * 1000), spot.lat, spot.lon).altitude / RAD; }
function moonInfo(t, spot) {
  const d = new Date(t * 1000);
  const alt = window.SunCalc.getMoonPosition(d, spot.lat, spot.lon).altitude / RAD;
  const frac = window.SunCalc.getMoonIllumination(d).fraction;
  return { alt, frac, up: alt > 0 };
}

export function auroraScore(hours, i0, i1, spot, offset) {
  if (!window.SunCalc) return null;
  if (!KP.length) return { score: 0, factors: [{ k: 'neutral', t: 'Aurora forecast unavailable right now (NOAA space weather feed)' }] };
  const need = kpNeeded(spot.lat, spot.lon);
  const south = spot.lat < 0;
  let best = -1, bh = null, bkp = null, bmoon = null, maxKp = 0;
  for (let i = i0; i <= i1; i++) {
    const h = hours[i];
    if (!h || sunAlt(h.t, spot) > -12) continue;
    const kp = kpAt(h.t);
    if (kp == null) continue;
    maxKp = Math.max(maxKp, kp);
    const sKp = clamp((kp - need + 1.5) / 2.5);
    const clear = 1 - clamp(((h.total ?? 50) - 20) / 70);
    const m = moonInfo(h.t, spot);
    const s = sKp * clear * (m.up ? 1 - 0.3 * m.frac : 1);
    if (s > best) { best = s; bh = h; bkp = kp; bmoon = m; }
  }
  if (!bh) return { score: 0, factors: [{ k: 'neutral', t: 'No aurora forecast for these dark hours yet' }] };
  const f = [];
  f.push(bkp >= need ? { k: 'good', t: `Kp forecast ${bkp.toFixed(1)} around ${fmtTime(bh.t, offset)}: enough for your latitude (about Kp ${need.toFixed(1)}+ needed here)` }
    : { k: 'bad', t: `Kp forecast peaks at ${maxKp.toFixed(1)}; this spot needs about ${need.toFixed(1)}+ for a camera to pick it up` });
  const cl = bh.total ?? 50;
  f.push(cl <= 30 ? { k: 'good', t: 'Mostly clear skies' } : cl >= 70 ? { k: 'bad', t: `Cloudy (${Math.round(cl)}%)` } : { k: 'neutral', t: `Some cloud (${Math.round(cl)}%)` });
  if (bmoon.up && bmoon.frac > 0.5) f.push({ k: 'bad', t: `Bright moon up (${Math.round(bmoon.frac * 100)}% lit)` });
  f.push({ k: 'neutral', t: `Look ${south ? 'south' : 'north'}, low over the horizon. Cameras see it before your eyes do.` });
  return { score: Math.round(100 * best), factors: f, peak: bh.t, kp: bkp, need };
}

// Galactic centre (RA 266.417°, Dec −29.008°): altitude and azimuth for a time and place.
export function coreAltAz(t, lat, lon) {
  const jd = t / 86400 + 2440587.5, D = jd - 2451545.0;
  let gmst = (18.697374558 + 24.06570982441908 * D) % 24; if (gmst < 0) gmst += 24;
  const ha = (((gmst * 15 + lon - 266.417) % 360) + 360) % 360 * RAD;
  const p = lat * RAD, d = -29.008 * RAD;
  const alt = Math.asin(Math.sin(p) * Math.sin(d) + Math.cos(p) * Math.cos(d) * Math.cos(ha));
  const az = Math.atan2(Math.sin(ha), Math.cos(ha) * Math.sin(p) - Math.tan(d) * Math.cos(p));
  return { alt: alt / RAD, az: (az / RAD + 180 + 360) % 360 };
}

export function astroScore(hours, i0, i1, spot, offset) {
  if (!window.SunCalc) return null;
  let best = -1, bh = null, bcore = null, bmoon = null, anyCore = false;
  for (let i = i0; i <= i1; i++) {
    const h = hours[i];
    if (!h) continue;
    const sa = sunAlt(h.t, spot);
    const dark = sa < -18 ? 1 : sa < -15 ? 0.5 : 0;
    if (!dark) continue;
    const core = coreAltAz(h.t, spot.lat, spot.lon);
    if (core.alt > 5) anyCore = true;
    const m = moonInfo(h.t, spot);
    const clear = 1 - clamp(((h.total ?? 50) - 15) / 60);
    const s = dark * clamp((core.alt - 5) / 20) * (m.up ? 1 - 0.85 * m.frac : 1) * clear;
    if (s > best) { best = s; bh = h; bcore = core; bmoon = m; }
  }
  if (!bh || !anyCore) return { score: 0, factors: [{ k: 'bad', t: "The Milky Way core isn't up during dark hours at this time of year" }] };
  const f = [];
  f.push({ k: bcore.alt >= 15 ? 'good' : 'neutral', t: `Core ${Math.round(bcore.alt)}° up in the ${compass(bcore.az)} (${Math.round(bcore.az)}°) around ${fmtTime(bh.t, offset)}` });
  f.push(!bmoon.up ? { k: 'good', t: 'Moon is down' } : bmoon.frac > 0.4 ? { k: 'bad', t: `Moon up and ${Math.round(bmoon.frac * 100)}% lit` } : { k: 'neutral', t: `Thin moon up (${Math.round(bmoon.frac * 100)}% lit)` });
  const cl = bh.total ?? 50;
  f.push(cl <= 20 ? { k: 'good', t: 'Clear skies' } : cl >= 60 ? { k: 'bad', t: `Cloudy (${Math.round(cl)}%)` } : { k: 'neutral', t: `Some cloud (${Math.round(cl)}%)` });
  let alignment = null;
  if (spot.facing !== '' && spot.facing != null && !isNaN(Number(spot.facing))) {
    const diff = angleDiff(bcore.az, Number(spot.facing));
    alignment = { diff, text: `Core sits ${Math.round(diff)}° from where you face` };
    f.push({ k: diff <= 30 ? 'good' : 'neutral', t: alignment.text });
  }
  return { score: Math.round(100 * best), factors: f, peak: bh.t, core: bcore, moon: bmoon, alignment };
}

export function computeNightHunts({ spot, data, i0, i1 }) {
  const sel = huntsOf(spot), out = {};
  if (sel.includes('aurora')) { const r = auroraScore(data.hours, i0, i1, spot, data.offset); if (r) out.aurora = r; }
  if (sel.includes('astro')) { const r = astroScore(data.hours, i0, i1, spot, data.offset); if (r) out.astro = r; }
  return out;
}
