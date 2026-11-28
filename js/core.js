// Tidelight: Shared by every screen: screen state (ui), forecasts, the rule-based briefing, shared fragments and the sheet.
import { getState } from './storage.js?v=7.5.2';
import { clearCache, savedForecast, FORECAST_TTL, fetchKp, fetchForecasts } from './api.js?v=7.5.2';
import { huntsOf, setKp, HUNT_VERB, HUNT_ORDER, HUNT_LABEL } from './hunts.js?v=7.5.2';
import { evaluateSpot, hikeMinutes, hikeIsEstimate } from './scoring.js?v=7.5.2';
import { fmtDay, fmtTime, compass, esc, cap, haversineKm, tzOffset, deviceOffset } from './util.js?v=7.5.2';
import { huntPhrase, savedAgo, toneDot } from './forecast.js?v=7.5.2';
import { fieldState } from './field.js?v=7.5.2';
import { render } from './app.js?v=7.5.2';

export function $(sel, el = document) { return el.querySelector(sel); }
export function $$(sel, el = document) { return [...el.querySelectorAll(sel)]; }
export function S() { return getState(); }
// Screen state that several parts of the app read and change (kept in one object so any module can update it).
export const ui = {
  tab: 'forecast',
  map: null,             // the Spots map
  found: null,           // last place picked from search: { name, lat, lon, marker }
  onSheetClose: null,
  homeDay: null,
  weekType: (() => { try { const v = localStorage.getItem('tidelight:weekType'); return ['sunrise', 'sunset', 'seas'].includes(v) ? v : 'all'; } catch { return 'all'; } })(),   // the week strip: all sessions, or only sunrises / sunsets
  homeAnimate: true,
  tabChanged: true,
  homeSel: null,
  plansView: 'upcoming',
  focusPlanKey: null,
  youPage: null,
  lastScreen: 'Forecast',
};
export const forecasts = {};          // spotId -> normalized forecast
export const eventIndex = new Map();  // event key -> event
/* ================= data ================= */

// Opening the app: show the forecasts saved on this device straight away, then fetch fresh ones in
// the background and redraw when they arrive. Only spots with nothing saved make you wait.
export async function loadForecasts(force = false) {
  if (force) { clearCache(); for (const k in forecasts) delete forecasts[k]; }
  const spots = S().spots;
  const needKp = spots.some(sp => huntsOf(sp).includes('aurora'));
  const old = [];
  if (!force) for (const sp of spots) {
    if (forecasts[sp.id]) continue;
    const saved = savedForecast(sp);
    if (!saved) continue;
    forecasts[sp.id] = saved.data;
    if (Date.now() - saved.at >= FORECAST_TTL) old.push(sp);
  }
  const missing = spots.filter(sp => !forecasts[sp.id]);
  const kp = needKp ? fetchKp().then(setKp).catch(() => {}) : Promise.resolve();
  let failed = [];
  if (missing.length) {
    const [{ out, failed: bad }] = await Promise.all([fetchForecasts(missing, { force, all: spots }), kp]);
    Object.assign(forecasts, out);
    if (Object.keys(out).length) { try { localStorage.setItem('tidelight:lastFetch', String(Date.now())); } catch {} forecastsLanded(); }
    failed = bad.map(f => `${f.spot.name} (${f.error?.message || 'error'})`);
  }
  if (old.length) refreshInBackground(old);
  return failed;
}
// Fresh forecasts for spots that are showing saved ones. Redraws the page you're on when they land,
// unless you're in the middle of something (a sheet or field mode is open).
export let bgRefresh = null;
// A place's time zone: a spot's comes with its forecast; for anywhere else (home, a moon planner
// stand point) borrow the zone of the nearest spot within 250 km. null when nothing's close.
export function placeTz(p) {
  if (!p) return null;
  const id = p.spotId || p.id;
  if (id && forecasts[id]?.tz) return forecasts[id].tz;
  let best = null, bestKm = 250;
  for (const sp of S().spots) {
    const tz = forecasts[sp.id]?.tz;
    if (!tz) continue;
    const km = haversineKm(p, sp);
    if (km < bestKm) { best = tz; bestKm = km; }
  }
  return best;
}
// The UTC offset at a place at a moment: its own zone (daylight saving included), else its forecast's
// offset, else the phone's.
export function offsetFor(p, t = Date.now() / 1000) {
  const id = p?.spotId || p?.id;
  return tzOffset(placeTz(p), t) ?? (id && forecasts[id] ? forecasts[id].offset : null) ?? deviceOffset(t);
}
// Things that want to know when fresh forecasts arrive (shoot records note the latest score of upcoming plans).
// (A function, not a const, so modules can register while the app is still loading.)
export function freshHooks() { return freshHooks.list || (freshHooks.list = []); }
export function forecastsLanded() { freshHooks().forEach(f => { try { f(); } catch (e) { console.error(e); } }); }
export function refreshInBackground(spots) {
  if (bgRefresh || !navigator.onLine) return bgRefresh;
  document.body.classList.add('refreshing');
  const el = $('.updated'); if (el && ui.tab === 'forecast') el.firstChild.textContent = `Updating, saved ${savedAgo()} `;
  bgRefresh = fetchForecasts(spots, { force: true, all: S().spots })
    .then(({ out }) => {
      if (!Object.keys(out).length) return;
      Object.assign(forecasts, out);
      try { localStorage.setItem('tidelight:lastFetch', String(Date.now())); } catch {}
      forecastsLanded();
      const busy = !$('#sheet').classList.contains('hidden') || fieldState;
      if (!busy && (ui.tab === 'forecast' || ui.tab === 'spots')) render();
    })
    .catch(() => {})
    .finally(() => {
      bgRefresh = null; document.body.classList.remove('refreshing');
      const el2 = $('.updated'); if (el2 && ui.tab === 'forecast' && /^Updating/.test(el2.firstChild?.textContent || '')) el2.firstChild.textContent = `Updated ${savedAgo()} `;
    });
  return bgRefresh;
}
// One load at a time: anything that asks while forecasts are already loading waits for that same load.
export let loadingForecasts = null;
export async function ensureForecasts() {
  const missing = S().spots.some(s => !forecasts[s.id]);
  if (!missing) return [];
  if (!loadingForecasts) loadingForecasts = loadForecasts().finally(() => { loadingForecasts = null; });
  return loadingForecasts;
}
export function indexEvents(evs) { evs.forEach(e => eventIndex.set(e.key, e)); }
export function allEvents(opts) {
  const st = S();
  const out = [];
  for (const s of st.spots) {
    const d = forecasts[s.id];
    if (d) out.push(...evaluateSpot(s, d, st.keepers, st.settings, opts));
  }
  indexEvents(out);
  return out;
}
/* ================= rule-based briefing (works without AI) ================= */

// "47 min drive + 35 min hike"
export function travelText(e) {
  const parts = [];
  if (e.drive != null) parts.push(`${e.drive} min drive`);
  if (e.hike) parts.push(`${e.hike} min hike`);
  return parts.join(' + ');
}
// "3.2 km, moderate, about 58 min" for a spot
export function hikeSummary(sp) {
  const m = hikeMinutes(sp);
  if (!m && !sp.hikeKm && !sp.difficulty) return '';
  const bits = [];
  if (sp.hikeKm) bits.push(`${Number(sp.hikeKm)} km`);
  if (sp.difficulty) bits.push(sp.difficulty);
  if (m) bits.push(`${hikeIsEstimate(sp) ? 'about ' : ''}${m} min`);
  return `Hike: ${bits.join(', ')}`;
}
// Confidence applies to the colour score; show it when colour is what the session is about.
export function confLine(e) {
  const c = e.confidence;
  if (!c || e.topHunt !== 'colour') return '';
  const text = { high: 'High confidence: weather models agree', medium: 'Medium confidence: models roughly agree', low: 'Low confidence: models disagree' }[c.level];
  return `<div class="conf conf-${c.level}">${text}</div>`;
}
export const unsure = e => e.confidence?.level === 'low' && e.topHunt === 'colour';
export function verdict(e) {
  const v = e.score >= 75 ? 'Go' : e.score >= 50 ? 'Maybe' : 'Skip';
  if (v === 'Skip' || !e.topHunt || e.topHunt === 'colour') return v;
  return `${v} for ${HUNT_VERB[e.topHunt]}`;
}
// Hunts on this session in display order, e.g. [['fog', {score, factors}], ...]
export const huntList = e => HUNT_ORDER.filter(k => e.hunts && e.hunts[k]).map(k => [k, e.hunts[k]]);
// "tonight", "tomorrow sunrise", "fri 23 oct sunset"
export function sessionName(e) {
  // Lower-case only the relative words; "Tue 17 Nov" keeps its capitals.
  const day = fmtDay(e.dayT ?? e.t, e.offset).replace(/^(Today|Tomorrow|Yesterday)$/, d => d.toLowerCase());
  if (e.type === 'day') return `${day} daytime`;
  if (e.type !== 'night') return `${day} ${e.type}`;
  return day === 'today' ? 'tonight' : `${day} night`;
}
// For compact badges: the leading hunt plus any other worth noticing (40+). Hidden for plain colour-only sessions.
export const notableHunts = e => {
  const list = huntList(e).filter(([k, v]) => k === e.topHunt || v.score >= 40);
  return list.length > 1 || e.topHunt !== 'colour' ? list : [];
};
export function briefing(e) {
  const o = e.offset, h = e.hour, s = e.spot;
  const lines = [];
  lines.push(e.type === 'night' || e.type === 'day'
    ? `${huntPhrase(e)}. ${s.name} ${sessionName(e)}, best around ${fmtTime(e.t, o)}.`
    : `${huntPhrase(e)}. ${s.name} ${e.type} at ${fmtTime(e.t, o)}.`);
  if (e.drive != null) {
    lines.push(`Leave ${fmtTime(e.leave, o)} (${travelText(e)}${e.hike ? `, start walking ${fmtTime(e.walkStart, o)}` : ''}, on location ${S().settings.arriveBeforeMin} min early).`);
  } else if (e.hike) {
    lines.push(`Start walking by ${fmtTime(e.walkStart, o)} (${e.hike} min hike, on location ${S().settings.arriveBeforeMin} min early). Set your home under You, in Home and travel, to include the drive.`);
  } else {
    lines.push(`Be on location by ${fmtTime(e.leave, o)}. Set your home under You, in Home and travel, to get a leave time.`);
  }
  if (e.hike >= 10) {
    const dawn = e.light?.blueStart, dusk = e.light?.blueEnd;
    const kind = s.difficulty ? ` ${s.difficulty}` : '';
    if (e.type === 'sunrise' && dawn && e.walkStart < dawn) lines.push(`The${kind} walk in starts before first light: bring a headtorch and allow extra time on the trail.`);
    else if (e.type === 'sunset' && dusk && e.t + (20 + e.hike) * 60 > dusk) lines.push(`You'll walk the ${e.hike} min${kind} track back after dark: bring a headtorch.`);
    else if (e.type === 'night') lines.push(`Both walks on the${kind} track are in the dark: headtorch, spare batteries, and tell someone your plan.`);
  }
  const good = e.factors.filter(f => f.k === 'good').map(f => f.t);
  const bad = e.factors.filter(f => f.k === 'bad').map(f => f.t);
  if (good.length) lines.push(`In your favour: ${good.slice(0, 2).join('; ').toLowerCase()}.`);
  if (bad.length) lines.push(`Against you: ${bad.slice(0, 2).join('; ').toLowerCase()}.`);
  if (e.tide) {
    const turn = e.tide.low && (!e.tide.high || Math.abs(e.tide.low.t - e.t) < Math.abs(e.tide.high.t - e.t))
      ? `low tide at ${fmtTime(e.tide.low.t, o)}` : e.tide.high ? `high tide at ${fmtTime(e.tide.high.t, o)}` : null;
    lines.push(`Tide is ${Math.round(e.tide.pos * 100)}% of its range and ${e.tide.rising ? 'rising' : 'falling'}${turn ? `, ${turn}` : ''}.`);
  }
  if (s.coastal && h.wave != null) {
    lines.push(h.wave < 0.8
      ? `Sea is calm (${h.wave.toFixed(1)} m): try 10–30 s with an ND filter for glassy water.`
      : `Waves around ${h.wave.toFixed(1)} m: try 0.3–2 s to keep texture in the water, and watch the sets.`);
  }
  if ((h.high ?? 0) > 30 && (e.type === 'sunrise' || e.type === 'sunset')) {
    lines.push(e.type === 'sunset' ? 'Stay 15–20 min after sunset for afterglow on the high cloud.' : 'Arrive early: high cloud often lights up 15–20 min before sunrise.');
  }
  const H = e.hunts || {};
  if (H.fog && H.fog.score >= 45) {
    lines.push(e.spot.fogMode === 'above'
      ? 'Fog is a real chance: get to the lookout before first light, as valley fog often lifts within an hour of sunrise.'
      : 'Fog is a real chance: arrive in blue hour for soft layers, and use trees or posts as shapes against it.');
  }
  if (H.storm && H.storm.score >= 45) lines.push(`Storm potential ${H.storm.score} around ${fmtTime(H.storm.peak, o)}: watch the radar from mid-afternoon for building cells.`);
  if (H.lightning && H.lightning.score >= 45) lines.push(`Lightning window in the dark (${fmtTime(H.lightning.from, o)}–${fmtTime(H.lightning.to, o)}): try ISO 100–400, f/5.6–8 and 15–30 s exposures on a tripod.`);
  if (H.rainbow && H.rainbow.score >= 45) lines.push(`Rainbow chance around ${fmtTime(H.rainbow.peak, o)}: keep the sun at your back and look ${compass(H.rainbow.look)}.`);
  if (H.aurora && H.aurora.score >= 40) lines.push(`Aurora possible around ${fmtTime(H.aurora.peak, o)} (Kp ${H.aurora.kp.toFixed(1)}). Find a dark spot with a clear ${s.lat < 0 ? 'southern' : 'northern'} horizon; try ISO 1600–3200, f/2.8 and 5–15 s.`);
  if (H.forest && H.forest.score >= 40) {
    const x = H.forest.extra;
    const win = H.forest.to > H.forest.from ? `best ${fmtTime(H.forest.from, o)}–${fmtTime(H.forest.to, o)}` : `best around ${fmtTime(H.forest.from ?? e.t, o)}`;
    lines.push(`Rainforest: ${x.wet >= 0.7 ? 'wet, saturated greens' : x.wet >= 0.3 ? 'damp foliage' : 'dry foliage'} under ${Math.round(x.tc)}% cloud, ${win}. A polariser cuts the glare off wet leaves; bring a lens cloth.`);
  }
  if (H.waterfall && H.waterfall.score >= 40) {
    const x = H.waterfall.extra;
    lines.push(x.flood
      ? 'Waterfall: very heavy recent rain. Expect brown, flooding water and check for track closures before heading in.'
      : `Waterfall: ${x.flow >= 0.6 ? 'good flow' : 'modest flow'} after ${x.r72.toFixed(0)} mm in 3 days. Try 0.5–2 s for silky water with a polariser or ND, and watch your footing on wet rock.`);
  }
  if (H.astro && H.astro.score >= 40 && H.astro.core) lines.push(`Milky Way core ${Math.round(H.astro.core.alt)}° up in the ${compass(H.astro.core.az)} around ${fmtTime(H.astro.peak, o)}. Try ISO 3200–6400, f/2.8 or wider, and 15–20 s on a wide lens.`);
  if (e.access) {
    if (e.access.none) lines.push('Tide access: the tide never drops low enough around this session for safe access.');
    else {
      const when = e.access.openStart
        ? `Tide access is open; be back off the rocks by ${fmtTime(e.access.backBy, o)}`
        : `Tide access opens ${fmtTime(e.access.start, o)}; be back off the rocks by ${fmtTime(e.access.backBy, o)}`;
      lines.push(`${when}${e.access.inside ? '.' : ", which doesn't cover this session."}`);
    }
  }
  if ((H.storm?.score ?? 0) >= 45 || (H.lightning?.score ?? 0) >= 45) {
    lines.push('Stay safe: if thunder follows a flash within 30 seconds, you are within striking distance. Shoot from a hard-topped car or a building, and wait 30 minutes after the last thunder.');
  }
  if (e.alignment) lines.push(e.alignment.text + '.');
  return lines.join('\n');
}
/* ================= shared fragments ================= */

export function horizon(e, big = false, photo = null) {
  const bg = photo ? `;--img:url('${photo}')` : '';
  return `<div class="horizon ${big ? 'big' : ''} ${photo ? 'has-photo' : ''}" style="--p:${e.score}${bg}" aria-label="Score ${e.score} out of 100">${e.score}${toneDot(e.score)}</div>`;
}
export function chips(e) {
  const c = [];
  if (e.tide) {
    const p = e.tide.pos;
    const label = p < 0.25 ? 'Low tide' : p > 0.75 ? 'High tide' : `Mid tide, ${e.tide.rising ? 'rising' : 'falling'}`;
    c.push(`<span class="chip tide">${label}</span>`);
  }
  if (e.hour.wave != null) c.push(`<span class="chip">${e.hour.wave.toFixed(1)} m sea</span>`);
  c.push(`<span class="chip">${Math.round(e.hour.low ?? 0)}/${Math.round(e.hour.mid ?? 0)}/${Math.round(e.hour.high ?? 0)}% cloud</span>`);
  if (e.personal) c.push(`<span class="chip me">Your style ${e.personal.score}</span>`);
  if (unsure(e)) c.unshift(`<span class="chip unsure">Models disagree</span>`);
  if (e.access && !e.access.inside) c.unshift(`<span class="chip warn">Tide blocks access</span>`);
  const hl = notableHunts(e);
  if (hl.length) hl.slice().reverse().forEach(([k, v]) => c.unshift(`<span class="chip ${k === e.topHunt ? 'me' : ''}">${HUNT_LABEL[k]} ${v.score}</span>`));
  return c.join('');
}
export function eventRow(e, extra = '') {
  const o = e.offset;
  return `<button class="ev-card" data-ev="${esc(e.key)}">
    ${horizon(e)}
    <div class="ev-main">
      <div class="ev-title">${esc(e.spot.name)}</div>
      <div class="ev-sub"><span><strong>${cap(e.type)} ${fmtTime(e.t, o)}</strong></span><span>Leave ${fmtTime(e.leave, o)}</span>${extra}</div>
      <div class="chips">${chips(e)}</div>
    </div>
  </button>`;
}
/* ================= sheet ================= */


export function runSheetClose() {
  const fn = ui.onSheetClose; ui.onSheetClose = null;
  if (fn) fn();
}
export let sheetReturnFocus = null;   // what had focus before the sheet opened, so closing puts you back there
export const BEHIND_SHEET = ['.topbar', '#view', '.tabbar'];
export function openSheet(html) {
  runSheetClose();
  const wasOpen = !$('#sheet').classList.contains('hidden');
  if (!wasOpen) sheetReturnFocus = document.activeElement;
  const body = $('#sheetBody');
  body.innerHTML = html;
  // Name the dialog after its first heading, and move focus into it.
  const head = body.querySelector('h1, h2');
  if (head) { head.id = head.id || 'sheetTitle'; head.tabIndex = -1; $('#sheet').setAttribute('aria-labelledby', head.id); }
  else $('#sheet').removeAttribute('aria-labelledby');
  clearTimeout(sheetCloseTimer);
  $('#sheet').classList.remove('hidden', 'closing');
  $('.sheet-panel').style.transform = '';
  [...BEHIND_SHEET, '#field'].forEach(s => { const el = $(s); if (el) el.inert = true; });
  document.body.classList.add('noscroll');
  body.scrollTop = 0;
  requestAnimationFrame(() => (head || $('.sheet-close')).focus({ preventScroll: true }));
}
export let sheetCloseTimer = null;
export function closeSheet() {
  runSheetClose();
  const sheet = $('#sheet');
  const wasOpen = !sheet.classList.contains('hidden') && !sheet.classList.contains('closing');
  if (wasOpen) {
    sheet.classList.add('closing');
    clearTimeout(sheetCloseTimer);
    sheetCloseTimer = setTimeout(() => { sheet.classList.add('hidden'); sheet.classList.remove('closing'); $('.sheet-panel').style.transform = ''; }, 190);
  }
  if ($('#field')) $('#field').inert = false;
  if (!$('#field')) {
    BEHIND_SHEET.forEach(s => { const el = $(s); if (el) el.inert = false; });
    document.body.classList.remove('noscroll');
  }
  if (wasOpen && sheetReturnFocus?.isConnected) sheetReturnFocus.focus({ preventScroll: true });
  sheetReturnFocus = null;
}
(() => {
  const panel = $('.sheet-panel'), body = $('#sheetBody');
  if (!panel) return;
  let y0 = null, x0 = 0, dy = 0, dragging = false;
  panel.addEventListener('touchstart', ev => {
    const t = ev.touches[0];
    const r = panel.getBoundingClientRect();
    if (body.scrollTop > 0 && t.clientY - r.top > 56) { y0 = null; return; }
    if (ev.target.closest('input, textarea, select, .band, .dial, .tide, [type=range]')) { y0 = null; return; }
    y0 = t.clientY; x0 = t.clientX; dy = 0; dragging = false;
  }, { passive: true });
  panel.addEventListener('touchmove', ev => {
    if (y0 == null) return;
    const t = ev.touches[0];
    dy = t.clientY - y0;
    if (!dragging && (dy < 8 || Math.abs(t.clientX - x0) > dy)) { if (dy < 0) y0 = null; return; }
    dragging = true;
    panel.style.transition = 'none';
    panel.style.transform = `translateY(${Math.max(0, dy)}px)`;
  }, { passive: true });
  panel.addEventListener('touchend', () => {
    if (y0 == null) return;
    y0 = null;
    panel.style.transition = '';
    if (dragging && dy > Math.min(140, panel.offsetHeight * 0.25)) closeSheet();
    else panel.style.transform = '';
    dragging = false;
  }, { passive: true });
})();
