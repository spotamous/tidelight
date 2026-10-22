// Free, keyless data from Open-Meteo (https://open-meteo.com). Personal / non-commercial use.
import { nearestIndex, tideInfo } from './scoring.js?v=2.1';

const FORECAST = 'https://api.open-meteo.com/v1/forecast';
const MARINE = 'https://marine-api.open-meteo.com/v1/marine';
const ARCHIVE = 'https://archive-api.open-meteo.com/v1/archive';
const TTL = 30 * 60 * 1000;
const cache = new Map();

async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) {
    let reason = '';
    try { reason = (await r.json()).reason || ''; } catch {}
    throw new Error(`Weather service error ${r.status}${reason ? ': ' + reason : ''}`);
  }
  return r.json();
}

const qs = o => new URLSearchParams(o).toString();

export function clearCache() { cache.clear(); }

export async function fetchSpotForecast(spot) {
  const key = `${spot.lat.toFixed(3)},${spot.lon.toFixed(3)}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.data;

  const common = { latitude: spot.lat, longitude: spot.lon, timezone: 'auto', timeformat: 'unixtime', forecast_days: 7, past_days: 2 };
  const BASE = 'cloud_cover,cloud_cover_low,cloud_cover_mid,cloud_cover_high,precipitation_probability,precipitation,visibility,wind_speed_10m,temperature_2m';
  const FOG_STORM = 'relative_humidity_2m,dew_point_2m,cape,lifted_index,convective_inhibition,wind_gusts_10m,weather_code';
  let wx;
  try {
    wx = await getJSON(`${FORECAST}?${qs({ ...common, hourly: `${BASE},${FOG_STORM}`, daily: 'sunrise,sunset' })}`);
  } catch {
    // Some variables aren't offered for every region/model; fall back to the core set.
    wx = await getJSON(`${FORECAST}?${qs({ ...common, hourly: `${BASE},relative_humidity_2m,dew_point_2m,cape,wind_gusts_10m,weather_code`, daily: 'sunrise,sunset' })}`)
      .catch(() => getJSON(`${FORECAST}?${qs({ ...common, hourly: BASE, daily: 'sunrise,sunset' })}`));
  }

  let marine = null;
  try {
    marine = await getJSON(`${MARINE}?${qs({ ...common, hourly: 'wave_height,swell_wave_height,sea_level_height_msl' })}`);
    const m = marine.hourly || {};
    const hasAny = (m.wave_height || []).some(v => v != null) || (m.sea_level_height_msl || []).some(v => v != null);
    if (!hasAny) marine = null;
  } catch { marine = null; }

  const data = normalize(wx, marine);
  cache.set(key, { at: Date.now(), data });
  return data;
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
