// Tidelight: big seas (7.5). Rare, powerful swells at coastal spots, measured against the spot's own
// wave history, so "a top-6 swell" means one of the six biggest in a typical year *here*.
// Shared with the alerts function (bundled by tools/build-alerts.mjs), so keep it free of the DOM.
import { fetchSeasForecast, fetchSeasHistory } from './api.js?v=7.5.2';
import { fmtTime, fmtDay } from './util.js?v=7.5.2';

export const SEAS_TOPS = [3, 6, 12];
export const SEAS_DEFAULT_TOP = 6;
const rad = d => (d * Math.PI) / 180;
const r1 = v => Math.round(v * 10) / 10;
const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
export const compass16 = deg => (deg == null || isNaN(deg) ? '' : COMPASS[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16]);
export const COMPASS_NAME = { N: 'north', NNE: 'north-north-east', NE: 'north-east', ENE: 'east-north-east', E: 'east', ESE: 'east-south-east', SE: 'south-east', SSE: 'south-south-east', S: 'south', SSW: 'south-south-west', SW: 'south-west', WSW: 'west-south-west', W: 'west', WNW: 'west-north-west', NW: 'north-west', NNW: 'north-north-west' };

// Wave power along the coast, kW per metre: about 0.49 × height² × period. Height counts most, but a
// long-period swell carries far more energy than a short, choppy sea of the same height.
export const powerOf = (h, T) => (h == null || T == null ? null : 0.49 * h * h * T);
// How square-on the waves hit a coast that faces `facing` (the bearing it looks out to sea; wave
// directions are where they come from). Straight in counts in full; side-on still counts a little.
export function aimOf(dir, facing) {
  if (dir == null || facing == null || facing === '') return 1;
  const d = Math.abs(((dir - facing + 540) % 360) - 180);
  return Math.max(0.15, Math.cos(rad(Math.min(d, 90))));
}
function circMean(degs) {
  let x = 0, y = 0;
  degs.filter(d => d != null).forEach(d => { x += Math.cos(rad(d)); y += Math.sin(rad(d)); });
  return x === 0 && y === 0 ? null : ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}
// Each day's biggest hour.
function dailyPeaks(H, facing) {
  const byDay = new Map();
  H.times.forEach((t, i) => {
    const p = powerOf(H.h[i], H.T[i]);
    if (p == null) return;
    const pe = p * aimOf(H.dir[i], facing);
    const k = Math.floor((t + (H.offset || 0)) / 86400);
    const cur = byDay.get(k);
    if (!cur || pe > cur.p) byDay.set(k, { t, p: pe, raw: p, h: H.h[i], T: H.T[i], dir: H.dir[i] });
  });
  return [...byDay.values()];
}
// Separate storms: biggest day first, and nothing within 3 days of one already counted.
function stormsOf(days) {
  const out = [];
  for (const d of [...days].sort((a, b) => b.p - a.p)) if (!out.some(o => Math.abs(o.t - d.t) < 3 * 86400)) out.push(d);
  return out;
}

// From the wave history: the coast's facing (yours, or where its biggest swells come from), and the
// ladder of its biggest storms, enough for the top 12 a year.
export function climateFrom(H, { facing = null, top = SEAS_DEFAULT_TOP } = {}) {
  const rawDays = dailyPeaks(H, null);
  if (rawDays.length < 300) throw new Error('Not enough wave records here to judge what\'s rare.');
  const years = rawDays.length / 365.25;
  const biggest = stormsOf(rawDays).slice(0, Math.max(8, Math.round(6 * years)));
  const autoFacing = circMean(biggest.map(d => d.dir));
  const face = facing === '' || facing == null ? autoFacing : Number(facing);
  const storms = stormsOf(dailyPeaks(H, face)).slice(0, Math.round(12 * years) + 1);
  return {
    v: 1, at: Math.round(Date.now() / 1000), years: r1(years), facing: Math.round(face), autoFacing: Math.round(autoFacing), auto: facing === '' || facing == null, top,
    storms: storms.map(d => ({ t: d.t, h: r1(d.h), T: Math.round(d.T), dir: Math.round(d.dir), p: Math.round(d.p) })),
  };
}
// The power a swell needs to be in the spot's top N a year.
export function thresholdOf(clim, top = clim?.top ?? SEAS_DEFAULT_TOP) {
  if (!clim?.storms?.length) return null;
  const k = Math.max(1, Math.round(top * clim.years));
  return clim.storms[Math.min(k, clim.storms.length) - 1].p;
}
// "#2": where a swell of power p would sit in a typical year at this spot.
export function rankOf(clim, p) {
  const bigger = clim.storms.filter(s => s.p > p).length;
  return { bigger, perYear: Math.floor(bigger / clim.years) + 1 };
}
export function rankText(clim, p) {
  const r = rankOf(clim, p);
  const yrs = Math.round(clim.years);
  return r.bigger === 0 ? `Bigger than any swell here in ${yrs} years` : `About #${r.perYear} of a typical year (${r.bigger} bigger in ${yrs} years)`;
}
export const seasOn = spot => !!(spot?.coastal && spot.seas?.on);
export const seasReady = spot => seasOn(spot) && !!spot.seas.clim?.storms?.length;

const ymdOf = (t, off) => new Date((t + off) * 1000).toISOString().slice(0, 10);
// Light for shooting: civil dawn to civil dusk, on the spot's local day (SunCalc wants local noon).
const noonOf = (t, off) => Math.floor((t + off) / 86400) * 86400 - off + 12 * 3600;
function sunDay(spot, t, off) {
  const S = window.SunCalc;
  if (!S) return null;
  const tm = S.getTimes(new Date(noonOf(t, off) * 1000), spot.lat, spot.lon);
  const dawn = tm.dawn?.getTime() / 1000, dusk = tm.dusk?.getTime() / 1000;
  return isNaN(dawn) || isNaN(dusk) ? null : { dawn, dusk };
}
function lightAt(spot, t, off) {
  const d = sunDay(spot, t, off);
  return !d || (t >= d.dawn && t <= d.dusk);
}
// The first light after a dark peak: the same morning if it's before dawn, else the next.
function firstLightAfter(spot, t, off) {
  const d = sunDay(spot, t, off);
  if (!d) return null;
  return t < d.dawn ? d.dawn : sunDay(spot, t + 86400, off)?.dawn ?? null;
}
// Local high tides (peaks of the sea level) between a and b.
function highTides(fc, a, b) {
  const out = [];
  for (let i = 1; i < fc.times.length - 1; i++) {
    const s0 = fc.sea[i - 1], s1 = fc.sea[i], s2 = fc.sea[i + 1];
    if (s0 == null || s1 == null || s2 == null) continue;
    if (s1 >= s0 && s1 > s2 && fc.times[i] >= a && fc.times[i] <= b) {
      // refine between the hours with a parabola through the three points
      const den = s0 - 2 * s1 + s2, f = den ? 0.5 * (s0 - s2) / den : 0;
      out.push(Math.round(fc.times[i] + f * 3600));
    }
  }
  return out;
}

// The outlook for one spot: every hour's power, each day's peak, and the days that make the cut.
// hours: optional main-forecast hours (for wind). Returns { thr, days: [...], events: [...] }.
export function seasOutlook(spot, fc, { now = Date.now() / 1000, hours = null } = {}) {
  const clim = spot.seas?.clim;
  const thr = thresholdOf(clim, spot.seas?.top ?? SEAS_DEFAULT_TOP);
  if (!thr) return null;
  const facing = clim.facing;
  const off = fc.offset || 0;
  const hrs = fc.times.map((t, i) => {
    const raw = powerOf(fc.h[i], fc.T[i]);
    return { t, h: fc.h[i], T: fc.T[i], dir: fc.dir[i], p: raw == null ? null : raw * aimOf(fc.dir[i], facing) };
  }).filter(x => x.p != null);
  const byDay = new Map();
  for (const x of hrs) {
    if (x.t < now - 6 * 3600) continue;
    const k = ymdOf(x.t, off);
    const d = byDay.get(k) || { ymd: k, peak: null, hours: [] };
    d.hours.push(x);
    if (!d.peak || x.p > d.peak.p) d.peak = x;
    byDay.set(k, d);
  }
  const days = [...byDay.values()].map(d => ({ ymd: d.ymd, t: d.peak.t, p: Math.round(d.peak.p), ratio: d.peak.p / thr, h: d.peak.h, T: d.peak.T, dir: d.peak.dir }));
  const events = [];
  for (const d of byDay.values()) {
    const pk = d.peak;
    if (pk.p < thr || pk.t < now - 3 * 3600) continue;
    // The best hour you can shoot: the peak if it's light, else the biggest light hour within 14 hours of it.
    const lit = hrs.filter(x => Math.abs(x.t - pk.t) <= 14 * 3600 && x.t > now && lightAt(spot, x.t, off));
    const best = lightAt(spot, pk.t, off) ? pk : lit.sort((a, b) => b.p - a.p)[0] || null;
    const night = !lightAt(spot, pk.t, off);
    const fl = night ? firstLightAfter(spot, pk.t, off) : null;
    const atFirst = fl && fl <= hrs[hrs.length - 1].t ? hrs.reduce((m, x) => (Math.abs(x.t - fl) < Math.abs((m?.t ?? Infinity) - fl) ? x : m), null) : null;
    // The big hours: everything above the line, for "peak 2–5pm".
    const big = d.hours.filter(x => x.p >= thr * 0.92).map(x => x.t);
    const tide = best ? highTides(fc, best.t - 4 * 3600, best.t + 4 * 3600).sort((a, b) => Math.abs(a - best.t) - Math.abs(b - best.t))[0] ?? null : null;
    const wh = hours && best ? hours.reduce((m, x) => (Math.abs(x.t - best.t) < Math.abs((m?.t ?? Infinity) - best.t) ? x : m), null) : null;
    events.push({
      key: `${spot.id}:${d.ymd}`, spot, ymd: d.ymd, offset: off,
      t: pk.t, p: Math.round(pk.p), ratio: pk.p / thr, h: pk.h, T: pk.T, dir: pk.dir,
      from: Math.min(...big), to: Math.max(...big),
      night, best: best ? { t: best.t, p: Math.round(best.p), share: best.p / pk.p, above: best.p >= thr, h: best.h, T: best.T } : null,
      firstLight: atFirst ? { t: fl, p: Math.round(atFirst.p), share: atFirst.p / pk.p, above: atFirst.p >= thr, h: atFirst.h } : null,
      tide, wind: wh?.wind ?? null, rank: rankOf(clim, pk.p), rankText: rankText(clim, pk.p),
    });
  }
  events.sort((a, b) => a.t - b.t);
  return { thr: Math.round(thr), days, events, clim, offset: off };
}

// Plain words for an event, used on the card and in the alerts.
export function seasWhen(e) {
  const o = e.offset;
  const span = e.to - e.from >= 2 * 3600 ? `${fmtTime(e.from, o)}–${fmtTime(e.to, o)}` : fmtTime(e.t, o);
  return `${fmtDay(e.t, o)}, peak ${span}`;
}
export function seasSwell(e) {
  return `${(+e.h).toFixed(1)} m at ${Math.round(e.T)} s from the ${compass16(e.dir)}`;
}
export function seasLightLine(e) {
  if (!e.night) return '';
  const o = e.offset;
  if (e.firstLight) {
    const fl = e.firstLight;
    return fl.above
      ? `Peaks in the dark around ${fmtTime(e.t, o)}. At first light (${fmtTime(fl.t, o)}) it's still ${Math.round(fl.share * 100)}% of the peak: still a big-seas morning.`
      : `Peaks in the dark around ${fmtTime(e.t, o)}. By first light (${fmtTime(fl.t, o)}) it's eased to ${Math.round(fl.share * 100)}% of the peak: still big, but past its best.`;
  }
  if (e.best) return `Peaks after dark around ${fmtTime(e.t, o)}. The best light hour is ${fmtTime(e.best.t, o)}, at ${Math.round(e.best.share * 100)}% of the peak.`;
  return `Peaks in the dark around ${fmtTime(e.t, o)}.`;
}
export function seasNotes(e) {
  const o = e.offset, out = [];
  out.push({ k: 'good', t: e.ratio >= 1.3 ? 'Well above this spot\'s top swells, a standout' : 'A swell that makes this spot\'s top few of the year' });
  if (e.T >= 14) out.push({ k: 'good', t: `Long-period swell (${Math.round(e.T)} s), with more power behind every wave` });
  if (e.tide && e.best && Math.abs(e.tide - e.best.t) <= 2 * 3600) out.push({ k: 'good', t: 'High tide lands in the big hours, putting more water against the cliffs' });
  if (e.wind != null && e.wind >= 35) out.push({ k: 'neutral', t: `Strong wind (${Math.round(e.wind)} km/h) means big spray, so shield the lens` });
  return out;
}

// Everything the forecast page and alerts need for the spots with big seas on.
export async function seasForSpots(spots, opts = {}) {
  const out = [];
  for (const sp of spots.filter(seasReady)) {
    try { out.push({ spot: sp, ...seasOutlook(sp, await fetchSeasForecast(sp), { ...opts, hours: opts.hoursFor?.(sp) || null }) }); }
    catch (err) { out.push({ spot: sp, error: err?.message || 'No wave forecast' }); }
  }
  return out;
}
// Read the history and work out what's rare at this spot. facing: '' for automatic.
export async function buildClimate(spot) {
  const H = await fetchSeasHistory(spot);
  return climateFrom(H, { facing: spot.seas?.facing ?? '', top: spot.seas?.top ?? SEAS_DEFAULT_TOP });
}
