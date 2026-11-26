import { clamp, haversineKm, angleDiff, compass } from './util.js?v=7.4';
import { computeHunts, computeNightHunts, computeDayHunts, huntsOf, NIGHT_HUNTS, DAY_HUNTS, HUNT_LABEL } from './hunts.js?v=7.4';

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

/* ---------- tide access window (rock shelves, caves, sandbars) ---------- */
// Open while the tide is below `frac` of its range; "back by" leaves `bufferMin` before it closes.
export function accessWindow(hours, idx, t, frac, bufferMin) {
  if (idx < 0 || hours[idx]?.sea == null) return null;
  const lo = Math.max(0, idx - 12), hi = Math.min(hours.length - 1, idx + 12);
  const vals = [];
  for (let i = lo; i <= hi; i++) if (hours[i].sea != null) vals.push(hours[i].sea);
  if (vals.length < 10) return null;
  const min = Math.min(...vals), max = Math.max(...vals);
  if (max - min < 0.05) return null;
  const level = min + frac * (max - min);
  const below = i => hours[i].sea != null && hours[i].sea <= level;
  const cross = i => { const a = hours[i], b = hours[i + 1]; return a.t + (level - a.sea) / (b.sea - a.sea) * (b.t - a.t); };
  const wins = [];
  for (let i = lo; i <= hi; i++) {
    if (!below(i)) continue;
    let j = i; while (j + 1 <= hi && below(j + 1)) j++;
    wins.push({ start: i > lo && hours[i - 1].sea != null ? cross(i - 1) : hours[i].t, end: j < hi && hours[j + 1].sea != null ? cross(j) : hours[j].t, openStart: i === lo, openEnd: j === hi });
    i = j;
  }
  if (!wins.length) return { none: true, inside: false };
  const dist = w => (t < w.start ? w.start - t : t > w.end ? t - w.end : 0);
  const w = wins.sort((a, b) => dist(a) - dist(b))[0];
  const backBy = w.end - (bufferMin || 0) * 60;
  return { start: w.start, end: w.end, backBy, inside: t >= w.start && t <= backBy, openStart: w.openStart, openEnd: w.openEnd };
}

/* ---------- feature vector: what the personal model compares ---------- */

export const FEATURE_NAMES = ['Low cloud', 'Mid cloud', 'High cloud', 'Rain', 'Wind', 'Tide height', 'Wave height', 'Dew point gap', 'Storm energy', 'Thunder'];

export function featureVector(h, tide) {
  return [
    (h.low ?? 0) / 100,
    (h.mid ?? 0) / 100,
    (h.high ?? 0) / 100,
    clamp((h.precip ?? 0) / 2),
    clamp((h.wind ?? 0) / 40),
    tide ? tide.pos : null,
    h.wave != null ? clamp(h.wave / 3) : null,
    h.temp != null && h.dew != null ? clamp((h.temp - h.dew) / 10) : null,   // small = fog-prone
    h.cape != null ? clamp(h.cape / 2500) : null,                            // storm fuel
    h.code != null ? ([95, 96, 99].includes(h.code) ? 1 : 0) : null,         // thunder
  ];
}

/* ---------- base score: physics-ish rules any photographer would agree with ---------- */

// The colour of a sunrise or sunset, from the cloud, rain and air (7.3). Shared by the live score and by
// the fair tests on saved sessions, so both always use the same rules. x: { low, mid, high, precip, pp,
// wind, vis (m), rh, aod }; o: { floor, lowK, windK, near, far, clearing } (near/far: horizon cloud 0–1).
// What it's built on (NOAA's Corfidi, the Sunsethue model, and Tyson's rated shoots):
//  - Mid and high cloud is the canvas. High cloud (cirrus) is thin, so even a full sheet of it lights up:
//    more canvas never hurts. A full mid-level deck only lights from underneath, through a gap towards the
//    sun, and two thick layers on top of each other block it.
//  - The light that paints cloud overhead comes from far away: for high cloud it skims the earth 300 km or
//    more towards the sun. Cloud out there decides whether the canvas lights up at all.
//  - A shower near the time is fine (often the best skies, especially as rain clears). Steady rain isn't.
//  - Clean air gives vivid colour; smoke, haze and very humid air mute it.
export function colourCore(x, o = {}) {
  const low = x.low ?? 0, mid = x.mid ?? 0, high = x.high ?? 0, floor = o.floor ?? 0.35;
  const cover = 1 - (1 - 0.95 * high / 100) * (1 - 0.9 * mid / 100);   // share of the sky with canvas
  const fill = Math.pow(clamp(cover / 0.6), 0.6);
  // A full mid deck needs a gap towards the sun; unknown counts as an even chance.
  const gap = o.far == null ? 0.45 : clamp((0.75 - o.far) / 0.5);
  const deck = 0.45 * clamp((mid - 65) / 35) * (1 - gap);
  const thick = 0.45 * clamp((Math.min(mid, high) - 55) / 45);
  const canvas = (floor + (1 - floor) * fill) * (1 - deck) * (1 - thick);
  // Low cloud overhead: a little is fine (it can colour too), a lid of it hides everything.
  const block = 1 - (o.lowK ?? 0.9) * Math.pow(clamp((low - 10) / 90), 1.15);
  // Rain: how much is forecast in the hour matters far more than the chance of a shower.
  const pp = x.pp ?? (x.precip > 0.2 ? 60 : 0);
  let rain = (1 - 0.45 * clamp((x.precip ?? 0) / 2)) * (1 - 0.15 * clamp(pp / 100));
  if (o.clearing) rain = Math.max(rain, 0.92);
  const vis = x.vis != null && x.vis < 2000 ? 0.7 : 1;
  const wind = x.wind ?? 0;
  const windF = o.windK ? 1 - o.windK * clamp(wind / 40) : 1 - 0.3 * clamp(wind / 60);
  // Cloud on the near horizon (60–120 km) hides the sun as it sets; out at 200–350 km it stops the light
  // reaching the canvas overhead (that matters more the more canvas there is).
  const nearF = o.near == null ? 1 : 1 - 0.55 * clamp((o.near - 0.35) / 0.5);
  // (7.4: softened. Rated shoots showed it often lights anyway, through gaps the model can't see.)
  const farF = o.far == null ? 1 : 1 - 0.22 * fill * clamp((o.far - 0.45) / 0.45);
  // A deep moist column (humid at two or more of 600, 500, 400 and 300 hPa, roughly 4–9 km): thick cloud
  // the light struggles through, however thin the high-cloud number looks. (7.4, from rated shoots)
  const deepF = x.deep == null ? 1 : 1 - 0.4 * clamp((x.deep - 1) / 2);
  const aodF = x.aod == null ? 1 : 1 - 0.45 * clamp((x.aod - 0.3) / 0.7);
  const rhF = x.rh == null ? 1 : 1 - 0.12 * clamp((x.rh - 85) / 15);
  const lift = o.clearing ? 1.1 : 1;
  const score = clamp(canvas * block * rain * vis * windF * nearF * farF * deepF * aodF * rhF * lift) * 100;
  return { score, cover, fill, canvas, deck, thick, block, rain, pp, vis, windF, nearF, farF, deepF, aodF, rhF };
}

export function baseScore(h, tide, spot, ctx = {}) {
  const factors = [];
  const low = h.low ?? 0, mid = h.mid ?? 0, high = h.high ?? 0;
  const near = ctx.horizon ? ctx.horizon.blk : null, far = ctx.horizon?.far ?? null;
  const floor = ctx.canvasFloor ?? 0.35;
  const c = colourCore({ ...h, aod: ctx.aod ?? null, deep: ctx.deep ?? null }, { floor, lowK: ctx.lowK, windK: ctx.windK, near, far, clearing: ctx.clearing });
  const coverPct = Math.round(c.cover * 100);

  // The canvas
  if (c.cover < 0.12 && floor > 0.35) factors.push({ k: 'good', t: 'Clean light suits this spot: clear-sky sessions here have delivered for you' });
  else if (c.cover < 0.12) factors.push({ k: 'neutral', t: 'Mostly clear upper sky: clean light, but little cloud to catch colour' });
  else if (c.thick >= 0.15) factors.push({ k: 'bad', t: 'Thick mid and high cloud stacked together: the light may not get through' });
  else if (c.deck >= 0.12) factors.push({ k: 'neutral', t: `A full mid-level deck (${Math.round(mid)}%): it only lights up if there's a gap towards the ${ctx.horizon?.kind || 'sun'}` });
  else if (high >= 60 && mid < 50) factors.push({ k: 'good', t: `High cloud (${Math.round(high)}%): thin cirrus that catches the best colour` });
  else factors.push({ k: 'good', t: `Good canvas: about ${coverPct}% of the sky with mid/high cloud to catch colour` });
  if (c.deck >= 0.12 && far != null && far < 0.35) factors.push({ k: 'good', t: `Clear far out towards the ${ctx.horizon.kind}: the light can get under the deck and light it from below` });

  if (ctx.deep >= 2 && c.fill > 0.3) factors.push({ k: 'bad', t: 'Moist air from about 4 to 9 km up: a thick cloud layer the light may not get through' });
  if (low >= 60) factors.push({ k: 'bad', t: `Low cloud ${Math.round(low)}%: the sky is likely blocked` });
  else if (low <= 20) factors.push({ k: 'good', t: 'Little low cloud overhead' });

  if (ctx.clearing) factors.unshift({ k: 'good', t: 'Rain clearing around the light: often the most dramatic skies of all' });
  else if ((h.precip ?? 0) >= 0.8) factors.push({ k: 'bad', t: `Steady rain forecast (${(+h.precip).toFixed(1)} mm in the hour)` });
  else if (c.pp >= 50) factors.push({ k: 'neutral', t: `Showers about (${Math.round(c.pp)}%): risky, but showery skies often light up` });

  if (c.vis < 1) factors.push({ k: 'neutral', t: `Fog or mist possible (visibility ${(h.vis / 1000).toFixed(1)} km): moody rather than colourful` });

  let tideF = 1;
  if (spot.coastal && spot.tide !== 'any' && tide) {
    const match = spot.tide === 'low' ? 1 - tide.pos : spot.tide === 'high' ? tide.pos : 1 - 2 * Math.abs(tide.pos - 0.5);
    tideF = 0.6 + 0.4 * match;
    if (match >= 0.7) factors.push({ k: 'good', t: `Tide suits this spot (${spot.tide} tide wanted)` });
    else if (match <= 0.35) factors.push({ k: 'bad', t: `Wrong tide for this spot (you want ${spot.tide})` });
  }

  const wind = h.wind ?? 0;
  if (wind >= 30) factors.push({ k: 'bad', t: `Strong wind (${Math.round(wind)} km/h): tripod shake and choppy water` });
  else if (wind <= 10) factors.push({ k: 'good', t: 'Light wind, good for long exposures' });

  if (ctx.horizon) {
    const where = `towards the ${ctx.horizon.kind} (${ctx.horizon.dir})`;
    if (near >= 0.7) factors.unshift({ k: 'bad', t: `Cloud bank on the horizon ${where}: it may hide the sun as it ${ctx.horizon.kind === 'sunrise' ? 'rises' : 'sets'}` });
    else if (near >= 0.45) factors.push({ k: 'neutral', t: `Some cloud on the horizon ${where}` });
    else factors.push({ k: 'good', t: `Clear horizon ${where}` });
    if (far != null && far >= 0.7 && c.fill > 0.3) factors.unshift({ k: 'bad', t: `Thick cloud 200–350 km ${where}: it can stop the light reaching the clouds overhead` });
  }
  if (ctx.aod != null && ctx.aod >= 0.4) factors.push({ k: 'bad', t: `Smoke or haze in the air: colours may be muted (the sun itself can glow red)` });
  else if (ctx.aod != null && ctx.aod <= 0.12 && c.fill > 0.3) factors.push({ k: 'good', t: 'Clean, clear air: colours should be crisp' });

  const score = c.score * tideF;
  // Each factor as 0–100, for the "why" bars.
  const pct = x => Math.round(clamp(x) * 100);
  const parts = [
    { label: 'Cloud canvas', value: pct((c.canvas - 0.35) / 0.65), note: `${coverPct}% of the sky with mid/high cloud${c.deck >= 0.12 ? ', a full mid deck' : ''}${floor > 0.35 ? '; this spot shines in clean light' : ''}` },
    { label: 'Low cloud', value: pct(c.block), note: `${Math.round(low)}% low cloud overhead` },
  ];
  if (ctx.horizon) parts.push({ label: 'Horizon', value: pct(c.nearF), note: `Towards the ${ctx.horizon.kind} (${ctx.horizon.dir})` });
  if (far != null) parts.push({ label: 'Light path', value: pct(1 - clamp((far - 0.25) / 0.6)), note: `Cloud 200–350 km towards the ${ctx.horizon.kind}` });
  parts.push({ label: 'Rain', value: pct(c.rain), note: ctx.clearing ? 'Clearing' : `${(+(h.precip ?? 0)).toFixed(1)} mm, ${Math.round(c.pp)}% chance` });
  if (ctx.aod != null || h.rh != null) parts.push({ label: 'Air', value: pct(c.aodF * c.rhF), note: [ctx.aod != null ? (ctx.aod >= 0.4 ? 'smoky or hazy' : ctx.aod <= 0.12 ? 'clean air' : 'light haze') : '', h.rh != null ? `${Math.round(h.rh)}% humidity` : ''].filter(Boolean).join(', ') });
  if (ctx.deep != null) parts.push({ label: 'Cloud depth', value: pct(c.deepF), note: ctx.deep >= 2 ? 'Moist from about 4 to 9 km: thick' : 'No deep moist layer' });
  if (c.vis < 1) parts.push({ label: 'Visibility', value: pct(c.vis), note: 'Fog or mist' });
  if (spot.coastal && spot.tide !== 'any' && tide) parts.push({ label: 'Tide', value: pct((tideF - 0.6) / 0.4), note: `${Math.round(tide.pos * 100)}% of range, ${spot.tide} wanted` });
  parts.push({ label: 'Wind', value: pct((c.windF - 0.7) / 0.3), note: `${Math.round(wind)} km/h` });
  return { score: Math.round(score), factors, parts };
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

/* ---------- learning each spot's light from your ratings ----------
   Feature vector: [low, mid, high, precip/2, wind/40, tide, wave/3, (temp−dew)/10, cape/2500, thunder].
   Some spots shine in clean, clear light (light on rock, sand or a landform is the picture); others need
   cloud overhead to catch colour. A spot earns a "clean light" boost only when its clear-sky sessions
   have actually been keepers, more often than they've been misses. */
const canvasOf = f => Math.min(100, 0.7 * (f[1] ?? 0) * 100 + 0.9 * (f[2] ?? 0) * 100);
const isClean = f => canvasOf(f) < 25 && (f[0] ?? 0) < 0.3;
const isFoggy = f => f.length > 7 && f[7] != null && f[7] < 0.05 && (f[0] ?? 0) >= 0.8;
export const CLEAN_FLOOR = 0.8;

// Rating tags. "Not the light's fault" sessions never teach the score; fog, storm and rainbow keepers
// were made by another hunt, so they don't teach the colour score.
export const RATING_TAGS = {
  made: [['colour', 'Colour in the clouds'], ['landscape', 'Light on the landscape'], ['fog', 'Fog or mist'], ['storm', 'Storm light'], ['rainbow', 'A rainbow']],
  spoiled: [['horizon', 'Cloud blocked the horizon'], ['rain', 'Rained out'], ['wind', 'Too windy'], ['tide', 'Wrong tide'], ['plain', 'Clear and plain']],
  notLight: [['crowds', 'Crowds'], ['late', 'I was late or out of position'], ['gear', 'Gear trouble']],
};
const NOT_LIGHT = new Set(RATING_TAGS.notLight.map(([k]) => k));
const OTHER_HUNT = new Set(['fog', 'storm', 'rainbow']);
// A rating as 0–10: the slider value, or the old three-way rating (delivered 8, so-so 5, not worth it 2).
export const ratingScore = r => (typeof r?.score10 === 'number' ? r.score10 : typeof r?.lightScore === 'number' ? r.lightScore : ({ keeper: 8, meh: 5, dud: 2 })[r?.label ?? r?.rating] ?? null);
export const labelFor = s10 => (s10 >= 7 ? 'keeper' : s10 >= 4 ? 'meh' : 'dud');

// Ratings that can teach a spot's colour score: sunrise/sunset (or photos), not fog mornings, no duplicates.
export function colourRatings(keepers, spot) {
  const seen = new Set();
  return keepers.filter(k => {
    if (!k.features || !['keeper', 'meh', 'dud'].includes(k.label)) return false;
    if (k.type && !['sunrise', 'sunset'].includes(k.type)) return false;
    if (k.hunt && k.hunt !== 'colour') return false;
    if (isFoggy(k.features)) return false;
    const tags = k.tags || [];
    if (tags.some(t => NOT_LIGHT.has(t))) return false;                                        // not the light's fault
    if (tags.some(t => OTHER_HUNT.has(t)) && !tags.includes('colour') && ratingScore(k) >= 6) return false;   // made by fog, storm or a rainbow
    if (spot) {
      const near = k.spotId ? k.spotId === spot.id : (k.lat != null ? haversineKm({ lat: k.lat, lon: k.lon }, spot) <= 1 : k.spotName === spot.name);
      if (!near) return false;
    }
    const sig = `${k.spotId || k.spotName}|${k.features.map(x => (x == null ? '' : x.toFixed(3))).join(',')}`;
    if (seen.has(sig)) return false;
    seen.add(sig);
    return true;
  });
}

// The colour-score floor for a spot: your own setting wins; otherwise learned from ratings (if learning is on).
export function spotFloor(spot, keepers = [], settings = {}) {
  const off = settings.tuning === false;
  const mine = off ? [] : colourRatings(keepers, spot);
  // Repeated complaints at a spot make it more sensitive to that factor (two or more tagged sessions).
  const tagged = t => keepers.filter(k => (k.tags || []).includes(t) && (k.spotId ? k.spotId === spot.id : k.lat != null ? haversineKm({ lat: k.lat, lon: k.lon }, spot) <= 1 : k.spotName === spot.name)).length;
  const windTags = off ? 0 : tagged('wind'), horizonTags = off ? 0 : tagged('horizon');
  const extra = { windK: windTags >= 2 ? 0.55 : undefined, lowK: horizonTags >= 2 ? 0.95 : undefined, windTags, horizonTags };
  if (spot.cleanLight === 'yes') return { floor: CLEAN_FLOOR, source: 'yours', ...extra };
  if (spot.cleanLight === 'no') return { floor: 0.35, source: 'yours', ...extra };
  if (off) return { floor: 0.35, source: 'off' };
  // Clear-sky evidence, weighted by how good or bad each session was (a 10 counts for more than a 7).
  // "Light on the landscape" counts as a clean-light success; "clear and plain" as a clean-light miss.
  let k = 0, d = 0, kn = 0, dn = 0;
  for (const r of mine) {
    const s10 = ratingScore(r), tags = r.tags || [];
    const cleanSky = isClean(r.features) || (tags.includes('landscape') && canvasOf(r.features) < 40) || tags.includes('plain');
    if (!cleanSky || s10 == null) continue;
    if (s10 >= 7 || (tags.includes('landscape') && s10 >= 6)) { k += 1 + Math.max(0, s10 - 8) / 2; kn++; }
    else if (s10 <= 4 || tags.includes('plain')) { d += 1 + Math.max(0, 2 - s10) / 2; dn++; }
  }
  const base = { source: 'learned', k: kn, d: dn, n: mine.length, ...extra };
  if (kn < 2 || k <= d) return { floor: 0.35, ...base };
  return { floor: Math.min(0.85, 0.35 + 0.6 * (k - d) / (k + d + 1)), ...base };
}

// A quick colour score from a saved feature vector (used to compare the standard and tuned rules fairly).
export function colourFromFeatures(f, floor = 0.35, k = {}) {
  const x = { low: (f[0] ?? 0) * 100, mid: (f[1] ?? 0) * 100, high: (f[2] ?? 0) * 100, precip: (f[3] ?? 0) * 2, wind: (f[4] ?? 0) * 40 };
  return Math.round(colourCore(x, { floor, lowK: k.lowK, windK: k.windK }).score);
}

// Fair test: score each rated session with what was learned from all the *other* sessions.
export function tuningReport(keepers, spots, settings = {}) {
  const band = sc => (sc >= 75 ? 'keeper' : sc >= 50 ? 'meh' : 'dud');
  const yours = r => labelFor(ratingScore(r));
  const rows = [];
  for (const sp of spots) for (const r of colourRatings(keepers, sp)) rows.push({ r, sp });
  const tally = { n: rows.length, std: { right: 0, keepGo: 0, dudGo: 0, dudSkip: 0, gap: 0 }, tuned: { right: 0, keepGo: 0, dudGo: 0, dudSkip: 0, gap: 0 }, keepers: 0, duds: 0, items: [] };
  for (const { r, sp } of rows) {
    const others = keepers.filter(k => k !== r);
    const t2 = spotFloor({ ...sp, cleanLight: sp.cleanLight === 'yes' || sp.cleanLight === 'no' ? sp.cleanLight : undefined }, others, settings);
    const s0 = colourFromFeatures(r.features), s1 = colourFromFeatures(r.features, t2.floor, t2);
    const lab = yours(r), s10 = ratingScore(r);
    for (const [key, sc] of [['std', s0], ['tuned', s1]]) {
      if (band(sc) === lab) tally[key].right++;
      if (lab === 'keeper' && sc >= 75) tally[key].keepGo++;
      if (lab === 'dud' && sc >= 75) tally[key].dudGo++;
      if (lab === 'dud' && sc < 50) tally[key].dudSkip++;
      tally[key].gap += Math.abs(sc - s10 * 10);
    }
    if (lab === 'keeper') tally.keepers++;
    if (lab === 'dud') tally.duds++;
    tally.items.push({ rating: r, spot: sp, standard: s0, tuned: s1 });
  }
  for (const key of ['std', 'tuned']) tally[key].gap = rows.length ? Math.round(tally[key].gap / rows.length) : 0;
  return tally;
}


export function personalScore(f, keepers) {
  const good = keepers.filter(k => k.label === 'keeper' && k.features);
  const bad = keepers.filter(k => k.label === 'dud' && k.features);
  if (good.length < MIN_KEEPERS) return null;
  const meh = keepers.filter(k => k.label === 'meh' && k.features);
  const g = avg(topK(f, good));
  const b = bad.length ? avg(topK(f, bad)) : 0;
  const m = meh.length ? avg(topK(f, meh)) : 0;
  // So-so sessions pull the score towards the middle when today looks like them.
  let p = clamp(g - 0.5 * b);
  p = p + (0.5 - p) * 0.5 * m;
  return {
    score: Math.round(100 * clamp(p)),
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
  const [low, mid, high, rain, wind, tide, wave, gap, cape, thunder] = FEATURE_NAMES.map((_, i) => mean(i));
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
  if (gap != null && gap < 0.2) out.push('fog-prone, humid mornings');
  if ((cape != null && cape > 0.3) || (thunder != null && thunder > 0.3)) out.push('stormy, unstable skies');
  return { n: good.length, text: out.join(', ') };
}

/* ---------- events ---------- */

/* ---------- horizon and model-agreement helpers ---------- */
const timeIndex = (obj, times) => obj._idx || (obj._idx = new Map(times.map((t, i) => [t, i])));

// How blocked the horizon towards the sun is at time t (0 clear … 1 solid). blk: the near horizon, from points
// 60 and 120 km out; far: 200 and 350 km out, where the light that paints the clouds overhead comes from.
export function horizonBlock(data, type, t) {
  const hz = data.horizon?.[type];
  if (!hz || !hz.points?.length) return null;
  let near = null, far = null;
  for (const p of hz.points) {
    const i = nearestIndex(p.times.map(x => ({ t: x })), t);   // nearest hour (works in half-hour time zones too)
    if (i == null || i < 0 || p.low?.[i] == null) continue;
    const blk = clamp(((p.low[i] ?? 0) + 0.6 * (p.mid?.[i] ?? 0)) / 100);
    if ((p.km ?? 60) > 150) far = far == null ? blk : Math.max(far, blk);
    else near = near == null ? blk : Math.max(near, blk);
  }
  if (near == null && far == null) return null;
  return { blk: near ?? far, far, dir: compass(hz.az), kind: type };
}

// Rain clearing around the light: rain in the hours before (or a shower now) that's gone in the next hour.
export function clearingAt(hours, idx) {
  const h = hours[idx], next = hours[idx + 1];
  if (!h || !next) return false;
  const before = Math.max(0, ...hours.slice(Math.max(0, idx - 3), idx).map(x => x.precip ?? 0));
  return (before >= 0.4 || (h.precip ?? 0) >= 0.3) && (next.precip ?? 0) <= 0.1 && (h.low ?? 0) < 60 && (next.low ?? 0) < 60;
}

// How deep the moist layer is at time t: of 600, 500, 400 and 300 hPa, how many are 75%+ humid.
export function deepAt(data, t) {
  const L = data.levels;
  if (!L?.times?.length) return null;
  let i = -1, bd = Infinity;
  L.times.forEach((x, k) => { if (Math.abs(x - t) < bd) { bd = Math.abs(x - t); i = k; } });
  if (bd > 3 * 3600) return null;
  const vals = [600, 500, 400, 300].map(l => L.rh[l]?.[i]);
  if (vals.some(v => v == null)) return null;
  return vals.filter(v => v >= 75).length;
}

// Smoke and haze (aerosol optical depth) at time t, when the air-quality forecast is in.
export function aodAt(data, t) {
  const A = data.air;
  if (!A?.times?.length) return null;
  let best = null, bd = Infinity;
  A.times.forEach((x, i) => { const v = A.aod[i]; if (v != null && Math.abs(x - t) < bd) { bd = Math.abs(x - t); best = v; } });
  return bd <= 3 * 3600 ? best : null;
}

// Score the same hour with each weather model's cloud; the spread is the confidence.
export function modelConfidence(data, idx, h, tide, spot, ctx) {
  const M = data.models;
  if (!M || !M.models?.length) return null;
  const i = timeIndex(M, M.times).get(h.t);
  if (i == null) return null;
  const scores = [];
  for (const m of M.models) {
    if (m.low[i] == null || m.mid[i] == null || m.high[i] == null) continue;
    scores.push({ model: m.model, score: baseScore({ ...h, low: m.low[i], mid: m.mid[i], high: m.high[i] }, tide, spot, ctx).score });
  }
  if (scores.length < 2) return null;
  const vals = scores.map(x => x.score);
  const spread = Math.max(...vals) - Math.min(...vals);
  return { level: spread <= 15 ? 'high' : spread <= 30 ? 'medium' : 'low', spread, min: Math.min(...vals), max: Math.max(...vals), scores };
}

let sunReady = false;
function ensureSunCalc() {
  if (!sunReady && window.SunCalc) {
    window.SunCalc.addTime(-4, 'blueHourEndAM', 'blueHourStartPM');
    sunReady = true;
  }
}
const secs = d => (d instanceof Date && !isNaN(d)) ? d.getTime() / 1000 : null;

// Walking speeds used to estimate a hike when only distance is known (km/h, allowing for terrain and stops).
export const HIKE_SPEED = { easy: 4, moderate: 3.3, hard: 2.6, 'very hard': 2 };
export const DIFFICULTIES = ['easy', 'moderate', 'hard', 'very hard'];

export function hikeMinutes(spot) {
  if (spot.hikeMin) return Number(spot.hikeMin);
  if (spot.hikeKm) return Math.round(Number(spot.hikeKm) / (HIKE_SPEED[spot.difficulty] || HIKE_SPEED.moderate) * 60);
  return 0;
}
export const hikeIsEstimate = spot => !spot.hikeMin && !!spot.hikeKm;

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
  const hz = horizonBlock(data, type, t);
  const tune = spotFloor(spot, keepers, settings);
  const aod = aodAt(data, t), clearing = clearingAt(data.hours, idx), deep = deepAt(data, t);
  const ctx = { ...(hz ? { horizon: hz } : {}), canvasFloor: tune.floor, lowK: tune.lowK, windK: tune.windK, aod, clearing, deep };
  const base = baseScore(h, tide, spot, ctx);
  const confidence = modelConfidence(data, idx, h, tide, spot, ctx);
  if (confidence) {
    if (confidence.level === 'low') {
      if (base.score > 50) base.score = Math.round(50 + (base.score - 50) * 0.8);   // don't oversell a coin toss
      base.factors.push({ k: 'bad', t: `Weather models disagree on the cloud (they range ${confidence.min}–${confidence.max}): treat it as a maybe` });
    } else if (confidence.level === 'high') {
      base.factors.push({ k: 'good', t: 'Weather models agree on the cloud' });
    }
  }
  const features = featureVector(h, tide);
  const personal = personalScore(features, keepers);

  // Each hunt chosen for this spot gets its own score; the session's score is the best of them.
  const hunts = computeHunts({ spot, data, idx, type, colour: { score: base.score, factors: base.factors, parts: base.parts } });
  let topHunt = null, top = -1;
  for (const [k, v] of Object.entries(hunts)) if (v && v.score > top) { top = v.score; topHunt = k; }
  if (!topHunt) { topHunt = 'colour'; top = base.score; hunts.colour = { score: base.score, factors: base.factors, parts: base.parts }; }

  let score = top;
  if (personal) score = Math.round((1 - personal.weight) * top + personal.weight * personal.score);

  const drive = driveMinutes(spot, settings);
  const hike = hikeMinutes(spot);
  const arrive = Number(settings.arriveBeforeMin ?? 30);
  const leave = t - (arrive + (drive || 0) + hike) * 60;
  const walkStart = hike ? t - (arrive + hike) * 60 : null;   // park up and start walking

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

  const access = spot.coastal && spot.tideAccess
    ? accessWindow(data.hours, idx, t, (Number(spot.accessPct) || 40) / 100, Number(spot.accessBuffer ?? 30)) : null;

  return {
    key: `${spot.id}:${type}:${t}`, access, confidence, sky: { near: hz ? hz.blk : null, far: hz?.far ?? null, aod, clearing, deep },
    spot, type, t, offset: data.offset, idx, hour: h, tide,
    base: top, colour: base.score, hunts, topHunt, personal, score, factors: hunts[topHunt]?.factors || base.factors,
    features, drive, hike, walkStart, leave, light, sunAz, alignment,
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
  if (huntsOf(spot).some(k => DAY_HUNTS.includes(k))) {
    for (let d = 0; d < data.days.length; d++) {
      const ev = evaluateDay({ spot, data, d, keepers, settings });
      if (ev && (includePast || data.days[d].sunset > now)) out.push(ev);
    }
  }
  if (huntsOf(spot).some(k => NIGHT_HUNTS.includes(k))) {
    for (let d = 0; d < data.days.length - 1; d++) {
      const ev = evaluateNight({ spot, data, d, keepers, settings });
      if (ev && (includePast || data.days[d + 1].sunrise > now)) out.push(ev);
    }
  }
  return out.sort((a, b) => (a.dayT ?? a.t) - (b.dayT ?? b.t) || a.t - b.t);
}

// A "Night" session: from sunset on day d to sunrise on day d+1, timed to the best hour.
export function evaluateNight({ spot, data, d, keepers, settings }) {
  const sunset = data.days[d]?.sunset, sunrise = data.days[d + 1]?.sunrise;
  if (!sunset || !sunrise || !window.SunCalc) return null;
  const i0 = nearestIndex(data.hours, sunset), i1 = nearestIndex(data.hours, sunrise);
  if (i0 < 0 || i1 < 0) return null;
  const hunts = computeNightHunts({ spot, data, i0, i1 });
  const keys = Object.keys(hunts);
  if (!keys.length) return null;
  const topHunt = keys.sort((a, b) => hunts[b].score - hunts[a].score)[0];
  const top = hunts[topHunt].score;
  const t = hunts[topHunt].peak ?? Math.round((sunset + sunrise) / 2);
  const idx = nearestIndex(data.hours, t);
  if (idx < 0) return null;
  const h = data.hours[idx];
  const tide = spot.coastal ? tideInfo(data.hours, idx) : null;
  const features = featureVector(h, tide);
  const personal = personalScore(features, keepers);
  let score = top;
  if (personal) score = Math.round((1 - personal.weight) * top + personal.weight * personal.score);
  const drive = driveMinutes(spot, settings);
  const hike = hikeMinutes(spot);
  const arrive = Number(settings.arriveBeforeMin ?? 30);
  const leave = t - (arrive + (drive || 0) + hike) * 60;
  const walkStart = hike ? t - (arrive + hike) * 60 : null;

  // Night timeline: astronomical dark, moonrise/set, the best moment, first light.
  const timeline = [];
  const at = new Date(sunset * 1000), next = new Date(sunrise * 1000);
  const tA = window.SunCalc.getTimes(at, spot.lat, spot.lon), tB = window.SunCalc.getTimes(next, spot.lat, spot.lon);
  const ok = x => x instanceof Date && !isNaN(x);
  if (ok(tA.night)) timeline.push({ t: tA.night.getTime() / 1000, label: 'Full darkness' });
  if (ok(tB.nightEnd)) timeline.push({ t: tB.nightEnd.getTime() / 1000, label: 'First light' });
  for (const day of [at, next]) {
    const mt = window.SunCalc.getMoonTimes(day, spot.lat, spot.lon);
    for (const [k, label] of [['rise', 'Moonrise'], ['set', 'Moonset']]) {
      const v = mt[k];
      if (ok(v) && v.getTime() / 1000 > sunset && v.getTime() / 1000 < sunrise) timeline.push({ t: v.getTime() / 1000, label });
    }
  }
  timeline.push({ t, label: `Best for ${topHunt === 'astro' ? 'the Milky Way' : 'aurora'}`, cls: 'key' });

  const access = spot.coastal && spot.tideAccess
    ? accessWindow(data.hours, idx, t, (Number(spot.accessPct) || 40) / 100, Number(spot.accessBuffer ?? 30)) : null;

  return {
    key: `${spot.id}:night:${sunset}`, access,
    spot, type: 'night', t, dayT: sunset, offset: data.offset, idx, hour: h, tide,
    base: top, colour: null, hunts, topHunt, personal, score, factors: hunts[topHunt].factors,
    features, drive, hike, walkStart, leave, light: {}, timeline, sunAz: null, alignment: hunts.astro?.alignment || null,
  };
}

// A "Daytime" session for rainforests and waterfalls: the best hour between mid-morning and mid-afternoon light.
export function evaluateDay({ spot, data, d, keepers, settings }) {
  const day = data.days[d];
  if (!day?.sunrise || !day?.sunset) return null;
  const i0 = nearestIndex(data.hours, day.sunrise + 3600), i1 = nearestIndex(data.hours, day.sunset - 3600);
  if (i0 < 0 || i1 < 0 || i1 < i0) return null;
  const hunts = computeDayHunts({ spot, data, i0, i1 });
  const keys = Object.keys(hunts);
  if (!keys.length) return null;
  const topHunt = keys.sort((a, b) => hunts[b].score - hunts[a].score)[0];
  const top = hunts[topHunt].score;
  const t = hunts[topHunt].peak;
  const idx = nearestIndex(data.hours, t);
  const h = data.hours[idx];
  const tide = spot.coastal ? tideInfo(data.hours, idx) : null;
  const features = featureVector(h, tide);
  const personal = personalScore(features, keepers);
  let score = top;
  if (personal) score = Math.round((1 - personal.weight) * top + personal.weight * personal.score);
  const drive = driveMinutes(spot, settings);
  const hike = hikeMinutes(spot);
  const arrive = Number(settings.arriveBeforeMin ?? 30);
  const leave = t - (arrive + (drive || 0) + hike) * 60;
  const walkStart = hike ? t - (arrive + hike) * 60 : null;
  const H = hunts[topHunt];
  const timeline = [
    { t, label: `Best for ${HUNT_LABEL[topHunt].toLowerCase()}`, cls: 'key' },
    ...(H.from < t ? [{ t: H.from, label: 'Good light from' }] : []),
    ...(H.to > t ? [{ t: H.to, label: 'Good light until' }] : []),
    { t: day.sunset, label: 'Sunset' },
  ];
  const access = spot.coastal && spot.tideAccess
    ? accessWindow(data.hours, idx, t, (Number(spot.accessPct) || 40) / 100, Number(spot.accessBuffer ?? 30)) : null;
  return {
    key: `${spot.id}:day:${day.t}`, access, confidence: null,
    spot, type: 'day', t, dayT: day.sunrise, offset: data.offset, idx, hour: h, tide,
    base: top, colour: null, hunts, topHunt, personal, score, factors: H.factors,
    features, drive, hike, walkStart, leave, light: {}, timeline, sunAz: null, alignment: null,
  };
}
