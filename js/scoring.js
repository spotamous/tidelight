import { clamp, haversineKm, angleDiff, compass } from './util.js?v=1.8';

/* ---------- helpers ---------- */

export function nearestIndex(hours, t) {
  let best = -1, bd = Infinity;
  for (let i = 0; i < hours.length; i++) {
    const d = Math.abs(hours[i].t - t);
    if (d < bd) { bd = d; best = i; }
  }
  return bd <= 5400 ? best : -1;
}

// Where the tide sits (0 = low, 1 = high) within the surrounding ±12h, plus the nearest turns.
export function tideInfo(hours, idx) {
  if (idx < 0 || hours[idx]?.sea == null) return null;
  const lo = Math.max(0, idx - 12), hi = Math.min(hours.length - 1, idx + 12);
  const vals = [];
  for (let i = lo; i <= hi; i++) if (hours[i].sea != null) vals.push(hours[i].sea);
  if (vals.length < 10) return null;
  const min = Math.min(...vals), max = Math.max(...vals);
  if (max - min < 0.05) return null; // effectively no tide here
  const pos = (hours[idx].sea - min) / (max - min);

  let low = null, high = null;
  const t0 = hours[idx].t;
  for (let i = Math.max(1, idx - 7); i <= Math.min(hours.length - 2, idx + 7); i++) {
    const a = hours[i - 1].sea, b = hours[i].sea, c = hours[i + 1].sea;
    if (a == null || b == null || c == null) continue;
    if (b <= a && b < c && (!low || Math.abs(hours[i].t - t0) < Math.abs(low.t - t0))) low = { t: hours[i].t, v: b };
    if (b >= a && b > c && (!high || Math.abs(hours[i].t - t0) < Math.abs(high.t - t0))) high = { t: hours[i].t, v: b };
  }
  const next = hours[idx + 1]?.sea;
  return { pos, range: max - min, height: hours[idx].sea, low, high, rising: next != null ? next > hours[idx].sea : null };
}

/* ---------- feature vector: what the personal model compares ---------- */

export const FEATURE_NAMES = ['Low cloud', 'Mid cloud', 'High cloud', 'Rain', 'Wind', 'Tide height', 'Wave height'];

export function featureVector(h, tide) {
  return [
    (h.low ?? 0) / 100,
    (h.mid ?? 0) / 100,
    (h.high ?? 0) / 100,
    clamp((h.precip ?? 0) / 2),
    clamp((h.wind ?? 0) / 40),
    tide ? tide.pos : null,
    h.wave != null ? clamp(h.wave / 3) : null,
  ];
}

/* ---------- base score: physics-ish rules any photographer would agree with ---------- */

export function baseScore(h, tide, spot) {
  const factors = [];
  const low = h.low ?? 0, mid = h.mid ?? 0, high = h.high ?? 0;

  // Upper cloud is the canvas that catches colour. Too little = clean but plain; too much = muted.
  const canvasCover = Math.min(100, 0.7 * mid + 0.9 * high);
  const canvas = 0.35 + 0.65 * (1 - Math.abs(canvasCover - 50) / 50);
  if (canvasCover < 15) factors.push({ k: 'neutral', t: 'Mostly clear upper sky: clean light, but little colour in the clouds' });
  else if (canvasCover <= 75) factors.push({ k: 'good', t: `Good canvas: about ${Math.round(canvasCover)}% mid/high cloud to catch colour` });
  else factors.push({ k: 'bad', t: 'Heavy upper cloud may mute the colour' });

  // Low cloud on the horizon blocks the light from reaching the canvas.
  const block = 1 - 0.8 * (low / 100);
  if (low >= 60) factors.push({ k: 'bad', t: `Low cloud ${Math.round(low)}%: the horizon is likely blocked` });
  else if (low <= 20) factors.push({ k: 'good', t: 'Clear horizon for the light to come through' });

  const pp = h.pp ?? (h.precip > 0.2 ? 60 : 0);
  const rain = 1 - 0.6 * clamp(pp / 100);
  if (pp >= 50) factors.push({ k: 'bad', t: `Rain likely (${Math.round(pp)}%)` });
  else if (pp >= 25) factors.push({ k: 'neutral', t: `Some chance of showers (${Math.round(pp)}%), which can mean dramatic light` });

  let vis = 1;
  if (h.vis != null && h.vis < 2000) {
    vis = 0.7;
    factors.push({ k: 'neutral', t: `Fog or mist possible (visibility ${(h.vis / 1000).toFixed(1)} km): moody rather than colourful` });
  }

  let tideF = 1;
  if (spot.coastal && spot.tide !== 'any' && tide) {
    const match = spot.tide === 'low' ? 1 - tide.pos : spot.tide === 'high' ? tide.pos : 1 - 2 * Math.abs(tide.pos - 0.5);
    tideF = 0.6 + 0.4 * match;
    if (match >= 0.7) factors.push({ k: 'good', t: `Tide suits this spot (${spot.tide} tide wanted)` });
    else if (match <= 0.35) factors.push({ k: 'bad', t: `Wrong tide for this spot (you want ${spot.tide})` });
  }

  const wind = h.wind ?? 0;
  const windF = 1 - 0.3 * clamp(wind / 60);
  if (wind >= 30) factors.push({ k: 'bad', t: `Strong wind (${Math.round(wind)} km/h): tripod shake and choppy water` });
  else if (wind <= 10) factors.push({ k: 'good', t: 'Light wind, good for long exposures' });

  const score = 100 * canvas * block * rain * vis * tideF * windF;
  return { score: Math.round(score), factors };
}

/* ---------- personal model: learns from your keepers and duds ---------- */

export function similarity(a, b) {
  let s = 0, n = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] == null || b[i] == null) continue;
    s += (a[i] - b[i]) ** 2; n++;
  }
  if (!n) return 0;
  const d2 = s / n;
  return Math.exp(-d2 / (2 * 0.15 * 0.15));
}

const avg = arr => arr.length ? arr.reduce((x, y) => x + y, 0) / arr.length : 0;
const topK = (f, list, k = 3) => list.map(x => similarity(f, x.features)).sort((a, b) => b - a).slice(0, k);

export const MIN_KEEPERS = 3;

export function personalScore(f, keepers) {
  const good = keepers.filter(k => k.label === 'keeper' && k.features);
  const bad = keepers.filter(k => k.label === 'dud' && k.features);
  if (good.length < MIN_KEEPERS) return null;
  const g = avg(topK(f, good));
  const b = bad.length ? avg(topK(f, bad)) : 0;
  return {
    score: Math.round(100 * clamp(g - 0.5 * b)),
    weight: Math.min(0.6, good.length * 0.06),
    n: good.length,
  };
}

export function personalModelSummary(keepers) {
  const good = keepers.filter(k => k.label === 'keeper' && k.features);
  if (!good.length) return null;
  const mean = i => {
    const v = good.map(k => k.features[i]).filter(x => x != null);
    return v.length ? avg(v) : null;
  };
  const [low, mid, high, rain, wind, tide, wave] = FEATURE_NAMES.map((_, i) => mean(i));
  const out = [];
  if (low != null) out.push(low < 0.25 ? 'clear horizons' : low > 0.55 ? 'heavy low cloud and moody skies' : 'some low cloud');
  if (mid != null && high != null) {
    const upper = Math.round(Math.min(100, (0.7 * mid + 0.9 * high) * 100));
    out.push(`about ${upper}% mid/high cloud`);
  }
  if (rain != null && rain > 0.15) out.push('showery, dramatic weather');
  if (wind != null) out.push(wind < 0.3 ? 'light wind' : wind > 0.6 ? 'windy, energetic conditions' : 'moderate wind');
  if (tide != null) out.push(tide < 0.35 ? 'lower tides' : tide > 0.65 ? 'higher tides' : 'mid tides');
  if (wave != null) out.push(wave < 0.27 ? 'calm seas' : wave > 0.55 ? 'big surf' : 'moderate swell');
  return { n: good.length, text: out.join(', ') };
}

/* ---------- events ---------- */

let sunReady = false;
function ensureSunCalc() {
  if (!sunReady && window.SunCalc) {
    window.SunCalc.addTime(-4, 'blueHourEndAM', 'blueHourStartPM');
    sunReady = true;
  }
}
const secs = d => (d instanceof Date && !isNaN(d)) ? d.getTime() / 1000 : null;

export function driveMinutes(spot, settings) {
  if (spot.driveMin) return Number(spot.driveMin);
  if (!settings.home) return null;
  const km = haversineKm(settings.home, spot) * 1.3; // roads aren't straight
  return Math.round(km / (settings.driveSpeedKmh || 60) * 60);
}

export function evaluateEvent({ spot, data, type, t, keepers, settings }) {
  const idx = nearestIndex(data.hours, t);
  if (idx < 0) return null;
  const h = data.hours[idx];
  const tide = spot.coastal ? tideInfo(data.hours, idx) : null;
  const base = baseScore(h, tide, spot);
  const features = featureVector(h, tide);
  const personal = personalScore(features, keepers);

  let score = base.score;
  if (personal) score = Math.round((1 - personal.weight) * base.score + personal.weight * personal.score);

  const drive = driveMinutes(spot, settings);
  const arrive = Number(settings.arriveBeforeMin ?? 30);
  const leave = t - (arrive + (drive || 0)) * 60;

  let light = {}, sunAz = null, alignment = null;
  ensureSunCalc();
  if (window.SunCalc) {
    const at = new Date(t * 1000);
    const times = window.SunCalc.getTimes(at, spot.lat, spot.lon);
    const pos = window.SunCalc.getPosition(at, spot.lat, spot.lon);
    sunAz = (pos.azimuth * 180 / Math.PI + 180 + 360) % 360;
    light = type === 'sunrise'
      ? { blueStart: secs(times.dawn), blueEnd: secs(times.blueHourEndAM), goldenStart: secs(times.sunrise), goldenEnd: secs(times.goldenHourEnd) }
      : { goldenStart: secs(times.goldenHour), goldenEnd: secs(times.sunset), blueStart: secs(times.blueHourStartPM), blueEnd: secs(times.dusk) };
    if (spot.facing !== '' && spot.facing != null && !isNaN(Number(spot.facing))) {
      const diff = angleDiff(sunAz, Number(spot.facing));
      alignment = { diff, text: `Sun ${type === 'sunrise' ? 'rises' : 'sets'} at ${Math.round(sunAz)}° ${compass(sunAz)}, ${Math.round(diff)}° from where you face` };
    }
  }

  return {
    key: `${spot.id}:${type}:${t}`,
    spot, type, t, offset: data.offset, idx, hour: h, tide,
    base: base.score, personal, score, factors: base.factors,
    features, drive, leave, light, sunAz, alignment,
  };
}

export function evaluateSpot(spot, data, keepers, settings, { includePast = false } = {}) {
  const now = Date.now() / 1000;
  const out = [];
  for (const d of data.days) {
    for (const type of spot.events || []) {
      const t = type === 'sunrise' ? d.sunrise : d.sunset;
      if (!t) continue;
      if (!includePast && t < now - 600) continue;
      const ev = evaluateEvent({ spot, data, type, t, keepers, settings });
      if (ev) out.push(ev);
    }
  }
  return out.sort((a, b) => a.t - b.t);
}
