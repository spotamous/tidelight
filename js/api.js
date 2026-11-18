// Free, keyless data from Open-Meteo (https://open-meteo.com). Personal / non-commercial use.
import { nearestIndex, tideInfo } from './scoring.js?v=6.9';
import { huntsOf, DAY_HUNTS } from './hunts.js?v=6.9';

const FORECAST = 'https://api.open-meteo.com/v1/forecast';
const MARINE = 'https://marine-api.open-meteo.com/v1/marine';
const ARCHIVE = 'https://archive-api.open-meteo.com/v1/archive';
const TTL = 30 * 60 * 1000;
const cache = new Map();

class SlowError extends Error {}
// Every request has a time limit, so a stalled connection can never freeze the app.
async function getJSON(url, ms = 15000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  let r;
  try { r = await fetch(url, { signal: ctl.signal }); }
  catch (e) { throw ctl.signal.aborted ? new SlowError('The weather service took too long to answer') : new Error('No connection to the weather service'); }
  finally { clearTimeout(timer); }
  if (!r.ok) {
    let reason = '';
    try { reason = (await r.json()).reason || ''; } catch {}
    throw new Error(`Weather service error ${r.status}${reason ? ': ' + reason : ''}`);
  }
  return r.json();
}

const qs = o => new URLSearchParams(o).toString();

export function clearCache() { cache.clear(); }

const BASE = 'cloud_cover,cloud_cover_low,cloud_cover_mid,cloud_cover_high,precipitation_probability,precipitation,visibility,wind_speed_10m,temperature_2m';
const FOG_STORM = 'relative_humidity_2m,dew_point_2m,cape,lifted_index,convective_inhibition,wind_gusts_10m,weather_code';
const HOURLY_SETS = [`${BASE},${FOG_STORM}`, `${BASE},relative_humidity_2m,dew_point_2m,cape,wind_gusts_10m,weather_code`, BASE];
const MODEL_SETS = [['ecmwf_ifs025', 'gfs_seamless', 'bom_access_global'], ['ecmwf_ifs025', 'gfs_seamless']];
const isDayHunter = spot => huntsOf(spot).some(k => DAY_HUNTS.includes(k));
const wantsColourOf = spot => huntsOf(spot).includes('colour') && (spot.events || []).length > 0;
const keyOf = spot => `${spot.lat.toFixed(3)},${spot.lon.toFixed(3)},${isDayHunter(spot) ? 'd' : ''}`;

/* ---------- forecasts kept on the device, so the app opens with the last ones straight away ---------- */
const IDB_NAME = 'tidelight-forecasts', IDB_STORE = 'f';
let idb = null;
function openStore() {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  if (!idb) idb = new Promise(resolve => {
    try {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = req.onblocked = () => resolve(null);
    } catch { resolve(null); }
  });
  return idb;
}
// Load the saved forecasts into memory. Call once at start-up; never throws.
export async function restoreForecasts() {
  const db = await openStore();
  if (!db) return 0;
  return new Promise(resolve => {
    try {
      const tx = db.transaction(IDB_STORE, 'readonly'), st = tx.objectStore(IDB_STORE);
      const keys = st.getAllKeys(), vals = st.getAll();
      tx.oncomplete = () => {
        let n = 0;
        keys.result.forEach((k, i) => { const v = vals.result[i]; if (v?.data && !cache.has(k)) { cache.set(k, v); n++; } });
        resolve(n);
      };
      tx.onerror = tx.onabort = () => resolve(0);
    } catch { resolve(0); }
  });
}
async function persist(entries, keep) {
  const db = await openStore();
  if (!db) return;
  try {
    const tx = db.transaction(IDB_STORE, 'readwrite'), st = tx.objectStore(IDB_STORE);
    for (const [k, v] of entries) st.put(v, k);
    if (keep) { const req = st.getAllKeys(); req.onsuccess = () => req.result.forEach(k => { if (!keep.has(k)) st.delete(k); }); }
  } catch {}
}
// The last forecast for a spot, however old it is: { at, data } or null.
export function savedForecast(spot) { return cache.get(keyOf(spot)) || null; }
export const FORECAST_TTL = TTL;

export async function fetchSpotForecast(spot) {
  const key = keyOf(spot);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.data;

  const common = { latitude: spot.lat, longitude: spot.lon, timezone: 'auto', timeformat: 'unixtime', forecast_days: 7, past_days: 2 };
  let wx;
  try {
    wx = await getJSON(`${FORECAST}?${qs({ ...common, hourly: HOURLY_SETS[0], daily: 'sunrise,sunset' })}`);
  } catch (e) {
    if (e instanceof SlowError || /connection/i.test(e.message)) throw e;   // only retry with fewer variables if the service refused them
    // Some variables aren't offered for every region/model; fall back to the core set.
    wx = await getJSON(`${FORECAST}?${qs({ ...common, hourly: HOURLY_SETS[1], daily: 'sunrise,sunset' })}`)
      .catch(() => getJSON(`${FORECAST}?${qs({ ...common, hourly: HOURLY_SETS[2], daily: 'sunrise,sunset' })}`));
  }

  const getMarine = async () => {
    if (!spot.coastal) return null;   // inland spots don't need tide or waves
    const mr = await getJSON(`${MARINE}?${qs({ ...common, hourly: 'wave_height,swell_wave_height,sea_level_height_msl' })}`, 10000);
    const m = mr.hourly || {};
    const hasAny = (m.wave_height || []).some(v => v != null) || (m.sea_level_height_msl || []).some(v => v != null);
    return hasAny ? mr : null;
  };
  // Rainforest and waterfall spots also need the last two weeks of rain.
  const getRainDaily = async () => {
    if (!isDayHunter(spot)) return null;
    const j = await getJSON(`${FORECAST}?${qs({ latitude: spot.lat, longitude: spot.lon, timezone: 'auto', timeformat: 'unixtime', daily: 'precipitation_sum', past_days: 14, forecast_days: 7 })}`);
    return (j.daily?.time || []).map((t, i) => ({ t, mm: j.daily.precipitation_sum?.[i] ?? 0 }));
  };
  // The horizon and model-agreement checks only matter for sunrise and sunset colour.
  const wantsColour = wantsColourOf(spot);
  const [mr, hz, md, rd] = await Promise.allSettled([getMarine(), wantsColour ? fetchHorizon(spot) : null, wantsColour ? fetchModels(spot) : null, getRainDaily()]);
  const marine = mr.status === 'fulfilled' ? mr.value : null;

  const data = normalize(wx, marine);
  data.horizon = hz.status === 'fulfilled' ? hz.value : null;   // cloud towards sunrise/sunset
  data.models = md.status === 'fulfilled' ? md.value : null;    // per-model cloud, for confidence
  data.rainDaily = rd.status === 'fulfilled' ? rd.value : null; // daily rain, 14 days back
  const entry = { at: Date.now(), data };
  cache.set(key, entry); persist([[key, entry]]);
  return data;
}

/* ---------- cloud on the horizon towards the sun ---------- */
function destPoint(lat, lon, bearing, km) {
  const R = 6371, d = km / R, b = bearing * Math.PI / 180, p1 = lat * Math.PI / 180, l1 = lon * Math.PI / 180;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
  const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return { lat: p2 * 180 / Math.PI, lon: ((l2 * 180 / Math.PI + 540) % 360) - 180 };
}

function horizonPoints(spot) {
  if (!window.SunCalc) return null;
  const now = new Date();
  const times = window.SunCalc.getTimes(now, spot.lat, spot.lon);
  const azAt = d => (window.SunCalc.getPosition(d, spot.lat, spot.lon).azimuth * 180 / Math.PI + 180 + 360) % 360;
  const ok = d => d instanceof Date && !isNaN(d);
  const dirs = { sunrise: ok(times.sunrise) ? azAt(times.sunrise) : 90, sunset: ok(times.sunset) ? azAt(times.sunset) : 270 };
  const pts = [];
  for (const [kind, az] of Object.entries(dirs)) for (const km of [60, 120]) pts.push({ kind, km, az, ...destPoint(spot.lat, spot.lon, az, km) });
  return { dirs, pts };
}
function horizonFrom({ dirs, pts }, arr) {
  const out = { sunrise: { az: dirs.sunrise, points: [] }, sunset: { az: dirs.sunset, points: [] } };
  arr.forEach((r, i) => {
    const H = r?.hourly;
    if (!H || !pts[i]) return;
    out[pts[i].kind].points.push({ km: pts[i].km, times: H.time, low: H.cloud_cover_low, mid: H.cloud_cover_mid, high: H.cloud_cover_high });
  });
  return out.sunrise.points.length || out.sunset.points.length ? out : null;
}
const HZ_PARAMS = { hourly: 'cloud_cover_low,cloud_cover_mid,cloud_cover_high', timezone: 'auto', timeformat: 'unixtime', forecast_days: 7, past_days: 2 };
async function fetchHorizon(spot) {
  const hp = horizonPoints(spot);
  if (!hp) return null;
  const j = await getJSON(`${FORECAST}?${qs({ latitude: hp.pts.map(p => p.lat.toFixed(3)).join(','), longitude: hp.pts.map(p => p.lon.toFixed(3)).join(','), ...HZ_PARAMS })}`, 10000);
  return horizonFrom(hp, Array.isArray(j) ? j : [j]);
}

/* ---------- the same cloud from several weather models, for confidence ---------- */
function modelsFrom(j, ms) {
  const H = j?.hourly || {};
  const models = ms.map(m => ({ model: m, low: H[`cloud_cover_low_${m}`], mid: H[`cloud_cover_mid_${m}`], high: H[`cloud_cover_high_${m}`] }))
    .filter(x => Array.isArray(x.low) && x.low.some(v => v != null));
  return models.length >= 2 ? { times: H.time, models } : null;
}
async function fetchModels(spot) {
  for (const ms of MODEL_SETS) {
    try {
      const j = await getJSON(`${FORECAST}?${qs({ latitude: spot.lat, longitude: spot.lon, models: ms.join(','), ...HZ_PARAMS })}`, 10000);
      const r = modelsFrom(j, ms);
      if (r) return r;
    } catch (e) { if (e instanceof SlowError) return null; /* refused: try the smaller set */ }
  }
  return null;
}

/* ---------- every spot at once: a handful of requests instead of three or four per spot ---------- */
// Open-Meteo takes comma-separated coordinates and answers with one result per place, in order.
const coords = list => ({ latitude: list.map(p => p.lat).join(','), longitude: list.map(p => p.lon).join(',') });
const asList = (j, n) => { const a = Array.isArray(j) ? j : [j]; if (a.length !== n) throw new Error('Unexpected answer from the weather service'); return a; };
const chunks = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };
async function many(list, size, fn) {   // run fn on chunks of the list, keeping order
  const parts = await Promise.all(chunks(list, size).map(fn));
  return parts.flat();
}

// Returns { [spot.id]: data } for the spots that loaded, plus { failed: [{ spot, error }] }.
// Spots fetched less than 30 minutes ago come from memory unless `force`. `all`: every spot you have,
// so saved forecasts for deleted spots can be cleared out.
export async function fetchForecasts(spots, { force = false, all = spots } = {}) {
  const out = {}, failed = [];
  const todo = [];
  for (const sp of spots) {
    const hit = cache.get(keyOf(sp));
    if (!force && hit && Date.now() - hit.at < TTL) out[sp.id] = hit.data; else todo.push(sp);
  }
  if (!todo.length) return { out, failed };
  const common = { timezone: 'auto', timeformat: 'unixtime', forecast_days: 7, past_days: 2 };

  const wxAll = async () => {
    let lastErr;
    for (const hourly of HOURLY_SETS) {
      try { return await many(todo, 40, part => getJSON(`${FORECAST}?${qs({ ...coords(part), ...common, hourly, daily: 'sunrise,sunset' })}`, 20000).then(j => asList(j, part.length))); }
      catch (e) { lastErr = e; if (e instanceof SlowError || /connection/i.test(e.message)) throw e; }
    }
    throw lastErr;
  };
  const coastal = todo.filter(sp => sp.coastal);
  const marineAll = async () => {
    if (!coastal.length) return [];
    const res = await many(coastal, 40, part => getJSON(`${MARINE}?${qs({ ...coords(part), ...common, hourly: 'wave_height,swell_wave_height,sea_level_height_msl' })}`, 12000).then(j => asList(j, part.length)));
    return res.map(mr => {
      const m = mr?.hourly || {};
      const hasAny = (m.wave_height || []).some(v => v != null) || (m.sea_level_height_msl || []).some(v => v != null);
      return hasAny ? mr : null;
    });
  };
  const dayHunters = todo.filter(isDayHunter);
  const rainAll = async () => {
    if (!dayHunters.length) return [];
    const res = await many(dayHunters, 40, part => getJSON(`${FORECAST}?${qs({ ...coords(part), timezone: 'auto', timeformat: 'unixtime', daily: 'precipitation_sum', past_days: 14, forecast_days: 7 })}`, 12000).then(j => asList(j, part.length)));
    return res.map(j => (j.daily?.time || []).map((t, i) => ({ t, mm: j.daily.precipitation_sum?.[i] ?? 0 })));
  };
  const colour = todo.filter(wantsColourOf);
  const hzAll = async () => {
    const hps = colour.map(horizonPoints);
    const pts = hps.flatMap(hp => (hp ? hp.pts : []));
    if (!pts.length) return colour.map(() => null);
    const arr = await many(pts, 100, part => getJSON(`${FORECAST}?${qs({ ...coords(part), ...HZ_PARAMS })}`, 12000).then(j => asList(j, part.length)));
    let i = 0;
    return hps.map(hp => { if (!hp) return null; const mine = arr.slice(i, i + hp.pts.length); i += hp.pts.length; return horizonFrom(hp, mine); });
  };
  const modelsAll = async () => {
    if (!colour.length) return [];
    for (const ms of MODEL_SETS) {
      try { return (await many(colour, 30, part => getJSON(`${FORECAST}?${qs({ ...coords(part), models: ms.join(','), ...HZ_PARAMS })}`, 12000).then(j => asList(j, part.length)))).map(j => modelsFrom(j, ms)); }
      catch (e) { if (e instanceof SlowError) return colour.map(() => null); }
    }
    return colour.map(() => null);
  };

  const [wx, mr, rd, hz, md] = await Promise.allSettled([wxAll(), marineAll(), rainAll(), hzAll(), modelsAll()]);
  if (wx.status !== 'fulfilled') {
    // The combined request didn't work (for example one place the service won't forecast): fall back to one spot at a time.
    if (wx.reason instanceof SlowError || /connection/i.test(wx.reason?.message || '')) {
      for (const sp of todo) failed.push({ spot: sp, error: wx.reason });
      return { out, failed };
    }
    const res = await Promise.allSettled(todo.map(sp => fetchSpotForecast(sp)));
    res.forEach((r, i) => { if (r.status === 'fulfilled') out[todo[i].id] = r.value; else failed.push({ spot: todo[i], error: r.reason }); });
    return { out, failed };
  }
  const pick = (res, list, sp) => (res.status === 'fulfilled' ? res.value[list.indexOf(sp)] ?? null : null);
  const now = Date.now(), entries = [];
  todo.forEach((sp, i) => {
    try {
      const data = normalize(wx.value[i], pick(mr, coastal, sp));
      data.horizon = wantsColourOf(sp) ? pick(hz, colour, sp) : null;
      data.models = wantsColourOf(sp) ? pick(md, colour, sp) : null;
      data.rainDaily = isDayHunter(sp) ? pick(rd, dayHunters, sp) : null;
      const entry = { at: now, data };
      cache.set(keyOf(sp), entry); entries.push([keyOf(sp), entry]);
      out[sp.id] = data;
    } catch (e) { failed.push({ spot: sp, error: e }); }
  });
  // Keep only the forecasts for the spots you have now.
  persist(entries, new Set(all.map(keyOf)));
  return { out, failed };
}

function normalize(wx, marine) {
  const H = wx.hourly;
  const mByTime = new Map();
  if (marine) {
    const M = marine.hourly;
    M.time.forEach((t, i) => mByTime.set(t, {
      wave: M.wave_height?.[i] ?? null,
      swell: M.swell_wave_height?.[i] ?? null,
      sea: M.sea_level_height_msl?.[i] ?? null,
    }));
  }
  const hours = H.time.map((t, i) => {
    const m = mByTime.get(t) || {};
    return {
      t,
      total: H.cloud_cover[i], low: H.cloud_cover_low[i], mid: H.cloud_cover_mid[i], high: H.cloud_cover_high[i],
      pp: H.precipitation_probability?.[i] ?? null, precip: H.precipitation?.[i] ?? 0,
      vis: H.visibility?.[i] ?? null, wind: H.wind_speed_10m?.[i] ?? null, temp: H.temperature_2m?.[i] ?? null,
      rh: H.relative_humidity_2m?.[i] ?? null, dew: H.dew_point_2m?.[i] ?? null,
      cape: H.cape?.[i] ?? null, li: H.lifted_index?.[i] ?? null, cin: H.convective_inhibition?.[i] ?? null,
      gust: H.wind_gusts_10m?.[i] ?? null, code: H.weather_code?.[i] ?? null,
      wave: m.wave ?? null, swell: m.swell ?? null, sea: m.sea ?? null,
    };
  });
  const D = wx.daily;
  const days = D.time.map((t, i) => ({ t, sunrise: D.sunrise[i], sunset: D.sunset[i] }));
  return { offset: wx.utc_offset_seconds || 0, tz: wx.timezone, elevation: wx.elevation ?? null, hours, days, hasMarine: !!marine };
}

// Conditions at a moment in the past (for keeper photos and rated sessions).
export async function fetchHistorical(lat, lon, date) {
  const t = Math.floor(date.getTime() / 1000);
  const DAY = 86400000;
  const ymd = ms => new Date(ms).toISOString().slice(0, 10);
  const now = Date.now();
  const start = ymd(date.getTime() - DAY);
  const end = ymd(Math.min(date.getTime() + DAY, now));
  const params = {
    latitude: lat, longitude: lon, start_date: start, end_date: end, timezone: 'auto', timeformat: 'unixtime',
    hourly: 'cloud_cover_low,cloud_cover_mid,cloud_cover_high,precipitation,wind_speed_10m,temperature_2m,dew_point_2m,cape,weather_code',
  };
  const coreHourly = 'cloud_cover_low,cloud_cover_mid,cloud_cover_high,precipitation,wind_speed_10m';

  // The archive lags a few days behind; the forecast API covers the recent past.
  const recent = now - date.getTime() < 10 * DAY;
  const sources = recent ? [FORECAST, ARCHIVE] : [ARCHIVE, FORECAST];
  let found = null;
  for (const url of sources) {
    try {
      const j = await getJSON(`${url}?${qs(params)}`).catch(() => getJSON(`${url}?${qs({ ...params, hourly: coreHourly })}`));
      const hours = j.hourly.time.map(tt => ({ t: tt }));
      const i = nearestIndex(hours, t);
      if (i >= 0 && j.hourly.cloud_cover_mid[i] != null) { found = { j, i }; break; }
    } catch {}
  }
  if (!found) throw new Error('No weather records for that date and place');

  const { j, i } = found, H = j.hourly;
  const hour = {
    t: H.time[i], low: H.cloud_cover_low[i], mid: H.cloud_cover_mid[i], high: H.cloud_cover_high[i],
    precip: H.precipitation[i], wind: H.wind_speed_10m[i], wave: null, sea: null,
    temp: H.temperature_2m?.[i] ?? null, dew: H.dew_point_2m?.[i] ?? null, cape: H.cape?.[i] ?? null, code: H.weather_code?.[i] ?? null,
  };

  let tide = null;
  try {
    const m = await getJSON(`${MARINE}?${qs({
      latitude: lat, longitude: lon, start_date: start, end_date: end, timezone: 'auto', timeformat: 'unixtime',
      hourly: 'wave_height,sea_level_height_msl',
    })}`);
    const hours = m.hourly.time.map((tt, k) => ({
      t: tt, sea: m.hourly.sea_level_height_msl?.[k] ?? null, wave: m.hourly.wave_height?.[k] ?? null,
    }));
    const k = nearestIndex(hours, t);
    if (k >= 0) { hour.wave = hours[k].wave; hour.sea = hours[k].sea; tide = tideInfo(hours, k); }
  } catch {}

  return { hour, tide };
}

/* ---------- Space weather: NOAA SWPC planetary Kp forecast (free, no key) ---------- */
const KP_URL = 'https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json';
let kpCache = null;

function parseTime(v) {
  let s = String(v).trim().replace(' ', 'T');
  if (!/[zZ]|[+-]\d\d:?\d\d$/.test(s)) s += 'Z'; // SWPC times are UTC
  return Date.parse(s) / 1000;
}

// Returns [{ t: unix seconds (start of 3-hour block), kp }]. Handles both of SWPC's JSON layouts.
export async function fetchKp() {
  if (kpCache && Date.now() - kpCache.at < 60 * 60 * 1000) return kpCache.data;
  const j = await getJSON(KP_URL);
  let rows = [];
  if (Array.isArray(j) && Array.isArray(j[0])) {
    const hdr = j[0].map(x => String(x).toLowerCase());
    const ti = hdr.indexOf('time_tag'), ki = hdr.indexOf('kp');
    rows = j.slice(1).map(r => ({ t: parseTime(r[ti]), kp: parseFloat(r[ki]) }));
  } else if (Array.isArray(j)) {
    rows = j.map(r => ({ t: parseTime(r.time_tag ?? r.time), kp: parseFloat(r.kp ?? r.Kp ?? r.kp_index) }));
  }
  rows = rows.filter(r => !isNaN(r.t) && !isNaN(r.kp)).sort((a, b) => a.t - b.t);
  kpCache = { at: Date.now(), data: rows };
  return rows;
}

/* ---------- Right now: current modelled conditions at a spot ---------- */
export async function fetchCurrent(spot) {
  const j = await getJSON(`${FORECAST}?${qs({
    latitude: spot.lat, longitude: spot.lon, timezone: 'auto', timeformat: 'unixtime',
    current: 'temperature_2m,relative_humidity_2m,cloud_cover,cloud_cover_low,cloud_cover_mid,cloud_cover_high,wind_speed_10m,wind_gusts_10m,weather_code,visibility,precipitation',
  })}`);
  const c = j.current || {};
  return {
    t: c.time, offset: j.utc_offset_seconds || 0, temp: c.temperature_2m, rh: c.relative_humidity_2m,
    total: c.cloud_cover, low: c.cloud_cover_low, mid: c.cloud_cover_mid, high: c.cloud_cover_high,
    wind: c.wind_speed_10m, gust: c.wind_gusts_10m, code: c.weather_code, vis: c.visibility, precip: c.precipitation,
  };
}

/* ---------- Live radar frames from RainViewer (free tier; may change) ---------- */
export async function fetchRadarFrames() {
  const j = await getJSON('https://api.rainviewer.com/public/weather-maps.json');
  const past = j?.radar?.past || [];
  if (!j.host || !past.length) throw new Error('No radar frames available');
  return past.slice(-8).map(f => ({ time: f.time, url: `${j.host}${f.path}/256/{z}/{x}/{y}/2/1_1.png` }));
}

export const WEATHER_TEXT = code => {
  if (code == null) return '–';
  if (code === 0) return 'Clear';
  if (code === 1) return 'Mostly clear';
  if (code === 2) return 'Partly cloudy';
  if (code === 3) return 'Overcast';
  if (code === 45 || code === 48) return 'Fog';
  if (code >= 51 && code <= 57) return 'Drizzle';
  if (code >= 61 && code <= 67) return 'Rain';
  if (code >= 71 && code <= 77) return 'Snow';
  if (code >= 80 && code <= 82) return 'Showers';
  if (code === 85 || code === 86) return 'Snow showers';
  if (code === 95) return 'Thunderstorm';
  if (code === 96 || code === 99) return 'Thunderstorm with hail';
  return 'Mixed';
};

/* ---------- Place search for adding spots ---------- */
// OpenStreetMap Nominatim (finds beaches, landmarks, lookouts; free, max ~1 search per second),
// with Open-Meteo's town/suburb search as a fallback.
export async function searchPlaces(q, home) {
  const p = { format: 'jsonv2', q, limit: 6, 'accept-language': 'en' };
  if (home) p.viewbox = `${home.lon - 3},${home.lat + 3},${home.lon + 3},${home.lat - 3}`; // prefer results near home
  try {
    const j = await getJSON(`https://nominatim.openstreetmap.org/search?${qs(p)}`);
    if (Array.isArray(j) && j.length) {
      return j.map(r => ({ name: r.name || String(r.display_name).split(',')[0], detail: r.display_name, lat: +r.lat, lon: +r.lon }));
    }
  } catch { /* fall through */ }
  const g = await getJSON(`https://geocoding-api.open-meteo.com/v1/search?${qs({ name: q.split(',')[0].trim(), count: 6, language: 'en', format: 'json' })}`);
  return (g.results || []).map(r => ({ name: r.name, detail: [r.admin2, r.admin1, r.country].filter(Boolean).join(', '), lat: r.latitude, lon: r.longitude }));
}

/* ---------- Hour-by-hour forecast for any place (Right now view) ---------- */
export async function fetchHourly(lat, lon) {
  // Coordinates rounded to ~100 m so repeat checks from the same place can use the offline cache.
  const j = await getJSON(`${FORECAST}?${qs({
    latitude: lat.toFixed(3), longitude: lon.toFixed(3), timezone: 'auto', timeformat: 'unixtime', forecast_days: 3,
    hourly: 'temperature_2m,precipitation_probability,precipitation,weather_code,cloud_cover,wind_speed_10m,wind_gusts_10m,wind_direction_10m,is_day',
    daily: 'sunrise,sunset',
  })}`);
  const H = j.hourly, now = Date.now() / 1000;
  const hours = H.time.map((t, i) => ({
    t, temp: H.temperature_2m?.[i], pp: H.precipitation_probability?.[i], precip: H.precipitation?.[i] ?? 0,
    code: H.weather_code?.[i], cloud: H.cloud_cover?.[i], wind: H.wind_speed_10m?.[i], gust: H.wind_gusts_10m?.[i],
    dir: H.wind_direction_10m?.[i], day: H.is_day?.[i] === 1,
  })).filter(h => h.t >= now - 3600).slice(0, 48);
  const suns = [];
  (j.daily?.time || []).forEach((_, i) => {
    if (j.daily.sunrise?.[i]) suns.push({ t: j.daily.sunrise[i], kind: 'Sunrise' });
    if (j.daily.sunset?.[i]) suns.push({ t: j.daily.sunset[i], kind: 'Sunset' });
  });
  return { offset: j.utc_offset_seconds || 0, hours, suns };
}

// Is this point on the coast? The marine model has wave data over water and nothing over land.
export async function coastalCheck(lat, lon) {
  try {
    const j = await getJSON(`${MARINE}?${qs({ latitude: lat, longitude: lon, hourly: 'wave_height', forecast_days: 1, timezone: 'auto' })}`, 8000);
    return (j.hourly?.wave_height || []).some(v => v != null);
  } catch { return false; }
}

// A short place name for a coordinate ("Cowes"), or null.
export async function placeName(lat, lon) {
  try {
    const j = await getJSON(`https://nominatim.openstreetmap.org/reverse?${qs({ format: 'jsonv2', lat, lon, zoom: 14, 'accept-language': 'en' })}`);
    const a = j.address || {};
    return a.suburb || a.town || a.village || a.city || a.hamlet || a.county || null;
  } catch { return null; }
}
