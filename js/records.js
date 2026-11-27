// Tidelight: shoot records. For every planned shoot: what was forecast when you planned it, the last
// forecast before it, what the weather actually did, and how Tidelight's call compared with your rating.
// This is what lets the score be checked (and improved) against real shoots rather than guesswork.
import { update } from './storage.js?v=7.4.2';
import { fetchPast, fetchSignals, PAST_LIMIT_DAYS } from './api.js?v=7.4.2';
import { evaluateSpot, ratingScore, labelFor, horizonBlock, aodAt } from './scoring.js?v=7.4.2';
import { S, allEvents, freshHooks } from './core.js?v=7.4.2';

/* ---------- the calls ---------- */
// The same cut-offs as everywhere else: Go 75+, Maybe 50 to 74, Skip under 50; and for your rating,
// 7+ was worth it, 4 to 6 so-so, 3 or less not.
export const callOf = sc => (sc >= 75 ? 'go' : sc >= 50 ? 'maybe' : 'skip');
export const CALL_WORD = { go: 'Go', maybe: 'Maybe', skip: 'Skip' };
const CALL_FOR = { keeper: 'go', meh: 'maybe', dud: 'skip' };
export const isRated = p => ['keeper', 'meh', 'dud'].includes(p?.rating);
export const ratedS10 = p => ratingScore({ label: p.rating, score10: p.lightScore });
export const yourCall = p => CALL_FOR[labelFor(ratedS10(p))];
const NOT_LIGHT = new Set(['crowds', 'late', 'gear']);
export const notLightsFault = p => (p.tags || []).some(t => NOT_LIGHT.has(t));

/* ---------- weather snapshots ---------- */
const r0 = v => (v == null || isNaN(v) ? null : Math.round(v));
const r1 = v => (v == null || isNaN(v) ? null : Math.round(v * 10) / 10);
export function snap(e) {
  const h = e.hour || {};
  const out = { low: r0(h.low), mid: r0(h.mid), high: r0(h.high), precip: r1(h.precip ?? 0), pp: r0(h.pp), wind: r0(h.wind), vis: h.vis != null ? r1(h.vis / 1000) : null };
  // 7.3: the horizon, haze and humidity too, so later tuning can check those against your ratings
  const k = e.sky;
  if (k) {
    if (k.near != null) out.hzNear = r0(k.near * 100);
    if (k.far != null) out.hzFar = r0(k.far * 100);
    if (k.aod != null) out.aod = Math.round(k.aod * 100) / 100;
    if (k.clearing) out.clearing = true;
    if (k.deep != null) out.deep = k.deep;
  }
  if (h.rh != null) out.rh = r0(h.rh);
  return out;
}
// Plans made before 7.1 kept their forecast only as the scoring features: enough for cloud, rain and wind.
export function forecastOf(p) {
  if (p.fc) return p.fc;
  const f = p.features;
  if (!Array.isArray(f)) return null;
  return { low: r0(f[0] * 100), mid: r0(f[1] * 100), high: r0(f[2] * 100), precip: f[3] != null ? r1(f[3] * 2) : null, wind: f[4] != null ? r0(f[4] * 40) : null, fromFeatures: true };
}

/* ---------- while a shoot is coming up: remember the latest forecast ---------- */
function noteLatest() {
  const now = Date.now() / 1000;
  const plans = S().plans.filter(p => p.t > now && !p.rating);
  if (!plans.length) return;
  const evs = allEvents();
  const changes = [];
  for (const p of plans) {
    const e = evs.find(x => x.key === p.key) || evs.find(x => x.spot.id === p.spotId && x.type === p.type && Math.abs(x.t - p.t) < 3600);
    if (!e) continue;
    const fc = snap(e);
    if (p.last && p.last.score === e.score && JSON.stringify(p.last.fc) === JSON.stringify(fc)) continue;
    changes.push([p.id, { at: Math.round(now), score: e.score, fc }]);
  }
  if (changes.length) update(s => changes.forEach(([id, last]) => { const pl = s.plans.find(x => x.id === id); if (pl) pl.last = last; }));
}
freshHooks().push(noteLatest);

/* ---------- after a shoot: what actually happened ---------- */
// Fetched a few hours after, and once more a day later when the weather records have settled.
const HOUR = 3600;
function needsActual(p, now) {
  if (p.rating === 'skipped' || !p.t || p.t > now - 4 * HOUR || p.t < now - PAST_LIMIT_DAYS * 86400) return false;
  const a = p.actual;
  if (!a) return true;
  if (a.error) return now - a.at > 12 * HOUR;
  return !a.final && now > p.t + 24 * HOUR;
}
function spotFor(p) {
  const sp = S().spots.find(s => s.id === p.spotId);
  const colour = p.type === 'sunrise' || p.type === 'sunset';
  if (sp) return { ...sp, events: colour ? [...new Set([...(sp.events || []), p.type])] : sp.events || [] };
  // the spot's been deleted since: score it as a plain colour spot at the same place
  return { id: p.spotId || 'gone', name: p.spotName, lat: p.lat, lon: p.lon, events: colour ? [p.type] : [], hunts: p.hunt ? [p.hunt] : ['colour'] };
}
export async function actualFor(p) {
  const now = Math.round(Date.now() / 1000);
  const spot = spotFor(p);
  const data = await fetchPast(spot, p.t);
  const st = S();
  // Leave this shoot's own rating out, so the answer isn't fed into the question.
  const keepers = st.keepers.filter(k => k.planId !== p.id);
  const evs = evaluateSpot(spot, data, keepers, st.settings, { includePast: true }).filter(x => x.type === p.type);
  const e = evs.sort((a, b) => Math.abs(a.t - p.t) - Math.abs(b.t - p.t))[0];
  if (!e || Math.abs(e.t - p.t) > 3 * HOUR) throw new Error('No matching session in the weather records');
  const series = data.hours.filter(h => h.t >= p.t - 3 * HOUR && h.t <= p.t + 2 * HOUR)
    .map(h => ({ t: h.t, low: r0(h.low), mid: r0(h.mid), high: r0(h.high), precip: r1(h.precip) }));
  return { at: now, final: now > p.t + 24 * HOUR, score: e.score, fc: snap(e), series };
}
let filling = null;
// Fill in what happened for recent shoots that don't have it yet. Quiet: failures just try again later.
export function fillActuals({ max = 8 } = {}) {
  if (filling || !navigator.onLine) return filling || Promise.resolve(0);
  filling = (async () => {
    const now = Date.now() / 1000;
    const todo = S().plans.filter(p => needsActual(p, now)).sort((a, b) => b.t - a.t).slice(0, max);
    let n = 0;
    for (const p of todo) {
      let actual;
      try { actual = await actualFor(p); } catch (err) {
        if (/connection|too long/i.test(err?.message || '')) break;   // offline again: stop, try next time
        actual = { at: Math.round(now), error: true };
      }
      update(s => { const pl = s.plans.find(x => x.id === p.id); if (pl) pl.actual = actual; });
      n++;
    }
    return n;
  })().finally(() => { filling = null; });
  return filling;
}

/* ---------- sky signals: extra data around each sunrise/sunset shoot, for testing the colour score ---------- */
// Kept compact: values at the shoot hour, plus short series for the trends. r = rounded.
export function signalsFrom(sig, t, type) {
  const H = sig.H, times = H?.time || [];
  if (!times.length) throw new Error('No signal data');
  let i = 0, bd = Infinity;
  times.forEach((x, k) => { if (Math.abs(x - t) < bd) { bd = Math.abs(x - t); i = k; } });
  if (bd > 3 * HOUR) throw new Error('No signal data for that hour');
  const at = (key, k = i) => (H[key]?.[k] ?? null);
  const span = (key, from, to) => { const out = []; for (let k = i + from; k <= i + to; k++) out.push(k >= 0 && k < times.length ? r0(H[key]?.[k]) : null); return out; };
  const rh = {}; sig.levels.forEach(l => { rh[l] = r0(at(`relative_humidity_${l}hPa`)); });
  const p = at('pressure_msl'), p6 = at('pressure_msl', i - 6), p12 = at('pressure_msl', i - 12);
  const hz = horizonBlock({ horizon: sig.horizon }, type, t);
  const aod = aodAt({ air: sig.air }, t);
  return {
    v: 1, rh, rh2m: r0(at('relative_humidity_2m')),
    dp6: p != null && p6 != null ? r1(p - p6) : null, dp12: p != null && p12 != null ? r1(p - p12) : null,
    wdir: r0(at('wind_direction_10m')), wdir12: r0(at('wind_direction_10m', i - 12)), wind: r0(at('wind_speed_10m')),
    dir: span('direct_radiation', -2, 1), dif: span('diffuse_radiation', -2, 1),
    low: span('cloud_cover_low', -2, 2), mid: span('cloud_cover_mid', -2, 2), high: span('cloud_cover_high', -2, 2),
    hzNear: hz ? r0(hz.blk * 100) : null, hzFar: hz?.far != null ? r0(hz.far * 100) : null,
    aod: aod != null ? Math.round(aod * 100) / 100 : null,
  };
}
const wantsSignals = (p, now) => ['sunrise', 'sunset'].includes(p.type) && isRated(p) && !p.signals?.v && !(p.signals?.error && now - p.signals.at < 24 * HOUR)
  && p.t < now - 2 * HOUR && p.t > now - (PAST_LIMIT_DAYS - 2) * 86400;
let signalling = null;
export function fillSignals({ max = 6 } = {}) {
  if (signalling || !navigator.onLine) return signalling || Promise.resolve(0);
  signalling = (async () => {
    const now = Date.now() / 1000;
    const todo = S().plans.filter(p => wantsSignals(p, now)).sort((a, b) => b.t - a.t).slice(0, max);
    let n = 0;
    for (const p of todo) {
      let signals;
      try { signals = { ...signalsFrom(await fetchSignals(spotFor(p), p.t), p.t, p.type), at: Math.round(now) }; }
      catch (err) {
        if (/connection|too long/i.test(err?.message || '')) break;
        signals = { at: Math.round(now), error: true };
      }
      update(s => { const pl = s.plans.find(x => x.id === p.id); if (pl) pl.signals = signals; });
      n++;
    }
    return n;
  })().finally(() => { signalling = null; });
  return signalling;
}

/* ---------- the verdict ---------- */
// right: the call matched your rating. forecast: it missed, but with the weather that really came the
// score would have been right: the forecast was the problem. score: even with the real weather the
// score would still have missed: that's what tuning should learn from.
export function verdict(p) {
  if (!isRated(p) || p.score == null) return null;
  const s10 = ratedS10(p), you = yourCall(p), said = callOf(p.score);
  if (said === you) return { kind: 'right', you, said, s10 };
  const a = p.actual && !p.actual.error ? p.actual : null;
  if (!a) return { kind: 'unknown', you, said, s10 };
  const real = callOf(a.score);
  return { kind: real === you ? 'forecast' : 'score', you, said, real, s10, realScore: a.score };
}

// What changed between forecast and reality, biggest first: [{ key, label, fc, actual, words }]
const ROWS = [
  ['low', 'Low cloud', v => `${v}%`, 25], ['mid', 'Mid cloud', v => `${v}%`, 30], ['high', 'High cloud', v => `${v}%`, 30],
  ['precip', 'Rain', v => `${v} mm`, 0.5], ['wind', 'Wind', v => `${v} km/h`, 15],
];
export function weatherRows(fc, actual) {
  return ROWS.map(([key, label, fmt, big]) => {
    const f = fc?.[key], a = actual?.[key];
    const off = f != null && a != null && Math.abs(a - f) >= big;
    return { key, label, fc: f == null ? '–' : fmt(f), actual: a == null ? '–' : fmt(a), off, delta: f != null && a != null ? (a - f) / big : 0 };
  });
}
export function missWords(fc, actual) {
  const rows = weatherRows(fc, actual).filter(r => r.off).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  if (!rows.length) return '';
  const r = rows[0];
  const more = r.delta > 0;
  const word = { low: more ? 'Low cloud came in that wasn\'t forecast' : 'The forecast low cloud never came',
    mid: more ? 'More mid cloud than forecast' : 'Less mid cloud than forecast',
    high: more ? 'More high cloud than forecast' : 'The high cloud that was forecast didn\'t show',
    precip: more ? 'It rained when no rain was forecast' : 'The forecast rain held off',
    wind: more ? 'Windier than forecast' : 'Calmer than forecast' }[r.key];
  return `${word} (${r.fc} forecast, ${r.actual} actual).`;
}

/* ---------- the accuracy report ---------- */
// Over every rated shoot (not the "not the light's fault" ones): how often the call was right, why the
// misses missed, and how each kind of shoot does.
export function accuracyReport(plans = S().plans) {
  const rows = plans.filter(p => isRated(p) && p.score != null && !notLightsFault(p))
    .sort((a, b) => b.t - a.t)
    .map(p => ({ p, v: verdict(p), kind: kindOf(p) }));
  const right = rows.filter(r => r.v.kind === 'right').length;
  const why = { forecast: 0, score: 0, unknown: 0 };
  rows.forEach(r => { if (r.v.kind !== 'right') why[r.v.kind]++; });
  const kinds = {};
  rows.forEach(r => { const k = kinds[r.kind] ||= { n: 0, right: 0 }; k.n++; if (r.v.kind === 'right') k.right++; });
  // With the weather that really came: would the score itself have been right? (the formula on its own)
  const withActual = rows.filter(r => r.p.actual && !r.p.actual.error);
  const realRight = withActual.filter(r => callOf(r.p.actual.score) === r.v.you).length;
  return { n: rows.length, right, rows, why, kinds, actualN: withActual.length, realRight };
}
export const KIND_LABEL = { sunsetColour: 'Sunset colour', sunriseColour: 'Sunrise colour', fog: 'Fog', astro: 'Milky Way', storm: 'Storms', aurora: 'Aurora', day: 'Daytime', other: 'Other' };
function kindOf(p) {
  if (p.hunt === 'fog') return 'fog';
  if (p.hunt === 'astro' || p.type === 'night') return 'astro';
  if (p.hunt === 'storm' || p.hunt === 'lightning') return 'storm';
  if (p.hunt === 'aurora') return 'aurora';
  if (p.type === 'day') return 'day';
  if (p.type === 'sunset') return 'sunsetColour';
  if (p.type === 'sunrise') return 'sunriseColour';
  return 'other';
}
