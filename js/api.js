// Free, keyless data from Open-Meteo (https://open-meteo.com). Personal / non-commercial use.
import { nearestIndex, tideInfo } from './scoring.js?v=1.6';

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
  const wx = await getJSON(`${FORECAST}?${qs({
    ...common,
    hourly: 'cloud_cover,cloud_cover_low,cloud_cover_mid,cloud_cover_high,precipitation_probability,precipitation,visibility,wind_speed_10m,temperature_2m',
    daily: 'sunrise,sunset',
  })}`);

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
      wave: m.wave ?? null, swell: m.swell ?? null, sea: m.sea ?? null,
    };
  });
  const D = wx.daily;
  const days = D.time.map((t, i) => ({ t, sunrise: D.sunrise[i], sunset: D.sunset[i] }));
  return { offset: wx.utc_offset_seconds || 0, tz: wx.timezone, hours, days, hasMarine: !!marine };
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
    hourly: 'cloud_cover_low,cloud_cover_mid,cloud_cover_high,precipitation,wind_speed_10m',
  };

  // The archive lags a few days behind; the forecast API covers the recent past.
  const recent = now - date.getTime() < 10 * DAY;
  const sources = recent ? [FORECAST, ARCHIVE] : [ARCHIVE, FORECAST];
  let found = null;
  for (const url of sources) {
    try {
      const j = await getJSON(`${url}?${qs(params)}`);
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
