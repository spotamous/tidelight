import { getState, update, exportData, importData, resetAll } from './storage.js?v=2.5';
import { fetchSpotForecast, fetchHistorical, clearCache, fetchKp, fetchCurrent, fetchRadarFrames, WEATHER_TEXT, searchPlaces, fetchHourly, placeName } from './api.js?v=2.5';
import { nearestIndex, tideInfo, evaluateSpot, featureVector, similarity, personalModelSummary, MIN_KEEPERS } from './scoring.js?v=2.5';
import { loadAllPhotos, photoUrl, coverUrl, addPhotoFile, deletePhotos, clearPhotos, exportPhotos, importPhotos } from './photos.js?v=2.5';
import { HUNT_ORDER, HUNT_LABEL, HUNT_VERB, huntsOf, NIGHT_HUNTS, setKp } from './hunts.js?v=2.5';
import { initSync, isConfigured, syncStatus, onSyncStatus, signInWithPassword, createAccount, signOut, syncNow } from './sync.js?v=2.5';
import { hasAI, testKey, aiBriefing, briefingContext, aiAnalyzeReference, aiResultToFeatures, readExif, resizeImage } from './ai.js?v=2.5';
import { compass, esc, fmtTime, fmtDay, fmtDate, fmtDayDate, fmtWeekday, dayKey, cap, uid, toast, downloadFile, getPosition } from './util.js?v=2.5';

export const APP_VERSION = '2.5';

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const S = () => getState();

let tab = 'forecast';
let map = null;
let found = null;             // last place picked from search: { name, lat, lon, marker }
const forecasts = {};          // spotId -> normalized forecast
const eventIndex = new Map();  // event key -> event

/* ================= data ================= */

async function loadForecasts(force = false) {
  if (force) { clearCache(); for (const k in forecasts) delete forecasts[k]; }
  const spots = S().spots;
  const needKp = spots.some(sp => huntsOf(sp).includes('aurora'));
  const [res] = await Promise.all([
    Promise.allSettled(spots.map(s => fetchSpotForecast(s))),
    needKp ? fetchKp().then(setKp).catch(() => {}) : Promise.resolve(),
  ]);
  const failed = [];
  if (res.some(r => r.status === 'fulfilled')) { try { localStorage.setItem('tidelight:lastFetch', String(Date.now())); } catch {} }
  res.forEach((r, i) => {
    if (r.status === 'fulfilled') forecasts[spots[i].id] = r.value;
    else failed.push(`${spots[i].name} (${r.reason?.message || 'error'})`);
  });
  return failed;
}

async function ensureForecasts() {
  const missing = S().spots.some(s => !forecasts[s.id]);
  return missing ? loadForecasts() : [];
}

function indexEvents(evs) { evs.forEach(e => eventIndex.set(e.key, e)); }

function allEvents(opts) {
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

function verdict(e) {
  const v = e.score >= 75 ? 'Go' : e.score >= 50 ? 'Maybe' : 'Skip';
  if (v === 'Skip' || !e.topHunt || e.topHunt === 'colour') return v;
  return `${v} for ${HUNT_VERB[e.topHunt]}`;
}

// Hunts on this session in display order, e.g. [['fog', {score, factors}], ...]
const huntList = e => HUNT_ORDER.filter(k => e.hunts && e.hunts[k]).map(k => [k, e.hunts[k]]);
// "tonight", "tomorrow sunrise", "fri 23 oct sunset"
function sessionName(e) {
  const day = fmtDay(e.dayT ?? e.t, e.offset).toLowerCase();
  if (e.type !== 'night') return `${day} ${e.type}`;
  return day === 'today' ? 'tonight' : `${day} night`;
}

// For compact badges: the leading hunt plus any other worth noticing (40+). Hidden for plain colour-only sessions.
const notableHunts = e => {
  const list = huntList(e).filter(([k, v]) => k === e.topHunt || v.score >= 40);
  return list.length > 1 || e.topHunt !== 'colour' ? list : [];
};

function briefing(e) {
  const o = e.offset, h = e.hour, s = e.spot;
  const lines = [];
  lines.push(e.type === 'night'
    ? `${verdict(e)}. ${s.name} ${sessionName(e)}, best around ${fmtTime(e.t, o)}.`
    : `${verdict(e)}. ${s.name} ${e.type} at ${fmtTime(e.t, o)}.`);
  lines.push(e.drive != null
    ? `Leave ${fmtTime(e.leave, o)} (${e.drive} min drive, on location ${S().settings.arriveBeforeMin} min early).`
    : `Be on location by ${fmtTime(e.leave, o)}. Set your home location in Settings to get a leave time.`);
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
  if ((h.high ?? 0) > 30 && e.type !== 'night') {
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
  return lines.join(' ');
}

/* ================= shared fragments ================= */

function horizon(e, big = false, photo = null) {
  const bg = photo ? `;--img:url('${photo}')` : '';
  return `<div class="horizon ${big ? 'big' : ''} ${photo ? 'has-photo' : ''}" style="--p:${e.score}${bg}" aria-label="Score ${e.score} out of 100">${e.score}</div>`;
}

function chips(e) {
  const c = [];
  if (e.tide) {
    const p = e.tide.pos;
    const label = p < 0.25 ? 'Low tide' : p > 0.75 ? 'High tide' : `Mid tide, ${e.tide.rising ? 'rising' : 'falling'}`;
    c.push(`<span class="chip tide">${label}</span>`);
  }
  if (e.hour.wave != null) c.push(`<span class="chip">${e.hour.wave.toFixed(1)} m sea</span>`);
  c.push(`<span class="chip">${Math.round(e.hour.low ?? 0)}/${Math.round(e.hour.mid ?? 0)}/${Math.round(e.hour.high ?? 0)}% cloud</span>`);
  if (e.personal) c.push(`<span class="chip me">Your style ${e.personal.score}</span>`);
  if (e.access && !e.access.inside) c.unshift(`<span class="chip warn">Tide blocks access</span>`);
  const hl = notableHunts(e);
  if (hl.length) hl.slice().reverse().forEach(([k, v]) => c.unshift(`<span class="chip ${k === e.topHunt ? 'me' : ''}">${HUNT_LABEL[k]} ${v.score}</span>`));
  return c.join('');
}

function eventRow(e, extra = '') {
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

let onSheetClose = null;  // cleanup hook for the open sheet (e.g. discard unsaved spot photos)

function runSheetClose() {
  const fn = onSheetClose; onSheetClose = null;
  if (fn) fn();
}
function openSheet(html) {
  runSheetClose();
  $('#sheetBody').innerHTML = html;
  $('#sheet').classList.remove('hidden');
  document.body.classList.add('noscroll');
  $('#sheetBody').scrollTop = 0;
}
function closeSheet() {
  runSheetClose();
  $('#sheet').classList.add('hidden');
  document.body.classList.remove('noscroll');
}

/* ================= router ================= */

function setTab(t) { if (t === 'forecast' && tab !== 'forecast') forecastView = 'call'; tab = t; closeSheet(); render(); window.scrollTo(0, 0); }

function render() {
  if (map) { map.remove(); map = null; }
  $$('.tabbar button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  const v = $('#view');
  ({ forecast: renderForecast, spots: renderSpots, plans: renderPlans, coach: renderCoach, settings: renderSettings })[tab](v);
}

/* ================= forecast ================= */

function emptySpots(v) {
  v.innerHTML = `<div class="empty">
    <h1>Know before <em>the alarm.</em></h1>
    <p>Add the spots you shoot. Tidelight scores every sunrise and sunset for the next 7 days using sky, tide and sea, tells you when to leave, and learns which conditions you love.</p>
    <div class="row"><button class="btn primary" id="goAdd">Add your first spot</button></div>
  </div>`;
  $('#goAdd').onclick = () => { tab = 'spots'; render(); openSpotForm(); };
}

function savedAgo() {
  const t = Number(localStorage.getItem('tidelight:lastFetch') || 0);
  if (!t) return 'earlier';
  const mins = Math.round((Date.now() - t) / 60000);
  return mins < 60 ? `${mins} min ago` : mins < 48 * 60 ? `${Math.round(mins / 60)} h ago` : `${Math.round(mins / 1440)} days ago`;
}

const SUN_ICON = {
  night: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/></svg>',
  sunrise: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M3 18h18M7 18a5 5 0 0 1 10 0M12 7v3M12 7l-2 2M12 7l2 2M5 12l1.5 1M19 12l-1.5 1"/></svg>',
  sunset: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M3 18h18M7 18a5 5 0 0 1 10 0M12 10V7M12 10l-2-2M12 10l2-2M5 12l1.5 1M19 12l-1.5 1"/></svg>',
};


let forecastView = 'call';   // 'call' (best pick) or 'matrix' (all spots × sessions)
let matrixSel = null;          // selected session key in the matrix

// Sessions in the next 3 days (today, tomorrow, the day after), each tagged with its day index.
function next3Days() {
  const now = Date.now() / 1000;
  const out = [];
  for (const e of allEvents()) {
    const k = dayKey(e.dayT ?? e.t, e.offset);
    for (let i = 0; i < 3; i++) if (dayKey(now + i * 86400, e.offset) === k) { out.push({ ...e, dayIdx: i }); break; }
  }
  return out;
}

function heroTitle(e) {
  if (e.score >= 75) return e.topHunt === 'colour' ? 'Worth the <em>alarm.</em>' : `Go for <em>${HUNT_VERB[e.topHunt]}.</em>`;
  if (e.score >= 50) return e.topHunt === 'colour' ? 'Worth a <em>look.</em>' : `Maybe <em>${HUNT_VERB[e.topHunt]}.</em>`;
  return 'A quiet few <em>days.</em>';
}

function forecastAlerts(st, failed) {
  return `${!navigator.onLine ? `<div class="alert info">You're offline. Showing the forecast saved ${savedAgo()}.</div>` : ''}
    ${failed.length && navigator.onLine ? `<div class="alert danger">Couldn't load: ${esc(failed.join(', '))}. Check your connection and tap refresh.</div>` : ''}
    ${!st.settings.home ? `<div class="alert info">Set your home location in Settings to get drive-aware leave times.</div>` : ''}`;
}

async function renderForecast(v) {
  const st = S();
  if (!st.spots.length) return emptySpots(v);
  v.innerHTML = `<p class="loading">Reading the sky for ${st.spots.length} spot${st.spots.length > 1 ? 's' : ''}…</p>`;
  const failed = await ensureForecasts();
  if (tab !== 'forecast') return;
  const evs = next3Days();
  indexEvents(evs);
  if (forecastView === 'matrix') return renderMatrix(v, evs, st, failed);

  const ranked = [...evs].sort((a, b) => b.score - a.score);
  const best = ranked[0];
  if (!best) {
    v.innerHTML = `${forecastAlerts(st, failed)}<div class="empty"><h1>No sessions <em>yet.</em></h1><p>Check your spots have sunrise, sunset or a night hunt turned on.</p></div>`;
    return;
  }
  const o = best.offset;
  const photo = coverUrl(best.spot);
  const reason = (best.hunts?.[best.topHunt]?.factors || best.factors).find(f => f.k === 'good')?.t;
  const planned = S().plans.some(p => p.key === best.key);
  // Runners-up: prefer other spots first, so the list offers real alternatives.
  const rest = ranked.slice(1);
  const seen = new Set([best.spot.id]);
  const also = [];
  for (const e of rest) if (also.length < 3 && !seen.has(e.spot.id)) { also.push(e); seen.add(e.spot.id); }
  for (const e of rest) if (also.length < 3 && !also.includes(e)) also.push(e);
  also.sort((a, b) => b.score - a.score);
  const tag = e => e.access && !e.access.inside ? '<span class="also-tag warn">Tide blocks</span>'
    : e.dayIdx === 0 ? `<span class="also-tag hot">${e.type === 'night' ? 'Tonight' : 'Today'}</span>`
    : `<span class="also-tag">${HUNT_LABEL[e.topHunt]}</span>`;

  v.innerHTML = `
    ${forecastAlerts(st, failed)}
    <section class="call">
      <div class="call-photo ${photo ? '' : 'no-photo'}" style="--p:${best.score}">
        ${photo ? `<img src="${photo}" alt="${esc(best.spot.name)}">` : ''}
      </div>
      <div class="call-panel">
        <p class="eyebrow">${esc(cap(sessionName(best)))} — ${fmtTime(best.t, o)}</p>
        <div class="call-head">
          <h1>${heroTitle(best)}</h1>
          <div class="call-score"><span class="num">${best.score}</span><span>${esc(HUNT_LABEL[best.topHunt])} score</span></div>
        </div>
        <div class="call-spot">${esc(best.spot.name)}</div>
        <div class="call-meta">
          <span><strong>Leave ${fmtTime(best.leave, o)}</strong></span>
          ${best.drive != null ? `<span>${best.drive} min drive</span>` : ''}
          ${reason ? `<span>${esc(reason)}</span>` : ''}
        </div>
        ${best.access && !best.access.inside ? '<div class="call-warn">The tide blocks access for this session. Check the briefing.</div>' : ''}
        <div class="row call-actions">
          <button class="btn primary" data-ev="${esc(best.key)}">Read the briefing</button>
          <button class="btn" id="planBest" ${planned ? 'disabled' : ''}>${planned ? 'Planned' : 'Plan it'}</button>
        </div>
      </div>
    </section>

    ${also.length ? `<section class="also">
      <div class="also-head"><span class="eyebrow">Also worth the alarm</span><button class="link-btn" id="toMatrix">All 3 days</button></div>
      ${also.map(e => `<button class="also-row" data-ev="${esc(e.key)}">
          ${horizon(e, false, coverUrl(e.spot))}
          <span class="also-text">
            <span class="also-name">${esc(e.spot.name)}</span>
            <span class="also-sub">${esc(cap(sessionName(e)))} ${fmtTime(e.t, e.offset)}, ${esc(HUNT_LABEL[e.topHunt].toLowerCase())}</span>
          </span>
          ${tag(e)}
        </button>`).join('')}
    </section>` : `<div class="row"><button class="btn block" id="toMatrix">See all 3 days</button></div>`}
    <p class="small muted" style="margin-top:22px">Forecasts are estimates; always check official marine and weather warnings before heading out.</p>`;

  $('#toMatrix').onclick = () => { forecastView = 'matrix'; matrixSel = null; renderForecast(v); window.scrollTo(0, 0); };
  const pb = $('#planBest');
  if (pb) pb.onclick = () => { addPlan(best); pb.textContent = 'Planned'; pb.disabled = true; toast('Planned. Rate it afterwards so the coach learns.'); };
}

const band = s => (s >= 80 ? 'b4' : s >= 65 ? 'b3' : s >= 50 ? 'b2' : 'b1');

function renderMatrix(v, evs, st, failed) {
  const now = Date.now() / 1000;
  const offset = evs[0]?.offset ?? 0;
  const types = ['sunrise', 'sunset', 'night'];
  const cols = [];
  for (let i = 0; i < 3; i++) for (const type of types) if (evs.some(e => e.dayIdx === i && e.type === type)) cols.push({ i, type });
  const cell = new Map(evs.map(e => [`${e.spot.id}|${e.dayIdx}|${e.type}`, e]));
  const spotBest = sp => Math.max(-1, ...evs.filter(e => e.spot.id === sp.id).map(e => e.score));
  const spots = [...st.spots].sort((a, b) => spotBest(b) - spotBest(a));
  if (!matrixSel || !eventIndex.has(matrixSel) || !evs.some(e => e.key === matrixSel)) matrixSel = [...evs].sort((a, b) => b.score - a.score)[0]?.key || null;
  const sel = evs.find(e => e.key === matrixSel);
  const groups = [0, 1, 2].map(i => ({ i, n: cols.filter(c => c.i === i).length })).filter(g => g.n);
  const dayLabel = i => fmtDayDate(now + i * 86400, offset).split(' ')[0].toUpperCase();
  const typeName = { sunrise: 'Sunrise', sunset: 'Sunset', night: 'Night' };

  v.innerHTML = `
    <button class="link-btn back" id="toCall">← Best pick</button>
    <p class="eyebrow" style="margin-top:10px">Every spot, next 3 days</p>
    <h1>Where's the <em>light?</em></h1>
    ${forecastAlerts(st, failed)}
    <div class="mx-wrap">
      <div class="mx" style="grid-template-columns: 116px repeat(${cols.length}, 42px)">
        <span class="mx-corner"></span>
        ${groups.map(g => `<span class="mx-day" style="grid-column: span ${g.n}">${dayLabel(g.i)}</span>`).join('')}
        <span class="mx-corner"></span>
        ${cols.map(c => `<span class="mx-type" title="${typeName[c.type]}" aria-label="${typeName[c.type]}">${SUN_ICON[c.type]}</span>`).join('')}
        ${spots.map(sp => `
          <span class="mx-spot">${coverUrl(sp) ? `<img src="${coverUrl(sp)}" alt="">` : `<span class="mx-ph" aria-hidden="true">${esc(sp.name.charAt(0))}</span>`}<span>${esc(sp.name)}</span></span>
          ${cols.map(c => {
            const e = cell.get(`${sp.id}|${c.i}|${c.type}`);
            if (!e) return '<span class="mx-none" aria-hidden="true">–</span>';
            return `<button class="mx-cell ${band(e.score)} ${e.key === matrixSel ? 'sel' : ''}" data-mx="${esc(e.key)}" aria-label="${esc(sp.name)}, ${esc(sessionName(e))}, score ${e.score}">${e.score}${e.access && !e.access.inside ? '<i class="mx-tide" aria-hidden="true"></i>' : ''}</button>`;
          }).join('')}`).join('')}
      </div>
    </div>
    <div class="mx-legend">
      <span><i class="b4"></i>80+</span><span><i class="b3"></i>65–79</span><span><i class="b2"></i>50–64</span><span><i class="b1"></i>Under 50</span>
    </div>
    ${sel ? `<section class="mx-detail">
      ${coverUrl(sel.spot) ? `<img src="${coverUrl(sel.spot)}" alt="">` : `<span class="mx-detail-ph" aria-hidden="true"></span>`}
      <div>
        <p class="eyebrow">${esc(fmtDayDate(sel.dayT ?? sel.t, sel.offset))} — ${typeName[sel.type]} ${fmtTime(sel.t, sel.offset)}</p>
        <div class="mx-detail-name">${esc(sel.spot.name)}</div>
        <div class="small"><strong class="caramel">${esc(verdict(sel))}, ${sel.score}.</strong> <span class="muted">Leave ${fmtTime(sel.leave, sel.offset)}.${sel.access && !sel.access.inside ? ' Tide blocks access.' : ''}</span></div>
      </div>
    </section>
    <div class="row"><button class="btn primary block" data-ev="${esc(sel.key)}">Open the briefing</button></div>` : '<p class="muted">No sessions in the next 3 days.</p>'}
  `;
  $('#toCall').onclick = () => { forecastView = 'call'; renderForecast(v); window.scrollTo(0, 0); };
  $$('[data-mx]', v).forEach(b => b.onclick = () => {
    const keepScroll = $('.mx-wrap').scrollLeft;
    matrixSel = b.dataset.mx;
    renderMatrix(v, evs, st, failed);
    $('.mx-wrap').scrollLeft = keepScroll;
  });
}

/* ================= event detail ================= */

function openEvent(key) {
  const e = eventIndex.get(key);
  if (!e) return;
  const o = e.offset, h = e.hour, L = e.light;

  const tl = [{ t: e.leave, label: e.drive != null ? `Leave home (${e.drive} min drive)` : 'Be on location', cls: 'leave' }];
  if (L.blueStart) tl.push({ t: L.blueStart, label: 'Blue hour starts' });
  if (L.blueEnd) tl.push({ t: L.blueEnd, label: 'Blue hour ends' });
  if (L.goldenStart && e.type === 'sunset') tl.push({ t: L.goldenStart, label: 'Golden hour starts' });
  if (e.timeline) tl.push(...e.timeline); else tl.push({ t: e.t, label: cap(e.type), cls: 'key' });
  if (e.access && !e.access.none) {
    if (!e.access.openStart) tl.push({ t: e.access.start, label: 'Tide access opens' });
    tl.push({ t: e.access.backBy, label: 'Be back off the rocks', cls: 'leave' });
  }
  if (L.goldenEnd && e.type === 'sunrise') tl.push({ t: L.goldenEnd, label: 'Golden hour ends' });
  if (e.tide?.low && Math.abs(e.tide.low.t - e.t) < 4 * 3600) tl.push({ t: e.tide.low.t, label: 'Low tide' });
  if (e.tide?.high && Math.abs(e.tide.high.t - e.t) < 4 * 3600) tl.push({ t: e.tide.high.t, label: 'High tide' });
  tl.sort((a, b) => a.t - b.t);

  const planned = S().plans.some(p => p.key === e.key);
  const cond = [
    ['Low cloud', `${Math.round(h.low ?? 0)}%`], ['Mid cloud', `${Math.round(h.mid ?? 0)}%`], ['High cloud', `${Math.round(h.high ?? 0)}%`],
    ['Rain chance', h.pp != null ? `${Math.round(h.pp)}%` : '–'], ['Wind', h.wind != null ? `${Math.round(h.wind)} km/h` : '–'],
    ['Visibility', h.vis != null ? `${(h.vis / 1000).toFixed(0)} km` : '–'],
    ['Waves', h.wave != null ? `${h.wave.toFixed(1)} m` : '–'], ['Tide', e.tide ? `${Math.round(e.tide.pos * 100)}%` : '–'],
    ['Temp', h.temp != null ? `${Math.round(h.temp)}°C` : '–'],
    ['Dew point', h.dew != null ? `${Math.round(h.dew)}°C` : '–'], ['Humidity', h.rh != null ? `${Math.round(h.rh)}%` : '–'],
    ['Storm energy', h.cape != null ? `${Math.round(h.cape)} J/kg` : '–'],
  ];

  openSheet(`
    ${coverUrl(e.spot) ? `<img class="banner" src="${coverUrl(e.spot)}" alt="${esc(e.spot.name)}">` : ''}
    <div class="sheet-head">
      ${horizon(e, true)}
      <div><h2>${esc(e.spot.name)}</h2><div class="muted">${e.type === 'night' ? `${cap(sessionName(e))}, best around ${fmtTime(e.t, o)}` : `${fmtDay(e.t, o)}, ${e.type} at ${fmtTime(e.t, o)}`}</div><div class="verdict">${verdict(e)}</div></div>
    </div>
    <ul class="timeline">${tl.map(x => `<li class="${x.cls || ''}"><time>${fmtTime(x.t, o)}</time><span>${x.label}</span></li>`).join('')}</ul>

    <h3>Briefing</h3>
    <div class="brief" id="briefText">${esc(briefing(e))}</div>
    <div class="row"><button class="btn ghost" id="aiBriefBtn">Ask the AI coach</button></div>

    <h3>Why this score</h3>
    ${huntList(e).map(([k, v]) => `
      <div class="hunt ${k === e.topHunt ? 'top' : ''}">
        <div class="hunt-head"><span>${HUNT_LABEL[k]}</span><b>${v.score}</b></div>
        <div class="hunt-bar"><i style="width:${v.score}%"></i></div>
        <ul class="factors">${v.factors.map(f => `<li class="${f.k}">${esc(f.t)}</li>`).join('') || '<li>Nothing stands out either way.</li>'}</ul>
        ${k === 'lightning' ? '<button class="btn ghost small-btn" data-lightning>Open the lightning distance timer</button>' : ''}
      </div>`).join('')}
    <p class="small muted" style="margin-top:10px">${e.personal
      ? `Blended score: ${e.base} from conditions, ${e.personal.score} from your ${e.personal.n} keepers (${Math.round(e.personal.weight * 100)}% weight).`
      : `Add ${MIN_KEEPERS}+ keeper photos in Coach and this score will start reflecting your taste.`}</p>

    <h3>Conditions at ${e.type === 'night' ? fmtTime(e.t, o) : e.type}</h3>
    ${e.access && !e.access.inside ? `<div class="alert danger">${e.access.none ? 'The tide stays above your access level around this session.' : `Tide access window is ${fmtTime(e.access.start, o)} to ${fmtTime(e.access.backBy, o)}, which doesn't cover this session.`}</div>` : ''}
    <div class="cond-grid">${cond.map(([k, val]) => `<div><b>${val}</b><span>${k}</span></div>`).join('')}</div>

    <div class="row" style="margin-top:20px">
      <button class="btn primary" id="planBtn" ${planned ? 'disabled' : ''}>${planned ? 'Planned' : 'Plan this shoot'}</button>
      <button class="btn" id="icsBtn">Add to calendar</button>
    </div>
  `);

  $('#planBtn').onclick = () => {
    addPlan(e);
    $('#planBtn').textContent = 'Planned';
    $('#planBtn').disabled = true;
    toast('Planned. Rate it afterwards so the coach learns.');
  };
  $('#icsBtn').onclick = () => downloadIcs(e);
  $('#aiBriefBtn').onclick = async () => {
    const st = S();
    if (!hasAI(st.settings)) { toast('Add your Claude API key in Settings to use the AI coach'); return; }
    const btn = $('#aiBriefBtn'), box = $('#briefText');
    btn.disabled = true; btn.textContent = 'Thinking…';
    try {
      const text = await aiBriefing(st.settings, briefingContext(e, personalModelSummary(st.keepers)));
      box.textContent = text;
      btn.textContent = 'AI briefing';
    } catch (err) {
      toast(err.message, 5000);
      btn.disabled = false; btn.textContent = 'Ask the AI coach';
    }
  };
}

/* ================= plans ================= */

function addPlan(e) {
  update(s => {
    if (s.plans.some(p => p.key === e.key)) return;
    s.plans.push({
      id: uid(), key: e.key, spotId: e.spot.id, spotName: e.spot.name, lat: e.spot.lat, lon: e.spot.lon,
      type: e.type, t: e.t, leave: e.leave, offset: e.offset, score: e.score, features: e.features,
      brief: briefing(e), rating: null,
    });
  });
}

function icsText({ id, title, start, end, desc, lat, lon }) {
  const fmt = t => new Date(t * 1000).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const escI = s => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Tidelight//EN', 'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT', `UID:${id}@tidelight`, `DTSTAMP:${fmt(Date.now() / 1000)}`,
    `DTSTART:${fmt(start)}`, `DTEND:${fmt(end)}`, `SUMMARY:${escI(title)}`,
    `DESCRIPTION:${escI(desc)}`, `GEO:${lat};${lon}`, `LOCATION:${lat.toFixed(5)}\\, ${lon.toFixed(5)}`,
    'BEGIN:VALARM', 'TRIGGER:-PT15M', 'ACTION:DISPLAY', `DESCRIPTION:${escI(title)}`, 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR',
  ].join('\r\n');
}

function downloadIcs(e) {
  const txt = icsText({
    id: e.key.replace(/[^a-z0-9]/gi, ''), title: `Leave for ${e.spot.name} ${e.type} (${e.score})`,
    start: e.leave, end: e.t + 30 * 60, desc: briefing(e), lat: e.spot.lat, lon: e.spot.lon,
  });
  downloadFile(`tidelight-${e.type}.ics`, txt, 'text/calendar');
}

// How often the app's call matched your rating. A "go" call is a predicted score of 60+.
function hitStats(plans) {
  const rated = plans.filter(p => p.rating && p.rating !== 'meh');
  const bySpot = {};
  let hits = 0;
  for (const p of rated) {
    const hit = (p.score >= 60) === (p.rating === 'keeper');
    if (hit) hits++;
    const b = bySpot[p.spotName] ||= { name: p.spotName, total: 0, hits: 0 };
    b.total++; if (hit) b.hits++;
  }
  const mean = arr => arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : null;
  return {
    total: rated.length, hits,
    meh: plans.filter(p => p.rating === 'meh').length,
    keeperAvg: mean(plans.filter(p => p.rating === 'keeper').map(p => p.score)),
    dudAvg: mean(plans.filter(p => p.rating === 'dud').map(p => p.score)),
    bySpot: Object.values(bySpot).sort((a, b) => b.total - a.total),
  };
}

function hitPanel(st) {
  const h = hitStats(st.plans);
  const pct = h.total ? Math.round(h.hits / h.total * 100) : null;
  return `<section class="panel">
    <h2>How often it's right</h2>
    ${h.total < 3
      ? `<p class="muted">Rate ${3 - h.total} more session${3 - h.total === 1 ? '' : 's'} to see how accurate the app is for you. Every rating also trains your personal score.</p>`
      : `<div class="hit-big"><span class="num">${pct}%</span><span>${h.hits} of ${h.total} calls right</span></div>
         <p class="small muted">A call counts as right when a predicted 60+ delivered, or a predicted under 60 wasn't worth it.${h.meh ? ` ${h.meh} so-so session${h.meh === 1 ? '' : 's'} not counted.` : ''}</p>
         ${h.keeperAvg != null && h.dudAvg != null ? `<p class="small">Sessions that delivered averaged a predicted <strong>${h.keeperAvg}</strong>; ones that didn't averaged <strong>${h.dudAvg}</strong>. ${h.keeperAvg - h.dudAvg >= 15 ? 'A clear gap, so the score is telling them apart.' : 'Not much gap yet; more ratings will sharpen your personal score.'}</p>` : ''}
         ${h.bySpot.length > 1 ? `<div class="hit-spots">${h.bySpot.map(b => `<div><span>${esc(b.name)}</span><span class="num">${b.hits}/${b.total}</span></div>`).join('')}</div>` : ''}`}
  </section>`;
}

async function renderPlans(v) {
  const st = S();
  const now = Date.now() / 1000;
  const upcoming = st.plans.filter(p => p.t >= now - 3600).sort((a, b) => a.t - b.t);
  const past = st.plans.filter(p => p.t < now - 3600).sort((a, b) => b.t - a.t);
  const toRate = past.filter(p => !p.rating);
  const rated = past.filter(p => p.rating);

  const planRow = p => `<div class="plan">
    <div class="ev-title">${esc(p.spotName)}</div>
    <div class="ev-sub"><span><strong>${fmtDay(p.t, p.offset)}, ${p.type} ${fmtTime(p.t, p.offset)}</strong></span><span>Leave ${fmtTime(p.leave, p.offset)}</span><span>Score when planned: ${p.score}</span></div>
    <div class="row">
      <button class="btn" data-ics="${p.id}">Add to calendar</button>
      <button class="btn danger" data-del="${p.id}">Remove</button>
    </div></div>`;

  const rateRow = p => `<div class="plan">
    <div class="ev-title">${esc(p.spotName)}</div>
    <div class="ev-sub"><span><strong>${fmtDay(p.t, p.offset)}, ${p.type}</strong></span><span>Predicted ${p.score}</span></div>
    <p class="small muted" style="margin:6px 0 0">Did it deliver?</p>
    <div class="row">
      <button class="btn" data-rate="keeper" data-id="${p.id}">It delivered</button>
      <button class="btn" data-rate="meh" data-id="${p.id}">So-so</button>
      <button class="btn" data-rate="dud" data-id="${p.id}">Not worth it</button>
    </div></div>`;

  const label = { keeper: 'Delivered', meh: 'So-so', dud: 'Not worth it', skipped: 'Didn\'t go' };

  v.innerHTML = `
    <p class="eyebrow">Plans</p><h1>Sessions <em>ahead.</em></h1>
    ${hitPanel(st)}
    ${toRate.length ? `<section class="panel"><h2>Rate your sessions</h2><p class="muted small">Each rating teaches your personal score what a good morning looks like for you.</p>${toRate.map(rateRow).join('')}</section>` : ''}
    <section class="panel">
      <h2>Upcoming</h2>
      ${upcoming.length ? upcoming.map(planRow).join('') : '<p class="muted">Nothing planned. Open any forecast and tap "Plan this shoot".</p>'}
    </section>
    ${rated.length ? `<section class="panel"><h2>History</h2>${rated.slice(0, 30).map(p => `<div class="plan"><div class="ev-title">${esc(p.spotName)}</div><div class="ev-sub"><span>${fmtDay(p.t, p.offset)}, ${p.type}</span><span>Predicted ${p.score}</span><span><strong>${label[p.rating]}</strong></span></div></div>`).join('')}</section>` : ''}
  `;

  $$('[data-ics]', v).forEach(b => b.onclick = () => {
    const p = S().plans.find(x => x.id === b.dataset.ics);
    downloadFile(`tidelight-${p.type}.ics`, icsText({
      id: p.id, title: `Leave for ${p.spotName} ${p.type} (${p.score})`, start: p.leave, end: p.t + 1800,
      desc: p.brief || '', lat: p.lat, lon: p.lon,
    }), 'text/calendar');
  });
  $$('[data-del]', v).forEach(b => b.onclick = () => { update(s => { s.plans = s.plans.filter(p => p.id !== b.dataset.del); }); render(); });
  $$('[data-rate]', v).forEach(b => b.onclick = () => ratePlan(b.dataset.id, b.dataset.rate, b));

  // Log sessions you shot without planning them (last 2 days), so they can be rated too.
  if (!st.spots.length) return;
  await ensureForecasts();
  if (tab !== 'plans') return;
  const planned = new Set(S().plans.map(p => p.key));
  const recent = allEvents({ includePast: true })
    .filter(e => e.t < now - 3600 && e.t > now - 2 * 86400 && !planned.has(e.key))
    .sort((a, b) => b.t - a.t).slice(0, 8);
  if (!recent.length) return;
  v.insertAdjacentHTML('beforeend', `<section class="panel">
    <h2>Shot something unplanned?</h2>
    <p class="small muted">Log it here, then rate it above. Unplanned sessions count towards your hit rate too.</p>
    ${recent.map(e => `<div class="plan"><div class="ev-title">${esc(e.spot.name)}</div>
      <div class="ev-sub"><span><strong>${cap(sessionName(e))}</strong></span><span>Predicted ${e.score}</span></div>
      <div class="row"><button class="btn" data-log="${esc(e.key)}">I shot this</button></div></div>`).join('')}
  </section>`);
  $$('[data-log]', v).forEach(b => b.onclick = () => {
    const e = eventIndex.get(b.dataset.log);
    if (!e) return;
    addPlan(e);
    toast('Logged. Now rate it.');
    renderPlans(v);
  });
}

async function ratePlan(id, rating, btn) {
  const p = S().plans.find(x => x.id === id);
  if (!p) return;
  btn.disabled = true; btn.textContent = 'Saving…';
  let features = p.features;
  try {
    // Use what actually happened rather than what was forecast.
    const { hour, tide } = await fetchHistorical(p.lat, p.lon, new Date(p.t * 1000));
    features = featureVector(hour, tide);
  } catch { /* fall back to the forecast snapshot */ }
  update(s => {
    const pl = s.plans.find(x => x.id === id);
    pl.rating = rating;
    if (rating !== 'meh') {
      s.keepers.push({
        id: uid(), label: rating === 'keeper' ? 'keeper' : 'dud', source: 'session',
        date: p.t * 1000, lat: p.lat, lon: p.lon, spotName: p.spotName, features, thumb: null,
      });
    }
  });
  toast(rating === 'meh' ? 'Saved' : 'Saved. Your coach just learned from that.');
  render();
}

/* ================= spots ================= */

function renderSpots(v) {
  const st = S();
  v.innerHTML = `
    <p class="eyebrow">Spots</p><h1>Where you <em>shoot.</em></h1>
    <form class="search" id="placeSearch" role="search">
      <input type="search" id="placeQ" placeholder="Search a beach, landmark or town" autocomplete="off" enterkeyhint="search" aria-label="Search for a place">
      <button class="btn primary" type="submit">Search</button>
    </form>
    <div id="placeResults" class="results" hidden></div>
    <div id="map" role="application" aria-label="Map of your spots. Tap to add a spot."></div>
    <p class="small muted" style="margin-top:8px">Tap anywhere on the map to add a spot there.</p>
    <div class="row">
      <button class="btn primary" id="addSpot">Add spot</button>
      <button class="btn" id="hereSpot">Add where I am</button>
    </div>
    <section>
      ${st.spots.length ? st.spots.map(s => `
        <button class="spot-row" data-spot="${s.id}">
          ${coverUrl(s) ? `<img class="spot-thumb" src="${coverUrl(s)}" alt="">` : `<span class="spot-thumb empty" aria-hidden="true">${esc(s.name.charAt(0))}</span>`}
          <div class="spot-text"><div class="ev-title">${esc(s.name)}</div>
          <div class="ev-sub"><span>${(s.events || []).map(cap).join(' and ') || 'No events'}</span><span>${huntsOf(s).map(k => HUNT_LABEL[k]).join(', ')}</span></div></div>
          <span class="muted" aria-hidden="true">›</span>
        </button>`).join('') : '<p class="muted">No spots yet. Your favourite locations go here.</p>'}
    </section>`;

  $('#addSpot').onclick = () => openSpotForm();
  found = null;
  $('#placeSearch').onsubmit = ev => { ev.preventDefault(); runPlaceSearch(); };
  $('#hereSpot').onclick = async () => {
    try { const p = await getPosition(); openSpotForm(p); } catch (e) { toast(e.message, 4000); }
  };
  $$('[data-spot]', v).forEach(b => b.onclick = () => openSpotDetail(b.dataset.spot));

  if (window.L) {
    const home = st.settings.home;
    map = window.L.map('map', { zoomControl: false, attributionControl: true })
      .setView(home ? [home.lat, home.lon] : [10, 0], home ? 9 : 2);
    window.L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, className: 'base-tiles', attribution: '&copy; OpenStreetMap contributors',
    }).addTo(map);
    const pts = [];
    st.spots.forEach(s => {
      window.L.circleMarker([s.lat, s.lon], { radius: 9, color: '#0F1111', weight: 2, fillColor: '#D9A066', fillOpacity: 1 })
        .addTo(map).bindTooltip(s.name).on('click', ev => { window.L.DomEvent.stopPropagation(ev); openSpotDetail(s.id); });
      pts.push([s.lat, s.lon]);
    });
    if (home) window.L.circleMarker([home.lat, home.lon], { radius: 6, color: '#ECE8E1', fillColor: '#ECE8E1', fillOpacity: 1 }).addTo(map).bindTooltip('Home');
    if (pts.length > 1) map.fitBounds(pts, { padding: [30, 30], maxZoom: 12 });
    else if (pts.length === 1) map.setView(pts[0], 11);
    map.on('click', ev => {
      // Fine-tuning near a searched place keeps its name.
      const near = found && Math.abs(found.lat - ev.latlng.lat) < 0.03 && Math.abs(found.lon - ev.latlng.lng) < 0.03;
      openSpotForm({ lat: ev.latlng.lat, lon: ev.latlng.lng, name: near ? found.name : '' });
    });
    setTimeout(() => map && map.invalidateSize(), 60);
  }
}

let lastSearchAt = 0;
async function runPlaceSearch() {
  const q = $('#placeQ').value.trim();
  const box = $('#placeResults');
  if (!q) return;
  $('#placeQ').blur();
  box.hidden = false;
  box.innerHTML = '<p class="loading">Searching…</p>';
  let results = [];
  const coords = q.match(/^\s*(-?\d{1,2}(?:\.\d+)?)\s*[,\s]\s*(-?\d{1,3}(?:\.\d+)?)\s*$/);
  if (coords) {
    const lat = parseFloat(coords[1]), lon = parseFloat(coords[2]);
    if (lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) results = [{ name: '', detail: `${lat.toFixed(5)}, ${lon.toFixed(5)}`, lat, lon, isCoords: true }];
  } else {
    // OpenStreetMap asks for no more than one search a second.
    const wait = 1100 - (Date.now() - lastSearchAt);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastSearchAt = Date.now();
    try { results = await searchPlaces(q, S().settings.home); }
    catch (e) { box.innerHTML = `<p class="muted small">Search isn't available right now. You can still tap the map or paste coordinates like -38.49, 144.88.</p>`; return; }
  }
  if (!results.length) {
    box.innerHTML = '<p class="muted small">No places found. Try adding the area, like "Pulpit Rock, Cape Schanck", or paste coordinates.</p>';
    return;
  }
  box.innerHTML = results.map((r, i) => `<button type="button" class="result" data-res="${i}">
      <span class="r-name">${esc(r.isCoords ? 'Go to these coordinates' : r.name)}</span>
      <span class="r-detail">${esc(r.detail)}</span>
    </button>`).join('') + '<button type="button" class="result-close" id="closeResults">Close results</button>';
  $$('[data-res]', box).forEach(b => b.onclick = () => { box.hidden = true; showFoundPlace(results[+b.dataset.res]); });
  $('#closeResults').onclick = () => { box.hidden = true; };
}

function showFoundPlace(r) {
  if (!map || !window.L) { openSpotForm({ lat: r.lat, lon: r.lon, name: r.name }); return; }
  if (found?.marker) found.marker.remove();
  map.setView([r.lat, r.lon], 15);
  const marker = window.L.circleMarker([r.lat, r.lon], { radius: 11, color: '#ECE8E1', weight: 3, fillColor: '#D9A066', fillOpacity: 1 }).addTo(map);
  marker.bindPopup(`<div class="pop">
      <strong>${esc(r.name || 'Dropped pin')}</strong>
      <button type="button" class="btn primary small-btn" data-add-here>Add spot here</button>
      <span>Or tap the map nearby to place it exactly.</span>
    </div>`, { closeButton: false, minWidth: 200 }).openPopup();
  found = { name: r.name, lat: r.lat, lon: r.lon, marker };
  $('#map').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function openSpotForm(prefill = {}, existing = null) {
  const s = existing || {
    name: prefill.name ?? '', lat: prefill.lat ?? '', lon: prefill.lon ?? '', events: ['sunrise', 'sunset'],
    coastal: true, tide: 'any', driveMin: '', facing: '', notes: '',
  };
  const num = x => (x === '' || x == null ? '' : Number(x).toFixed(5));
  openSheet(`
    <h2>${existing ? 'Edit spot' : 'New spot'}</h2>
    <form id="spotForm" class="form" novalidate>
      <label>Name<input name="name" required value="${esc(s.name)}" placeholder="e.g. North jetty"></label>
      <fieldset>
        <legend>Photos</legend>
        <span class="hint">The first photo is the cover. Tap a photo to make it the cover.</span>
        <div class="photo-grid" id="photoGrid"></div>
        <label class="btn ghost" id="addPhotosBtn">Add photos<input type="file" id="spotPhotos" class="file-input" accept="image/*" multiple></label>
      </fieldset>
      <div class="two">
        <label>Latitude<input name="lat" inputmode="decimal" required value="${num(s.lat)}"></label>
        <label>Longitude<input name="lon" inputmode="decimal" required value="${num(s.lon)}"></label>
      </div>
      <fieldset><legend>Shoot at</legend>
        <div class="checks">
          <label class="check"><input type="checkbox" name="ev_sunrise" ${s.events.includes('sunrise') ? 'checked' : ''}> Sunrise</label>
          <label class="check"><input type="checkbox" name="ev_sunset" ${s.events.includes('sunset') ? 'checked' : ''}> Sunset</label>
        </div>
      </fieldset>
      <fieldset><legend>What to hunt for here</legend>
        <span class="hint">Each one gets its own score. The session shows the best of them.</span>
        <div class="checks">
          ${HUNT_ORDER.map(k => `<label class="check"><input type="checkbox" name="hunt_${k}" ${huntsOf(s).includes(k) ? 'checked' : ''}> ${HUNT_LABEL[k]}</label>`).join('')}
        </div>
      </fieldset>
      <label>For fog, this spot is<select name="fogMode">
        <option value="in" ${s.fogMode !== 'above' ? 'selected' : ''}>In the fog (forest, jetty, paddock)</option>
        <option value="above" ${s.fogMode === 'above' ? 'selected' : ''}>Above the fog (lookout over a valley)</option>
      </select></label>
      <label class="check"><input type="checkbox" name="coastal" ${s.coastal ? 'checked' : ''}> Coastal spot (use tide and wave data)</label>
      <label class="check"><input type="checkbox" name="tideAccess" ${s.tideAccess ? 'checked' : ''}> Access depends on the tide (rock shelf, cave, sandbar)</label>
      <div class="two">
        <label>Open below (% of tide range)<span class="hint">0 = low tide, 100 = high</span><input name="accessPct" inputmode="numeric" value="${s.accessPct ?? 40}"></label>
        <label>Safety buffer (min)<span class="hint">Be back this long before it closes</span><input name="accessBuffer" inputmode="numeric" value="${s.accessBuffer ?? 30}"></label>
      </div>
      <label>Best tide<select name="tide">
        ${['any', 'low', 'mid', 'high'].map(t => `<option value="${t}" ${s.tide === t ? 'selected' : ''}>${cap(t)}</option>`).join('')}
      </select></label>
      <div class="two">
        <label>Drive time (min)<span class="hint">Blank = estimate from home</span><input name="driveMin" inputmode="numeric" value="${s.driveMin ?? ''}"></label>
        <label>Facing (°)<span class="hint">Your composition's compass bearing, optional</span><input name="facing" inputmode="numeric" value="${s.facing ?? ''}"></label>
      </div>
      <label>Notes<textarea name="notes" placeholder="Access, parking, hazards, compositions">${esc(s.notes || '')}</textarea></label>
      <div class="row">
        <button type="submit" class="btn primary">${existing ? 'Save spot' : 'Add spot'}</button>
        <button type="button" class="btn ghost" data-close>Cancel</button>
      </div>
      ${existing ? '<div class="row"><button type="button" class="btn danger" id="delSpot">Delete spot</button></div>' : ''}
    </form>`);

  // Photos: work on a copy; only commit on save, discard new uploads if the sheet is closed.
  const original = [...(existing?.photos || [])];
  let photos = [...original];
  const added = new Set();
  let saved = false;
  onSheetClose = () => { if (!saved) deletePhotos([...added]); };

  const drawPhotos = () => {
    $('#photoGrid').innerHTML = photos.map((id, i) => `
      <div class="ph-tile ${i === 0 ? 'cover' : ''}">
        <button type="button" class="ph-pick" data-cover="${id}" aria-label="${i === 0 ? 'Cover photo' : 'Make cover photo'}">
          <img src="${photoUrl(id)}" alt="">
        </button>
        ${i === 0 ? '<span class="ph-badge">Cover</span>' : ''}
        <button type="button" class="ph-x" data-unphoto="${id}" aria-label="Remove photo">×</button>
      </div>`).join('');
    $$('[data-cover]', $('#photoGrid')).forEach(b => b.onclick = () => {
      photos = [b.dataset.cover, ...photos.filter(x => x !== b.dataset.cover)]; drawPhotos();
    });
    $$('[data-unphoto]', $('#photoGrid')).forEach(b => b.onclick = () => {
      photos = photos.filter(x => x !== b.dataset.unphoto); drawPhotos();
    });
  };
  drawPhotos();

  $('#spotPhotos').onchange = async ev => {
    const files = [...ev.target.files];
    ev.target.value = '';
    if (!files.length) return;
    const btn = $('#addPhotosBtn');
    const label = btn.firstChild;
    label.textContent = 'Adding…';
    const form = $('#spotForm');
    for (const file of files) {
      try {
        // A new spot with no coordinates yet? Use the photo's GPS if it has one.
        if (!form.lat.value && !form.lon.value) {
          const ex = await readExif(file);
          if (ex.lat != null) {
            form.lat.value = ex.lat.toFixed(5); form.lon.value = ex.lon.toFixed(5);
            toast('Location filled in from the photo');
          }
        }
        const id = await addPhotoFile(file);
        added.add(id); photos.push(id); drawPhotos();
      } catch (e) { toast(e.message, 4000); }
    }
    label.textContent = 'Add photos';
  };

  $('#spotForm').onsubmit = ev => {
    ev.preventDefault();
    const f = new FormData(ev.target);
    const lat = parseFloat(f.get('lat')), lon = parseFloat(f.get('lon'));
    const name = String(f.get('name')).trim();
    if (!name) return toast('Give the spot a name');
    if (!(lat >= -90 && lat <= 90) || !(lon >= -180 && lon <= 180)) return toast('Latitude must be −90 to 90 and longitude −180 to 180');
    const events = ['sunrise', 'sunset'].filter(t => f.get(`ev_${t}`));
    const data = {
      name, lat, lon, events, coastal: !!f.get('coastal'), tide: f.get('tide'),
      driveMin: f.get('driveMin') ? parseInt(f.get('driveMin'), 10) : '',
      facing: f.get('facing') !== '' ? parseFloat(f.get('facing')) : '',
      notes: String(f.get('notes') || ''),
      hunts: HUNT_ORDER.filter(k => f.get(`hunt_${k}`)).length ? HUNT_ORDER.filter(k => f.get(`hunt_${k}`)) : ['colour'],
      fogMode: f.get('fogMode') === 'above' ? 'above' : 'in',
      tideAccess: !!f.get('tideAccess'),
      accessPct: Math.min(100, Math.max(0, parseFloat(f.get('accessPct')) || 40)),
      accessBuffer: Math.max(0, parseInt(f.get('accessBuffer'), 10) || 0),
      photos,
    };
    saved = true;
    deletePhotos(original.filter(id => !photos.includes(id)).concat([...added].filter(id => !photos.includes(id))));
    update(st => {
      if (existing) Object.assign(st.spots.find(x => x.id === existing.id), data);
      else st.spots.push({ id: uid(), ...data });
    });
    if (existing) delete forecasts[existing.id];
    closeSheet();
    toast(existing ? 'Spot saved' : 'Spot added');
    render();
  };
  if (existing) {
    $('#delSpot').onclick = () => {
      if (!confirm(`Delete ${existing.name}?`)) return;
      saved = true;
      deletePhotos([...new Set([...original, ...added])]);
      update(st => { st.spots = st.spots.filter(x => x.id !== existing.id); });
      delete forecasts[existing.id];
      closeSheet(); render();
    };
  }
}

async function openSpotDetail(id) {
  const s = S().spots.find(x => x.id === id);
  if (!s) return;
  openSheet(`<h2>${esc(s.name)}</h2><p class="loading">Loading the week…</p>`);
  try {
    if (!forecasts[id]) forecasts[id] = await fetchSpotForecast(s);
  } catch (e) {
    $('#sheetBody').innerHTML = `<h2>${esc(s.name)}</h2><div class="alert danger">${esc(e.message)}</div>`;
    return;
  }
  const st = S();
  const evs = evaluateSpot(s, forecasts[id], st.keepers, st.settings);
  indexEvents(evs);
  const data = forecasts[id];
  const pics = (s.photos || []).filter(id => photoUrl(id));
  $('#sheetBody').innerHTML = `
    ${pics.length ? `<img class="banner" id="spotBanner" src="${photoUrl(pics[0])}" alt="${esc(s.name)}">` : ''}
    ${pics.length > 1 ? `<div class="gallery-strip">${pics.map((id, i) => `<button class="${i === 0 ? 'on' : ''}" data-show="${id}" aria-label="Show photo ${i + 1}"><img src="${photoUrl(id)}" alt=""></button>`).join('')}</div>` : ''}
    <h2>${esc(s.name)}</h2>
    <p class="muted small">${s.lat.toFixed(4)}, ${s.lon.toFixed(4)}${s.coastal && !data.hasMarine ? '. No tide or wave data at this exact point; try moving the pin slightly offshore.' : ''}</p>
    ${s.notes ? `<p>${esc(s.notes)}</p>` : ''}
    <div class="row">
      <button class="btn" id="editSpot">Edit spot</button>
      <button class="btn" id="spotHourly">Hourly forecast</button>
      <a class="btn" target="_blank" rel="noopener" href="https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lon}">Directions</a>
    </div>
    <div>${evs.map(e => eventRow(e, `<span>${fmtDay(e.dayT ?? e.t, e.offset)}</span>`)).join('') || '<p class="muted">No upcoming events.</p>'}</div>`;
  $('#editSpot').onclick = () => openSpotForm({}, s);
  $('#spotHourly').onclick = () => openNow({ kind: 'spot', id: s.id, lat: s.lat, lon: s.lon, name: s.name });
  $$('[data-show]').forEach(b => b.onclick = () => {
    $('#spotBanner').src = photoUrl(b.dataset.show);
    $$('[data-show]').forEach(x => x.classList.toggle('on', x === b));
  });
}

/* ================= right now ================= */

let nowPlace = { kind: 'here' };   // last place chosen in the hourly forecast

const WX_ICON = (code, day) => {
  const p = d => `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const cloud = 'M7 18h10a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.2 9.3 4.4 4.4 0 0 0 7 18z';
  if (code == null) return p('<circle cx="12" cy="12" r="2"/>');
  if (code >= 95) return p(`<path d="${cloud}"/><path d="M12.5 13l-2 3.5h3l-2 3.5"/>`);
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return p(`<path d="M7 15h10a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.2 6.3 4.4 4.4 0 0 0 7 15z"/><path d="M9 18l-1 2.5M13 18l-1 2.5M17 18l-1 2.5"/>`);
  if (code >= 71 && code <= 86) return p(`<path d="M7 15h10a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.2 6.3 4.4 4.4 0 0 0 7 15z"/><path d="M9 19h.01M13 20h.01M17 19h.01"/>`);
  if (code === 45 || code === 48) return p('<path d="M4 9h16M4 13h16M6 17h12"/>');
  if (code === 3) return p(`<path d="${cloud}"/>`);
  if (code === 1 || code === 2) return day
    ? p('<circle cx="9" cy="9" r="3"/><path d="M9 3v1.5M3 9h1.5M4.8 4.8l1 1M13.2 4.8l-1 1"/><path d="M9 19h8a3.5 3.5 0 0 0 .5-7 5 5 0 0 0-8.7 1.4A3 3 0 0 0 9 19z"/>')
    : p('<path d="M13 4.5A5 5 0 1 0 8 11a4 4 0 0 1 5-6.5z"/><path d="M9 19h8a3.5 3.5 0 0 0 .5-7 5 5 0 0 0-8.7 1.4A3 3 0 0 0 9 19z"/>');
  return day ? p('<circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4"/>')
    : p('<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>');
};

function hourlySummary(fc) {
  const hs = fc.hours.slice(0, 24), o = fc.offset;
  if (!hs.length) return 'No forecast available.';
  const wet = h => (h.pp ?? 0) >= 50 || h.precip >= 0.3;
  const dry = h => (h.pp ?? 0) < 30 && h.precip < 0.1;
  const out = [];
  if (wet(hs[0])) {
    const ease = hs.find(dry);
    out.push(ease ? `Rain now, easing around ${fmtTime(ease.t, o)}.` : 'Rain now, and it looks set in for the day.');
  } else {
    const start = hs.find(wet);
    if (start) {
      const end = hs.slice(hs.indexOf(start)).find(dry);
      out.push(`Dry until about ${fmtTime(start.t, o)}, then rain likely (${Math.round(start.pp ?? 0)}%)${end ? ` until around ${fmtTime(end.t, o)}` : ''}.`);
    } else out.push('Dry for the next 24 hours.');
  }
  const storm = fc.hours.slice(0, 12).find(h => h.code >= 95);
  if (storm) out.push(`Thunderstorms possible around ${fmtTime(storm.t, o)}.`);
  const gusty = fc.hours.slice(0, 12).reduce((m, h) => (h.gust ?? 0) > (m?.gust ?? 0) ? h : m, null);
  if (gusty && gusty.gust >= 45) out.push(`Gusts to ${Math.round(gusty.gust)} km/h around ${fmtTime(gusty.t, o)}.`);
  return out.join(' ');
}

function hourlyChart(fc) {
  const hs = fc.hours.slice(0, 24), o = fc.offset;
  if (hs.length < 2) return '';
  const W = 350, bw = W / hs.length, base = 92;
  const temps = hs.map(h => h.temp).filter(v => v != null);
  const tMin = Math.min(...temps), tMax = Math.max(...temps), span = Math.max(1, tMax - tMin);
  const ty = v => 14 + (1 - (v - tMin) / span) * 44;
  const line = hs.map((h, i) => h.temp == null ? '' : `${i ? 'L' : 'M'}${(i * bw + bw / 2).toFixed(1)} ${ty(h.temp).toFixed(1)}`).join('');
  const hiI = hs.findIndex(h => h.temp === tMax), loI = hs.findIndex(h => h.temp === tMin);
  const label = (i, txt, above) => `<text x="${Math.min(W - 14, Math.max(14, i * bw + bw / 2))}" y="${ty(hs[i].temp) + (above ? -6 : 14)}" text-anchor="middle" font-size="10" fill="var(--text)">${txt}</text>`;
  return `<figure class="hourly-chart">
    <svg viewBox="0 0 ${W} 118" role="img" aria-label="Next 24 hours: rain chance bars and temperature line, ${Math.round(tMin)} to ${Math.round(tMax)} degrees">
      ${hs.map((h, i) => `<rect x="${(i * bw + 1).toFixed(1)}" y="${(base - (h.pp ?? 0) * 0.3).toFixed(1)}" width="${(bw - 2).toFixed(1)}" height="${((h.pp ?? 0) * 0.3).toFixed(1)}" rx="1.5" fill="var(--slate)" fill-opacity="${h.precip >= 0.3 ? 0.9 : 0.45}"/>`).join('')}
      <line x1="0" x2="${W}" y1="${base}" y2="${base}" stroke="var(--line)"/>
      <path d="${line}" fill="none" stroke="var(--caramel)" stroke-width="2" stroke-linejoin="round"/>
      ${label(hiI, `${Math.round(tMax)}°`, true)}${loI !== hiI ? label(loI, `${Math.round(tMin)}°`, false) : ''}
      ${hs.map((h, i) => i % 3 === 0 ? `<text x="${i === 0 ? 1 : (i * bw + bw / 2).toFixed(1)}" y="110" text-anchor="${i === 0 ? 'start' : 'middle'}" font-size="9.5" fill="var(--muted)">${i === 0 ? 'Now' : fmtTime(h.t, o).replace(':00', '')}</text>` : '').join('')}
    </svg>
    <figcaption><span><i class="key-rain"></i>Rain chance</span><span><i class="key-temp"></i>Temperature</span></figcaption>
  </figure>`;
}

function hourlyRows(fc, count) {
  const o = fc.offset, rows = [];
  const hs = fc.hours.slice(0, count);
  hs.forEach((h, i) => {
    const next = hs[i + 1]?.t ?? h.t + 3600;
    const dayChange = i > 0 && dayKey(h.t, o) !== dayKey(hs[i - 1].t, o);
    if (dayChange) rows.push(`<div class="hr-day">${fmtDay(h.t, o)}</div>`);
    rows.push(`<div class="hr-row">
      <span class="hr-time num">${i === 0 ? 'Now' : fmtTime(h.t, o).replace(':00', '')}</span>
      <span class="hr-icon" title="${esc(WEATHER_TEXT(h.code))}">${WX_ICON(h.code, h.day)}</span>
      <span class="hr-temp num">${h.temp != null ? Math.round(h.temp) + '°' : '–'}</span>
      <span class="hr-rain"><i style="width:${Math.round(h.pp ?? 0)}%"></i><b class="num">${Math.round(h.pp ?? 0)}%</b>${h.precip >= 0.1 ? `<em class="num">${h.precip.toFixed(1)}mm</em>` : ''}</span>
      <span class="hr-wind num"><svg viewBox="0 0 24 24" width="13" height="13" style="transform:rotate(${(h.dir ?? 0) + 180}deg)" aria-hidden="true"><path d="M12 3l5 9h-3.5v9h-3v-9H7z" fill="currentColor"/></svg>${Math.round(h.wind ?? 0)}${h.gust ? `<small>–${Math.round(h.gust)}</small>` : ''}</span>
      <span class="hr-cloud num">${h.cloud != null ? Math.round(h.cloud) + '%' : ''}</span>
    </div>`);
    fc.suns.filter(s => s.t >= h.t && s.t < next).forEach(s => rows.push(`<div class="hr-sun"><span class="num">${fmtTime(s.t, o)}</span><span>${s.kind}</span></div>`));
  });
  return `<div class="hr-head"><span>Time</span><span></span><span>Temp</span><span>Rain</span><span>Wind km/h</span><span>Cloud</span></div>${rows.join('')}`;
}

async function loadHourly(place) {
  const box = $('#hourly');
  if (!box) return;
  box.innerHTML = '<p class="loading">Getting the forecast…</p>';
  try {
    if (place.kind === 'here' && place.lat == null) {
      const p = await getPosition();
      place = { ...place, ...p };
      placeName(p.lat, p.lon).then(n => {
        if (!n) return;
        place.name = `Near ${n}`;           // used by later redraws
        if ($('#hourlyWhere')) $('#hourlyWhere').textContent = place.name;
      });
    }
    nowPlace = place;
    const fc = await fetchHourly(place.lat, place.lon);
    if (!$('#hourly')) return;
    let count = 24;
    const draw = () => {
      $('#hourly').innerHTML = `
        <div class="hourly-where" id="hourlyWhere">${esc(place.name || (place.kind === 'here' ? 'Your location' : 'Selected place'))}</div>
        <p class="hourly-summary">${esc(hourlySummary(fc))}</p>
        ${hourlyChart(fc)}
        <div class="hr-list">${hourlyRows(fc, count)}</div>
        ${fc.hours.length > 24 ? `<button class="btn ghost block small-btn" id="hourlyMore">${count === 24 ? 'Show the next 24 hours' : 'Show less'}</button>` : ''}`;
      const more = $('#hourlyMore');
      if (more) more.onclick = () => { count = count === 24 ? 48 : 24; draw(); };
    };
    draw();
  } catch (e) {
    if ($('#hourly')) $('#hourly').innerHTML = `<p class="muted small">${esc(e.message || "Couldn't load the forecast.")} You can pick a spot or search a place instead.</p>`;
  }
}

async function openNow(start) {
  const st = S();
  if (start) nowPlace = start;
  const sel = nowPlace.kind === 'spot' ? nowPlace.id : nowPlace.kind;
  openSheet(`
    <p class="eyebrow">Right now</p>
    <h2>What's <em>coming.</em></h2>
    <div class="place-pick">
      <select id="hourlyPlace" aria-label="Forecast location">
        <option value="here" ${sel === 'here' ? 'selected' : ''}>My location</option>
        ${st.spots.map(sp => `<option value="${sp.id}" ${sel === sp.id ? 'selected' : ''}>${esc(sp.name)}</option>`).join('')}
        ${nowPlace.kind === 'search' ? `<option value="search" selected>${esc(nowPlace.name)}</option>` : ''}
      </select>
      <button class="btn ghost" id="hourlyFind" type="button">Search</button>
    </div>
    <form class="search" id="hourlySearch" hidden>
      <input type="search" id="hourlyQ" placeholder="Any town, beach or landmark" enterkeyhint="search" aria-label="Search a place for the hourly forecast">
      <button class="btn primary" type="submit">Go</button>
    </form>
    <div id="hourlyResults" class="results" hidden></div>
    <div id="hourly"></div>

    <h3>At your spots now</h3>
    <div id="nowSpots">${st.spots.length ? '<p class="loading">Checking your spots…</p>' : '<p class="muted">Add spots to see conditions at each one.</p>'}</div>
    <h3>Rain radar</h3>
    <div id="radar" class="radar"></div>
    <div class="radar-bar"><span id="radarTime" class="num"></span><button class="btn ghost small-btn" id="radarPlay" hidden>Pause</button></div>
    <div class="row">
      <a class="btn" target="_blank" rel="noopener" href="https://www.bom.gov.au/australia/radar/">BOM radar</a>
      <a class="btn" target="_blank" rel="noopener" href="https://www.bom.gov.au/australia/satellite/">Satellite loop</a>
    </div>
    <div class="row"><a class="btn ghost" target="_blank" rel="noopener" href="https://www.bom.gov.au/australia/warnings/">Weather warnings</a></div>
    <p class="small muted">Spot conditions are modelled for right now (Open-Meteo), not station readings. Radar: RainViewer. Links open the Bureau of Meteorology.</p>
  `);

  let radarMap = null, timer = null;
  onSheetClose = () => { clearInterval(timer); if (radarMap) { radarMap.remove(); radarMap = null; } };

  // Hourly forecast: my location, a spot, or a searched place.
  $('#hourlyPlace').onchange = e => {
    const v = e.target.value;
    if (v === 'here') loadHourly({ kind: 'here' });
    else if (v !== 'search') { const sp = S().spots.find(x => x.id === v); if (sp) loadHourly({ kind: 'spot', id: sp.id, lat: sp.lat, lon: sp.lon, name: sp.name }); }
  };
  $('#hourlyFind').onclick = () => { const f = $('#hourlySearch'); f.hidden = !f.hidden; if (!f.hidden) $('#hourlyQ').focus(); };
  $('#hourlySearch').onsubmit = async ev => {
    ev.preventDefault();
    const q = $('#hourlyQ').value.trim(), box = $('#hourlyResults');
    if (!q) return;
    box.hidden = false; box.innerHTML = '<p class="loading">Searching…</p>';
    let res = [];
    try { res = await searchPlaces(q, S().settings.home); } catch { box.innerHTML = '<p class="muted small">Search isn\'t available right now.</p>'; return; }
    if (!res.length) { box.innerHTML = '<p class="muted small">No places found.</p>'; return; }
    box.innerHTML = res.map((r, i) => `<button type="button" class="result" data-hres="${i}"><span class="r-name">${esc(r.name)}</span><span class="r-detail">${esc(r.detail)}</span></button>`).join('');
    $$('[data-hres]', box).forEach(b => b.onclick = () => {
      const r = res[+b.dataset.hres];
      box.hidden = true; $('#hourlySearch').hidden = true;
      const selEl = $('#hourlyPlace');
      selEl.querySelector('option[value="search"]')?.remove();
      selEl.insertAdjacentHTML('beforeend', `<option value="search" selected>${esc(r.name)}</option>`);
      loadHourly({ kind: 'search', lat: r.lat, lon: r.lon, name: r.name });
    });
  };
  loadHourly(nowPlace.kind === 'here' ? { kind: 'here' } : nowPlace);

  // Spot conditions
  if (st.spots.length) {
    const res = await Promise.allSettled(st.spots.map(sp => fetchCurrent(sp)));
    const box = $('#nowSpots');
    if (!box) return;
    box.innerHTML = st.spots.map((sp, i) => {
      const r = res[i];
      if (r.status !== 'fulfilled') return `<div class="now-row"><div class="ev-title">${esc(sp.name)}</div><p class="small muted">Couldn't load right now.</p></div>`;
      const c = r.value;
      let tideTxt = '';
      const fc = forecasts[sp.id];
      if (sp.coastal && fc) {
        const idx = nearestIndex(fc.hours, Date.now() / 1000);
        const td = tideInfo(fc.hours, idx);
        if (td) tideTxt = `<span>Tide ${Math.round(td.pos * 100)}%, ${td.rising ? 'rising' : 'falling'}</span>`;
      }
      return `<div class="now-row">
        ${coverUrl(sp) ? `<img class="spot-thumb" src="${coverUrl(sp)}" alt="">` : `<span class="spot-thumb empty" aria-hidden="true">${esc(sp.name.charAt(0))}</span>`}
        <div class="spot-text">
          <div class="ev-title">${esc(sp.name)}</div>
          <div class="now-main"><strong>${WEATHER_TEXT(c.code)}</strong><span class="num">${c.temp != null ? Math.round(c.temp) + '°C' : ''}</span></div>
          <div class="ev-sub">
            <span>Cloud ${Math.round(c.low ?? 0)}/${Math.round(c.mid ?? 0)}/${Math.round(c.high ?? 0)}%</span>
            <span>Wind ${Math.round(c.wind ?? 0)}${c.gust ? `–${Math.round(c.gust)}` : ''} km/h</span>
            ${c.vis != null ? `<span>Vis ${(c.vis / 1000).toFixed(c.vis < 5000 ? 1 : 0)} km</span>` : ''}
            ${tideTxt}
          </div>
        </div>
      </div>`;
    }).join('');
  }

  // Radar
  const radarEl = $('#radar');
  if (!radarEl || !window.L) { if (radarEl) radarEl.innerHTML = '<p class="muted small radar-msg">The map library didn\'t load. Use the BOM radar link below.</p>'; return; }
  try {
    const frames = await fetchRadarFrames();
    if (!$('#radar')) return;
    const c = st.settings.home || st.spots[0] || { lat: -37.8, lon: 145 };
    radarMap = window.L.map('radar', { zoomControl: false, attributionControl: true }).setView([c.lat, c.lon], 7);
    window.L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 12, className: 'base-tiles', attribution: '&copy; OpenStreetMap &copy; RainViewer' }).addTo(radarMap);
    const layers = frames.map(f => window.L.tileLayer(f.url, { opacity: 0, maxNativeZoom: 7, maxZoom: 12, zIndex: 5 }).addTo(radarMap));
    st.spots.forEach(sp => window.L.circleMarker([sp.lat, sp.lon], { radius: 5, color: '#0F1111', weight: 2, fillColor: '#D9A066', fillOpacity: 1 }).addTo(radarMap).bindTooltip(sp.name));
    let i = layers.length - 1, playing = true;
    const show = k => {
      layers.forEach((l, j) => l.setOpacity(j === k ? 0.75 : 0));
      const d = new Date(frames[k].time * 1000);
      $('#radarTime').textContent = `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}${k === layers.length - 1 ? ' (latest)' : ''}`;
    };
    show(i);
    timer = setInterval(() => { if (playing) { i = (i + 1) % layers.length; show(i); } }, 700);
    const btn = $('#radarPlay');
    btn.hidden = false;
    btn.onclick = () => { playing = !playing; btn.textContent = playing ? 'Pause' : 'Play'; if (!playing) { i = layers.length - 1; show(i); } };
    setTimeout(() => radarMap && radarMap.invalidateSize(), 80);
  } catch {
    const el = $('#radar');
    if (el) el.innerHTML = '<p class="muted small radar-msg">Live radar isn\'t available right now. Use the BOM radar link below.</p>';
  }
}

/* ================= lightning distance timer ================= */

function openLightningTimer() {
  openSheet(`
    <h2>Lightning distance</h2>
    <p class="muted small">Tap when you see the flash, then tap again when you hear the thunder.</p>
    <button class="lt-btn" id="ltBtn">Flash</button>
    <div class="lt-out" id="ltOut" aria-live="polite"></div>
    <ol class="lt-log" id="ltLog"></ol>
    <div class="row"><button class="btn ghost" id="ltReset">Clear readings</button></div>
    <p class="small muted">Sound covers about 1 km every 3 seconds. If thunder follows the flash within 30 seconds (about 10 km), you're within striking distance: get inside a building or a hard-topped car, and wait 30 minutes after the last thunder before heading out.</p>
  `);
  let start = null, timer = null;
  const readings = [];
  const btn = $('#ltBtn'), out = $('#ltOut');
  const stop = () => { clearInterval(timer); timer = null; };
  onSheetClose = stop;

  const show = () => {
    const last = readings[readings.length - 1];
    if (!last) { out.innerHTML = ''; $('#ltLog').innerHTML = ''; return; }
    const prev = readings[readings.length - 2];
    const trend = !prev ? '' : last.km < prev.km - 0.3 ? 'Getting closer' : last.km > prev.km + 0.3 ? 'Moving away' : 'Holding steady';
    out.innerHTML = `
      <div class="lt-km">${last.km.toFixed(1)}<span> km</span></div>
      <div class="lt-note ${last.km < 10 ? 'warn' : ''}">${last.km < 10 ? 'Within striking distance. Take shelter.' : 'Outside the usual 10 km striking range.'}</div>
      ${trend ? `<div class="lt-note">${trend} since the last reading.</div>` : ''}`;
    $('#ltLog').innerHTML = readings.slice().reverse().map(r => `<li><span>${r.time}</span><span>${r.secs.toFixed(1)} s</span><b>${r.km.toFixed(1)} km</b></li>`).join('');
  };

  btn.onclick = () => {
    if (start == null) {
      start = performance.now();
      btn.classList.add('timing');
      timer = setInterval(() => { btn.textContent = `Thunder  ${((performance.now() - start) / 1000).toFixed(1)} s`; }, 100);
      btn.textContent = 'Thunder  0.0 s';
    } else {
      const secs = (performance.now() - start) / 1000;
      stop(); start = null;
      btn.classList.remove('timing'); btn.textContent = 'Flash';
      const d = new Date();
      readings.push({ secs, km: secs * 0.343, time: `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}` });
      show();
    }
  };
  $('#ltReset').onclick = () => { readings.length = 0; stop(); start = null; btn.classList.remove('timing'); btn.textContent = 'Flash'; show(); };
}

/* ================= coach ================= */

function renderCoach(v, logLines = []) {
  const st = S();
  const good = st.keepers.filter(k => k.label === 'keeper').length;
  const duds = st.keepers.filter(k => k.label === 'dud').length;
  const summary = personalModelSummary(st.keepers);
  const active = good >= MIN_KEEPERS;
  const sorted = [...st.keepers].sort((a, b) => b.date - a.date);

  v.innerHTML = `
    <p class="eyebrow">Coach</p><h1>Learn your <em>light.</em></h1>
    <section class="panel">
      <h2>Field tools</h2>
      <p class="small muted">Count the gap between a lightning flash and its thunder to see how far away the storm is, and whether it's coming closer.</p>
      <button class="btn primary block" data-lightning>Lightning distance timer</button>
    </section>

    <section class="panel">
      <h2>Your light profile</h2>
      <div class="meter"><i style="width:${Math.min(100, good / 10 * 100)}%"></i></div>
      <p class="small muted">${good} keeper${good === 1 ? '' : 's'}, ${duds} dud${duds === 1 ? '' : 's'}. ${active ? 'Your personal score is on.' : `Add ${MIN_KEEPERS - good} more keeper${MIN_KEEPERS - good === 1 ? '' : 's'} to switch on your personal score.`} It gets more confident up to 10.</p>
      ${summary ? `<p>Your best shots tend to have <strong>${esc(summary.text)}</strong>.</p>` : '<p class="muted">Once you add keepers, this is where you\'ll see the conditions you shoot best in.</p>'}
    </section>

    <section class="panel">
      <h2>Teach it your keepers</h2>
      <p>Import your favourite shots. Tidelight reads the time and location saved in each photo, looks up the sky, tide and sea at that moment, and learns what your best mornings look like. Photos stay on this device.</p>
      <label class="form" style="margin-bottom:12px">
        <span class="small"><strong>If a photo has no location, use this spot</strong></span>
        <select id="fallbackSpot">
          <option value="">Skip photos without location</option>
          ${st.spots.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}
        </select>
      </label>
      <label class="btn primary block">Import photos<input type="file" id="keeperFiles" class="file-input" accept="image/*" multiple></label>
      <div class="log" id="importLog">${logLines.map(l => `<div>${esc(l)}</div>`).join('')}</div>
      <div class="thumbs">${sorted.map(k => `
        <div class="thumb">
          ${k.thumb ? `<img src="${k.thumb}" alt="">` : `<div class="ph">${k.source === 'session' ? 'Session' : 'Photo'}<br>${esc(k.spotName || '')}<br>${fmtDate(k.date)}</div>`}
          <button class="tag ${k.label}" data-flip="${k.id}" title="Tap to switch keeper/dud">${k.label === 'keeper' ? 'Keeper' : 'Dud'}</button>
          <button class="x" data-rm="${k.id}" aria-label="Remove">×</button>
        </div>`).join('')}</div>
    </section>

    <section class="panel">
      <h2>Recreate a shot</h2>
      <p>Pick any photo you'd love to recreate, yours or an inspiration shot. Tidelight works out the conditions it needed and finds the upcoming sessions across your spots that match best.</p>
      ${!hasAI(st.settings) ? '<p class="small muted">Photos without location data need the AI coach. Add your Claude API key in Settings.</p>' : ''}
      <label class="btn block">Choose a photo<input type="file" id="refFile" class="file-input" accept="image/*"></label>
      <div id="refResult"></div>
    </section>`;

  $('#keeperFiles').onchange = ev => importKeepers([...ev.target.files]);
  $('#refFile').onchange = ev => ev.target.files[0] && recreateShot(ev.target.files[0]);
  $$('[data-flip]', v).forEach(b => b.onclick = () => {
    update(s => { const k = s.keepers.find(x => x.id === b.dataset.flip); k.label = k.label === 'keeper' ? 'dud' : 'keeper'; });
    renderCoach(v);
  });
  $$('[data-rm]', v).forEach(b => b.onclick = () => {
    update(s => { s.keepers = s.keepers.filter(x => x.id !== b.dataset.rm); });
    renderCoach(v);
  });
}

async function importKeepers(files) {
  if (!files.length) return;
  const log = [];
  const logEl = $('#importLog');
  const line = t => { log.push(t); if (logEl) logEl.innerHTML = log.map(l => `<div>${esc(l)}</div>`).join(''); };
  const fbId = $('#fallbackSpot').value;
  const fb = S().spots.find(s => s.id === fbId);
  let added = 0;

  for (const file of files) {
    line(`Reading ${file.name}…`);
    const ex = await readExif(file);
    let { lat, lon } = ex, spotName = null;
    if (lat == null) {
      if (!fb) { line(`✗ ${file.name}: no location in photo. Pick a fallback spot above.`); continue; }
      lat = fb.lat; lon = fb.lon; spotName = fb.name;
    }
    if (!ex.date) { line(`✗ ${file.name}: no capture time saved in the photo`); continue; }
    try {
      const { hour, tide } = await fetchHistorical(lat, lon, ex.date);
      const thumb = await resizeImage(file, 240, 0.7).catch(() => null);
      update(s => s.keepers.push({
        id: uid(), label: 'keeper', source: 'photo', date: ex.date.getTime(), lat, lon,
        spotName, features: featureVector(hour, tide), thumb,
      }));
      added++;
      line(`✓ ${file.name}: ${Math.round(hour.low)}/${Math.round(hour.mid)}/${Math.round(hour.high)}% cloud${tide ? `, tide ${Math.round(tide.pos * 100)}%` : ''}`);
    } catch (e) {
      line(`✗ ${file.name}: ${e.message}`);
    }
  }
  toast(`Added ${added} keeper${added === 1 ? '' : 's'}`);
  if (tab === 'coach') renderCoach($('#view'), log);
}

async function recreateShot(file) {
  const out = $('#refResult');
  const st = S();
  out.innerHTML = '<p class="loading">Working out what this shot needed…</p>';
  let preview = '';
  try { preview = await resizeImage(file, 900, 0.8); } catch {}

  let target = null, desc = '', timeOfDay = null;
  const ex = await readExif(file);
  if (ex.lat != null && ex.date) {
    try {
      const { hour, tide } = await fetchHistorical(ex.lat, ex.lon, ex.date);
      target = featureVector(hour, tide);
      desc = `From the photo's own data: taken ${fmtDate(ex.date.getTime())} with ${Math.round(hour.low)}% low, ${Math.round(hour.mid)}% mid and ${Math.round(hour.high)}% high cloud${tide ? `, tide at ${Math.round(tide.pos * 100)}% of its range` : ''}${hour.wave != null ? `, ${hour.wave.toFixed(1)} m sea` : ''}.`;
      const hr = ex.date.getHours();
      timeOfDay = hr < 12 ? 'sunrise' : 'sunset';
    } catch {}
  }
  if (!target && hasAI(st.settings) && preview) {
    try {
      const r = await aiAnalyzeReference(st.settings, preview.split(',')[1]);
      target = aiResultToFeatures(r);
      desc = [r.summary, r.recipe].filter(Boolean).join(' ');
      if (r.timeOfDay === 'sunrise' || r.timeOfDay === 'sunset') timeOfDay = r.timeOfDay;
    } catch (e) {
      out.innerHTML = `<div class="alert danger">${esc(e.message)}</div>`;
      return;
    }
  }
  if (!target) {
    out.innerHTML = `<div class="alert info">This photo has no saved location and time, so there's nothing to look up. Add your Claude API key in Settings and the AI coach will read the sky from the image itself.</div>`;
    return;
  }

  await ensureForecasts();
  let evs = allEvents();
  if (timeOfDay) evs = evs.filter(e => e.type === timeOfDay);
  const ranked = evs.map(e => ({ e, m: Math.round(similarity(target, e.features) * 100) }))
    .sort((a, b) => b.m - a.m).slice(0, 5);

  out.innerHTML = `
    ${preview ? `<img class="ref-img" src="${preview}" alt="Your reference photo">` : ''}
    <p>${esc(desc)}</p>
    <h3>Closest upcoming matches</h3>
    ${ranked.length ? ranked.map(({ e, m }) => eventRow(e, `<span>${fmtDay(e.dayT ?? e.t, e.offset)}</span><span class="match">${m}% match</span>`)).join('') : '<p class="muted">Add some spots first so there are forecasts to match against.</p>'}`;
}

/* ================= settings ================= */

function syncAgo(t) {
  if (!t) return 'not yet';
  const m = Math.round((Date.now() - t) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
}

function renderAccount() {
  const box = $('#accountPanel');
  if (!box) return;
  const st = syncStatus();
  if (!st.configured) {
    box.innerHTML = `<h2>Account and sync</h2>
      <p class="small muted">Sync isn't switched on yet. Add your Supabase anon key to <code>js/config.js</code> and run <code>supabase/schema.sql</code> in Supabase (see the README).</p>`;
    return;
  }
  if (st.email) {
    box.innerHTML = `<h2>Account and sync</h2>
      <p>Signed in as <strong>${esc(st.email)}</strong>.</p>
      <p class="small ${st.state === 'error' ? 'sync-err' : 'muted'}">${st.state === 'syncing' ? 'Syncing…' : st.state === 'error' ? esc(st.error) : `Last synced ${syncAgo(st.lastSync)}. Spots, photos, plans, keepers and settings stay in step across your devices. Your Claude key stays on each device.`}</p>
      <div class="row"><button class="btn primary" id="syncNowBtn" ${st.state === 'syncing' ? 'disabled' : ''}>Sync now</button><button class="btn ghost" id="signOutBtn">Sign out</button></div>`;
    $('#syncNowBtn').onclick = () => syncNow();
    $('#signOutBtn').onclick = async () => { await signOut(); toast('Signed out. Your data stays on this device.'); renderAccount(); };
    return;
  }
  box.innerHTML = `<h2>Account and sync</h2>
    <p class="small muted">Sign in to keep your spots, photos, plans and keepers in step across your phone and computer.</p>
    <form class="form" id="authForm">
      <label>Email<input type="email" name="email" autocomplete="username" inputmode="email" required placeholder="you@example.com"></label>
      <label>Password<input type="password" name="password" autocomplete="current-password" required minlength="8" placeholder="At least 8 characters"></label>
      <div class="row">
        <button class="btn primary" type="submit" value="signin">Sign in</button>
        <button class="btn ghost" type="submit" value="create">Create account</button>
      </div>
    </form>
    <p class="small muted">First time? Tap Create account once on any device, then Sign in everywhere else with the same details.</p>`;
  const form = $('#authForm');
  form.onsubmit = async ev => {
    ev.preventDefault();
    const mode = ev.submitter?.value || 'signin';
    const email = form.email.value.trim(), password = form.password.value;
    const buttons = [...form.querySelectorAll('button')];
    buttons.forEach(b => { b.disabled = true; });
    try {
      if (mode === 'create') {
        const signedIn = await createAccount(email, password);
        if (!signedIn) {
          toast('Account created. Confirm the email Supabase sent you, then tap Sign in.', 7000);
          buttons.forEach(b => { b.disabled = false; });   // keep the details filled in
          return;
        }
        toast('Account created. Syncing your data.');
      } else {
        await signInWithPassword(email, password);
        toast('Signed in. Syncing your data.');
      }
      renderAccount();
    } catch (e) {
      toast(e.message, 7000);
      buttons.forEach(b => { b.disabled = false; });
    }
  };
}

function renderSettings(v) {
  const st = S(), s = st.settings;
  v.innerHTML = `
    <p class="eyebrow">Settings</p><h1>Settings</h1>
    <section class="panel" id="accountPanel"></section>
    <section class="panel">
      <h2>Home</h2>
      <p class="small muted">Used to estimate drive times and leave times. Stays on this device.</p>
      <form class="form" id="homeForm">
        <div class="two">
          <label>Latitude<input name="lat" inputmode="decimal" value="${s.home ? s.home.lat.toFixed(5) : ''}"></label>
          <label>Longitude<input name="lon" inputmode="decimal" value="${s.home ? s.home.lon.toFixed(5) : ''}"></label>
        </div>
        <div class="two">
          <label>Average drive speed (km/h)<input name="speed" inputmode="numeric" value="${s.driveSpeedKmh}"></label>
          <label>Arrive before sun event (min)<input name="arrive" inputmode="numeric" value="${s.arriveBeforeMin}"></label>
        </div>
        <div class="row">
          <button type="button" class="btn" id="homeHere">Use my location</button>
          <button type="submit" class="btn primary">Save</button>
        </div>
      </form>
    </section>

    <section class="panel">
      <h2>AI coach</h2>
      <p class="small muted">Optional. Adds written briefings and reads the sky from reference photos. Get a key at console.anthropic.com. The key is stored only in this browser and is never included in backups or your GitHub repo. Each briefing costs a fraction of a cent.</p>
      <form class="form" id="aiForm">
        <label>Claude API key<input name="key" type="password" autocomplete="off" value="${esc(s.claudeKey)}" placeholder="sk-ant-…"></label>
        <label>Model<input name="model" value="${esc(s.claudeModel)}"></label>
        <div class="row">
          <button type="button" class="btn" id="testKey">Test key</button>
          <button type="submit" class="btn primary">Save</button>
        </div>
      </form>
    </section>

    <section class="panel">
      <h2>Your data</h2>
      <p class="small muted">Everything is saved in this browser. Export a backup to move to another device.</p>
      <div class="row">
        <button class="btn" id="exportBtn">Export backup</button>
        <label class="btn">Import backup<input type="file" id="importFile" class="file-input" accept="application/json,.json"></label>
      </div>
      <div class="row"><button class="btn danger" id="resetBtn">Delete all data</button></div>
    </section>

    <p class="small muted">Tidelight version ${APP_VERSION}. Weather, tide and sea data: Open-Meteo (CC BY 4.0). Maps: OpenStreetMap. Tide heights are modelled and can differ from official tide tables; check local warnings before heading out.</p>`;

  renderAccount();

  $('#homeHere').onclick = async () => {
    try {
      const p = await getPosition();
      $('#homeForm').lat.value = p.lat.toFixed(5);
      $('#homeForm').lon.value = p.lon.toFixed(5);
      toast('Location filled in. Tap Save.');
    } catch (e) { toast(e.message, 4000); }
  };
  $('#homeForm').onsubmit = ev => {
    ev.preventDefault();
    const f = new FormData(ev.target);
    const lat = parseFloat(f.get('lat')), lon = parseFloat(f.get('lon'));
    const hasHome = !isNaN(lat) && !isNaN(lon);
    if (hasHome && (lat < -90 || lat > 90 || lon < -180 || lon > 180)) return toast('Check the latitude and longitude');
    update(st2 => {
      st2.settings.home = hasHome ? { lat, lon } : null;
      st2.settings.driveSpeedKmh = parseFloat(f.get('speed')) || 60;
      st2.settings.arriveBeforeMin = parseInt(f.get('arrive'), 10) || 0;
    });
    toast('Saved');
  };
  $('#aiForm').onsubmit = ev => {
    ev.preventDefault();
    const f = new FormData(ev.target);
    update(st2 => { st2.settings.claudeKey = String(f.get('key')).trim(); st2.settings.claudeModel = String(f.get('model')).trim() || 'claude-sonnet-5-5'; });
    toast('Saved');
  };
  $('#testKey').onclick = async () => {
    const f = new FormData($('#aiForm'));
    const tmp = { claudeKey: String(f.get('key')), claudeModel: String(f.get('model')) };
    if (!hasAI(tmp)) return toast('Paste a key first');
    const b = $('#testKey'); b.disabled = true; b.textContent = 'Testing…';
    try { await testKey(tmp); toast('Key works'); } catch (e) { toast(e.message, 6000); }
    b.disabled = false; b.textContent = 'Test key';
  };
  $('#exportBtn').onclick = async () => {
    const b = $('#exportBtn'); b.disabled = true; b.textContent = 'Preparing…';
    try {
      const backup = JSON.parse(exportData());
      backup.photos = await exportPhotos(S().spots.flatMap(sp => sp.photos || []));
      downloadFile(`tidelight-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(backup), 'application/json');
    } catch (e) { toast(e.message, 5000); }
    b.disabled = false; b.textContent = 'Export backup';
  };
  $('#importFile').onchange = async ev => {
    const file = ev.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      importData(text);
      const parsed = JSON.parse(text);
      if (parsed.photos) await importPhotos(parsed.photos);
      for (const k in forecasts) delete forecasts[k];
      toast('Backup restored'); render();
    }
    catch (e) { toast(e.message, 5000); }
  };
  $('#resetBtn').onclick = async () => {
    if (!confirm('Delete all spots, photos, plans, keepers and settings from this browser? If you are signed in, you will be signed out and your synced copy stays safe in your account.')) return;
    await signOut().catch(() => {});
    resetAll(); clearPhotos(); for (const k in forecasts) delete forecasts[k];
    toast('All data deleted'); render();
  };
}

/* ================= boot ================= */

document.addEventListener('click', ev => {
  if (ev.target.closest('[data-lightning]')) { openLightningTimer(); return; }
  if (ev.target.closest('[data-add-here]') && found) { openSpotForm({ lat: found.lat, lon: found.lon, name: found.name }); return; }
  const evBtn = ev.target.closest('[data-ev]');
  if (evBtn) { openEvent(evBtn.dataset.ev); return; }
  if (ev.target.closest('[data-close]')) closeSheet();
});
document.addEventListener('keydown', ev => { if (ev.key === 'Escape') closeSheet(); });
$$('.tabbar button').forEach(b => b.onclick = () => setTab(b.dataset.tab));
$('#nowBtn').onclick = () => openNow();
window.addEventListener('online', () => { toast('Back online'); if (tab === 'forecast') loadForecasts(true).then(render); });
window.addEventListener('offline', () => toast("You're offline. Showing saved forecasts."));
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

$('#refreshBtn').onclick = async () => {
  const b = $('#refreshBtn');
  b.classList.add('spin');
  const failed = await loadForecasts(true);
  syncNow();
  b.classList.remove('spin');
  toast(failed.length ? `Some spots failed: ${failed.join(', ')}` : 'Forecasts updated');
  if (tab === 'forecast' || tab === 'spots') render();
};

loadAllPhotos().finally(() => {
  render();
  initSync(() => { for (const k in forecasts) delete forecasts[k]; if (!$('#sheet').classList.contains('hidden')) return; render(); })
    .catch(() => {});
  onSyncStatus(() => { if (tab === 'settings') renderAccount(); });
});
