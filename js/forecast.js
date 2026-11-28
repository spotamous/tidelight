// Tidelight: The Forecast tab: the session card, score gauge and What if?, the light band, week strip, little pictures (horizon scenes, spot tiles, avatars) and gestures.
import { dayKey, esc, fmtTime, toast, fmtWeekday, fmtDayDate, cap } from './util.js?v=7.5.1';
import { nearestIndex, horizonBlock, spotFloor, baseScore, tideInfo } from './scoring.js?v=7.5.1';
import { HUNT_LABEL, HUNT_VERB, huntsOf, forestAt, waterfallAt, stormAt, setKp, huntWord } from './hunts.js?v=7.5.1';
import { update } from './storage.js?v=7.5.1';
import { unshareFromCrew, syncNow } from './sync.js?v=7.5.1';
import { coverUrl } from './photos.js?v=7.5.1';
import { fetchForecasts, fetchKp } from './api.js?v=7.5.1';
import { $, $$, S, allEvents, bgRefresh, ensureForecasts, eventIndex, forecasts, forecastsLanded, indexEvents, openSheet, sessionName, ui, unsure } from './core.js?v=7.5.1';
import { render } from './app.js?v=7.5.1';
import { openSpotForm, openSpotDetail } from './spots.js?v=7.5.1';
import { anySeas, ensureSeas, seasBanner, seasView, wireSeasView } from './seasui.js?v=7.5.1';
import { untilText } from './field.js?v=7.5.1';
import { crewGoing, goingText, loadCrew } from './crews.js?v=7.5.1';
import { PIN_ICON, openHere } from './here.js?v=7.5.1';

/* ================= forecast ================= */

export function emptySpots(v) {
  v.innerHTML = `<div class="empty">
    <h1 class="page-title">Know before the alarm</h1>
    <p>Add the spots you shoot. Tidelight scores every sunrise and sunset for the next 7 days using sky, tide and sea, tells you when to leave, and learns which conditions you love.</p>
    <div class="row"><button class="btn primary" id="goAdd">Add your first spot</button></div>
  </div>`;
  $('#goAdd').onclick = () => { ui.tab = 'spots'; render(); openSpotForm(); };
}
export function savedAgo() {
  const t = Number(localStorage.getItem('tidelight:lastFetch') || 0);
  if (!t) return 'earlier';
  const mins = Math.round((Date.now() - t) / 60000);
  return mins < 1 ? 'just now' : mins < 60 ? `${mins} min ago` : mins < 48 * 60 ? `${Math.round(mins / 60)} h ago` : `${Math.round(mins / 1440)} days ago`;
}
export const SUN_ICON = {
  day: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4"/></svg>',
  night: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/></svg>',
  sunrise: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M3 18h18M7 18a5 5 0 0 1 10 0M12 7v3M12 7l-2 2M12 7l2 2M5 12l1.5 1M19 12l-1.5 1"/></svg>',
  sunset: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M3 18h18M7 18a5 5 0 0 1 10 0M12 10V7M12 10l-2-2M12 10l2-2M5 12l1.5 1M19 12l-1.5 1"/></svg>',
};
// Sessions in the next 3 days (today, tomorrow, the day after), each tagged with its day index.
// Sessions in the next n days (today first), each tagged with its day index.
export function nextDays(n = 7) {
  const now = Date.now() / 1000;
  const out = [];
  for (const e of allEvents()) {
    const k = dayKey(e.dayT ?? e.t, e.offset);
    for (let i = 0; i < n; i++) if (dayKey(now + i * 86400, e.offset) === k) { out.push({ ...e, dayIdx: i }); break; }
  }
  return out;
}
export const next3Days = () => nextDays(3);
// The day the app should open on: today while one of its sessions is still worth leaving for, otherwise the next day with light.
export function nextLightDay(evs) {
  const now = Date.now() / 1000;
  if (evs.some(e => e.dayIdx === 0 && e.leave > now - 15 * 60)) return 0;
  const later = evs.filter(e => e.dayIdx > 0).map(e => e.dayIdx);
  return later.length ? Math.min(...later) : 0;
}
export function forecastAlerts(st, failed) {
  return `${!navigator.onLine ? `<div class="alert info">You're offline. Showing the forecast saved ${savedAgo()}.</div>` : ''}
    ${failed.length && navigator.onLine ? `<div class="alert danger"><p>${failed.length === st.spots.length ? "Couldn't reach the weather service." : `Couldn't load ${failed.length} of your ${st.spots.length} spots.`} ${failed.some(f => /429|busy|too many|too long/i.test(f)) ? "It's busy right now; try again in a minute." : 'Check your connection, then refresh.'}</p>
      <details><summary>Details</summary><p class="small">${esc(failed.join('; '))}</p></details></div>` : ''}
    ${!st.settings.home ? `<div class="alert info">Set your home under You, in Home and travel, to get leave times that include the drive.</div>` : ''}`;
}
export const SESSION_TYPES = ['sunrise', 'day', 'sunset', 'night'];
export const TYPE_NAME = { sunrise: 'Sunrise', day: 'Daytime', sunset: 'Sunset', night: 'Night', seas: 'Big seas' };
// One line on why: the strongest point in its favour, or the main thing against it.
export function whyLine(e) {
  const fs = e.hunts?.[e.topHunt]?.factors || e.factors || [];
  const good = fs.find(f => f.k === 'good'), bad = fs.find(f => f.k === 'bad');
  return (e.score >= 50 ? (good || bad) : (bad || good))?.t || '';
}
export function whySentence(e) {
  const fs = e.hunts?.[e.topHunt]?.factors || e.factors || [];
  const goods = fs.filter(f => f.k === 'good').slice(0, 2).map(f => f.t);
  const bad = fs.find(f => f.k === 'bad')?.t;
  let txt = goods.length ? goods.join('. ') + '.' : '';
  if (bad) txt += `${txt ? ' ' : ''}${goods.length ? 'Against it, ' + bad.charAt(0).toLowerCase() + bad.slice(1) : bad}.`;
  return txt || 'Nothing stands out either way.';
}
export function couldChange(e) {
  const H = e.hunts?.[e.topHunt] || {};
  switch (e.topHunt) {
    case 'colour': {
      if (e.confidence?.level === 'low') return 'The weather models disagree, so check again the evening before.';
      const hz = (H.parts || []).find(p => p.label === 'Horizon');
      if (hz && hz.value < 60) return 'Cloud on the horizon could block the light. Check the radar before you leave.';
      return 'Low cloud rolling in on the horizon is the main risk. Re-check the evening before.';
    }
    case 'fog': return 'A breeze overnight would mix the fog out. Check the wind before you set the alarm.';
    case 'storm': case 'lightning': return 'Storms are hit and miss. Watch the radar from mid-afternoon.';
    case 'rainbow': return 'Rainbows need sun and showers at the same moment. Watch the sky in that hour.';
    case 'forest': return 'Sun breaking through would harshen the light. Keep an eye on the cloud.';
    case 'waterfall': return H.extra?.flood ? 'Heavy rain can close tracks and make crossings dangerous. Check before heading in.' : 'More rain before you go means more flow; a dry spell means less.';
    case 'aurora': return 'Aurora forecasts shift by the hour. Check the Kp again at dusk.';
    case 'astro': return 'Cloud can creep in after dark. Check the radar before heading out.';
    default: return '';
  }
}
export function partBar(p, cls = '') {
  return `<div class="part ${cls}"><span class="part-label">${esc(p.label)}</span>
    <span class="part-track"><i style="width:${Math.max(0, Math.min(100, p.value))}%"></i></span>
    <span class="part-val num">${Math.round(p.value)}</span>
    <span class="part-note">${esc(p.note || '')}</span></div>`;
}
// "6:17am", "best 2:10am", or a daytime window "10:00am–2:00pm"
// The same, tightened for small spaces: "10am–2pm".
export const shortWhen = e => sessionWhen(e).replace(/:00(?=[ap]m)/g, '');
export function sessionWhen(e) {
  const o = e.offset, H = e.hunts?.[e.topHunt];
  if (e.type === 'day' && H?.from) return H.from === H.to ? fmtTime(e.t, o) : `${fmtTime(H.from, o)}–${fmtTime(H.to, o)}`;
  return e.type === 'night' ? `best ${fmtTime(e.t, o)}` : fmtTime(e.t, o);
}
// Placeholder shapes in the layout of the page that's loading, with a plain status line for screen readers.
export function skeleton(kind, status) {
  const shapes = {
    home: '<div class="sk sk-title"></div><div class="sk sk-line"></div><div class="sk sk-band"></div><div class="sk sk-panel"></div><div class="sk sk-row"></div><div class="sk sk-row"></div>',
    cards: '<div class="sk sk-card"></div><div class="sk sk-card"></div><div class="sk sk-card"></div>',
    week: '<div class="sk sk-line"></div><div class="sk sk-grid"></div>',
    here: '<div class="sk sk-panel"></div><div class="sk sk-line"></div><div class="sk sk-row"></div><div class="sk sk-row"></div>',
  }[kind];
  return `<div class="sk-wrap" aria-hidden="true">${shapes}</div><p class="sk-status" role="status">${esc(status)}</p>`;
}
/* ---------- motion ---------- */
export const motionOK = () => (S().settings.motion || 'full') !== 'reduced' && !matchMedia('(prefers-reduced-motion: reduce)').matches;
// Theme: dark (the default), daylight, or match the phone's own light/dark setting.
export const THEMES = [['dark', 'Dark', 'Easy on the eyes before dawn and after dark.'], ['light', 'Daylight', 'Bright and high-contrast, for reading in the sun.'], ['auto', 'Match my phone', "Follows your phone's light and dark setting."], ['festive', 'Festive', 'Pine and gold, fairy lights and a little snow, for the holidays.']];
export const lightQuery = matchMedia('(prefers-color-scheme: light)');
export function applyTheme() {
  const pref = S().settings.theme || 'dark';
  const theme = pref === 'auto' ? (lightQuery.matches ? 'light' : 'dark') : pref;
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem('tidelight:theme', pref); } catch {}
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = theme === 'light' ? '#EEE9E1' : theme === 'festive' ? '#0B1511' : '#0B0D12';
  festiveTrim(theme === 'festive');
}
lightQuery.addEventListener?.('change', () => { if ((S().settings.theme || 'dark') === 'auto') applyTheme(); });
// The festive theme's fairy lights and snow (decorations only: hidden from screen readers).
function festiveTrim(on) {
  document.querySelector('.festive-lights')?.remove();
  document.querySelector('.festive-snow')?.remove();
  if (!on) return;
  const COLS = ['#E8414F', '#F2C94C', '#4CC27A', '#F7F2E6', '#5AA9F0'];
  const W = Math.max(320, innerWidth), gap = 30, n = Math.round(W / gap), step = W / n, bulbs = [];
  let wire = 'M0 3';
  for (let i = 1; i <= n; i++) wire += ` Q${(i - 0.5) * step} 13 ${i * step} 3`;   // the wire dips between hooks
  for (let i = 0; i < n; i++) {
    const x = (i + 0.5) * step, y = 9.5;   // a bulb hangs from the bottom of each dip
    bulbs.push(`<g class="bulb" style="--d:${((i * 0.37) % 2.4).toFixed(2)}s"><rect x="${(x - 2).toFixed(1)}" y="${y - 2}" width="4" height="3" rx="1" fill="#2B3A33"/><ellipse cx="${x.toFixed(1)}" cy="${y + 5}" rx="3.6" ry="5" fill="${COLS[i % COLS.length]}"/><ellipse cx="${(x - 1.1).toFixed(1)}" cy="${y + 3.4}" rx="1" ry="1.6" fill="rgba(255,255,255,.55)"/></g>`);
  }
  const lights = document.createElement('div');
  lights.className = 'festive-lights'; lights.setAttribute('aria-hidden', 'true');
  lights.innerHTML = `<svg viewBox="0 0 ${W} 22" width="${W}" height="22"><path class="wire" d="${wire}"/>${bulbs.join('')}</svg>`;
  if (!festiveTrim.wired) { festiveTrim.wired = true; addEventListener('resize', () => { if (document.querySelector('.festive-lights')) festiveTrim(true); }); }
  const snow = document.createElement('div');
  snow.className = 'festive-snow'; snow.setAttribute('aria-hidden', 'true');
  snow.innerHTML = Array.from({ length: 22 }, (_, i) => {
    const r = k => ((Math.sin((i + 1) * 12.9898 * k) * 43758.5453) % 1 + 1) % 1;   // the same scatter every time
    return `<i style="--x:${(r(1) * 100).toFixed(1)}%;--s:${(2 + r(2) * 3).toFixed(1)}px;--t:${(14 + r(3) * 14).toFixed(1)}s;--d:${(-r(4) * 28).toFixed(1)}s;--o:${(0.3 + r(5) * 0.45).toFixed(2)};--sway:${((r(6) - 0.5) * 50).toFixed(0)}px"></i>`;
  }).join('');
  document.body.append(snow, lights);
}
export function applyMotion() {
  if ((S().settings.motion || 'full') === 'reduced') document.documentElement.dataset.motion = 'reduced';
  else delete document.documentElement.dataset.motion;
}
// Count a number up to its value (used when a score appears in answer to a tap).
export function countUp(el, to, ms = 650) {
  const t0 = performance.now();
  const step = t => {
    const k = Math.min(1, (t - t0) / ms), eased = 1 - (1 - k) ** 3;
    el.textContent = String(Math.round(to * eased));
    if (k < 1 && el.isConnected) requestAnimationFrame(step); else el.textContent = String(to);
  };
  requestAnimationFrame(step);
}
export function runCounts(root) {
  if (!motionOK()) return;
  $$('[data-count]', root).forEach(el => { const to = Number(el.dataset.count); if (isFinite(to)) countUp(el, to); });
}
// The sky over the band, from the selected spot's hourly forecast: cloud drifts where there's cloud
// (denser where it's overcast), rain falls in the hours rain is likely, stars show in clear dark hours.
// The sky over the band, from the selected spot's hourly forecast. Each two-hour slot gets at most one cloud,
// placed at that time and sized by how cloudy it is (alternating high and low so neighbours don't overlap);
// clouds hover and swell gently rather than drifting, so they never suggest cloud moving through the day.
// Rain slots get a dark rain cloud with drops falling beneath (a denser layer for heavy rain); clear dark
// hours get stars. Clouds dim after sunset, as real cloud does.
// A sample day for the welcome and the tour: high cloud at sunrise, cloud building, a mid-afternoon
// shower, then clearing to a starry night. Same shape as a forecast's hours.
export function demoSkyDay(w0) {
  const hours = [];
  for (let h = 0; h <= 26; h++) {
    const lh = (3 + h) % 24;   // the band starts at 3am
    const sh = lh >= 14 && lh < 17;
    const cover = lh < 5 ? 8 : lh < 9 ? 45 : lh < 14 ? 55 : sh ? 85 : lh < 19 ? 40 : lh < 21 ? 25 : 6;
    hours.push({ t: w0 + h * 3600, total: cover, low: sh ? 70 : 10, mid: cover * 0.6, high: lh < 9 ? 45 : 20, pp: sh ? 75 : 5, precip: sh ? 1.1 : 0 });
  }
  return { hours };
}
export function bandSky(e, w0, marks, sample) {
  const data = sample || (e && forecasts[e.spot.id]);
  if (!data) return '';
  const cl = x => Math.max(0, Math.min(1, x));
  const at = t => { const i = nearestIndex(data.hours, t); return i >= 0 ? data.hours[i] : null; };
  const coverOf = hr => (hr ? (hr.total ?? Math.max(hr.low ?? 0, hr.mid ?? 0, hr.high ?? 0)) : 0);
  const rainOf = hr => (hr ? cl(((hr.pp ?? 0) - 35) / 40) : 0);
  const heavyOf = hr => (hr ? cl(((hr.precip ?? 0) - 0.8) / 1.7) * rainOf(hr) : 0);

  // Rain drops, masked hour by hour so they fall only where rain is likely.
  const rainStops = [], heavyStops = [], clearDark = [];
  let anyRain = false, anyHeavy = false;
  for (let h = 0; h <= 24; h++) {
    const t = w0 + h * 3600, hr = at(t);
    const ra = rainOf(hr), ha = heavyOf(hr);
    if (ra > 0.05) anyRain = true;
    if (ha > 0.05) anyHeavy = true;
    const x = ((h / 24) * 100).toFixed(1);
    rainStops.push(`rgba(0,0,0,${ra.toFixed(2)}) ${x}%`);
    heavyStops.push(`rgba(0,0,0,${ha.toFixed(2)}) ${x}%`);
    if (h < 24 && hr && coverOf(hr) < 35 && /dark|twilight/.test(phaseAt(marks, t + 1800))) clearDark.push(h);
  }

  // One cloud per two-hour slot.
  let anyCloud = false;
  const clouds = [];
  for (let k = 0; k < 12; k++) {
    const t = w0 + (2 * k + 1) * 3600;
    const a = at(t - 1800), b = at(t + 1800);
    const cover = (coverOf(a) + coverOf(b)) / 2, rain = Math.max(rainOf(a), rainOf(b));
    const ph = phaseAt(marks, t);
    const dim = ph === 'dark' ? 0.45 : ph === 'twilight' ? 0.65 : ph === 'blue hour' ? 0.85 : 1;
    const left = (((2 * k + 1) / 24) * 100).toFixed(2);
    const high = k % 2 === 0;
    const anim = `--d:${(8 + (k * 7) % 5).toFixed(1)}s; --dl:${(-((k * 3.1) % 6)).toFixed(1)}s`;
    if (rain > 0.12) {
      anyCloud = true;
      clouds.push(`<i class="cl rain" style="left:${left}%; top:${high ? 3 : 11}%; --w:${(7 + 0.6 * rain).toFixed(2)}%; --o:${(0.75 + 0.25 * rain).toFixed(2)}; ${anim}"></i>`);
    } else if (cover >= 25) {
      anyCloud = true;
      const size = (5.2 + 2.4 * cl((cover - 25) / 70)).toFixed(2);   // 5.2–7.6% of the band: always within its 8.3% slot
      clouds.push(`<i class="cl" style="left:${left}%; top:${high ? 10 : 46}%; --w:${size}%; --o:${((0.55 + 0.45 * cl((cover - 25) / 60)) * dim).toFixed(2)}; ${anim}"></i>`);
    }
  }

  const mask = stops => { const g = `linear-gradient(to right, ${stops.join(', ')})`; return `-webkit-mask-image:${g}; mask-image:${g}`; };
  let seed = Math.floor(w0 / 86400);
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const stars = clearDark.flatMap(h => [0, 1].map(() => `<i class="star" style="left:${(((h + rnd()) / 24) * 100).toFixed(1)}%; top:${(12 + rnd() * 70).toFixed(0)}%; animation-delay:${(rnd() * 4).toFixed(1)}s"></i>`)).slice(0, 18).join('');
  bandSky.last = { cloud: anyCloud, rain: anyRain };
  return `<div class="band-sky" aria-hidden="true">
      ${stars}
      ${anyRain ? `<div class="sky-rain" style="${mask(rainStops)}"><i class="drops-far"></i><i class="drops-near"></i></div>` : ''}
      ${anyHeavy ? `<div class="sky-heavy" style="${mask(heavyStops)}"><i class="drops-near"></i></div>` : ''}
      ${clouds.join('')}
    </div>`;
}
/* ---------- the score gauge and the "What if?" lab ---------- */
export const G_R = 40, G_C = 2 * Math.PI * G_R, G_L = G_C * 240 / 360;   // a 240° arc
export const gaugeColor = sc => (sc >= 75 ? '#D9A066' : sc >= 50 ? '#B08A5E' : '#6E7480');
export function gauge(score, size = 92, cls = '') {
  const tick = val => {
    const a = (150 + 240 * val / 100) * Math.PI / 180;
    return `<line class="g-tick" x1="${(50 + 33 * Math.cos(a)).toFixed(1)}" y1="${(50 + 33 * Math.sin(a)).toFixed(1)}" x2="${(50 + 47 * Math.cos(a)).toFixed(1)}" y2="${(50 + 47 * Math.sin(a)).toFixed(1)}"/>`;
  };
  return `<span class="gauge ${cls}" style="--size:${size}px">
    <svg viewBox="0 0 100 100" aria-hidden="true">
      <circle class="g-track" cx="50" cy="50" r="${G_R}" stroke-dasharray="${G_L.toFixed(1)} ${G_C.toFixed(1)}" transform="rotate(150 50 50)"/>
      <circle class="g-value" cx="50" cy="50" r="${G_R}" stroke-dasharray="${(G_L * score / 100).toFixed(1)} ${G_C.toFixed(1)}" transform="rotate(150 50 50)" style="stroke:${gaugeColor(score)}"/>
      ${tick(50)}${tick(75)}
    </svg>
    <span class="g-num num" data-count="${score}">${score}</span>
  </span>`;
}
export function setGauge(root, score) {
  const val = $('.g-value', root), num = $('.g-num', root);
  if (!val || !num) return;
  val.setAttribute('stroke-dasharray', `${(G_L * score / 100).toFixed(1)} ${G_C.toFixed(1)}`);
  val.style.stroke = gaugeColor(score);
  num.textContent = String(score);
}
// What each kind of session's score is built from, as sliders you can move.
export function labModel(e) {
  const h = e.hour || {}, sp = e.spot, H = e.hunts?.[e.topHunt] || {};
  const cl = x => Math.max(0, Math.min(1, x));
  if (e.topHunt === 'colour') {
    const data = forecasts[sp.id];
    const hz = data ? horizonBlock(data, e.type, e.t) : null;
    const useTide = sp.coastal && sp.tide !== 'any' && e.tide;
    const sliders = [
      { id: 'low', label: 'Low cloud overhead', unit: '%', min: 0, max: 100, step: 1, value: Math.round(h.low ?? 0) },
      { id: 'mid', label: 'Mid cloud', unit: '%', min: 0, max: 100, step: 1, value: Math.round(h.mid ?? 0) },
      { id: 'high', label: 'High cloud', unit: '%', min: 0, max: 100, step: 1, value: Math.round(h.high ?? 0) },
      ...(hz ? [{ id: 'hz', label: `Cloud on the horizon, towards the ${e.type}`, unit: '%', min: 0, max: 100, step: 1, value: Math.round(hz.blk * 100) }] : []),
      ...(hz?.far != null ? [{ id: 'hzf', label: `Cloud 200–350 km towards the ${e.type}`, unit: '%', min: 0, max: 100, step: 1, value: Math.round(hz.far * 100) }] : []),
      { id: 'pp', label: 'Chance of rain', unit: '%', min: 0, max: 100, step: 1, value: Math.round(h.pp ?? 0) },
      { id: 'wind', label: 'Wind', unit: ' km/h', min: 0, max: 60, step: 1, value: Math.round(h.wind ?? 0) },
      ...(useTide ? [{ id: 'tide', label: `Tide height (you want ${sp.tide})`, unit: '%', min: 0, max: 100, step: 1, value: Math.round(e.tide.pos * 100) }] : []),
    ];
    const floor = spotFloor(sp, S().keepers, S().settings).floor;
    const run = v => baseScore({ ...h, low: v.low, mid: v.mid, high: v.high, pp: v.pp, wind: v.wind },
      useTide ? { ...e.tide, pos: v.tide / 100 } : (e.tide || null), sp, { ...(hz ? { horizon: { ...hz, blk: v.hz / 100, far: hz.far != null ? v.hzf / 100 : null } } : {}), canvasFloor: floor, aod: e.sky?.aod ?? null, clearing: e.sky?.clearing, deep: e.sky?.deep ?? null });
    return { sliders, score: v => run(v).score, reason: v => { const f = run(v).factors; return (f.find(x => x.k === 'bad') || f.find(x => x.k === 'good') || {}).t || ''; } };
  }
  if (e.topHunt === 'forest' && H.extra) {
    const x = H.extra;
    const sliders = [
      { id: 'tc', label: 'Cloud cover', unit: '%', min: 0, max: 100, step: 1, value: Math.round(x.tc) },
      { id: 'r24', label: 'Rain in the 24 hours before', unit: ' mm', min: 0, max: 20, step: 0.5, value: Math.round(x.r24 * 2) / 2 },
      { id: 'wind', label: 'Wind', unit: ' km/h', min: 0, max: 50, step: 1, value: Math.round(x.wind ?? 0) },
    ];
    const score = v => {
      const soft = cl((v.tc - 40) / 50), wet = cl((v.r24 + 0.5 * x.r48) / 6), windOK = 1 - 0.5 * cl((v.wind - 8) / 20);
      return Math.round(cl((100 * (0.45 * soft + 0.35 * wet + 0.2 * windOK) * x.now.f + (x.mist ? 10 : 0)) / 100) * 100);
    };
    const reason = v => (v.tc < 60 ? 'Thin cloud means harsh, dappled light under the canopy.' : v.r24 + 0.5 * x.r48 < 2 ? 'Dry foliage: the greens won\'t glow without recent rain.' : v.wind >= 20 ? 'Wind this strong blurs leaves on long exposures.' : 'Soft light on wet forest: the conditions you\'re after.');
    return { sliders, score, reason };
  }
  if (e.topHunt === 'waterfall' && H.extra) {
    const x = H.extra;
    const sliders = [
      { id: 'r72', label: 'Rain in the past 3 days', unit: ' mm', min: 0, max: 100, step: 1, value: Math.round(x.r72) },
      { id: 'tc', label: 'Cloud cover', unit: '%', min: 0, max: 100, step: 1, value: Math.round(x.tc) },
    ];
    const score = v => {
      const r7 = x.r7 == null ? null : Math.max(0, x.r7 + (v.r72 - x.r72));
      const flow = r7 == null ? cl(v.r72 / 15) : 0.7 * cl(v.r72 / 15) + 0.3 * cl(r7 / 40);
      const soft = cl((v.tc - 40) / 50), windOK = 1 - 0.5 * cl(((h.wind ?? 0) - 15) / 25), flood = v.r72 >= 80;
      return Math.round(100 * cl((0.55 * flow + 0.35 * soft + 0.1 * windOK) * x.now.f * (flood ? 0.5 : 1)));
    };
    const reason = v => (v.r72 >= 80 ? 'This much rain means flooding: brown water and dangerous access.' : v.r72 < 4 ? 'Little recent rain: expect a thin flow.' : v.tc < 60 ? 'Good flow, but bright sun will blow out the white water.' : 'Good flow under soft light.');
    return { sliders, score, reason };
  }
  return null;
}
export function openLab(key) {
  const e = eventIndex.get(key);
  const model = e && labModel(e);
  if (!model) { toast('Try other weather works for colour, forest and waterfall sessions.', 4500); return; }
  const start = Object.fromEntries(model.sliders.map(sl => [sl.id, sl.value]));
  const vals = { ...start };
  const base = model.score(start);
  openSheet(`
    <h2 class="bf-name">Try other weather</h2>
    <p class="bf-when">${esc(e.spot.name)}, ${esc(sessionName(e))}. Move a slider to see how the ${esc(huntWord(e.topHunt))} score responds.</p>
    <div class="lab-top">
      ${gauge(base, 118, 'big')}
      <div class="lab-read">
        <p class="lab-verdict" id="labVerdict"></p>
        <p class="lab-reason" id="labReason" aria-live="polite"></p>
      </div>
    </div>
    <div class="lab-sliders">
      ${model.sliders.map(sl => `<label class="slider">
        <span class="slider-head"><span>${esc(sl.label)}</span><output class="num" id="out_${sl.id}">${sl.value}${sl.unit}</output></span>
        <input type="range" data-lab-id="${sl.id}" min="${sl.min}" max="${sl.max}" step="${sl.step}" value="${sl.value}" style="--fc:${((sl.value - sl.min) / (sl.max - sl.min) * 100).toFixed(1)}%">
        <span class="slider-foot">Forecast: ${sl.value}${sl.unit}</span>
      </label>`).join('')}
    </div>
    <div class="row"><button class="btn" id="labReset">Back to the forecast</button></div>
    <p class="small muted">This is the conditions score for the session's leading hunt, before your personal score and the model-agreement check are applied${e.score !== base ? `, which is why it starts at ${base} rather than ${e.score}` : ''}.</p>`);
  const body = $('#sheetBody');
  const draw = () => {
    const sc = model.score(vals), d = sc - base;
    setGauge(body, sc);
    $('#labVerdict').textContent = `${sc >= 75 ? 'Go' : sc >= 50 ? 'Maybe' : 'Skip'}${d === 0 ? ', as forecast' : `, ${d > 0 ? 'up' : 'down'} ${Math.abs(d)} on the forecast`}`;
    $('#labReason').textContent = model.reason(vals);
  };
  $$('[data-lab-id]', body).forEach(inp => inp.oninput = () => {
    const sl = model.sliders.find(x => x.id === inp.dataset.labId);
    vals[sl.id] = Number(inp.value);
    $(`#out_${sl.id}`).textContent = `${inp.value}${sl.unit}`;
    inp.style.setProperty('--val', `${((vals[sl.id] - sl.min) / (sl.max - sl.min) * 100).toFixed(1)}%`);
    draw();
  });
  $$('[data-lab-id]', body).forEach(inp => inp.style.setProperty('--val', inp.style.getPropertyValue('--fc')));
  $('#labReset').onclick = () => {
    Object.assign(vals, start);
    $$('[data-lab-id]', body).forEach(inp => { const sl = model.sliders.find(x => x.id === inp.dataset.labId); inp.value = sl.value; inp.style.setProperty('--val', inp.style.getPropertyValue('--fc')); $(`#out_${sl.id}`).textContent = `${sl.value}${sl.unit}`; });
    draw();
  };
  draw();
}
// "Leave in 3 h 12 min", kept current while the page is open.
export function liveLine(e) {
  const now = Date.now() / 1000;
  const H = e.hunts?.[e.topHunt];
  if (e.type === 'day' && H?.from <= now && H?.to > now) return `Good light now, until ${fmtTime(H.to, e.offset)}`;
  if (e.leave - now > 36 * 3600) return `${hasDrive(e) ? 'Leave' : 'Be there'} ${fmtWeekday(e.leave, e.offset)} at ${fmtTime(e.leave, e.offset)}`;
  if (e.leave > now) return `${hasDrive(e) ? 'Leave' : 'Be there'} in ${untilText(e.leave - now)}`;
  if (e.t > now) return `Leave time has passed. ${TYPE_NAME[e.type]} in ${untilText(e.t - now)}`;
  if (e.type === 'day' && H?.to > now) return `Good light now, for about ${untilText(H.to - now)} more`;
  return 'Under way or finished';
}
export let homeTimer = null;      // keeps the Now line and the live line moving
export let bandRevealed = false;   // the band's reveal plays once per app open
// Light phases for a day, from the sun's real position at a reference place (home, or the first spot).
// Window runs 3am to 3am so a pre-dawn start and a late night both fit.
export const BAND = { night: '#10151F', twilight: '#1F2B45', blue: '#36507A', golden: '#C68A52', day: '#536A77' };
export function lightBand(w0, place) {
  const w1 = w0 + 86400;
  const pos = t => Math.max(0, Math.min(100, ((t - w0) / 86400) * 100));
  let marks = null;
  if (window.SunCalc && place) {
    const T = window.SunCalc.getTimes(new Date((w0 + 9 * 3600) * 1000), place.lat, place.lon);
    const ok = d => d instanceof Date && !isNaN(d);
    const sec = d => d.getTime() / 1000;
    if (['nightEnd', 'dawn', 'sunrise', 'goldenHourEnd', 'goldenHour', 'sunset', 'dusk', 'night'].every(k => ok(T[k]))) {
      marks = { nightEnd: sec(T.nightEnd), dawn: sec(T.dawn), sunrise: sec(T.sunrise), gEnd: sec(T.goldenHourEnd), gStart: sec(T.goldenHour), sunset: sec(T.sunset), dusk: sec(T.dusk), night: sec(T.night) };
    }
  }
  if (!marks) {   // no sun data: a plain 6am–8pm day
    const m = h => w0 + (h - 3) * 3600;
    marks = { nightEnd: m(4.5), dawn: m(5.5), sunrise: m(6), gEnd: m(7), gStart: m(18.5), sunset: m(19.5), dusk: m(20), night: m(21.5) };
  }
  const stops = [
    [BAND.night, w0], [BAND.night, marks.nightEnd], [BAND.twilight, (marks.nightEnd + marks.dawn) / 2], [BAND.blue, marks.dawn],
    [BAND.golden, marks.sunrise], [BAND.golden, marks.gEnd], [BAND.day, marks.gEnd + 3600], [BAND.day, marks.gStart - 3600],
    [BAND.golden, marks.gStart], [BAND.golden, marks.sunset], [BAND.blue, marks.dusk], [BAND.twilight, (marks.dusk + marks.night) / 2],
    [BAND.night, marks.night], [BAND.night, w1],
  ];
  return { gradient: `linear-gradient(to right, ${stops.map(([c, t]) => `${c} ${pos(t).toFixed(2)}%`).join(', ')})`, pos, marks };
}
// The light phase colour at any moment (used by the briefing's plan strip).
export function day3am(t, offset) {
  const d = new Date((t - 3 * 3600 + offset) * 1000);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000 - offset + 3 * 3600;
}
export const PHASE_COLOR = { dark: BAND.night, twilight: BAND.twilight, 'blue hour': BAND.blue, 'golden hour': BAND.golden, daylight: BAND.day };
export function phaseColor(place, t, offset) {
  return PHASE_COLOR[phaseAt(lightBand(day3am(t, offset), place).marks, t)] || BAND.night;
}
export const bandFill = s => (s >= 80 ? '#D9A066' : s >= 65 ? '#8F6B44' : s >= 50 ? '#36322D' : '#1A1F28');
export const bandInk = s => (s >= 80 ? '#1A130B' : '#ECE8E1');
export function huntPhrase(e) {
  const v = HUNT_VERB[e.topHunt];
  if (e.score >= 75) return e.topHunt === 'colour' ? (e.type === 'sunset' ? 'Worth the drive' : 'Worth the alarm') : `Go for ${v}`;
  if (e.score >= 50) return e.topHunt === 'colour' ? 'Worth a look' : `Maybe ${v}`;
  return 'Probably not worth it';
}
/* ---------- the session's sky: the real light at its moment, veiled by its cloud ---------- */
// Zenith and horizon colours for each light phase.
export const SKY = {
  dark: ['#090C13', '#161D2C'],
  twilight: ['#0E1424', '#2B3757'],
  'blue hour': ['#16223D', '#4C6893'],
  'golden hour': ['#252C47', '#E0A066'],
  daylight: ['#3F5866', '#A2B3B9'],
};
export const hexMix = (a, b, k) => {
  const p = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
  const A = p(a), B = p(b);
  return '#' + A.map((x, i) => Math.round(x + (B[i] - x) * k).toString(16).padStart(2, '0')).join('');
};
// The moment that defines a session's light: just after sunrise, just before sunset, its best hour otherwise.
export const lightMoment = e => e.t + (e.type === 'sunrise' ? 600 : e.type === 'sunset' ? -600 : 0);
export function skyPhase(e) {
  return phaseAt(lightBand(day3am(e.t, e.offset), e.spot).marks, lightMoment(e));
}
export function skyOf(e) {
  const [zen, hor] = SKY[skyPhase(e)] || SKY.dark;
  const h = e.hour || {};
  // Low and mid cloud grey the sky out; high cloud alone mostly doesn't.
  const veil = Math.min(1, Math.max(h.low ?? 0, (h.mid ?? 0) * 0.8) / 100) * 0.62;
  const grey = '#5E666C';
  const z = hexMix(zen, grey, veil * 0.6), hz = hexMix(hor, grey, veil);
  return `linear-gradient(to bottom, ${z} 0%, ${hexMix(z, hz, 0.42)} 52%, ${hz} 100%)`;
}
export const scoreTone = sc => (sc >= 75 ? 'tone-go' : sc >= 50 ? 'tone-maybe' : 'tone-skip');
export const skyClass = e => (/dark|twilight/.test(skyPhase(e)) ? 'sky-night' : skyPhase(e) === 'daylight' ? 'sky-day' : 'sky-low');
// What the sky is doing at a session, as a small icon and a word or two: the key to the week strip's colours.
export const G = (body) => `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
export const G_CLOUD = 'M7.5 18.5h9.2a3.6 3.6 0 0 0 .4-7.2 5 5 0 0 0-9.6 1.3 3 3 0 0 0 0 5.9z';
export const G_CLOUD_SM = 'M11 20h7a2.8 2.8 0 0 0 .3-5.6 3.9 3.9 0 0 0-7.5 1A2.3 2.3 0 0 0 11 20z';
export const G_HORIZON = 'M3 17.5h18M7.5 17.5a4.5 4.5 0 0 1 9 0';
export const G_RAYS_UP = 'M12 7.5V5M6.6 10.4 5 8.8M17.4 10.4 19 8.8';
export const G_SUN = '<circle cx="12" cy="12" r="3.6"/><path d="M12 4v1.6M12 18.4V20M4 12h1.6M18.4 12H20M6.3 6.3l1.1 1.1M16.6 16.6l1.1 1.1M6.3 17.7l1.1-1.1M16.6 7.4l1.1-1.1"/>';
export const G_MOON = '<path d="M17.5 14.6A6.5 6.5 0 0 1 9.4 6.5a6.5 6.5 0 1 0 8.1 8.1z"/>';
export function skyNow(e) {
  const h = e.hour || {};
  const low = h.low ?? 0, mid = h.mid ?? 0, high = h.high ?? 0;
  const total = h.total ?? Math.max(low, mid, high);
  const night = skyClass(e) === 'sky-night';
  if ((h.precip ?? 0) >= 0.3 || (h.pp ?? 0) >= 60) return { kind: 'rain', word: 'Showers' };
  if (e.topHunt === 'fog' || (h.vis != null && h.vis < 1500)) return { kind: 'fog', word: 'Fog' };
  if (low >= 70 || total >= 88) return { kind: 'cloudy', word: 'Overcast' };
  if (Math.max(mid, high) >= 30 && low < 40) return { kind: 'canvas', word: night ? 'High cloud' : 'Cloud to catch colour' };
  if (total >= 30) return { kind: 'part', word: 'Some cloud' };
  return { kind: 'clear', word: night ? 'Clear night' : 'Clear' };
}
export function skyGlyph(e) {
  const { kind } = skyNow(e);
  const golden = e.type === 'sunrise' || e.type === 'sunset';
  const night = e.type === 'night' || skyClass(e) === 'sky-night';
  const sun = night ? G_MOON : golden ? '<path d="M3 17.5h18M7.5 17.5a4.5 4.5 0 0 1 9 0"/><path d="M12 9.5V8M7.6 11.6l-1.1-1.1M16.4 11.6l1.1-1.1"/>' : G_SUN;
  if (kind === 'rain') return G(`<path d="${G_CLOUD}" transform="translate(0 -3)"/><path d="M9 18.5l-1 2.5M12.5 18.5l-1 2.5M16 18.5l-1 2.5"/>`);
  if (kind === 'fog') return G('<path d="M4 8.5h16M6 12.5h12M4 16.5h16"/>');
  if (kind === 'cloudy') return G(`<path d="${G_CLOUD}"/>`);
  if (kind === 'canvas') return G(golden ? '<path d="M3 17.5h18M7.5 17.5a4.5 4.5 0 0 1 9 0"/><path d="M4 7.5h7.5M14 5.5h6M9 11h9"/>' : `<g transform="translate(-2.4 -2.4) scale(.8)">${sun}</g><path d="M11 15.5h9M13.5 19h6"/>`);
  if (kind === 'part') return G(`<g transform="translate(-2.4 -2.4) scale(.8)">${sun}</g><path d="${G_CLOUD_SM}"/>`);
  return G(night ? `${G_MOON}<path d="M18.5 4.5v2M17.5 5.5h2"/>` : sun);
}
// A tiny mark for the session type, so each day's score says what it's for.
const TYPE_MARK = {
  sunrise: '<path d="M3 18h18M7.5 18a4.5 4.5 0 0 1 9 0"/><path d="M12 11V4.5M9 7.5l3-3 3 3"/>',
  sunset: '<path d="M3 18h18M7.5 18a4.5 4.5 0 0 1 9 0"/><path d="M12 4.5V11M9 8l3 3 3-3"/>',
  night: G_MOON,
  day: G_SUN,
};
const typeMark = type => `<svg class="wk-t" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${TYPE_MARK[type] || ''}</svg>`;
const WAVE_MARK = '<svg class="wk-t" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 15c2 0 2-1.5 4-1.5S8 15 10 15s2-1.5 4-1.5 2 1.5 4 1.5 2-1.5 4-1.5"/><path d="M3 11c1.5-4 5-6.5 9-6.5 2.5 0 4 1.5 4 3.5S14.5 10.5 13 10.5c-1.2 0-2-.8-2-1.8"/></svg>';
// All / Sunrise / Sunset above the week, plus Big seas when a coastal spot has it on.
export function weekFilter() {
  const types = [['all', 'All'], ['sunrise', 'Sunrise'], ['sunset', 'Sunset'], ...(anySeas() ? [['seas', 'Big seas']] : [])];
  return `<div class="wk-filter" role="group" aria-label="Show in the week">${types.map(([k, l]) => `<button class="${ui.weekType === k ? 'on' : ''}" data-weektype="${k}" aria-pressed="${ui.weekType === k}">${k === 'all' ? '' : k === 'seas' ? WAVE_MARK : typeMark(k)}${l}</button>`).join('')}</div>`;
}
export function weekStrip(allEvs, offset) {
  const now = Date.now() / 1000;
  const cells = [];
  const only = ui.weekType !== 'all' ? ui.weekType : null;
  const evs = only ? allEvs.filter(e => e.type === only) : allEvs;
  for (let i = 0; i < 7; i++) {
    const t = now + i * 86400;
    const best = evs.filter(e => e.dayIdx === i).sort((a, b) => b.score - a.score)[0];
    const wd = fmtWeekday(t, offset);
    const date = fmtDayDate(t, offset).split(' ')[1] || '';
    const label = i === 0 ? 'Today' : wd.slice(0, 3);
    const full = i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : `${wd} ${date}`;
    cells.push(`<button class="wk-d ${i === ui.homeDay ? 'on' : ''}" data-day="${i}" aria-pressed="${i === ui.homeDay}"
        aria-label="${esc(full)}${S().plans.some(p => evs.some(e => e.dayIdx === i && e.key === p.key)) ? ', you have a plan' : ''}${best ? `: best is ${best.score}, ${TYPE_NAME[best.type].toLowerCase()} at ${esc(best.spot.name)}, ${skyNow(best).word.toLowerCase()}` : ': no sessions'}">
      ${i === ui.homeDay ? '<span class="wk-hl" aria-hidden="true"></span>' : ''}<span class="wk-l">${label}<small class="num">${esc(date)}</small></span>
      <span class="wk-sky ${best ? `${skyClass(best)} ${scoreTone(best.score)}` : 'none'}" ${best ? `style="background:${skyOf(best)}"` : ''} aria-hidden="true">${best ? skyGlyph(best) : ''}</span>
      <span class="wk-s num ${best && best.score >= 75 ? 'go' : ''}" aria-hidden="true">${best ? `${only ? toneDot(best.score) : typeMark(best.type)}${best.score}` : '–'}</span>${S().plans.some(p => evs.some(e => e.dayIdx === i && e.key === p.key)) ? '<span class="wk-plan" aria-hidden="true"></span>' : ''}
    </button>`);
  }
  const seg = weekFilter();
  return `${seg}<nav class="week" aria-label="Choose a day">${cells.join('')}</nav>
    <details class="wk-key"><summary>${only ? `Showing ${only}s only · ` : ''}Key</summary><p><span>The sky at each day's best ${only || 'session'}${only ? '' : ` (${typeMark('sunrise')}sunrise, ${typeMark('sunset')}sunset)`}</span>
      <span class="wk-key-i">${G('<path d="M3 17.5h18M7.5 17.5a4.5 4.5 0 0 1 9 0"/><path d="M12 9.5V8M7.6 11.6l-1.1-1.1M16.4 11.6l1.1-1.1"/>')}Clear</span><span class="wk-key-i">${G('<path d="M3 17.5h18M7.5 17.5a4.5 4.5 0 0 1 9 0"/><path d="M4 7.5h7.5M14 5.5h6M9 11h9"/>')}High cloud</span><span class="wk-key-i">${G(`<path d="${G_CLOUD}"/>`)}Overcast</span><span class="wk-key-i">${G(`<path d="${G_CLOUD}" transform="translate(0 -3)"/><path d="M9 18.5l-1 2.5M12.5 18.5l-1 2.5M16 18.5l-1 2.5"/>`)}Rain</span><span class="wk-key-i">${G('<path d="M4 8.5h16M6 12.5h12M4 16.5h16"/>')}Fog</span></p></details>`;
}
// When to set the alarm: the leave time, less the time you need to get ready.
export const alarmAt = e => e.leave - (S().settings.readyMin ?? 30) * 60;
export const hasDrive = e => !!S().settings.home && e.drive != null;
// An alarm only makes sense for an early start: before 10am local.
export const alarmSensible = e => { const h = new Date((alarmAt(e) + e.offset) * 1000).getUTCHours(); return h < 10 || h >= 23; };
// "You're set" after planning, or "Planned" when coming back to a planned session.
export function commitPanel(e, justNow = false) {
  const o = e.offset;
  const early = hasDrive(e) && alarmSensible(e);
  const what = justNow
    ? (early ? `Set an alarm for <b class="num">${fmtTime(alarmAt(e), o)}</b>: adding it to your calendar does that for you.` : `Leave by <b class="num">${fmtTime(e.leave, o)}</b>. Add it to your calendar for a reminder.`)
    : (early ? `Alarm <b class="num">${fmtTime(alarmAt(e), o)}</b>, leave <b class="num">${fmtTime(e.leave, o)}</b>.` : `Leave by <b class="num">${fmtTime(e.leave, o)}</b>.`);
  return `<div class="commit" ${justNow ? 'role="status"' : ''}>
      <p class="commit-head"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg><span>Planned. ${what}</span></p>
      <div class="commit-actions">
        ${justNow
          ? `<button class="btn primary" data-ics-ev="${esc(e.key)}">${early ? 'Add alarm to calendar' : 'Add to calendar'}</button><button class="btn" data-goplans="${esc(e.key)}">See the plan</button>`
          : `<button class="btn primary" data-field="${esc(e.key)}">Field mode</button><button class="btn" data-ics-ev="${esc(e.key)}">Add to calendar</button>`}
      </div>
      ${justNow ? `<button class="link-btn" data-undo-plan="${esc(e.key)}">Undo</button>` : ''}
    </div>`;
}
export async function undoPlan(key) {
  const p = S().plans.find(x => x.key === key);
  if (!p) return;
  update(s => { s.plans = s.plans.filter(x => x.key !== key); });
  toast('Plan removed.');
  if (p.sharedTo?.length && p.sessionKey) { for (const c of p.sharedTo) await unshareFromCrew(c, p.sessionKey).catch(() => {}); loadCrew(); }
}
/* ================= little pictures: horizon scenes, spot tiles, crew avatars ================= */
// A small, repeatable random number from a string, so a scene or avatar looks the same every time.
export function seeded(str) {
  let h = 2166136261;
  for (const ch of String(str)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return () => { h = Math.imul(h ^ (h >>> 15), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909); return ((h ^= h >>> 16) >>> 0) / 4294967296; };
}
// The briefing's header when a spot has no photo: the horizon at that time, with the sun or moon
// where it will be (relative to the way you face, when the spot knows it) and the forecast's
// low, mid and high cloud drawn in as layers.
export function horizonScene(e) {
  const W = 400, H = 132, GROUND = 104;
  const rnd = seeded(e.key);
  const h = e.hour || {};
  const low = h.low ?? 0, mid = h.mid ?? 0, high = h.high ?? 0;
  const night = skyClass(e) === 'sky-night';
  const wet = (h.precip ?? 0) >= 0.3 || (h.pp ?? 0) >= 60;
  const foggy = e.topHunt === 'fog' || (h.vis != null && h.vis < 1500);
  // Where the sun sits across the picture: straight ahead is the middle; 90° either side is the edge.
  let sx = e.type === 'sunrise' ? 0.36 : e.type === 'sunset' ? 0.64 : 0.5;
  if (e.sunAz != null && e.spot.facing !== '' && e.spot.facing != null && !isNaN(Number(e.spot.facing))) {
    const d = ((e.sunAz - Number(e.spot.facing) + 540) % 360) - 180;
    sx = Math.max(0.08, Math.min(0.92, 0.5 + d / 180));
  }
  const sunX = sx * W, sunY = e.type === 'day' ? 34 : GROUND;
  const golden = e.type === 'sunrise' || e.type === 'sunset';
  // At sunrise and sunset, mid and high cloud catch the light: the colour you're there for.
  const lit = golden && low < 60;
  const out = [`<linearGradient id="litc" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#F6D2B0"/><stop offset="1" stop-color="#E8936A"/></linearGradient>`];
  // stars on dark skies, fewer under cloud
  if (night) {
    const n = Math.round(46 * (1 - Math.max(low, mid) / 100));
    for (let i = 0; i < n; i++) out.push(`<circle cx="${(rnd() * W).toFixed(1)}" cy="${(rnd() * (GROUND - 14)).toFixed(1)}" r="${(0.5 + rnd() * 0.9).toFixed(2)}" fill="#fff" opacity="${(0.35 + rnd() * 0.6).toFixed(2)}"/>`);
  }
  // the sun's glow, then the sun (or the moon at night)
  if (!night) {
    out.push(`<radialGradient id="glow" cx="${sunX}" cy="${sunY}" r="${e.type === 'day' ? 120 : 170}" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#FFE2B0" stop-opacity="${e.type === 'day' ? .45 : .7}"/><stop offset="1" stop-color="#FFE2B0" stop-opacity="0"/></radialGradient>`);
    out.push(`<rect width="${W}" height="${H}" fill="url(#glow)"/>`);
    out.push(`<circle cx="${sunX}" cy="${sunY}" r="${e.type === 'day' ? 11 : 15}" fill="#FFF1D6" opacity=".95"/>`);
  } else {
    out.push(`<path d="M${sunX + 9} ${30 - 12}a12 12 0 1 0 6 21 10 10 0 0 1-6-21z" fill="#F4EEE2" opacity=".9" transform="translate(${W * 0.22 - sunX} 0)"/>`);
  }
  // high cloud: thin streaks; mid: soft rows of puffs; low: a heavy band on the horizon
  const streaks = Math.round(high / 9);
  for (let i = 0; i < streaks; i++) {
    const x = rnd() * W, y = 8 + rnd() * 30, w = 50 + rnd() * 110;
    out.push(`<path d="M${x.toFixed(0)} ${y.toFixed(0)}h${w.toFixed(0)}" stroke="${lit ? '#F4C29E' : '#fff'}" stroke-width="${(1.2 + rnd() * 2).toFixed(1)}" stroke-linecap="round" opacity="${(lit ? 0.4 : 0.18) + rnd() * 0.22}"/>`);
  }
  const puffs = Math.round(mid / 7);
  for (let i = 0; i < puffs; i++) {
    const x = rnd() * W, y = 44 + rnd() * 26, r = 10 + rnd() * 14;
    out.push(`<ellipse cx="${x.toFixed(0)}" cy="${y.toFixed(0)}" rx="${(r * 2.2).toFixed(0)}" ry="${(r * 0.8).toFixed(0)}" fill="${night ? '#9AA6B8' : lit ? 'url(#litc)' : '#E9E4DC'}" opacity="${((lit ? 0.3 : 0.16) + rnd() * 0.16).toFixed(2)}"/>`);
  }
  if (low > 8) {
    const op = Math.min(0.85, 0.12 + low / 115);
    let d = `M0 ${GROUND + 2}`;
    for (let x = 0; x <= W; x += 25) d += ` Q${x + 12} ${GROUND - 26 - rnd() * 22 * (low / 100 + 0.3)} ${x + 25} ${GROUND - 8 - rnd() * 10}`;
    d += ` L${W} ${GROUND + 2}Z`;
    out.push(`<path d="${d}" fill="${night ? '#5E6878' : '#8D949A'}" opacity="${op.toFixed(2)}"/>`);
  }
  if (wet) for (let i = 0; i < 26; i++) { const x = rnd() * W, y = 60 + rnd() * 30; out.push(`<path d="M${x.toFixed(0)} ${y.toFixed(0)}l-4 12" stroke="#CFD8E0" stroke-width="1.2" opacity=".45"/>`); }
  // the land
  let land = `M0 ${H} L0 ${GROUND + 4}`;
  for (let x = 0; x <= W; x += 100) land += ` Q${x + 50} ${GROUND - 6 - rnd() * 10} ${x + 100} ${GROUND + rnd() * 4}`;
  land += ` L${W} ${H}Z`;
  out.push(`<path d="${land}" fill="#0E1114" opacity=".92"/>`);
  if (foggy) for (let i = 0; i < 3; i++) out.push(`<rect x="-20" y="${GROUND - 10 + i * 9}" width="${W + 40}" height="9" rx="4.5" fill="#E8EDF0" opacity="${0.22 - i * 0.04}"/>`);
  return `<svg class="bf-scene" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMax slice" aria-hidden="true">${out.join('')}</svg>`;
}
export function cloudChips(e) {
  const h = e.hour || {};
  const pct = v => `${Math.round(v ?? 0)}%`;
  return `<p class="bf-layers" aria-label="Cloud at ${esc(fmtTime(e.t, e.offset))}: high ${pct(h.high)}, mid ${pct(h.mid)}, low ${pct(h.low)}"><span>High <b class="num">${pct(h.high)}</b></span><span>Mid <b class="num">${pct(h.mid)}</b></span><span>Low <b class="num">${pct(h.low)}</b></span></p>`;
}
// A spot with no photo gets a tile: a sky for what you shoot there, and its icon.
export const HUNT_TILE = {
  colour: ['#2C3550', '#C98A55'], fog: ['#4B5862', '#AEB7BD'], storm: ['#262A3A', '#5E5874'], lightning: ['#1E2236', '#4B4870'],
  rainbow: ['#3E5568', '#C9A46B'], forest: ['#1F3A2F', '#5F7F5C'], waterfall: ['#1E3A40', '#5D8B8A'], aurora: ['#0E1A2C', '#2F7C6C'], astro: ['#0B1022', '#2B3560'],
};
export const HUNT_GLYPH = {
  colour: '<path d="M3 17.5h18M7.5 17.5a4.5 4.5 0 0 1 9 0"/><path d="M4 7.5h7.5M14 5.5h6M9 11h9"/>',
  fog: '<path d="M4 8.5h16M6 12.5h12M4 16.5h16"/>',
  storm: '<path d="M7.5 15.5h9.2a3.6 3.6 0 0 0 .4-7.2 5 5 0 0 0-9.6 1.3 3 3 0 0 0 0 5.9z"/><path d="M12.5 15.5 10.5 19h3l-2 3"/>',
  lightning: '<path d="M13 2 6 13h5l-1 9 7-12h-5z"/>',
  rainbow: '<path d="M3 17a9 9 0 0 1 18 0M6.5 17a5.5 5.5 0 0 1 11 0"/>',
  forest: '<path d="M12 3 6.5 11h3L6 16h12l-3.5-5h3z"/><path d="M12 16v4"/>',
  waterfall: '<path d="M5 4h14M8 4v12M12 4v14M16 4v11"/><path d="M5 20c2-1.5 4-1.5 7 0s5 1.5 7 0"/>',
  aurora: '<path d="M3 15c3-6 6-9 9-9s6 3 9 9"/><path d="M6 18c2-4 4-6 6-6s4 2 6 6" opacity=".7"/>',
  astro: '<path d="M4 20 20 4" opacity=".6"/><path d="M8 7l.8 1.7L10.5 9.5l-1.7.8L8 12l-.8-1.7L5.5 9.5l1.7-.8zM16.5 14.5l.6 1.3 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6z"/>',
};
export function spotTile(sp, cls = 'lib-img') {
  const k = huntsOf(sp)[0] || 'colour';
  const [a, b] = HUNT_TILE[k] || HUNT_TILE.colour;
  return `<span class="${cls} tile" style="--ta:${a};--tb:${b}" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${HUNT_GLYPH[k] || HUNT_GLYPH.colour}</svg></span>`;
}
// Crew avatars: initials on a colour that's the same for that person everywhere.
export const AVATAR_TONES = ['#C98A55', '#7E9BA6', '#8DA77F', '#B97B7B', '#A08CBF', '#C4A35A', '#5E9C95'];
export function avatar(name, size = 28) {
  const nm = String(name || '?').trim();
  if (nm === 'You') return `<span class="avatar you" style="--av:${size}px" title="You" aria-hidden="true">You</span>`;
  const parts = nm.split(/\s+/).filter(Boolean);
  const ini = (parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : nm.slice(0, 2)).toUpperCase();
  const tone = AVATAR_TONES[Math.floor(seeded(nm.toLowerCase())() * AVATAR_TONES.length)];
  return `<span class="avatar" style="--av:${size}px;--tone:${tone}" title="${esc(nm)}" aria-hidden="true">${esc(ini)}</span>`;
}
export const avatarStack = (names, size) => `<span class="avatars">${names.map(n => avatar(n, size)).join('')}</span>`;
// The call: one session, painted in its own light, with the times that matter and one thing to do.
export function callCard(e, nav = null) {
  const photo = coverUrl(e.spot);
  const planned = S().plans.some(p => p.key === e.key);
  const going = crewGoing(e);
  const o = e.offset;
  const lab = !!labModel(e);
  const times = [];
  const upcoming = e.leave > Date.now() / 1000;
  if (upcoming && hasDrive(e)) { if (alarmSensible(e)) times.push(['Alarm', fmtTime(alarmAt(e), o)]); times.push(['Leave', fmtTime(e.leave, o)]); }
  else if (upcoming && e.hike && e.walkStart) times.push(['Start walking', fmtTime(e.walkStart, o)]);
  else if (upcoming) times.push(['Be there by', fmtTime(e.leave, o)]);
  times.push([e.type === 'day' ? 'Good light' : TYPE_NAME[e.type], shortWhen(e)]);
  const pk = e.hunts?.[e.topHunt]?.peak;
  if (pk && Math.abs(pk - e.t) > 45 * 60) times.push([`${HUNT_LABEL[e.topHunt]} peak`, fmtTime(pk, o)]);
  const score = `<span class="num" data-count="${e.score}">${e.score}</span>`;
  return `<article class="call ${slideFrom ? `slide-${slideFrom}` : ''}" aria-labelledby="callVerdict">
    <div class="call-sky ${photo ? 'has-photo' : skyClass(e)}" data-ev="${esc(e.key)}" style="${photo ? `background-image:url('${photo}')` : `--sky:${skyOf(e)}`}">
      <div class="call-top">
        <h2 class="call-verdict" id="callVerdict">${esc(huntPhrase(e))}</h2>
        ${lab
          ? `<button class="call-score" data-lab="${esc(e.key)}" aria-label="Score ${e.score} out of 100. Try other weather">${score}<small>Try other weather</small></button>`
          : `<p class="call-score" role="img" aria-label="Score ${e.score} out of 100">${score}</p>`}
      </div>
      <div class="call-bottom">
        <div class="call-foot">
          <p class="call-spot">${esc(e.spot.name)}</p>
          <p class="call-when">${esc(cap(sessionName(e)))}${planned ? ' · <span class="your-plan">your plan</span>' : ''}</p>
        </div>
        ${nav && nav.total > 1 ? `<nav class="call-slide" aria-label="Sessions on this day, best first">
          <button class="slide-btn" data-step="-1" aria-label="Previous session" ${nav.index === 0 ? 'disabled' : ''}><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.5 6l-6 6 6 6"/></svg></button>
          <span class="slide-count num">${nav.index + 1}/${nav.total}</span>
          <button class="slide-btn" data-step="1" aria-label="Next session" ${nav.index === nav.total - 1 ? 'disabled' : ''}><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.5 6l6 6-6 6"/></svg></button>
        </nav>` : ''}
      </div>
    </div>
    <div class="call-body">
      <dl class="call-times">${times.map(([k, val]) => `<div><dt>${k}</dt><dd class="num">${val}</dd></div>`).join('')}</dl>
      <p class="call-live num" id="liveLeave">${esc(liveLine(e))}</p>
      <p class="call-why">${esc(whySentence(e))}</p>
      ${e.topHunt === 'colour' && e.confidence ? `<p class="note conf-${e.confidence.level}">${{ high: 'The weather models agree.', medium: 'The weather models roughly agree.', low: 'The weather models disagree, so treat this as a maybe.' }[e.confidence.level]}</p>` : ''}
      ${e.access && !e.access.inside ? '<p class="note conf-low">The tide blocks access for this session.</p>' : ''}
      ${going.length ? `<p class="note crew">${avatarStack(going, 22)}${esc(goingText(going))}.</p>` : ''}
      <div class="call-actions">${planned ? commitPanel(e) : `<button class="btn primary" data-plan="${esc(e.key)}">Plan this shoot</button><button class="btn" data-ev="${esc(e.key)}">Briefing</button>`}</div>
    </div>
  </article>`;
}
/* ---------- scrubbing the light band ---------- */
export function phaseAt(marks, t) {
  if (t < marks.nightEnd) return 'dark';
  if (t < marks.dawn) return 'twilight';
  if (t < marks.sunrise) return 'blue hour';
  if (t < marks.gEnd) return 'golden hour';
  if (t < marks.gStart) return 'daylight';
  if (t < marks.sunset) return 'golden hour';
  if (t < marks.dusk) return 'blue hour';
  if (t < marks.night) return 'twilight';
  return 'dark';
}
// The selected session's hunt, scored at another hour (where an hour-by-hour score makes sense).
export function scoreAtHour(e, data, i) {
  const h = data.hours[i], sp = e.spot;
  switch (e.topHunt) {
    case 'forest': return forestAt(data, i).score;
    case 'waterfall': return waterfallAt(data, i).score;
    case 'storm': case 'lightning': return Math.round(stormAt(h) * 100);
    case 'colour': return baseScore(h, sp.coastal ? tideInfo(data.hours, i) : null, sp).score;
    default: return null;
  }
}
export function scrubText(e, t, marks) {
  const data = forecasts[e.spot.id];
  const phase = phaseAt(marks, t);
  const head = `${fmtTime(t, e.offset)}, ${phase}`;
  if (!data) return { head, lines: [] };
  const i = nearestIndex(data.hours, t);
  if (i < 0) return { head, lines: [] };
  const h = data.hours[i];
  const lines = [
    `Low cloud ${Math.round(h.low ?? 0)}%, mid ${Math.round(h.mid ?? 0)}%, high ${Math.round(h.high ?? 0)}%`,
    `Rain ${Math.round(h.pp ?? 0)}%, wind ${Math.round(h.wind ?? 0)} km/h${h.temp != null ? `, ${Math.round(h.temp)}°C` : ''}`,
  ];
  const sc = scoreAtHour(e, data, i);
  if (sc != null) {
    const note = e.topHunt === 'colour' && !/golden|blue/.test(phase) ? ' (sky only: colour needs a low sun)' : '';
    lines.push(`${HUNT_LABEL[e.topHunt]} ${sc} at ${e.spot.name}${note}`);
  }
  return { head, lines };
}
export function wireScrub(v, w0, marks, sel) {
  const bandEl = $('.band', v), out = $('#scrub', v), line = $('#scrubLine', v);
  if (!bandEl || !out || !sel) return;
  let scrubbing = false, hideTimer = null, current = sel.t;
  const show = t => {
    current = Math.max(w0, Math.min(w0 + 86399, t));
    const f = (current - w0) / 86400 * 100;
    const { head, lines } = scrubText(sel, current, marks);
    out.innerHTML = `<strong>${esc(head)}</strong>${lines.map(l => `<span>${esc(l)}</span>`).join('')}`;
    out.hidden = false; line.hidden = false;
    line.style.left = `${f}%`;
    out.style.left = `${f}%`;
    out.dataset.edge = f < 22 ? 'left' : f > 78 ? 'right' : '';
    bandEl.setAttribute('aria-valuenow', String(Math.round((current - w0) / 60)));
    bandEl.setAttribute('aria-valuetext', `${head}. ${lines.join('. ')}`);
    clearTimeout(hideTimer);
  };
  const hideSoon = () => { clearTimeout(hideTimer); hideTimer = setTimeout(() => { out.hidden = true; line.hidden = true; }, 3500); };
  const tAt = x => { const r = bandEl.getBoundingClientRect(); return w0 + Math.max(0, Math.min(1, (x - r.left) / r.width)) * 86400; };
  bandEl.addEventListener('pointerdown', ev => {
    if (ev.target.closest('.band-mark')) return;
    scrubbing = true;
    try { bandEl.setPointerCapture(ev.pointerId); } catch {}
    show(tAt(ev.clientX));
  });
  bandEl.addEventListener('pointermove', ev => { if (scrubbing) show(tAt(ev.clientX)); });
  const end = () => { if (scrubbing) { scrubbing = false; hideSoon(); } };
  bandEl.addEventListener('pointerup', end);
  bandEl.addEventListener('pointercancel', () => { scrubbing = false; out.hidden = true; line.hidden = true; });
  // First time only: sweep the readout across a couple of hours to show the band can be dragged.
  if (!localStorage.getItem('tidelight:scrubHint') && motionOK()) {
    localStorage.setItem('tidelight:scrubHint', '1');
    const from = Math.max(w0 + 3600, Math.min(w0 + 86400 - 4 * 3600, sel.t)), t0 = performance.now() + 1600;
    const tick = now => {
      if (scrubbing || !bandEl.isConnected) return;
      const k = (now - t0) / 2600;
      if (k < 0) return requestAnimationFrame(tick);
      if (k >= 1) { hideSoon(); return; }
      show(from + Math.sin(k * Math.PI) * 3 * 3600);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
  bandEl.addEventListener('keydown', ev => {
    const step = { ArrowRight: 1800, ArrowLeft: -1800, PageUp: 3 * 3600, PageDown: -3 * 3600 }[ev.key];
    if (step) { ev.preventDefault(); show(current + step); hideSoon(); }
    else if (ev.key === 'Home') { ev.preventDefault(); show(w0); hideSoon(); }
    else if (ev.key === 'End') { ev.preventDefault(); show(w0 + 86399); hideSoon(); }
    else if (ev.key === 'Escape') { out.hidden = true; line.hidden = true; }
  });
}
/* ---------- swipe gestures ---------- */
export function onSwipe(el, left, right) {
  if (!el) return;
  let x0 = null, y0 = 0, t0 = 0;
  el.addEventListener('touchstart', e => { const t = e.touches[0]; x0 = t.clientX; y0 = t.clientY; t0 = Date.now(); }, { passive: true });
  el.addEventListener('touchend', e => {
    if (x0 == null) return;
    const t = e.changedTouches[0], dx = t.clientX - x0, dy = t.clientY - y0;
    x0 = null;
    if (Math.abs(dx) > 50 && Math.abs(dy) < Math.abs(dx) * 0.6 && Date.now() - t0 < 700) (dx < 0 ? left : right)();
  }, { passive: true });
}
export let slideFrom = '';   // 'left' | 'right': which way the detail panel should slide in after a change
// Spread markers that would overlap so each stays easy to tap. A pin on the band keeps each session's
// exact time; a marker only moves sideways as far as it needs to.
export function layoutBandMarks() {
  const bandEl = $('.band');
  if (!bandEl || !bandEl.clientWidth) return;
  const W = bandEl.clientWidth;
  const gap = (52 / W) * 100, edge = (24 / W) * 100;
  const marks = $$('.band-mark', bandEl).map(el => ({ el, x: parseFloat(el.dataset.pos) })).sort((a, b) => a.x - b.x);
  marks.forEach((m, i) => { m.p = Math.max(m.x, edge, i ? marks[i - 1].p + gap : -Infinity); });
  for (let i = marks.length - 1; i >= 0; i--) {
    const max = i === marks.length - 1 ? 100 - edge : marks[i + 1].p - gap;
    if (marks[i].p > max) marks[i].p = max;
  }
  marks.forEach(m => {
    m.el.style.left = `${m.p}%`;
    m.el.classList.toggle('nudged', Math.abs(m.p - m.x) > 0.5);
  });
  const label = $('.span-label', bandEl);
  if (label) {
    const hits = () => { const r = label.getBoundingClientRect(); return $$('.band-mark', bandEl).some(el => { const m = el.getBoundingClientRect(); return r.left < m.right + 2 && r.right > m.left - 2 && r.top < m.bottom && r.bottom > m.top; }); };
    const fits = () => label.getBoundingClientRect().width <= label.parentElement.getBoundingClientRect().width + 1;
    label.classList.remove('end', 'hide');
    if (!fits()) label.classList.add('hide');
    else if (hits()) { label.classList.add('end'); if (hits()) label.classList.add('hide'); }
  }
}
window.addEventListener('resize', () => { if (ui.tab === 'forecast') layoutBandMarks(); });
export async function renderForecast(v) {
  const st = S();
  if (!st.spots.length) return emptySpots(v);
  if (st.spots.some(s => !forecasts[s.id])) v.innerHTML = skeleton('home', `Reading the sky for ${st.spots.length} spot${st.spots.length > 1 ? 's' : ''}…`);
  const slowNote = setTimeout(() => { const el = $('.sk-status'); if (el) el.textContent = 'Taking longer than usual. The weather service is slow to answer; saved forecasts are used where it doesn\'t.'; }, 6000);
  const failed = await ensureForecasts().finally(() => clearTimeout(slowNote));
  if (ui.tab !== 'forecast') return;
  try { await ensureSeas(); } catch { /* big seas are extra: never block the forecast */ }
  if (ui.tab !== 'forecast') return;
  if (ui.weekType === 'seas' && !anySeas()) ui.weekType = 'all';
  const evs = nextDays(7);
  indexEvents(evs);
  const offset = evs[0]?.offset ?? -new Date().getTimezoneOffset() * 60;
  if (ui.homeDay == null || ui.homeDay > 6) ui.homeDay = nextLightDay(evs);

  const now = Date.now() / 1000;
  // With Sunrise or Sunset picked above the week, the whole day shows only that kind of session.
  const shown = e => ui.weekType === 'all' || e.type === ui.weekType;
  const dayEvs = evs.filter(e => e.dayIdx === ui.homeDay && shown(e)).sort((a, b) => b.score - a.score);
  const best = dayEvs[0];
  // A plan you've made on this day leads; otherwise the day's best session.
  const plannedKeys = new Set(st.plans.map(p => p.key));
  const myPlan = dayEvs.filter(e => plannedKeys.has(e.key)).sort((a, b) => a.t - b.t)[0];
  if (!ui.homeSel || !dayEvs.some(e => e.key === ui.homeSel)) ui.homeSel = (myPlan || best)?.key || null;
  const sel = dayEvs.find(e => e.key === ui.homeSel);
  const noData = st.spots.every(sp => !forecasts[sp.id]);
  const stale = !!bgRefresh;

  // The day is drawn for the place you're looking at: the chosen session's spot, in its own time zone,
  // with its own sunrise and sunset. Other spots that day sit at their own local clock time, so a 6am
  // sunrise in Canada and one in Victoria both show at 6am, whatever time zone the phone is in.
  const view = sel || best;
  const viewOff = view?.offset ?? offset;
  const place = view?.spot || st.settings.home || st.spots[0];
  const dayRef = now + ui.homeDay * 86400;
  const local = new Date((dayRef + viewOff) * 1000);
  const midnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) / 1000 - viewOff;
  const w0 = midnight + 3 * 3600;   // the day's 3am-to-3am window, local to that place
  const band = lightBand(w0, place);
  const at = (t, off) => band.pos(t + ((off ?? viewOff) - viewOff));   // a moment, placed by its own local clock
  const dateLine = fmtDayDate(dayRef, viewOff).split(' ').slice(1).join(' ');   // "11 Nov"
  const weekday = fmtWeekday(dayRef, viewOff);
  const dayName = ui.homeDay === 0 ? 'Today' : ui.homeDay === 1 ? 'Tomorrow' : weekday;

  // One marker per session type: the best spot for it. Daytime sessions also draw their window.
  const perType = SESSION_TYPES.map(type => dayEvs.find(e => e.type === type)).filter(Boolean);
  const counts = Object.fromEntries(SESSION_TYPES.map(t => [t, dayEvs.filter(e => e.type === t).length]));
  let spanTimes = '';
  const markers = perType.map((e, mi) => {
    const H = e.hunts?.[e.topHunt];
    const hasSpan = e.type === 'day' && H?.from && H.to > H.from;
    if (hasSpan) spanTimes = `${fmtTime(H.from, e.offset).replace(':00', '')}–${fmtTime(H.to, e.offset).replace(':00', '')}`;
    const span = hasSpan ? `<span class="band-span" style="left:${at(H.from, e.offset)}%; width:${Math.max(1, at(H.to, e.offset) - at(H.from, e.offset))}%"><b class="span-label">Good light ${spanTimes}</b></span>` : '';
    const more = counts[e.type] > 1 ? `<span class="band-more" aria-hidden="true">+${counts[e.type] - 1}</span>` : '';
    return `${span}<span class="band-pin" style="left:${at(e.t, e.offset)}%" aria-hidden="true"></span><button class="band-mark ${e.key === ui.homeSel ? 'on' : ''} ${plannedKeys.has(e.key) ? 'planned' : ''}" data-pos="${at(e.t, e.offset)}" style="left:${at(e.t, e.offset)}%; --i:${mi}; --fill:${bandFill(e.score)}; --ink:${bandInk(e.score)}" data-sel="${esc(e.key)}"
      aria-label="${TYPE_NAME[e.type]} at ${esc(e.spot.name)}, ${sessionWhen(e)}, score ${e.score}${counts[e.type] > 1 ? `, best of ${counts[e.type]} spots` : ''}${plannedKeys.has(e.key) ? ', planned' : ''}">${e.score}${more}</button>`;
  }).join('');
  const ticks = [[w0 + 3 * 3600, '6am'], [w0 + 9 * 3600, 'Noon'], [w0 + 15 * 3600, '6pm'], [w0 + 21 * 3600, 'Midnight']]
    .map(([t, l]) => `<span class="band-tick" style="left:${band.pos(t)}%">${l}</span>`).join('');
  const nowLine = now > w0 && now < w0 + 86400 ? `<span class="band-now" style="left:${band.pos(now)}%" aria-hidden="true"></span>` : '';

  const others = dayEvs.filter(e => e.key !== ui.homeSel).sort((a, b) => a.t - b.t);
  const order = [...dayEvs].sort((a, b) => b.score - a.score || a.t - b.t);   // slide order: best first
  const nextWithLight = [1, 2, 3, 4, 5, 6].map(d => ui.homeDay + d).find(d => d <= 6 && evs.some(e => e.dayIdx === d && shown(e)));

  const wireFilter = () => $$('[data-weektype]', v).forEach(b => b.onclick = () => {
    if (ui.weekType === b.dataset.weektype) return;
    ui.weekType = b.dataset.weektype;
    try { localStorage.setItem('tidelight:weekType', ui.weekType); } catch {}
    if (ui.weekType !== 'all' && ui.weekType !== 'seas') ui.homeSel = evs.filter(e => e.dayIdx === ui.homeDay && e.type === ui.weekType).sort((a, b) => b.score - a.score)[0]?.key || ui.homeSel;
    ui.homeAnimate = false;
    renderForecast(v).then(() => { if (ui.weekType === 'seas') window.scrollTo({ top: 0, behavior: motionOK() ? 'smooth' : 'auto' }); });
  });
  if (ui.weekType === 'seas') {
    v.innerHTML = `${forecastAlerts(st, failed)}${weekFilter()}${seasView()}`;
    wireFilter();
    wireSeasView(v, { onSpot: id => openSpotDetail(id), rerender: () => renderForecast(v) });
    return;
  }

  v.innerHTML = `
    ${forecastAlerts(st, failed)}
    ${weekStrip(evs, viewOff)}
    ${seasBanner()}
    <div class="home-grid ${ui.homeAnimate ? 'enter' : ''}">
    <header class="day-head-v2">
      <h1 class="day-title">${esc(dayName)}<span>${esc(ui.homeDay > 1 ? dateLine : `${weekday} ${dateLine}`)}</span></h1>
      <button class="here-pill" id="hereBtn" aria-label="Forecast right where you are, without saving a spot">${PIN_ICON}Right here</button>
      <p class="updated ${stale ? 'stale' : ''}">${navigator.onLine ? `${stale ? `Updating, saved ${savedAgo()}` : `Updated ${savedAgo()}`} ` : `Offline, saved ${savedAgo()} `}<button class="link-btn" id="refreshLink">Refresh</button></p>
    </header>
    ${sel ? callCard(sel, { index: order.findIndex(e => e.key === sel.key), total: order.length })
      : noData ? `<section class="call-empty"><p>No forecast to show yet.</p><p class="small muted">Tidelight shows nothing rather than guess. Try again in a minute.</p><button class="btn primary" id="retryEmpty">Try again</button></section>`
      : `<section class="call-empty"><p>${ui.homeDay === 0 ? (ui.weekType !== 'all' ? `Today's ${ui.weekType} is done.` : "Today's light is done.") : ui.weekType !== 'all' ? `No ${ui.weekType}s on this day.` : 'No sessions on this day.'}</p>${nextWithLight != null ? `<button class="btn" data-day="${nextWithLight}">Show ${nextWithLight === 1 ? 'tomorrow' : esc(fmtWeekday(now + nextWithLight * 86400, offset))}</button>` : ''}</section>`}
    <figure class="band-wrap">
      <div class="band ${bandRevealed ? '' : 'reveal'}" style="background:${band.gradient}" tabindex="0" role="slider"
        aria-label="${esc(dayName)}'s light, 3am to 3am. Drag, or use the arrow keys, to see conditions at any time." aria-valuemin="0" aria-valuemax="1440" aria-valuenow="0">
        ${bandSky(view, w0, band.marks)}
        ${nowLine}${markers}
        <span class="scrub-line" id="scrubLine" hidden></span>
        <div class="scrub" id="scrub" hidden></div>
      </div>
      <div class="band-ticks" aria-hidden="true">${ticks}</div>
      ${new Set(dayEvs.map(e => e.offset)).size > 1 ? `<p class="small muted band-tz">Your spots span time zones: every time is local to its spot, and the band shows ${esc(place.name || 'the chosen spot')}'s day.</p>` : ''}
      <details class="band-help">
        <summary>Reading the band</summary>
        <div class="band-key">
          <span><i style="background:${BAND.blue}"></i>Blue hour</span><span><i style="background:${BAND.golden}"></i>Golden hour</span><span><i style="background:${BAND.day}"></i>Daylight</span><span><i style="background:${BAND.night}"></i>Dark</span>${bandSky.last?.cloud ? '<span><b class="key-icon sky-key-cloud" aria-hidden="true"></b>Cloud</span>' : ''}${bandSky.last?.rain ? '<span><b class="key-icon sky-key-rain" aria-hidden="true"></b>Rain likely</span>' : ''}${spanTimes ? `<span><b class="key-span" aria-hidden="true"></b>Good light, ${spanTimes}</span>` : ''}
        </div>
        <p>The band is the day's real light, 3am to 3am. Each circle is the best spot for that session, with its score; +2 means two more spots are scored for it below.${sel ? ` Cloud and rain are drawn for ${esc(sel.spot.name)}.` : ''} Drag along the band to see any hour.</p>
      </details>
    </figure>
    ${others.length ? `<section class="others" aria-labelledby="othersTitle">
      <h2 class="others-title" id="othersTitle">${ui.weekType !== 'all' ? `Other ${ui.weekType}s` : 'Also'} ${ui.homeDay === 0 ? 'today' : ui.homeDay === 1 ? 'tomorrow' : `on ${esc(weekday)}`}</h2>
      ${others.map((e, oi) => `<button class="other-row" style="--i:${oi}" data-sel="${esc(e.key)}">
        ${coverUrl(e.spot)
          ? `<span class="other-sky has-photo ${scoreTone(e.score)}" style="background-image:url('${coverUrl(e.spot)}')"><b class="num">${e.score}</b></span>`
          : `<span class="other-sky ${skyClass(e)} ${scoreTone(e.score)}" style="background:${skyOf(e)}"><b class="num">${e.score}</b></span>`}
        <span class="other-name">${esc(e.spot.name)}<small>${TYPE_NAME[e.type]} ${shortWhen(e)}${e.topHunt !== 'colour' ? `, ${huntWord(e.topHunt)}` : ''}${unsure(e) ? ', models disagree' : ''}</small></span>
        <span class="other-verdict ${plannedKeys.has(e.key) ? 'planned' : e.score >= 75 ? 'go' : ''}">${plannedKeys.has(e.key) ? `${toneDot(100)}Planned` : `${toneDot(e.score)}${e.score >= 75 ? 'Go' : e.score >= 50 ? 'Maybe' : 'Skip'}`}</span>
      </button>`).join('')}
    </section>` : ''}
    <p class="small muted foot-note">Scores are estimates from forecast data. Check official warnings before heading out.</p>
    </div>`;

  bandRevealed = true;
  slideFrom = '';
  ui.homeAnimate = false;
  runCounts(v);
  clearInterval(homeTimer);
  homeTimer = setInterval(() => {
    if (ui.tab !== 'forecast' || !$('.band')) { clearInterval(homeTimer); return; }
    const n = Date.now() / 1000, nl = $('.band-now'), lv = $('#liveLeave');
    if (nl) nl.style.left = `${band.pos(n)}%`;
    if (lv && sel) { const txt = liveLine(sel); if (lv.textContent !== txt) lv.textContent = txt; }
  }, 15000);
  layoutBandMarks();
  wireScrub(v, w0, band.marks, sel);
  const pickDay = d => {
    if (d < 0 || d > 6 || d === ui.homeDay) return;
    const dir = d > ui.homeDay ? 'right' : 'left';
    ui.homeDay = d; ui.homeSel = null;
    if (ui.weekType !== 'all') ui.homeSel = evs.filter(e => e.dayIdx === d && e.type === ui.weekType).sort((a, b) => b.score - a.score)[0]?.key || null;
    transitionHome(v, dir);
  };
  wireFilter();
  $$('[data-day]', v).forEach(b => b.onclick = () => pickDay(Number(b.dataset.day)));
  const step = d => {
    const i = order.findIndex(e => e.key === ui.homeSel) + d;
    if (i < 0 || i >= order.length) return;
    ui.homeSel = order[i].key;
    transitionHome(v, d > 0 ? 'right' : 'left');
  };
  onSwipe($('.call', v), () => step(1), () => step(-1));
  onSwipe($('.day-head-v2', v), () => pickDay(ui.homeDay + 1), () => pickDay(ui.homeDay - 1));
  $$('[data-step]', v).forEach(b => b.onclick = () => step(Number(b.dataset.step)));
  $$('[data-sel]', v).forEach(b => b.onclick = () => {
    ui.homeSel = b.dataset.sel;
    renderForecast(v).then(() => { const d = $('.call'); if (d && b.classList.contains('other-row') && !matchMedia('(min-width: 1000px)').matches) d.scrollIntoView({ behavior: motionOK() ? 'smooth' : 'auto', block: 'start' }); });
  });
  $('#refreshLink', v).onclick = () => refreshForecasts($('#refreshLink', v));
  $('#hereBtn', v).onclick = () => openHere();
  const re = $('#retryEmpty', v); if (re) re.onclick = () => refreshForecasts(re);
}
// Redraw the Forecast after a day or session change. Where View Transitions exist, the call slides
// the way you moved and the week's highlight glides to the new day; elsewhere the call slides in by CSS.
export function transitionHome(v, dir) {
  const vt = document.startViewTransition && motionOK();
  if (!vt) { slideFrom = dir; ui.homeAnimate = false; return renderForecast(v); }
  document.documentElement.dataset.dir = dir === 'right' ? 'next' : 'prev';
  ui.homeAnimate = false; slideFrom = '';
  const t = document.startViewTransition(() => renderForecast(v));
  t.finished.finally(() => { delete document.documentElement.dataset.dir; });
}
// Fetch every spot's forecast again (the Refresh link on the Forecast page).
export async function refreshForecasts(btn, quiet = false) {
  if (btn) { btn.disabled = true; btn.textContent = 'Refreshing…'; }
  // Fetch everything fresh, but keep showing the saved forecast for any spot that doesn't load.
  const spots = S().spots;
  const { out, failed } = await fetchForecasts(spots, { force: true, all: spots });
  Object.assign(forecasts, out);
  if (Object.keys(out).length) { try { localStorage.setItem('tidelight:lastFetch', String(Date.now())); } catch {} forecastsLanded(); }
  if (spots.some(sp => huntsOf(sp).includes('aurora'))) fetchKp().then(setKp).catch(() => {});
  syncNow();
  if (!quiet || failed.length) toast(!failed.length ? 'Forecasts updated.'
    : !Object.keys(out).length ? `Couldn't reach the weather service. Showing the forecast saved ${savedAgo()}.`
    : `${failed.length} spot${failed.length === 1 ? '' : 's'} didn't load, so ${failed.length === 1 ? 'it shows its' : 'they show their'} saved forecast. Try again in a minute.`, 4000);
  if (ui.tab === 'forecast' || ui.tab === 'spots') render();
}
export const band = s => (s >= 75 ? 'b4' : s >= 50 ? 'b3' : 'b1');   // go, maybe, skip: the same cut-offs as the verdict
// The same go / maybe / skip, as a mark beside any score: filled for go, a ring for maybe, faint for skip.
export const toneOf = sc => (sc >= 75 ? 'go' : sc >= 50 ? 'maybe' : 'skip');
export const toneDot = sc => `<i class="tone-dot ${toneOf(sc)}" aria-hidden="true"></i>`;
