import { getState, update, exportData, importData, resetAll } from './storage.js?v=5.5';
import { fetchSpotForecast, fetchHistorical, clearCache, fetchKp, fetchCurrent, fetchRadarFrames, WEATHER_TEXT, searchPlaces, fetchHourly, placeName } from './api.js?v=5.5';
import { baseScore, horizonBlock, driveMinutes, DIFFICULTIES, hikeMinutes, hikeIsEstimate, nearestIndex, tideInfo, evaluateSpot, featureVector, similarity, personalModelSummary, MIN_KEEPERS } from './scoring.js?v=5.5';
import { loadAllPhotos, photoUrl, coverUrl, addPhotoFile, deletePhotos, clearPhotos, exportPhotos, importPhotos } from './photos.js?v=5.5';
import { HUNT_ORDER, HUNT_LABEL, HUNT_VERB, huntsOf, NIGHT_HUNTS, setKp, forestAt, waterfallAt, stormAt, coreAltAz } from './hunts.js?v=5.5';
import { initSync, isConfigured, syncStatus, onSyncStatus, signInWithPassword, createAccount, signOut, syncNow, savePushSubscription, removePushSubscription, sendTestAlert, onPasswordRecovery, sendPasswordReset, setNewPassword, currentUser, myCrews, crewMembers, crewPlans, createCrew, joinCrew, leaveCrew, shareToCrew, unshareFromCrew } from './sync.js?v=5.5';
import { gearFor } from './gear.js?v=5.5';
import { VAPID_PUBLIC_KEY } from './config.js?v=5.5';
import { hasAI, testKey, aiBriefing, briefingContext, aiAnalyzeReference, aiResultToFeatures, readExif, resizeImage } from './ai.js?v=5.5';
import { angleDiff, haversineKm, compass, esc, fmtTime, fmtDay, fmtDate, fmtDayDate, fmtWeekday, dayKey, cap, uid, toast, downloadFile, getPosition } from './util.js?v=5.5';

export const APP_VERSION = '5.5';

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

// "47 min drive + 35 min hike"
function travelText(e) {
  const parts = [];
  if (e.drive != null) parts.push(`${e.drive} min drive`);
  if (e.hike) parts.push(`${e.hike} min hike`);
  return parts.join(' + ');
}
// "3.2 km, moderate, about 58 min" for a spot
function hikeSummary(sp) {
  const m = hikeMinutes(sp);
  if (!m && !sp.hikeKm && !sp.difficulty) return '';
  const bits = [];
  if (sp.hikeKm) bits.push(`${Number(sp.hikeKm)} km`);
  if (sp.difficulty) bits.push(sp.difficulty);
  if (m) bits.push(`${hikeIsEstimate(sp) ? 'about ' : ''}${m} min`);
  return `Hike: ${bits.join(', ')}`;
}

// Confidence applies to the colour score; show it when colour is what the session is about.
function confLine(e) {
  const c = e.confidence;
  if (!c || e.topHunt !== 'colour') return '';
  const text = { high: 'High confidence: weather models agree', medium: 'Medium confidence: models roughly agree', low: 'Low confidence: models disagree' }[c.level];
  return `<div class="conf conf-${c.level}">${text}</div>`;
}
const unsure = e => e.confidence?.level === 'low' && e.topHunt === 'colour';

function verdict(e) {
  const v = e.score >= 75 ? 'Go' : e.score >= 50 ? 'Maybe' : 'Skip';
  if (v === 'Skip' || !e.topHunt || e.topHunt === 'colour') return v;
  return `${v} for ${HUNT_VERB[e.topHunt]}`;
}

// Hunts on this session in display order, e.g. [['fog', {score, factors}], ...]
const huntList = e => HUNT_ORDER.filter(k => e.hunts && e.hunts[k]).map(k => [k, e.hunts[k]]);
// "tonight", "tomorrow sunrise", "fri 23 oct sunset"
function sessionName(e) {
  // Lower-case only the relative words; "Tue 17 Nov" keeps its capitals.
  const day = fmtDay(e.dayT ?? e.t, e.offset).replace(/^(Today|Tomorrow|Yesterday)$/, d => d.toLowerCase());
  if (e.type === 'day') return `${day} daytime`;
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
  if (H.forest && H.forest.score >= 40) {
    const x = H.forest.extra;
    lines.push(`Rainforest: ${x.wet >= 0.7 ? 'wet, saturated greens' : x.wet >= 0.3 ? 'damp foliage' : 'dry foliage'} under ${Math.round(x.tc)}% cloud, best ${fmtTime(H.forest.from, o)}–${fmtTime(H.forest.to, o)}. A polariser cuts the glare off wet leaves; bring a lens cloth.`);
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
  if (unsure(e)) c.unshift(`<span class="chip unsure">Models disagree</span>`);
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
  if (!$('#field')) document.body.classList.remove('noscroll');
}

/* ================= router ================= */

function setTab(t) { if (t !== tab) { tabChanged = true; homeAnimate = true; } if (t === 'forecast' && tab !== 'forecast') { homeDay = 0; homeSel = null; } if (t === 'you') youPage = null; tab = t; closeSheet(); render(); window.scrollTo(0, 0); }

function render() {
  if (map) { map.remove(); map = null; }
  clearInterval(plansTimer);
  $$('.tabbar button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  const v = $('#view');
  v.dataset.view = tab;   // lets wide screens size each page appropriately
  clearInterval(homeTimer);
  v.classList.remove('view-in');
  if (tabChanged) { void v.offsetWidth; v.classList.add('view-in'); tabChanged = false; }
  ({ forecast: renderForecast, spots: renderSpots, plans: renderPlans, tools: renderTools, you: renderYou })[tab](v);
}

/* ================= forecast ================= */

function emptySpots(v) {
  v.innerHTML = `<div class="empty">
    <h1 class="page-title">Know before the alarm</h1>
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
  day: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M7 18h10a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.2 9.3 4.4 4.4 0 0 0 7 18z"/><path d="M9 21l1-1.5M13 21l1-1.5"/></svg>',
  night: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/></svg>',
  sunrise: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M3 18h18M7 18a5 5 0 0 1 10 0M12 7v3M12 7l-2 2M12 7l2 2M5 12l1.5 1M19 12l-1.5 1"/></svg>',
  sunset: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M3 18h18M7 18a5 5 0 0 1 10 0M12 10V7M12 10l-2-2M12 10l2-2M5 12l1.5 1M19 12l-1.5 1"/></svg>',
};


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
    ${!st.settings.home ? `<div class="alert info">Set your home under You, in Home and travel, to get leave times that include the drive.</div>` : ''}`;
}

let homeDay = 0;          // 0 today, 1 tomorrow, 2 the day after, or 'all' for the spot matrix

const SESSION_TYPES = ['sunrise', 'day', 'sunset', 'night'];
const TYPE_NAME = { sunrise: 'Sunrise', day: 'Daytime', sunset: 'Sunset', night: 'Night' };

function dayPills(offset) {
  const now = Date.now() / 1000;
  const label = i => (i === 0 ? 'Today' : fmtWeekday(now + i * 86400, offset).slice(0, 3));
  return `<div class="day-pills" role="tablist" aria-label="Choose a day">
    ${[0, 1, 2].map(i => `<button role="tab" aria-selected="${homeDay === i}" class="${homeDay === i ? 'on' : ''}" data-day="${i}">${label(i)}</button>`).join('')}
    <button role="tab" aria-selected="${homeDay === 'all'}" class="${homeDay === 'all' ? 'on' : ''}" data-day="all">All spots</button>
  </div>`;
}
function wirePills(v) {
  $$('[data-day]', v).forEach(b => b.onclick = () => {
    homeDay = b.dataset.day === 'all' ? 'all' : Number(b.dataset.day);
    homeSel = null; homeAnimate = true;
    renderForecast(v);
  });
}

// One line on why: the strongest point in its favour, or the main thing against it.
function whyLine(e) {
  const fs = e.hunts?.[e.topHunt]?.factors || e.factors || [];
  const good = fs.find(f => f.k === 'good'), bad = fs.find(f => f.k === 'bad');
  return (e.score >= 50 ? (good || bad) : (bad || good))?.t || '';
}
function whySentence(e) {
  const fs = e.hunts?.[e.topHunt]?.factors || e.factors || [];
  const goods = fs.filter(f => f.k === 'good').slice(0, 2).map((f, i) => (i ? f.t.charAt(0).toLowerCase() + f.t.slice(1) : f.t));
  const bad = fs.find(f => f.k === 'bad')?.t;
  let txt = goods.length ? goods.join('; ') + '.' : '';
  if (bad) txt += `${txt ? ' ' : ''}${goods.length ? 'Against it: ' + bad.charAt(0).toLowerCase() + bad.slice(1) : bad}.`;
  return txt || 'Nothing stands out either way.';
}
function couldChange(e) {
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
function partBar(p, cls = '') {
  return `<div class="part ${cls}"><span class="part-label">${esc(p.label)}</span>
    <span class="part-track"><i style="width:${Math.max(0, Math.min(100, p.value))}%"></i></span>
    <span class="part-val num">${Math.round(p.value)}</span>
    <span class="part-note">${esc(p.note || '')}</span></div>`;
}
// "6:17am", "best 2:10am", or a daytime window "10:00am–2:00pm"
function sessionWhen(e) {
  const o = e.offset, H = e.hunts?.[e.topHunt];
  if (e.type === 'day' && H?.from) return H.from === H.to ? fmtTime(e.t, o) : `${fmtTime(H.from, o)}–${fmtTime(H.to, o)}`;
  return e.type === 'night' ? `best ${fmtTime(e.t, o)}` : fmtTime(e.t, o);
}

// Placeholder shapes in the layout of the page that's loading, with a plain status line for screen readers.
function skeleton(kind, status) {
  const shapes = {
    home: '<div class="sk sk-title"></div><div class="sk sk-line"></div><div class="sk sk-band"></div><div class="sk sk-panel"></div><div class="sk sk-row"></div><div class="sk sk-row"></div>',
    cards: '<div class="sk sk-card"></div><div class="sk sk-card"></div><div class="sk sk-card"></div>',
    week: '<div class="sk sk-line"></div><div class="sk sk-grid"></div>',
  }[kind];
  return `<div class="sk-wrap" aria-hidden="true">${shapes}</div><p class="sk-status" role="status">${esc(status)}</p>`;
}

/* ---------- motion ---------- */
const motionOK = () => (S().settings.motion || 'full') !== 'reduced' && !matchMedia('(prefers-reduced-motion: reduce)').matches;
function applyMotion() {
  if ((S().settings.motion || 'full') === 'reduced') document.documentElement.dataset.motion = 'reduced';
  else delete document.documentElement.dataset.motion;
}
// Count a number up to its value (used when a score appears in answer to a tap).
function countUp(el, to, ms = 650) {
  const t0 = performance.now();
  const step = t => {
    const k = Math.min(1, (t - t0) / ms), eased = 1 - (1 - k) ** 3;
    el.textContent = String(Math.round(to * eased));
    if (k < 1 && el.isConnected) requestAnimationFrame(step); else el.textContent = String(to);
  };
  requestAnimationFrame(step);
}
function runCounts(root) {
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
function bandSky(e, w0, marks) {
  const data = e && forecasts[e.spot.id];
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
const G_R = 40, G_C = 2 * Math.PI * G_R, G_L = G_C * 240 / 360;   // a 240° arc
const gaugeColor = sc => (sc >= 75 ? '#D9A066' : sc >= 50 ? '#B08A5E' : '#6E7474');
function gauge(score, size = 92, cls = '') {
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
function setGauge(root, score) {
  const val = $('.g-value', root), num = $('.g-num', root);
  if (!val || !num) return;
  val.setAttribute('stroke-dasharray', `${(G_L * score / 100).toFixed(1)} ${G_C.toFixed(1)}`);
  val.style.stroke = gaugeColor(score);
  num.textContent = String(score);
}

// What each kind of session's score is built from, as sliders you can move.
function labModel(e) {
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
      { id: 'pp', label: 'Chance of rain', unit: '%', min: 0, max: 100, step: 1, value: Math.round(h.pp ?? 0) },
      { id: 'wind', label: 'Wind', unit: ' km/h', min: 0, max: 60, step: 1, value: Math.round(h.wind ?? 0) },
      ...(useTide ? [{ id: 'tide', label: `Tide height (you want ${sp.tide})`, unit: '%', min: 0, max: 100, step: 1, value: Math.round(e.tide.pos * 100) }] : []),
    ];
    const run = v => baseScore({ ...h, low: v.low, mid: v.mid, high: v.high, pp: v.pp, wind: v.wind },
      useTide ? { ...e.tide, pos: v.tide / 100 } : (e.tide || null), sp, hz ? { horizon: { ...hz, blk: v.hz / 100 } } : {});
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

function openLab(key) {
  const e = eventIndex.get(key);
  const model = e && labModel(e);
  if (!model) { toast('What if? works for colour, forest and waterfall sessions.', 4500); return; }
  const start = Object.fromEntries(model.sliders.map(sl => [sl.id, sl.value]));
  const vals = { ...start };
  const base = model.score(start);
  openSheet(`
    <h2 class="bf-name">What if?</h2>
    <p class="bf-when">${esc(e.spot.name)}, ${esc(sessionName(e))}. Move a slider to see how the ${esc(HUNT_LABEL[e.topHunt].toLowerCase())} score responds.</p>
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
function liveLine(e) {
  const now = Date.now() / 1000;
  if (e.leave > now) return `Leave in ${untilText(e.leave - now)}`;
  if (e.t > now) return `${TYPE_NAME[e.type]} in ${untilText(e.t - now)}`;
  return 'Under way or finished';
}
let homeTimer = null;      // keeps the Now line and the live line moving
let homeAnimate = true;    // play the entrance (markers drop in, lists cascade) on the next draw
let tabChanged = true;     // ease the page in after a tab change

let homeSel = null;   // the session shown in the detail panel
let bandRevealed = false;   // the band's reveal plays once per app open

// Light phases for a day, from the sun's real position at a reference place (home, or the first spot).
// Window runs 3am to 3am so a pre-dawn start and a late night both fit.
const BAND = { night: '#141A23', twilight: '#22304A', blue: '#3A5072', golden: '#B9824E', day: '#59605C' };
function lightBand(w0, place) {
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
function day3am(t, offset) {
  const d = new Date((t - 3 * 3600 + offset) * 1000);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000 - offset + 3 * 3600;
}
const PHASE_COLOR = { dark: BAND.night, twilight: BAND.twilight, 'blue hour': BAND.blue, 'golden hour': BAND.golden, daylight: BAND.day };
function phaseColor(place, t, offset) {
  return PHASE_COLOR[phaseAt(lightBand(day3am(t, offset), place).marks, t)] || BAND.night;
}

const bandFill = s => (s >= 80 ? '#D9A066' : s >= 65 ? '#8F6B44' : s >= 50 ? '#3A342B' : '#1E2222');
const bandInk = s => (s >= 80 ? '#1A130B' : '#ECE8E1');

function huntPhrase(e) {
  const v = HUNT_VERB[e.topHunt];
  if (e.score >= 75) return e.topHunt === 'colour' ? 'Worth the alarm' : `Go for ${v}`;
  if (e.score >= 50) return e.topHunt === 'colour' ? 'Worth a look' : `Maybe ${v}`;
  return 'Probably not worth it';
}

function sessionDetail(e, isBest = false, nav = null) {
  const H = e.hunts?.[e.topHunt] || {};
  const parts = [...(H.parts || [])];
  if (e.topHunt === 'colour' && e.confidence) parts.push({ label: 'Models agree', value: Math.max(0, 100 - e.confidence.spread * 2), note: `${cap(e.confidence.level)} confidence: within ${e.confidence.spread} points`, alt: true });
  if (e.personal) parts.push({ label: 'Your style', value: e.personal.score, note: `Compared with your ${e.personal.n} keepers`, alt: true });
  const planned = S().plans.some(p => p.key === e.key);
  const going = crewGoing(e);
  const photo = coverUrl(e.spot);
  return `<article class="detail ${slideFrom ? `slide-${slideFrom}` : ''}" aria-live="polite">
    ${photo || (nav && nav.total > 1) ? `<div class="detail-photo-wrap ${photo ? '' : 'no-photo'}">
      ${photo ? `<img class="detail-photo" src="${photo}" alt="${esc(e.spot.name)}">` : ''}
      ${nav && nav.total > 1 ? `<nav class="slide-nav" aria-label="Sessions this day, ${nav.index + 1} of ${nav.total}">
        <button class="slide-arrow prev" data-step="-1" aria-label="Previous session" ${nav.index === 0 ? 'disabled' : ''}><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.5 6l-6 6 6 6"/></svg></button>
        <span class="slide-dots" aria-hidden="true">${nav.total <= 9
          ? Array.from({ length: nav.total }, (_, k) => `<i class="${k === nav.index ? 'on' : ''}"></i>`).join('')
          : `<b class="num">${nav.index + 1} / ${nav.total}</b>`}</span>
        <button class="slide-arrow next" data-step="1" aria-label="Next session" ${nav.index === nav.total - 1 ? 'disabled' : ''}><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.5 6l6 6-6 6"/></svg></button>
      </nav>` : ''}
    </div>` : ''}
    <div class="detail-head">
      <div>
        <h2 class="detail-name">${esc(e.spot.name)}</h2>
        <p class="detail-when">${TYPE_NAME[e.type]} ${sessionWhen(e)}. Leave ${fmtTime(e.leave, e.offset)}${e.hike ? `, ${e.hike} min walk in` : ''}.</p>
      </div>
      ${labModel(e)
        ? `<button class="gauge-btn" data-lab="${esc(e.key)}" aria-label="Score ${e.score} out of 100. Open What if?">${gauge(e.score)}<span class="gauge-hint">What if?</span></button>`
        : `<span class="gauge-btn static" role="img" aria-label="Score ${e.score} out of 100">${gauge(e.score)}</span>`}
    </div>
    <p class="detail-live num" id="liveLeave">${esc(liveLine(e))}</p>
    <p class="detail-verdict">${isBest ? '' : `${esc(huntPhrase(e))}. `}${esc(whySentence(e))}</p>
    ${e.topHunt === 'colour' && e.confidence ? `<p class="detail-conf conf-${e.confidence.level}">${{ high: 'The weather models agree.', medium: 'The weather models roughly agree.', low: 'The weather models disagree, so treat this as a maybe.' }[e.confidence.level]}</p>` : ''}
    ${e.access && !e.access.inside ? '<p class="detail-warn">The tide blocks access for this session.</p>' : ''}
    ${going.length ? `<p class="crew-going">${esc(goingText(going))}.</p>` : ''}
    <div class="parts">${parts.map(p => partBar(p, p.alt ? 'alt' : '')).join('')}</div>
    ${couldChange(e) ? `<p class="could">${esc(couldChange(e))}</p>` : ''}
    <div class="row">
      <button class="btn primary" data-plan="${esc(e.key)}" ${planned ? 'disabled' : ''}>${planned ? 'Planned' : 'Plan this shoot'}</button>
      <button class="btn" data-ev="${esc(e.key)}">Full briefing</button>
      <button class="btn" data-compass="${esc(e.key)}">Compass</button>
      <button class="btn" data-field="${esc(e.key)}">Field mode</button>
    </div>
  </article>`;
}

/* ---------- scrubbing the light band ---------- */
function phaseAt(marks, t) {
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
function scoreAtHour(e, data, i) {
  const h = data.hours[i], sp = e.spot;
  switch (e.topHunt) {
    case 'forest': return forestAt(data, i).score;
    case 'waterfall': return waterfallAt(data, i).score;
    case 'storm': case 'lightning': return Math.round(stormAt(h) * 100);
    case 'colour': return baseScore(h, sp.coastal ? tideInfo(data.hours, i) : null, sp).score;
    default: return null;
  }
}
function scrubText(e, t, marks) {
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
function wireScrub(v, w0, marks, sel) {
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
function onSwipe(el, left, right) {
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
let slideFrom = '';   // 'left' | 'right': which way the detail panel should slide in after a change

// Spread markers that would overlap so each stays easy to tap. A pin on the band keeps each session's
// exact time; a marker only moves sideways as far as it needs to.
function layoutBandMarks() {
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
}
window.addEventListener('resize', () => { if (tab === 'forecast') layoutBandMarks(); });

async function renderForecast(v) {
  const st = S();
  if (!st.spots.length) return emptySpots(v);
  v.innerHTML = `${dayPills(0)}${skeleton('home', `Reading the sky for ${st.spots.length} spot${st.spots.length > 1 ? 's' : ''}…`)}`;
  const failed = await ensureForecasts();
  if (tab !== 'forecast') return;
  const evs = next3Days();
  indexEvents(evs);
  const offset = evs[0]?.offset ?? 0;
  if (homeDay === 'all') return renderMatrix(v, evs, st, failed);

  const now = Date.now() / 1000;
  const dayEvs = evs.filter(e => e.dayIdx === homeDay).sort((a, b) => b.score - a.score);
  const best = dayEvs[0];
  if (!homeSel || !dayEvs.some(e => e.key === homeSel)) homeSel = best?.key || null;
  const sel = dayEvs.find(e => e.key === homeSel);

  // The day's 3am-to-3am window in local time.
  const dayRef = now + homeDay * 86400;
  const local = new Date((dayRef + offset) * 1000);
  const midnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) / 1000 - offset;
  const w0 = midnight + 3 * 3600;
  const place = st.settings.home || st.spots[0];
  const band = lightBand(w0, place);
  const dateLine = fmtDayDate(dayRef, offset).split(' ').slice(1).join(' ');   // "11 Nov", in the spots' time zone
  const weekday = fmtWeekday(dayRef, offset);

  // One marker per session type: the best spot for it. Daytime sessions also draw their window.
  const perType = SESSION_TYPES.map(type => dayEvs.find(e => e.type === type)).filter(Boolean);
  const counts = Object.fromEntries(SESSION_TYPES.map(t => [t, dayEvs.filter(e => e.type === t).length]));
  const markers = perType.map((e, mi) => {
    const H = e.hunts?.[e.topHunt];
    const span = e.type === 'day' && H?.from && H.to > H.from
      ? `<span class="band-span" style="left:${band.pos(H.from)}%; width:${Math.max(1, band.pos(H.to) - band.pos(H.from))}%"></span>` : '';
    const more = counts[e.type] > 1 ? `<span class="band-more">+${counts[e.type] - 1}</span>` : '';
    return `${span}<span class="band-pin" style="left:${band.pos(e.t)}%" aria-hidden="true"></span><button class="band-mark ${e.key === homeSel ? 'on' : ''}" data-pos="${band.pos(e.t)}" style="left:${band.pos(e.t)}%; --i:${mi}; --fill:${bandFill(e.score)}; --ink:${bandInk(e.score)}" data-sel="${esc(e.key)}"
      aria-label="${TYPE_NAME[e.type]} at ${esc(e.spot.name)}, ${sessionWhen(e)}, score ${e.score}">${e.score}${more}</button>`;
  }).join('');
  const ticks = [[w0 + 3 * 3600, '6am'], [w0 + 9 * 3600, 'Noon'], [w0 + 15 * 3600, '6pm'], [w0 + 21 * 3600, 'Midnight']]
    .map(([t, l]) => `<span class="band-tick" style="left:${band.pos(t)}%">${l}</span>`).join('');
  const nowLine = now > w0 && now < w0 + 86400 ? `<span class="band-now" style="left:${band.pos(now)}%" aria-hidden="true"></span>` : '';

  const others = dayEvs.filter(e => e.key !== homeSel).sort((a, b) => a.t - b.t);
  const order = [...dayEvs].sort((a, b) => a.t - b.t || b.score - a.score);   // swipe order: through the day

  v.innerHTML = `
    ${dayPills(offset)}
    ${forecastAlerts(st, failed)}
    <div class="home-grid ${homeAnimate ? 'enter' : ''}">
    <header class="day-head-v2">
      <h1 class="day-title">${homeDay === 0 ? 'Today' : homeDay === 1 ? 'Tomorrow' : esc(weekday)}<span>, ${esc(homeDay > 1 ? dateLine : `${weekday} ${dateLine}`)}</span></h1>
      <p class="day-lede">${best ? `${esc(huntPhrase(best))} at ${esc(best.spot.name)}, ${TYPE_NAME[best.type].toLowerCase()} ${sessionWhen(best)}.` : 'No sessions left for this day. Try another day.'}</p>
    </header>
    <figure class="band-wrap">
      <div class="band ${bandRevealed ? '' : 'reveal'}" style="background:${band.gradient}" tabindex="0" role="slider"
        aria-label="The day's light, 3am to 3am. Drag, or use the arrow keys, to see conditions at any time." aria-valuemin="0" aria-valuemax="1440" aria-valuenow="0">
        ${bandSky(sel, w0, band.marks)}
        ${nowLine}${markers}
        <span class="scrub-line" id="scrubLine" hidden></span>
        <div class="scrub" id="scrub" hidden></div>
      </div>
      <div class="band-ticks" aria-hidden="true">${ticks}</div>
      <figcaption class="band-key">
        <span><i style="background:${BAND.blue}"></i>Blue hour</span><span><i style="background:${BAND.golden}"></i>Golden hour</span><span><i style="background:${BAND.day}"></i>Daylight</span>${bandSky.last?.cloud ? '<span class="key-icon-wrap"><b class="key-icon sky-key-cloud" aria-hidden="true"></b>Cloud</span>' : ''}${bandSky.last?.rain ? '<span class="key-icon-wrap"><b class="key-icon sky-key-rain" aria-hidden="true"></b>Rain likely</span>' : ''}<span><i style="background:${BAND.night}; outline:1px solid var(--line)"></i>Dark</span>
      </figcaption>
      ${sel && forecasts[sel.spot.id] ? `<p class="band-sky-note">Cloud, rain and clear night sky shown for ${esc(sel.spot.name)}. Drag along the band to see any hour.</p>` : ''}
    </figure>
    ${sel ? sessionDetail(sel, sel.key === best?.key, { index: order.findIndex(e => e.key === sel.key), total: order.length }) : ''}
    ${others.length ? `<section class="others">
      <h3 class="others-title">Other sessions ${homeDay === 0 ? 'today' : homeDay === 1 ? 'tomorrow' : `on ${esc(weekday)}`}</h3>
      ${others.map((e, oi) => `<button class="other-row" style="--i:${oi}" data-sel="${esc(e.key)}">
        <span class="other-time num">${sessionWhen(e)}</span>
        <span class="other-name">${esc(e.spot.name)}<small>${TYPE_NAME[e.type]}${e.topHunt !== 'colour' ? `, ${HUNT_LABEL[e.topHunt].toLowerCase()}` : ''}${unsure(e) ? ', models disagree' : ''}</small></span>
        <span class="other-score num" style="--fill:${bandFill(e.score)}; --ink:${bandInk(e.score)}">${e.score}</span>
      </button>`).join('')}
    </section>` : ''}
    <p class="small muted foot-note">Scores are estimates from forecast data. Check official warnings before heading out.</p>
    </div>`;

  bandRevealed = true;
  slideFrom = '';
  homeAnimate = false;
  runCounts(v);
  clearInterval(homeTimer);
  homeTimer = setInterval(() => {
    if (tab !== 'forecast' || !$('.band')) { clearInterval(homeTimer); return; }
    const n = Date.now() / 1000, nl = $('.band-now'), lv = $('#liveLeave');
    if (nl) nl.style.left = `${band.pos(n)}%`;
    if (lv && sel) lv.textContent = liveLine(sel);
  }, 1000);
  layoutBandMarks();
  wirePills(v);
  wireScrub(v, w0, band.marks, sel);
  const step = d => {
    const i = order.findIndex(e => e.key === homeSel) + d;
    if (i < 0 || i >= order.length) return;
    homeSel = order[i].key; slideFrom = d > 0 ? 'right' : 'left';
    renderForecast(v);
  };
  const goDay = d => {
    const next = Math.max(0, Math.min(2, homeDay + d));
    if (next === homeDay) return;
    homeDay = next; homeSel = null; homeAnimate = true; slideFrom = d > 0 ? 'right' : 'left';
    renderForecast(v);
  };
  onSwipe($('.detail', v), () => step(1), () => step(-1));
  onSwipe($('.day-head-v2', v), () => goDay(1), () => goDay(-1));
  $$('[data-step]', v).forEach(b => b.onclick = () => step(Number(b.dataset.step)));
  $$('[data-sel]', v).forEach(b => b.onclick = () => {
    homeSel = b.dataset.sel;
    renderForecast(v).then(() => { const d = $('.detail'); if (d && b.classList.contains('other-row') && !matchMedia('(min-width: 1000px)').matches) d.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' }); });
  });
  $$('[data-plan]', v).forEach(b => b.onclick = () => {
    const e = eventIndex.get(b.dataset.plan);
    if (!e) return;
    addPlan(e);
    b.textContent = 'Planned'; b.disabled = true;
    afterPlanned(e.key);
  });
}

const band = s => (s >= 80 ? 'b4' : s >= 65 ? 'b3' : s >= 50 ? 'b2' : 'b1');

function renderMatrix(v, evs, st, failed) {
  const now = Date.now() / 1000;
  const offset = evs[0]?.offset ?? 0;
  const types = ['sunrise', 'day', 'sunset', 'night'];
  const cols = [];
  for (let i = 0; i < 3; i++) for (const type of types) if (evs.some(e => e.dayIdx === i && e.type === type)) cols.push({ i, type });
  const cell = new Map(evs.map(e => [`${e.spot.id}|${e.dayIdx}|${e.type}`, e]));
  const spotBest = sp => Math.max(-1, ...evs.filter(e => e.spot.id === sp.id).map(e => e.score));
  const spots = [...st.spots].sort((a, b) => spotBest(b) - spotBest(a));
  if (!matrixSel || !eventIndex.has(matrixSel) || !evs.some(e => e.key === matrixSel)) matrixSel = [...evs].sort((a, b) => b.score - a.score)[0]?.key || null;
  const sel = evs.find(e => e.key === matrixSel);
  const groups = [0, 1, 2].map(i => ({ i, n: cols.filter(c => c.i === i).length })).filter(g => g.n);
  const dayLabel = i => fmtDayDate(now + i * 86400, offset).split(' ')[0].toUpperCase();
  const typeName = { sunrise: 'Sunrise', day: 'Daytime', sunset: 'Sunset', night: 'Night' };

  v.innerHTML = `
    ${dayPills(offset)}
    <h1 class="page-title">All spots</h1>
    <p class="page-lede">Every spot against every session for the next 3 days. Tap a score for its summary.</p>
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
            return `<button class="mx-cell ${band(e.score)} ${e.key === matrixSel ? 'sel' : ''} ${unsure(e) ? 'unsure' : ''}" data-mx="${esc(e.key)}" aria-label="${esc(sp.name)}, ${esc(sessionName(e))}, score ${e.score}">${e.score}${e.access && !e.access.inside ? '<i class="mx-tide" aria-hidden="true"></i>' : ''}</button>`;
          }).join('')}`).join('')}
      </div>
    </div>
    <div class="mx-legend">
      <span><i class="b4"></i>80+</span><span><i class="b3"></i>65–79</span><span><i class="b2"></i>50–64</span><span><i class="b1"></i>Under 50</span><span><i class="unsure-key"></i>Models disagree</span>
    </div>
    ${sel ? `<section class="mx-detail">
      ${coverUrl(sel.spot) ? `<img src="${coverUrl(sel.spot)}" alt="">` : `<span class="mx-detail-ph" aria-hidden="true"></span>`}
      <div>
        <p class="mx-detail-when">${esc(fmtDayDate(sel.dayT ?? sel.t, sel.offset))}, ${typeName[sel.type].toLowerCase()} ${sessionWhen(sel)}</p>
        <div class="mx-detail-name">${esc(sel.spot.name)}</div>
        <div class="small"><strong class="caramel">${esc(verdict(sel))}, ${sel.score}.</strong> <span class="muted">Leave ${fmtTime(sel.leave, sel.offset)}.${sel.access && !sel.access.inside ? ' Tide blocks access.' : ''}</span></div>
      </div>
    </section>
    <div class="row"><button class="btn primary block" data-ev="${esc(sel.key)}">Open the briefing</button></div>` : '<p class="muted">No sessions in the next 3 days.</p>'}
  `;
  wirePills(v);
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

  const tl = [{ t: e.leave, label: e.drive != null ? `Leave home (${e.drive} min drive)` : e.hike ? 'Start walking' : 'Be on location', cls: 'leave' }];
  if (e.hike && e.drive != null) tl.push({ t: e.walkStart, label: `Start the hike (${[e.spot.hikeKm ? `${Number(e.spot.hikeKm)} km` : '', e.spot.difficulty || '', `${e.hike} min`].filter(Boolean).join(', ')})`, cls: 'leave' });
  if (L.blueStart) tl.push({ t: L.blueStart, label: 'Blue hour starts' });
  if (L.blueEnd) tl.push({ t: L.blueEnd, label: 'Blue hour ends' });
  if (L.goldenStart && e.type === 'sunset') tl.push({ t: L.goldenStart, label: 'Golden hour starts' });
  if (e.timeline) tl.push(...e.timeline); else tl.push({ t: e.t, label: cap(e.type), cls: 'key' });
  if (e.access && !e.access.none) {
    if (!e.access.openStart) tl.push({ t: e.access.start, label: 'Tide access opens' });
    tl.push({ t: e.access.backBy, label: 'Be back off the rocks', cls: 'warn' });
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

  // The plan as a strip of light: each step takes the colour of the sky at that moment.
  const stripStops = tl.map((x, i) => `${phaseColor(e.spot, x.t, o)} ${(((i + 0.5) / tl.length) * 100).toFixed(1)}%`).join(', ');
  const huntBlock = ([k, v]) => `
      <div class="part-list">${(v.parts || []).map(p => partBar(p)).join('')}</div>
      <ul class="factors">${v.factors.map(f => `<li class="${f.k}">${esc(f.t)}</li>`).join('') || '<li>Nothing stands out either way.</li>'}</ul>
      ${k === 'lightning' ? '<button class="link-btn" data-lightning>Open the lightning distance timer</button>' : ''}`;
  const hunts = huntList(e);
  const topHunt = hunts.find(([k]) => k === e.topHunt) || hunts[0];
  const otherHunts = hunts.filter(h => h !== topHunt);
  const going = crewGoing(e);
  const gear = gearFor(e, S().settings);

  openSheet(`
    ${coverUrl(e.spot) ? `<img class="banner" src="${coverUrl(e.spot)}" alt="${esc(e.spot.name)}">` : ''}
    <header class="bf-head">
      <div>
        <h2 class="bf-name">${esc(e.spot.name)}</h2>
        <p class="bf-when">${esc(cap(sessionName(e)))}, ${sessionWhen(e)}</p>
      </div>
      <p class="bf-score num" aria-label="Score ${e.score} out of 100" data-count="${e.score}">${e.score}</p>
    </header>
    <p class="bf-verdict">${esc(huntPhrase(e))}. ${esc(whySentence(e))}</p>
    ${e.topHunt === 'colour' && e.confidence ? `<p class="bf-note conf-${e.confidence.level}">${{ high: 'The weather models agree.', medium: 'The weather models roughly agree.', low: 'The weather models disagree, so treat this as a maybe.' }[e.confidence.level]}</p>` : ''}
    ${e.access && !e.access.inside ? `<p class="bf-note conf-low">${e.access.none ? 'The tide stays above your access level around this session.' : `Tide access runs ${fmtTime(e.access.start, o)} to ${fmtTime(e.access.backBy, o)}, which doesn't cover this session.`}</p>` : ''}
    ${going.length ? `<p class="bf-note crew">${esc(goingText(going))}.</p>` : ''}
    <div class="bf-quiet">
      ${currentUser() && crewState.crews.length ? '<button class="link-btn" id="shareBtn">Share with crew</button>' : ''}
      <button class="link-btn" id="icsBtn">Add to calendar</button>
      <button class="link-btn" data-compass="${esc(e.key)}">Open compass</button>
      ${labModel(e) ? `<button class="link-btn" data-lab="${esc(e.key)}">What if?</button>` : ''}
      <button class="link-btn" data-dial="${esc(e.key)}">Light dial</button>
    </div>

    <h3 class="sec">The plan</h3>
    <ol class="tline" style="--strip: linear-gradient(to bottom, ${stripStops})">
      ${tl.map(x => `<li class="${x.cls || ''}"><time class="num">${fmtTime(x.t, o)}</time><span>${esc(x.label)}</span></li>`).join('')}
    </ol>

    ${tideChart(e)}

    <h3 class="sec">Briefing</h3>
    <p class="bf-brief" id="briefText">${esc(briefing(e))}</p>
    <button class="link-btn" id="aiBriefBtn">Rewrite with the AI coach</button>

    <h3 class="sec">Why this score</h3>
    ${topHunt ? `<div class="bf-hunt"><div class="bf-hunt-head"><span>${HUNT_LABEL[topHunt[0]]}</span><b class="num">${topHunt[1].score}</b></div>${huntBlock(topHunt)}</div>` : ''}
    ${otherHunts.map(h => `<details class="bf-hunt more"><summary><span>${HUNT_LABEL[h[0]]}</span><b class="num">${h[1].score}</b></summary>${huntBlock(h)}</details>`).join('')}
    <p class="small muted bf-personal">${e.personal
      ? `The ${e.score} blends ${e.base} from conditions with ${e.personal.score} from your ${e.personal.n} keepers (${Math.round(e.personal.weight * 100)}% weight).`
      : `Add ${MIN_KEEPERS} or more keeper photos under You, in Light profile, and this score will start reflecting your taste.`}</p>

    <h3 class="sec">Conditions at ${e.type === 'night' || e.type === 'day' ? fmtTime(e.t, o) : e.type}</h3>
    <dl class="bf-cond">${cond.filter(([, val]) => val !== '–').map(([k, val]) => `<div><dt>${k}</dt><dd class="num">${val}</dd></div>`).join('')}</dl>

    <h3 class="sec">What to bring</h3>
    <ul class="gear-preview">${gear.map(g => `<li><strong>${esc(g.label)}</strong><span>${esc(g.why)}</span></li>`).join('')}</ul>
    <p class="small muted">Plan the shoot to tick these off as you pack. Your always-bring items live under You, in My kit.</p>

    <div class="sheet-actions">
      <button class="btn primary" id="planBtn" ${planned ? 'disabled' : ''}>${planned ? 'Planned' : 'Plan this shoot'}</button>
      <button class="btn" data-field="${esc(e.key)}">Open field mode</button>
    </div>
  `);
  runCounts($('#sheetBody'));
  wireTide(e);
  const sb = $('#shareBtn');
  if (sb) sb.onclick = () => {
    if (!S().plans.some(p => p.key === e.key)) addPlan(e);
    openShareSheet(S().plans.find(p => p.key === e.key).id);
  };

  $('#planBtn').onclick = () => {
    addPlan(e);
    $('#planBtn').textContent = 'Planned';
    $('#planBtn').disabled = true;
    afterPlanned(e.key);
  };
  $('#icsBtn').onclick = () => downloadIcs(e);
  $('#aiBriefBtn').onclick = async () => {
    const st = S();
    if (!hasAI(st.settings)) { toast('Add your Claude key under You, in AI coach, to use this.', 5000); return; }
    const btn = $('#aiBriefBtn'), box = $('#briefText');
    btn.disabled = true; btn.textContent = 'Thinking…';
    try {
      const text = await aiBriefing(st.settings, briefingContext(e, personalModelSummary(st.keepers)));
      box.textContent = text;
      btn.textContent = 'Rewritten by the AI coach';
    } catch (err) {
      toast(err.message, 5000);
      btn.disabled = false; btn.textContent = 'Rewrite with the AI coach';
    }
  };
}

/* ================= crews ================= */

const crewState = { loaded: false, crews: [], members: [], plans: [], error: null };
const sessionKeyOf = (lat, lon, type, t) => `${lat.toFixed(3)},${lon.toFixed(3)}:${type}:${Math.round(t / 3600)}`;

async function loadCrew() {
  if (!currentUser()) { Object.assign(crewState, { loaded: true, crews: [], members: [], plans: [], error: null }); return; }
  try {
    const crews = await myCrews();
    const ids = crews.map(c => c.id);
    const [members, plans] = await Promise.all([crewMembers(ids), crewPlans(ids, Math.floor(Date.now() / 1000) - 3 * 3600)]);
    Object.assign(crewState, { loaded: true, crews, members, plans, error: null });
  } catch (e) {
    Object.assign(crewState, { loaded: true, error: e.message });
  }
}

// What travels with a shared plan so crewmates can see and save the spot: its settings and a small cover photo.
const thumbCache = new Map();
async function spotThumb(sp) {
  const id = (sp.photos || []).find(x => photoUrl(x));
  if (!id) return null;
  if (thumbCache.has(id)) return thumbCache.get(id);
  try {
    const img = new Image();
    img.src = photoUrl(id);
    await img.decode();
    const k = Math.min(1, 560 / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    const url = c.toDataURL('image/jpeg', 0.72);
    thumbCache.set(id, url);
    return url;
  } catch { return null; }
}
async function spotPayload(spotId) {
  const sp = S().spots.find(x => x.id === spotId);
  if (!sp) return null;
  const keep = ['events', 'coastal', 'tide', 'tideAccess', 'accessPct', 'accessBuffer', 'facing', 'hikeMin', 'hikeKm', 'difficulty', 'fogMode', 'notes'];
  const out = { v: 1, hunts: huntsOf(sp) };
  for (const k of keep) if (sp[k] !== undefined && sp[k] !== '') out[k] = sp[k];
  if (typeof out.notes === 'string') out.notes = out.notes.slice(0, 1000);
  const thumb = await spotThumb(sp);
  if (thumb && thumb.length < 150000) out.photo = thumb;
  return out;
}
// Share a plan with every crew you're in (used when you plan a shoot, if auto-sharing is on).
async function autoShare(planKey) {
  const st = S();
  if (st.settings.crewAutoShare === false || !currentUser()) return false;
  if (!crewState.loaded) await loadCrew();
  if (!crewState.crews.length) return false;
  const plan = S().plans.find(p => p.key === planKey);
  if (!plan) return false;
  const spot = await spotPayload(plan.spotId);
  for (const c of crewState.crews) {
    try { await shareToCrew(c.id, myNameIn(c), plan, '', spot); } catch (e) { toast(e.message, 6000); return false; }
  }
  update(s2 => { const x = s2.plans.find(p => p.key === planKey); if (x) x.sharedTo = crewState.crews.map(c => c.id); });
  loadCrew();
  return true;
}
// After planning: share automatically if that's on, and say so.
async function afterPlanned(planKey) {
  const shared = await autoShare(planKey);
  const names = crewState.crews.map(c => c.name);
  toast(shared ? `Planned and shared with ${names.length === 1 ? names[0] : 'your crews'}.` : crewState.crews.length ? 'Planned. Share it with your crew from Plans.' : 'Planned. Rate it afterwards so your personal score learns.', 4500);
}

// Crewmates heading to roughly the same place and session (within ~1.5 km and 2 hours).
function crewGoing(e) {
  const me = currentUser()?.id;
  if (!crewState.plans.length || !e?.spot) return [];
  const names = new Set();
  for (const cp of crewState.plans) {
    if (cp.user_id === me || cp.type !== e.type || Math.abs(cp.t - e.t) > 7200) continue;
    if (haversineKm({ lat: cp.lat, lon: cp.lon }, e.spot) > 1.5) continue;
    names.add(cp.display_name);
  }
  return [...names];
}
function goingText(names) {
  if (!names.length) return '';
  const list = names.length <= 2 ? names.join(' and ') : `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`;
  return `${list} ${names.length === 1 ? 'is' : 'are'} going`;
}
function myNameIn(crew) { return crew.myName || (currentUser()?.email || 'Me').split('@')[0]; }

// Share one of your plans with one or more crews, with an optional note.
function openShareSheet(planId) {
  const p = S().plans.find(x => x.id === planId);
  if (!p) return;
  if (!crewState.crews.length) { toast('Make or join a crew first, at the top of Plans.'); return; }
  openSheet(`
    <h2>Share with your crew</h2>
    <p class="muted small">${esc(p.spotName)}, ${esc(fmtDay(p.dayT ?? p.t, p.offset))} ${esc(TYPE_NAME[p.type] || p.type)} ${fmtTime(p.t, p.offset)}. Crewmates see the spot, the time and the score, and get a notification.</p>
    <form class="form" id="shareForm">
      <fieldset><legend>Crews</legend>
        ${crewState.crews.map((c, i) => `<label class="check"><input type="checkbox" name="crew" value="${c.id}" ${i === 0 ? 'checked' : ''}> ${esc(c.name)}</label>`).join('')}
      </fieldset>
      <label>Note (optional)<input name="note" maxlength="200" placeholder="e.g. Meeting at the car park 5:10am"></label>
      <div class="row"><button class="btn primary" type="submit">Share</button><button class="btn ghost" type="button" data-close>Cancel</button></div>
    </form>`);
  $('#shareForm').onsubmit = async ev => {
    ev.preventDefault();
    const f = new FormData(ev.target);
    const ids = f.getAll('crew');
    if (!ids.length) return toast('Pick a crew');
    const btn = ev.target.querySelector('button[type=submit]');
    btn.disabled = true; btn.textContent = 'Sharing…';
    try {
      if (!p.sessionKey) update(s => { const x = s.plans.find(y => y.id === p.id); x.sessionKey = sessionKeyOf(x.lat, x.lon, x.type, x.t); });
      const plan = S().plans.find(x => x.id === p.id);
      for (const id of ids) {
        const crew = crewState.crews.find(c => c.id === id);
        await shareToCrew(id, myNameIn(crew), plan, String(f.get('note') || '').trim(), await spotPayload(plan.spotId));
      }
      update(s => { const x = s.plans.find(y => y.id === p.id); x.sharedTo = [...new Set([...(x.sharedTo || []), ...ids])]; });
      await loadCrew();
      closeSheet();
      toast('Shared. Your crew has been notified.');
      render();
    } catch (e) { toast(e.message, 6000); btn.disabled = false; btn.textContent = 'Share'; }
  };
}

// Join a crewmate's plan: add it to your Plans (with your own leave time) and tell the crew you're in.
async function joinCrewPlan(cpId) {
  const cp = crewState.plans.find(x => x.id === cpId);
  if (!cp) return;
  const st = S();
  const drive = driveMinutes({ lat: cp.lat, lon: cp.lon }, st.settings);
  const arrive = Number(st.settings.arriveBeforeMin ?? 30);
  const plan = {
    id: uid(), key: `crew:${cp.session_key}`, spotId: null, spotName: cp.spot_name, lat: cp.lat, lon: cp.lon,
    type: cp.type, t: cp.t, dayT: cp.day_t, leave: cp.t - (arrive + (drive || 0)) * 60, offset: cp.offset_s, score: cp.score,
    hunt: cp.hunt, sessionKey: cp.session_key, features: null, brief: cp.note ? `Crew note: ${cp.note}` : '',
    gear: gearFor({ type: cp.type, t: cp.t, topHunt: cp.hunt || 'colour', hunts: { [cp.hunt || 'colour']: { score: 100 } }, spot: {}, hour: {} }, st.settings),
    packed: [], rating: null, sharedTo: [cp.crew_id],
  };
  if (!S().plans.some(p => p.sessionKey === cp.session_key)) update(s => { s.plans.push(plan); });
  const crew = crewState.crews.find(c => c.id === cp.crew_id);
  try { await shareToCrew(cp.crew_id, myNameIn(crew), S().plans.find(p => p.sessionKey === cp.session_key), '', cp.spot || null); } catch (e) { toast(e.message, 6000); }
  await loadCrew();
  toast("You're in. It's in your Plans and the crew knows.");
  render();
}

// Open a crewmate's spot: its forecast for the week, from your point of view (your drive, your personal score).
const sharedSpotOf = cp => ({
  ...(cp.spot || {}), id: `crew-${cp.id}`, name: cp.spot_name, lat: cp.lat, lon: cp.lon,
  hunts: cp.spot?.hunts || [cp.hunt || 'colour'], events: cp.spot?.events || ['sunrise', 'sunset'], photos: [],
});
function mySpotNear(lat, lon) { return S().spots.find(sp => haversineKm(sp, { lat, lon }) <= 0.3); }

async function openSharedSpot(cpId) {
  const cp = crewState.plans.find(x => x.id === cpId);
  if (!cp) { toast('That crew plan has been removed.'); return; }
  const me = currentUser()?.id;
  const sp = sharedSpotOf(cp);
  const who = cp.user_id === me ? 'You' : cp.display_name;
  const photo = cp.spot?.photo || null;
  openSheet(`<h2 class="bf-name">${esc(cp.spot_name)}</h2>${skeleton('week', 'Loading the forecast for this spot…')}`);
  let data;
  try {
    data = forecasts[sp.id] || await fetchSpotForecast(sp);
    forecasts[sp.id] = data;
  } catch (e) { $('#sheetBody').innerHTML = `<h2 class="bf-name">${esc(cp.spot_name)}</h2><div class="alert danger">${esc(e.message)}</div>`; return; }
  const st = S();
  const evs = evaluateSpot(sp, data, st.keepers, st.settings);
  indexEvents(evs);
  const theirs = evs.find(e => e.type === cp.type && Math.abs(e.t - cp.t) < 7200);
  const mine = mySpotNear(cp.lat, cp.lon);
  const going = crewState.plans.filter(x => x.session_key === cp.session_key || (x.type === cp.type && Math.abs(x.t - cp.t) <= 7200 && haversineKm(x, cp) <= 1.5));
  const names = [...new Set(going.map(x => x.user_id === me ? 'You' : x.display_name))];
  const inAlready = going.some(x => x.user_id === me);

  const now = Date.now() / 1000;
  const dayOf = e => dayKey(e.dayT ?? e.t, e.offset);
  const days = [];
  for (let i = 0; i < 7; i++) { const t = now + i * 86400, k = dayKey(t, data.offset); if (evs.some(e => dayOf(e) === k)) days.push({ k, label: i === 0 ? 'Today' : fmtWeekday(t, data.offset).slice(0, 3), date: fmtDayDate(t, data.offset).split(' ')[1] }); }
  const types = SESSION_TYPES.filter(type => evs.some(e => e.type === type));
  const cellFor = (k, type) => evs.find(e => dayOf(e) === k && e.type === type);
  const hunts = (cp.spot?.hunts || []).map(k => HUNT_LABEL[k]).filter(Boolean).join(', ');

  $('#sheetBody').innerHTML = `
    ${photo ? `<img class="banner" src="${photo}" alt="${esc(cp.spot_name)}">` : ''}
    <header class="bf-head"><div>
      <h2 class="bf-name">${esc(cp.spot_name)}</h2>
      <p class="bf-when">Shared by ${esc(who)}${hunts ? `. ${esc(hunts)}` : ''}${cp.spot?.hikeMin || cp.spot?.hikeKm ? `. ${esc(hikeSummary(sp) || '')}` : ''}</p>
    </div></header>
    <p class="bf-verdict">${esc(names.join(', '))} ${names.length === 1 && names[0] !== 'You' ? 'is' : 'are'} going ${esc(sessionName({ type: cp.type, t: cp.t, dayT: cp.day_t ?? cp.t, offset: cp.offset_s }))}, ${fmtTime(cp.t, cp.offset_s)}.${theirs ? ` For you it scores ${theirs.score}: ${esc(huntPhrase(theirs).toLowerCase())}, leaving at ${fmtTime(theirs.leave, theirs.offset)}.` : ''}</p>
    ${cp.note ? `<p class="crew-note">“${esc(cp.note)}” <span class="muted">${esc(who)}</span></p>` : ''}
    ${mine ? `<p class="bf-note crew">This is near ${esc(mine.name)}, one of your spots.</p>` : ''}
    <div class="bf-quiet">
      ${theirs ? `<button class="link-btn" data-ev="${esc(theirs.key)}">Briefing for this session</button>` : ''}
      <a class="link-btn" target="_blank" rel="noopener" href="https://www.google.com/maps/dir/?api=1&destination=${cp.lat},${cp.lon}">Directions</a>
    </div>

    <h3 class="sec">The week here, for you</h3>
    ${days.length && types.length ? `<div class="wk-wrap"><div class="wk" style="grid-template-columns: 74px repeat(${days.length}, 44px)">
      <span></span>${days.map(d => `<span class="wk-day">${d.label}<small>${d.date}</small></span>`).join('')}
      ${types.map((type, ti) => `<span class="wk-type">${TYPE_NAME[type]}</span>${days.map((d, di) => {
        const e = cellFor(d.k, type);
        return e ? `<button class="mx-cell ${band(e.score)} ${theirs && e.key === theirs.key ? 'theirs' : ''}" style="--n:${ti + di}" data-ev="${esc(e.key)}" aria-label="${TYPE_NAME[type]} ${d.label}, score ${e.score}">${e.score}</button>` : '<span class="mx-none" aria-hidden="true">–</span>';
      }).join('')}`).join('')}
    </div></div>
    <p class="small muted">Scored with your drive time and personal score. The outlined square is ${esc(who === 'You' ? 'your' : `${who}'s`)} session.</p>` : '<p class="muted">No sessions in the next 7 days.</p>'}
    ${cp.spot?.notes ? `<h3 class="sec">${esc(who === 'You' ? 'Your' : `${who}'s`)} notes</h3><p class="bf-brief">${esc(cp.spot.notes)}</p>` : ''}

    <div class="sheet-actions">
      ${mine ? `<button class="btn" data-open-mine="${mine.id}">Open my copy</button>` : '<button class="btn primary" id="saveShared">Save to my spots</button>'}
      ${cp.user_id !== me && !inAlready ? `<button class="btn ${mine ? 'primary' : ''}" data-join="${cp.id}">I'm in</button>` : ''}
    </div>`;
  runCounts($('#sheetBody'));
  const save = $('#saveShared');
  if (save) save.onclick = async () => {
    save.disabled = true; save.textContent = 'Saving…';
    const id = await saveSharedSpot(cp);
    toast(`${cp.spot_name} saved to your spots.`);
    for (const k in forecasts) if (k.startsWith('crew-')) delete forecasts[k];
    openSpotDetail(id);
  };
  const om = $('[data-open-mine]');
  if (om) om.onclick = () => openSpotDetail(om.dataset.openMine);
  $$('#sheetBody [data-join]').forEach(b => b.onclick = () => { b.disabled = true; closeSheet(); joinCrewPlan(b.dataset.join); });
}

async function saveSharedSpot(cp) {
  const src = cp.spot || {};
  let photos = [];
  if (src.photo) {
    try {
      const blob = await (await fetch(src.photo)).blob();
      photos = [await addPhotoFile(new File([blob], 'shared.jpg', { type: blob.type || 'image/jpeg' }))];
    } catch { /* keep the spot even if the photo can't be read */ }
  }
  const id = uid();
  const pick = ['events', 'coastal', 'tide', 'tideAccess', 'accessPct', 'accessBuffer', 'facing', 'hikeMin', 'hikeKm', 'difficulty', 'fogMode', 'notes'];
  const spot = { id, name: cp.spot_name, lat: cp.lat, lon: cp.lon, events: ['sunrise', 'sunset'], coastal: false, tide: 'any', driveMin: '', facing: '', notes: '', photos, hunts: src.hunts?.length ? src.hunts : [cp.hunt || 'colour'], fogMode: 'in', sharedFrom: cp.display_name };
  for (const k of pick) if (src[k] !== undefined) spot[k] = src[k];
  update(st => st.spots.push(spot));
  return id;
}

function crewPanel() {
  if (!currentUser()) return `<section class="panel"><h2>Crew</h2><p class="small muted">Sign in under You, in Account and sync, to make or join a crew and share plans with the people you shoot with.</p></section>`;
  if (!crewState.loaded) return `<section class="panel" id="crewPanel"><h2>Crew</h2><p class="loading">Loading your crew…</p></section>`;
  if (crewState.error) return `<section class="panel"><h2>Crew</h2><p class="small sync-err">${esc(crewState.error)}</p></section>`;
  const me = currentUser().id;
  if (!crewState.crews.length) return `<section class="panel">
    <h2>Crew</h2>
    <p class="small muted">Share plans with the people you shoot with: see who's heading where, join their sessions, and get a notification when someone shares.</p>
    <form class="form" id="crewCreate">
      <div class="two"><label>Crew name<input name="name" maxlength="60" required placeholder="e.g. Dawn patrol"></label><label>Your name<input name="me" maxlength="40" required value="${esc((currentUser().email || '').split('@')[0])}"></label></div>
      <button class="btn primary" type="submit">Create a crew</button>
    </form>
    <form class="form" id="crewJoin" style="margin-top:16px">
      <div class="two"><label>Invite code<input name="code" maxlength="6" required autocapitalize="characters" placeholder="ABC123"></label><label>Your name<input name="me" maxlength="40" required value="${esc((currentUser().email || '').split('@')[0])}"></label></div>
      <button class="btn" type="submit">Join a crew</button>
    </form>
  </section>`;

  // Group crew plans by session: shared sessions show everyone who's in.
  const groups = [];
  for (const cp of crewState.plans) {
    const g = groups.find(x => x.type === cp.type && Math.abs(x.t - cp.t) <= 7200 && haversineKm(x, cp) <= 1.5);
    if (g) g.items.push(cp); else groups.push({ type: cp.type, t: cp.t, lat: cp.lat, lon: cp.lon, items: [cp] });
  }
  const groupRow = g => {
    const first = g.items[0];
    const mine = g.items.some(x => x.user_id === me);
    const people = [...new Set(g.items.map(x => x.user_id === me ? 'You' : x.display_name))];
    const notes = g.items.filter(x => x.note).map(x => `<p class="crew-note">“${esc(x.note)}” <span class="muted">${esc(x.user_id === me ? 'You' : x.display_name)}</span></p>`).join('');
    const scores = g.items.map(x => x.score).filter(x => x != null);
    return `<div class="plan crew-plan">
      <div class="ev-title">${esc(first.spot_name)}</div>
      <div class="ev-sub"><span><strong>${esc(fmtDay(first.day_t ?? first.t, first.offset_s))}, ${esc(TYPE_NAME[first.type] || first.type)} ${fmtTime(first.t, first.offset_s)}</strong></span>${scores.length ? `<span>Score ${Math.max(...scores)}</span>` : ''}</div>
      <p class="crew-people">${esc(people.join(', '))}</p>
      ${notes}
      <div class="row">
        <button class="btn ${mine ? '' : 'primary'}" data-view-spot="${first.id}">${first.spot?.photo ? 'View spot' : 'View spot and forecast'}</button>
        ${mine ? '<span class="small caramel crew-in">You\'re in</span>' : `<button class="btn" data-join="${first.id}">I'm in</button>`}
      </div>
      ${mySpotNear(first.lat, first.lon) ? '' : '<p class="small muted">Not in your spots yet. Open it to save a copy.</p>'}
    </div>`;
  };
  return `<section class="panel">
    <h2>Crew</h2>
    ${crewState.crews.map(c => {
      const mem = crewState.members.filter(m => m.crew_id === c.id);
      return `<div class="crew-head">
        <div><div class="ev-title">${esc(c.name)}</div><div class="ev-sub"><span>${esc(mem.map(m => m.user_id === me ? 'You' : m.display_name).join(', '))}</span></div></div>
        <div class="crew-code"><span class="num">${esc(c.invite_code)}</span><button class="btn ghost small-btn" data-invite="${c.id}">Invite</button></div>
      </div>`;
    }).join('')}
    <label class="switch-row"><span><strong>Share my plans automatically</strong><small>Every shoot you plan is shared with your crew, and they get a notification.</small></span>
      <input type="checkbox" id="autoShare" role="switch" ${S().settings.crewAutoShare !== false ? 'checked' : ''}></label>
    <h3>Who's going where</h3>
    ${groups.length ? groups.map(groupRow).join('') : '<p class="small muted">No crew plans yet. Share one of yours from Upcoming below.</p>'}
    <div class="row"><button class="btn ghost small-btn" id="crewMore">Join or make another crew</button>${crewState.crews.length ? `<button class="btn ghost small-btn" id="crewLeave">Leave a crew</button>` : ''}</div>
  </section>`;
}

function wireCrewPanel(v) {
  const meName = f => String(f.get('me') || '').trim();
  const cf = $('#crewCreate', v);
  if (cf) cf.onsubmit = async ev => {
    ev.preventDefault();
    const f = new FormData(cf);
    try { const c = await createCrew(String(f.get('name')).trim(), meName(f)); await loadCrew(); closeSheet(); toast(`Crew made. Invite code ${c.invite_code}.`, 5000); render(); }
    catch (e) { toast(e.message, 6000); }
  };
  const jf = $('#crewJoin', v);
  if (jf) jf.onsubmit = async ev => {
    ev.preventDefault();
    const f = new FormData(jf);
    try { const c = await joinCrew(String(f.get('code')).trim(), meName(f)); await loadCrew(); closeSheet(); toast(`You've joined ${c.name}.`); render(); }
    catch (e) { toast(e.message, 6000); }
  };
  $$('[data-invite]', v).forEach(b => b.onclick = async () => {
    const c = crewState.crews.find(x => x.id === b.dataset.invite);
    const text = `Join my Tidelight crew "${c.name}" with the code ${c.invite_code}: open Tidelight, then Plans → Crew → Join a crew. ${location.origin + location.pathname}`;
    try {
      if (navigator.share) await navigator.share({ title: 'Join my Tidelight crew', text });
      else { await navigator.clipboard.writeText(text); toast('Invite copied. Paste it in a message.'); }
    } catch { /* cancelled */ }
  });
  $$('[data-join]', v).forEach(b => b.onclick = () => { b.disabled = true; joinCrewPlan(b.dataset.join); });
  $$('[data-view-spot]', v).forEach(b => b.onclick = () => openSharedSpot(b.dataset.viewSpot));
  const as = $('#autoShare', v);
  if (as) as.onchange = () => { update(s2 => { s2.settings.crewAutoShare = as.checked; }); toast(as.checked ? 'New plans will be shared with your crew.' : 'New plans stay private until you share them.'); };
  const more = $('#crewMore', v);
  if (more) more.onclick = () => { openSheet(`<h2>Another crew</h2>
    <form class="form" id="crewCreate"><div class="two"><label>Crew name<input name="name" maxlength="60" required></label><label>Your name<input name="me" maxlength="40" required value="${esc(myNameIn(crewState.crews[0] || {}))}"></label></div><button class="btn primary" type="submit">Create a crew</button></form>
    <form class="form" id="crewJoin" style="margin-top:16px"><div class="two"><label>Invite code<input name="code" maxlength="6" required autocapitalize="characters"></label><label>Your name<input name="me" maxlength="40" required value="${esc(myNameIn(crewState.crews[0] || {}))}"></label></div><button class="btn" type="submit">Join a crew</button></form>`); wireCrewPanel($('#sheetBody')); };
  const leave = $('#crewLeave', v);
  if (leave) leave.onclick = () => {
    openSheet(`<h2>Leave a crew</h2><p class="small muted">Your shared plans in that crew are removed. You can rejoin with the invite code.</p>
      ${crewState.crews.map(c => `<div class="row"><button class="btn danger block" data-leave="${c.id}">Leave ${esc(c.name)}</button></div>`).join('')}`);
    $$('[data-leave]').forEach(b => b.onclick = async () => {
      try { await leaveCrew(b.dataset.leave); await loadCrew(); closeSheet(); toast('Left the crew.'); render(); } catch (e) { toast(e.message, 6000); }
    });
  };
}

/* ================= plans ================= */

function addPlan(e) {
  update(s => {
    if (s.plans.some(p => p.key === e.key)) return;
    s.plans.push({
      id: uid(), key: e.key, spotId: e.spot.id, spotName: e.spot.name, lat: e.spot.lat, lon: e.spot.lon,
      type: e.type, t: e.t, dayT: e.dayT ?? null, leave: e.leave, offset: e.offset, score: e.score, hunt: e.topHunt,
      sessionKey: sessionKeyOf(e.spot.lat, e.spot.lon, e.type, e.t), features: e.features,
      brief: briefing(e), gear: gearFor(e, s.settings), packed: [], rating: null,
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
  return `<section class="hit">
    <h3 class="sec">How often the score is right</h3>
    ${h.total < 3
      ? `<p class="muted">Rate ${3 - h.total} more session${3 - h.total === 1 ? '' : 's'} to see how accurate the app is for you. Every rating also trains your personal score.</p>`
      : `<div class="hit-big"><span class="num">${pct}%</span><span>${h.hits} of ${h.total} calls right</span></div>
         <p class="small muted">A call counts as right when a predicted 60+ delivered, or a predicted under 60 wasn't worth it.${h.meh ? ` ${h.meh} so-so session${h.meh === 1 ? '' : 's'} not counted.` : ''}</p>
         ${h.keeperAvg != null && h.dudAvg != null ? `<p class="small">Sessions that delivered averaged a predicted <strong>${h.keeperAvg}</strong>; ones that didn't averaged <strong>${h.dudAvg}</strong>. ${h.keeperAvg - h.dudAvg >= 15 ? 'A clear gap, so the score is telling them apart.' : 'Not much gap yet; more ratings will sharpen your personal score.'}</p>` : ''}
         ${h.bySpot.length > 1 ? `<div class="hit-spots">${h.bySpot.map(b => `<div><span>${esc(b.name)}</span><span class="num">${b.hits}/${b.total}</span></div>`).join('')}</div>` : ''}`}
  </section>`;
}

const openGear = new Set();   // which plans have their gear list open
let plansView = 'upcoming';   // upcoming | crew | history
let plansTimer = null;        // keeps the "leave in…" line current

// "tomorrow sunrise, 6:17am" (callers capitalise it when it starts a sentence)
function planWhen(p) {
  const day = fmtDay(p.dayT ?? p.t, p.offset).replace(/^(Today|Tomorrow|Yesterday)$/, d => d.toLowerCase());
  return `${day} ${(TYPE_NAME[p.type] || p.type).toLowerCase()}, ${fmtTime(p.t, p.offset)}`;
}
function leaveText(p) {
  const now = Date.now() / 1000;
  if (p.leave > now) return `in ${untilText(p.leave - now)}`;
  if (p.t > now) return `now: the session starts in ${untilText(p.t - now)}`;
  return 'the session has started';
}
function gearChecklist(p, open) {
  const gear = p.gear || [];
  if (!gear.length) return '';
  const packed = new Set(p.packed || []);
  return `<details class="gear-list" ${open || openGear.has(p.id) ? 'open' : ''} data-gearbox="${p.id}">
      <summary>Gear: ${gear.filter(g => packed.has(g.id)).length} of ${gear.length} packed</summary>
      ${gear.map(g => `<label class="check gear-item"><input type="checkbox" data-pack="${p.id}" value="${esc(g.id)}" ${packed.has(g.id) ? 'checked' : ''}><span>${esc(g.label)}<small>${esc(g.why)}</small></span></label>`).join('')}
    </details>`;
}
function planActions(p, lead) {
  const shared = (p.sharedTo || []).length;
  return `<div class="plan-actions">
      ${eventIndex.has(p.key) ? `<button class="btn ${lead ? 'primary' : ''}" data-field="${esc(p.key)}">Open field mode</button>` : ''}
      ${eventIndex.has(p.key) ? `<button class="btn" data-ev="${esc(p.key)}">Full briefing</button>` : ''}
      ${currentUser() ? `<button class="btn" data-share="${p.id}">${shared ? 'Shared with crew' : 'Share with crew'}</button>` : ''}
    </div>
    <div class="bf-quiet">
      <button class="link-btn" data-ics="${p.id}">Add to calendar</button>
      <button class="link-btn danger" data-del="${p.id}">Remove plan</button>
    </div>`;
}

async function renderPlans(v, refreshed = false) {
  clearInterval(plansTimer);
  const st = S();
  const now = Date.now() / 1000;
  const upcoming = st.plans.filter(p => p.t >= now - 3600).sort((a, b) => a.t - b.t);
  const past = st.plans.filter(p => p.t < now - 3600).sort((a, b) => b.t - a.t);
  const toRate = past.filter(p => !p.rating);
  const rated = past.filter(p => p.rating);
  const next = upcoming[0];
  const later = upcoming.slice(1);
  const label = { keeper: 'Delivered', meh: 'So-so', dud: 'Not worth it', skipped: "Didn't go" };

  const lede = [
    next ? `Next: ${next.spotName}, ${planWhen(next)}.` : 'Nothing planned yet.',
    toRate.length ? `${toRate.length} session${toRate.length === 1 ? '' : 's'} to rate.` : '',
  ].filter(Boolean).join(' ');

  const upcomingView = () => `
    ${toRate.length ? `<section class="rate-block">
      <h3 class="sec">How did ${toRate.length === 1 ? 'this one' : 'these'} go?</h3>
      <p class="small muted">Each rating teaches your personal score, and counts towards the hit rate under History.</p>
      ${toRate.map(p => `<div class="rate-row">
        <p class="rate-name">${esc(p.spotName)}<small>${esc(cap(planWhen(p)))}${p.score != null ? `, predicted ${p.score}` : ''}</small></p>
        <div class="rate-btns">
          <button class="btn" data-rate="keeper" data-id="${p.id}">It delivered</button>
          <button class="btn" data-rate="meh" data-id="${p.id}">So-so</button>
          <button class="btn" data-rate="dud" data-id="${p.id}">Not worth it</button>
        </div></div>`).join('')}
    </section>` : ''}
    ${next ? `<section class="next-up">
      <h2 class="nu-name">${esc(next.spotName)}</h2>
      <p class="nu-when">${esc(cap(planWhen(next)))}${next.score != null ? `. Scored ${next.score} when you planned it.` : '.'}</p>
      <p class="nu-leave">Leave at ${fmtTime(next.leave, next.offset)}</p>
      <p class="nu-in" id="leaveIn" aria-live="off">${esc(cap(leaveText(next)))}</p>
      ${gearChecklist(next, true)}
      ${planActions(next, true)}
    </section>` : `<section class="empty-plans">
      <p>Pick a session on the Forecast page and tap <strong>Plan this shoot</strong>. It shows up here with its leave time, a gear list to pack and field mode.</p>
      <button class="btn primary" id="toForecast">Go to Forecast</button>
    </section>`}
    ${later.length ? `<section class="later">
      <h3 class="sec">After that</h3>
      ${later.map(p => `<details class="plan-item" ${openGear.has('item:' + p.id) ? 'open' : ''} data-item="${p.id}">
        <summary><span class="pi-name">${esc(p.spotName)}</span><span class="pi-when">${esc(cap(planWhen(p)))}</span><span class="pi-leave num">Leave ${fmtTime(p.leave, p.offset)}</span></summary>
        ${gearChecklist(p, false)}
        ${planActions(p, false)}
      </details>`).join('')}
    </section>` : ''}`;

  const historyView = () => `
    ${hitPanel(st)}
    ${rated.length ? `<section><h3 class="sec">Rated sessions</h3>
      ${rated.slice(0, 40).map(p => `<div class="hist-row">
        <span class="hist-name">${esc(p.spotName)}<small>${esc(cap(planWhen(p)))}</small></span>
        <span class="hist-score num">${p.score ?? '–'}</span>
        <span class="hist-rating ${p.rating}">${label[p.rating] || ''}</span>
      </div>`).join('')}</section>` : '<p class="muted">No rated sessions yet. After a planned session passes, it appears under Upcoming to rate.</p>'}
    <div id="unplanned"></div>`;

  v.innerHTML = `
    <h1 class="page-title">Plans</h1>
    <p class="page-lede">${esc(lede)}</p>
    <div class="day-pills" role="tablist" aria-label="Plans views">
      ${[['upcoming', `Upcoming${upcoming.length ? ` (${upcoming.length})` : ''}`], ['crew', 'Crew'], ['history', 'History']]
        .map(([k, t]) => `<button role="tab" aria-selected="${plansView === k}" class="${plansView === k ? 'on' : ''}" data-pview="${k}">${t}</button>`).join('')}
    </div>
    <div class="plans-view">${plansView === 'upcoming' ? upcomingView() : plansView === 'crew' ? crewPanel() : historyView()}</div>`;

  $$('[data-pview]', v).forEach(b => b.onclick = () => { plansView = b.dataset.pview; renderPlans(v); });
  const tf = $('#toForecast', v);
  if (tf) tf.onclick = () => setTab('forecast');
  if (next && $('#leaveIn', v)) plansTimer = setInterval(() => { const el = $('#leaveIn'); if (el && tab === 'plans') el.textContent = cap(leaveText(next)); else clearInterval(plansTimer); }, 1000);

  $$('[data-ics]', v).forEach(b => b.onclick = () => {
    const p = S().plans.find(x => x.id === b.dataset.ics);
    downloadFile(`tidelight-${p.type}.ics`, icsText({
      id: p.id, title: `Leave for ${p.spotName} ${p.type}${p.score != null ? ` (${p.score})` : ''}`, start: p.leave, end: p.t + 1800,
      desc: p.brief || '', lat: p.lat, lon: p.lon,
    }), 'text/calendar');
  });
  $$('[data-del]', v).forEach(b => b.onclick = async () => {
    const p = S().plans.find(x => x.id === b.dataset.del);
    if (!p || !confirm(`Remove your plan for ${p.spotName}?`)) return;
    update(s2 => { s2.plans = s2.plans.filter(x => x.id !== b.dataset.del); });
    if (p.sharedTo?.length && p.sessionKey) { for (const c of p.sharedTo) await unshareFromCrew(c, p.sessionKey).catch(() => {}); await loadCrew(); }
    toast('Plan removed.');
    render();
  });
  $$('[data-share]', v).forEach(b => b.onclick = () => openShareSheet(b.dataset.share));
  $$('[data-pack]', v).forEach(cb => cb.onchange = () => {
    update(s2 => {
      const p = s2.plans.find(x => x.id === cb.dataset.pack);
      const set = new Set(p.packed || []);
      if (cb.checked) set.add(cb.value); else set.delete(cb.value);
      p.packed = [...set];
    });
    const p = S().plans.find(x => x.id === cb.dataset.pack);
    cb.closest('details').querySelector('summary').textContent = `Gear: ${(p.packed || []).length} of ${(p.gear || []).length} packed`;
  });
  $$('[data-gearbox]', v).forEach(d => d.ontoggle = () => { if (d.open) openGear.add(d.dataset.gearbox); else openGear.delete(d.dataset.gearbox); });
  $$('[data-item]', v).forEach(d => d.ontoggle = () => { const k = 'item:' + d.dataset.item; if (d.open) openGear.add(k); else openGear.delete(k); });
  $$('[data-rate]', v).forEach(b => b.onclick = () => ratePlan(b.dataset.id, b.dataset.rate, b));
  if (plansView === 'crew') {
    wireCrewPanel(v);
    if (currentUser() && !crewState.loaded) loadCrew().then(() => { if (tab === 'plans' && plansView === 'crew') renderPlans(v); });
  }

  // Sessions need their live forecast loaded for field mode, the briefing, and logging unplanned shoots.
  if (!st.spots.length) return;
  const missing = upcoming.some(p => p.spotId && !eventIndex.has(p.key));
  await ensureForecasts();
  if (tab !== 'plans') return;
  const all = allEvents({ includePast: true });
  if (missing && !refreshed && upcoming.some(p => eventIndex.has(p.key))) return renderPlans(v, true);

  const box = $('#unplanned', v);
  if (!box) return;
  const planned = new Set(S().plans.map(p => p.key));
  const recent = all.filter(e => e.t < now - 3600 && e.t > now - 2 * 86400 && !planned.has(e.key)).sort((a, b) => b.t - a.t).slice(0, 8);
  if (!recent.length) return;
  box.innerHTML = `<h3 class="sec">Shot something unplanned?</h3>
    <p class="small muted">Log it here and it moves to Upcoming for you to rate. Unplanned sessions count towards your hit rate too.</p>
    ${recent.map(e => `<div class="hist-row">
      <span class="hist-name">${esc(e.spot.name)}<small>${esc(cap(sessionName(e)))}, predicted ${e.score}</small></span>
      <button class="btn" data-log="${esc(e.key)}">I shot this</button>
    </div>`).join('')}`;
  $$('[data-log]', box).forEach(b => b.onclick = () => {
    const e = eventIndex.get(b.dataset.log);
    if (!e) return;
    addPlan(e);
    plansView = 'upcoming';
    toast('Logged. Rate it at the top of Upcoming.');
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
    s.keepers.push({
      id: uid(), label: rating, source: 'session', planId: p.id,   // keeper | meh | dud
      date: p.t * 1000, lat: p.lat, lon: p.lon, spotName: p.spotName, features, thumb: null,
    });
  });
  toast('Saved. Your personal score just learned from that.');
  render();
}

/* ================= spots ================= */

let spotFilter = 'all';     // all | sunrise | day | sunset | night
let spotsShowMap = false;

function spotChips(sp, e) {
  const c = [];
  if (e) c.push(`<span class="tag-chip">${esc(HUNT_LABEL[e.topHunt])}</span>`);
  const hk = hikeSummary(sp);
  if (hk) c.push(`<span class="tag-chip">${esc(hk.replace('Hike: ', 'Hike '))}</span>`);
  if (e?.access && !e.access.none) c.push(e.access.inside
    ? `<span class="tag-chip">Tide open ${fmtTime(e.access.start, e.offset)}–${fmtTime(e.access.backBy, e.offset)}</span>`
    : '<span class="tag-chip warn">Tide blocks access</span>');
  if (e && unsure(e)) c.push('<span class="tag-chip unsure">Models disagree</span>');
  else if (e?.confidence?.level === 'high' && e.topHunt === 'colour') c.push('<span class="tag-chip">Models agree</span>');
  const going = e ? crewGoing(e) : [];
  if (going.length) c.push(`<span class="tag-chip crew">${esc(goingText(going))}</span>`);
  return c.join('');
}

function spotCard(sp, e) {
  return `<button class="spot-card" data-spot="${sp.id}">
    ${coverUrl(sp) ? `<img class="spot-card-img" src="${coverUrl(sp)}" alt="">` : `<span class="spot-card-img empty" aria-hidden="true">${esc(sp.name.charAt(0))}</span>`}
    <span class="spot-card-body">
      <span class="spot-card-head"><span class="spot-card-name">${esc(sp.name)}</span>${e ? `<span class="spot-card-score num" data-count="${e.score}">${e.score}</span>` : ''}</span>
      ${e ? `<span class="spot-card-when">${esc(cap(sessionName(e)))}, ${sessionWhen(e)}</span>
             <span class="spot-card-why">${esc(whyLine(e))}</span>`
          : `<span class="spot-card-why">${spotFilter === 'all' ? 'No sessions in the next 3 days. Check its sessions and hunts.' : `No ${TYPE_NAME[spotFilter].toLowerCase()} sessions here.`}</span>`}
      <span class="spot-card-chips">${spotChips(sp, e)}</span>
    </span>
  </button>`;
}

async function renderSpots(v) {
  if (map) { map.remove(); map = null; }
  const st = S();
  v.innerHTML = `
    <h1 class="page-title">Spots</h1>
    <p class="page-lede">Ranked by each spot's best session in the next 3 days.</p>
    <form class="search" id="placeSearch" role="search">
      <input type="search" id="placeQ" placeholder="Search to add a beach, falls or lookout" autocomplete="off" enterkeyhint="search" aria-label="Search for a place to add">
      <button class="btn primary" type="submit">Search</button>
    </form>
    <div id="placeResults" class="results" hidden></div>
    <div class="row spot-actions">
      <button class="btn" id="addSpot">Add spot</button>
      <button class="btn" id="scoutBtn">Scout this spot</button>
      <button class="btn ${spotsShowMap ? 'primary' : 'ghost'}" id="mapToggle" aria-pressed="${spotsShowMap}">${spotsShowMap ? 'Hide map' : 'Map'}</button>
    </div>
    ${spotsShowMap ? `<div id="map" role="application" aria-label="Map of your spots. Tap to add a spot."></div>
      <p class="small muted" style="margin-top:8px">Tap anywhere on the map to add a spot there.</p>` : ''}
    <div class="day-pills filter" role="tablist" aria-label="Filter by session">
      ${['all', ...SESSION_TYPES].map(f => `<button role="tab" aria-selected="${spotFilter === f}" class="${spotFilter === f ? 'on' : ''}" data-filter="${f}">${f === 'all' ? 'All' : TYPE_NAME[f]}</button>`).join('')}
    </div>
    <section id="spotCards">${st.spots.length ? skeleton('cards', 'Scoring your spots…') : '<p class="muted">No spots yet. Search above, tap the map, or add where you are.</p>'}</section>`;

  $('#addSpot').onclick = () => openSpotForm();
  found = null;
  $('#placeSearch').onsubmit = ev => { ev.preventDefault(); runPlaceSearch(); };
  $('#scoutBtn').onclick = () => openScout();
  $('#mapToggle').onclick = () => { spotsShowMap = !spotsShowMap; renderSpots(v); };
  $$('[data-filter]', v).forEach(b => b.onclick = () => { spotFilter = b.dataset.filter; renderSpots(v); });
  if (spotsShowMap) initSpotsMap(st);

  if (!st.spots.length) return;
  await ensureForecasts();
  if (tab !== 'spots' || !$('#spotCards')) return;
  const evs = next3Days();
  indexEvents(evs);
  const bestFor = sp => evs.filter(e => e.spot.id === sp.id && (spotFilter === 'all' || e.type === spotFilter)).sort((a, b) => b.score - a.score)[0];
  const rows = st.spots.map(sp => ({ sp, e: bestFor(sp) }))
    .filter(r => spotFilter === 'all' || r.e)
    .sort((a, b) => (b.e?.score ?? -1) - (a.e?.score ?? -1));
  $('#spotCards').innerHTML = rows.length ? rows.map(r => spotCard(r.sp, r.e)).join('') : `<p class="muted">None of your spots have ${TYPE_NAME[spotFilter].toLowerCase()} sessions in the next 3 days.</p>`;
  $$('#spotCards [data-spot]').forEach(b => b.onclick = () => openSpotDetail(b.dataset.spot));
  runCounts($('#spotCards'));
}

function initSpotsMap(st) {
  if (!window.L || !$('#map')) return;
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
  if (window.L && !map && tab === 'spots') {
    spotsShowMap = true;
    renderSpots($('#view'));
    if (map) return showFoundPlace(r);
  }
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
  const hasTravel = !!(s.driveMin || s.hikeMin || s.hikeKm || s.difficulty);
  const hasComposition = (s.facing !== '' && s.facing != null) || !!s.notes;
  const travelNote = hikeSummary(s) ? hikeSummary(s).replace('Hike: ', '') : (s.driveMin ? `${s.driveMin} min drive` : 'Estimated from home');
  const coastNote = s.coastal ? `Coastal${s.tide && s.tide !== 'any' ? `, ${s.tide} tide` : ''}${s.tideAccess ? ', tide access' : ''}` : 'Inland';
  const fold = (title, note, open, body) => `<details class="fold" ${open ? 'open' : ''}><summary><span>${title}</span><small>${esc(note)}</small></summary><div class="fold-body">${body}</div></details>`;
  openSheet(`
    <h2 class="bf-name">${existing ? 'Edit spot' : 'New spot'}</h2>
    <form id="spotForm" class="form spot-form" novalidate>
      <label>Name<input name="name" required value="${esc(s.name)}" placeholder="e.g. North jetty"></label>
      <fieldset>
        <legend>Photos</legend>
        <span class="hint">The first photo is the cover. Tap a photo to make it the cover.</span>
        <div class="photo-grid" id="photoGrid"></div>
        <label class="btn ghost" id="addPhotosBtn">Add photos<input type="file" id="spotPhotos" class="file-input" accept="image/*" multiple></label>
      </fieldset>

      <h3 class="sec">What you shoot here</h3>
      <fieldset><legend>Sessions</legend>
        <div class="checks">
          <label class="check"><input type="checkbox" name="ev_sunrise" ${s.events.includes('sunrise') ? 'checked' : ''}> Sunrise</label>
          <label class="check"><input type="checkbox" name="ev_sunset" ${s.events.includes('sunset') ? 'checked' : ''}> Sunset</label>
        </div>
        <span class="hint">Daytime and night sessions appear when you pick a forest, waterfall, aurora or Milky Way hunt.</span>
      </fieldset>
      <fieldset><legend>Hunts</legend>
        <span class="hint">Each one gets its own score. A session shows the best of them.</span>
        <div class="checks">
          ${HUNT_ORDER.map(k => `<label class="check"><input type="checkbox" name="hunt_${k}" ${huntsOf(s).includes(k) ? 'checked' : ''}> ${HUNT_LABEL[k]}</label>`).join('')}
        </div>
      </fieldset>
      <label id="fogModeWrap">For fog, this spot is<select name="fogMode">
        <option value="in" ${s.fogMode !== 'above' ? 'selected' : ''}>In the fog (forest, jetty, paddock)</option>
        <option value="above" ${s.fogMode === 'above' ? 'selected' : ''}>Above the fog (lookout over a valley)</option>
      </select></label>

      ${fold('Getting there', travelNote, hasTravel, `
        <label>Drive time (min)<span class="hint">Leave blank to estimate it from your home location</span><input name="driveMin" inputmode="numeric" value="${s.driveMin ?? ''}"></label>
        <fieldset><legend>Hike from the car</legend>
          <span class="hint">Leave blank if you can shoot from the car park. Leave times include the walk.</span>
          <div class="three">
            <label>Time (min)<input name="hikeMin" inputmode="numeric" value="${s.hikeMin ?? ''}" placeholder="Auto"></label>
            <label>Distance (km)<input name="hikeKm" inputmode="decimal" value="${s.hikeKm ?? ''}" placeholder="0"></label>
            <label>Difficulty<select name="difficulty">
              <option value="" ${!s.difficulty ? 'selected' : ''}>–</option>
              ${DIFFICULTIES.map(d => `<option value="${d}" ${s.difficulty === d ? 'selected' : ''}>${cap(d)}</option>`).join('')}
            </select></label>
          </div>
          <span class="hint">No time entered? It's estimated one way from distance and difficulty.</span>
        </fieldset>`)}

      ${fold('Coast and tide', coastNote, !!s.coastal && !!existing, `
        <label class="check"><input type="checkbox" name="coastal" ${s.coastal ? 'checked' : ''}> Coastal spot (use tide and wave data)</label>
        <label>Best tide<select name="tide">
          ${['any', 'low', 'mid', 'high'].map(t => `<option value="${t}" ${s.tide === t ? 'selected' : ''}>${cap(t)}</option>`).join('')}
        </select></label>
        <label class="check"><input type="checkbox" name="tideAccess" ${s.tideAccess ? 'checked' : ''}> Access depends on the tide (rock shelf, cave, sandbar)</label>
        <div class="two" id="accessWrap">
          <label>Open below (% of tide range)<span class="hint">0 is low tide, 100 is high</span><input name="accessPct" inputmode="numeric" value="${s.accessPct ?? 40}"></label>
          <label>Safety buffer (min)<span class="hint">Be back this long before it closes</span><input name="accessBuffer" inputmode="numeric" value="${s.accessBuffer ?? 30}"></label>
        </div>`)}

      ${fold('Composition and notes', hasComposition ? [s.facing !== '' && s.facing != null ? `Facing ${Math.round(Number(s.facing))}°` : '', s.notes ? 'Notes added' : ''].filter(Boolean).join(', ') : 'Optional', hasComposition, `
        <label>Facing (°)<span class="hint">The compass bearing of your composition. Used for sun and Milky Way alignment.</span><input name="facing" inputmode="numeric" value="${s.facing ?? ''}"></label>
        <label>Notes<textarea name="notes" placeholder="Access, parking, hazards, compositions">${esc(s.notes || '')}</textarea></label>`)}

      ${fold('Location', s.lat !== '' && s.lat != null ? `${Number(s.lat).toFixed(4)}, ${Number(s.lon).toFixed(4)}` : 'Needed', s.lat === '' || s.lat == null, `
        <div class="two">
          <label>Latitude<input name="lat" inputmode="decimal" required value="${num(s.lat)}"></label>
          <label>Longitude<input name="lon" inputmode="decimal" required value="${num(s.lon)}"></label>
        </div>
        <span class="hint">Set from the map, search or scouting. Edit here to fine-tune.</span>`)}

      ${existing ? '<div class="bf-quiet"><button type="button" class="link-btn danger" id="delSpot">Delete this spot</button></div>' : ''}
      <div class="sheet-actions">
        <button type="submit" class="btn primary">${existing ? 'Save spot' : 'Add spot'}</button>
        <button type="button" class="btn" data-close>Cancel</button>
      </div>
    </form>`);
  // Show the fog and tide-access options only when they apply.
  const sf = $('#spotForm');
  const syncOptional = () => {
    $('#fogModeWrap').hidden = !sf.querySelector('[name=hunt_fog]').checked;
    $('#accessWrap').hidden = !sf.querySelector('[name=tideAccess]').checked;
  };
  sf.addEventListener('change', syncOptional);
  syncOptional();

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
      hikeMin: f.get('hikeMin') ? Math.max(0, parseInt(f.get('hikeMin'), 10) || 0) || '' : '',
      hikeKm: f.get('hikeKm') ? Math.max(0, parseFloat(f.get('hikeKm')) || 0) || '' : '',
      difficulty: DIFFICULTIES.includes(f.get('difficulty')) ? f.get('difficulty') : '',
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
  openSheet(`<h2 class="bf-name">${esc(s.name)}</h2>${skeleton('week', 'Loading the week…')}`);
  try {
    if (!forecasts[id]) forecasts[id] = await fetchSpotForecast(s);
  } catch (e) {
    $('#sheetBody').innerHTML = `<h2 class="bf-name">${esc(s.name)}</h2><div class="alert danger">${esc(e.message)}</div>`;
    return;
  }
  const st = S();
  const evs = evaluateSpot(s, forecasts[id], st.keepers, st.settings);
  indexEvents(evs);
  const data = forecasts[id];
  const pics = (s.photos || []).filter(id => photoUrl(id));

  // The week at a glance: days across, session types down, shaded by score.
  const now = Date.now() / 1000;
  const dayOf = e => dayKey(e.dayT ?? e.t, e.offset);
  const days = [];
  for (let i = 0; i < 7; i++) {
    const t = now + i * 86400, k = dayKey(t, data.offset);
    if (evs.some(e => dayOf(e) === k)) days.push({ k, label: i === 0 ? 'Today' : fmtWeekday(t, data.offset).slice(0, 3), date: fmtDayDate(t, data.offset).split(' ')[1] });
  }
  const types = SESSION_TYPES.filter(type => evs.some(e => e.type === type));
  const cellFor = (k, type) => evs.find(e => dayOf(e) === k && e.type === type);
  const best = [...evs].sort((a, b) => b.score - a.score)[0];
  const week = days.length && types.length ? `
    <div class="wk-wrap"><div class="wk" style="grid-template-columns: 74px repeat(${days.length}, 44px)">
      <span></span>${days.map(d => `<span class="wk-day">${d.label}<small>${d.date}</small></span>`).join('')}
      ${types.map((type, ti) => `<span class="wk-type">${TYPE_NAME[type]}</span>${days.map((d, di) => {
        const e = cellFor(d.k, type);
        return e ? `<button class="mx-cell ${band(e.score)} ${unsure(e) ? 'unsure' : ''}" style="--n:${ti + di}" data-ev=""${esc(e.key)}" aria-label="${TYPE_NAME[type]} ${d.label} ${d.date}, score ${e.score}">${e.score}${e.access && !e.access.inside ? '<i class="mx-tide" aria-hidden="true"></i>' : ''}</button>` : '<span class="mx-none" aria-hidden="true">–</span>';
      }).join('')}`).join('')}
    </div></div>
    <p class="small muted">Tap a score for its briefing.${evs.some(e => e.access && !e.access.inside) ? ' A red dot means the tide blocks access.' : ''}</p>` : '<p class="muted">No sessions in the next 7 days. Check this spot\'s sessions and hunts under Edit spot.</p>';

  $('#sheetBody').innerHTML = `
    ${pics.length ? `<img class="banner" id="spotBanner" src="${photoUrl(pics[0])}" alt="${esc(s.name)}">` : ''}
    ${pics.length > 1 ? `<div class="gallery-strip">${pics.map((id, i) => `<button class="${i === 0 ? 'on' : ''}" data-show="${id}" aria-label="Show photo ${i + 1}"><img src="${photoUrl(id)}" alt=""></button>`).join('')}</div>` : ''}
    <header class="bf-head">
      <div>
        <h2 class="bf-name">${esc(s.name)}</h2>
        <p class="bf-when">${esc(huntsOf(s).map(k => HUNT_LABEL[k]).join(', '))}${hikeSummary(s) ? `. ${esc(hikeSummary(s))}` : ''}</p>
      </div>
    </header>
    ${best ? `<p class="bf-verdict">Best this week: ${esc(sessionName(best))}, ${sessionWhen(best)}. ${esc(huntPhrase(best))}, ${best.score}.</p>` : ''}

    <h3 class="sec">The week here</h3>
    ${week}

    ${alignmentText(s) || s.notes ? `<h3 class="sec">About this spot</h3>
      ${alignmentText(s) ? `<p class="align-line">${esc(alignmentText(s))}</p>` : ''}
      ${s.notes ? `<p class="bf-brief">${esc(s.notes)}</p>` : ''}` : ''}
    <p class="small muted">${s.lat.toFixed(4)}, ${s.lon.toFixed(4)}${s.coastal && !data.hasMarine ? '. No tide or wave data at this exact point; try moving the pin slightly offshore.' : ''}</p>
    <div class="bf-quiet">
      <button class="link-btn" id="spotHourly">Hourly forecast</button>
      <a class="link-btn" target="_blank" rel="noopener" href="https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lon}">Directions</a>
    </div>
    <div class="sheet-actions">
      ${best ? `<button class="btn primary" data-ev="${esc(best.key)}">Best session</button>` : ''}
      <button class="btn" id="editSpot">Edit spot</button>
    </div>`;
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
    <h2 class="bf-name">Right now</h2>
    <p class="bf-when">What's happening, and what's coming over the next 48 hours.</p>
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

    <h3 class="sec">At your spots now</h3>
    <div id="nowSpots">${st.spots.length ? '<p class="loading">Checking your spots…</p>' : '<p class="muted">Add spots to see conditions at each one.</p>'}</div>
    <h3 class="sec">Rain radar</h3>
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

/* ================= field compass ================= */

const WIND_WORDS = { N: 'north', NNE: 'north-northeast', NE: 'northeast', ENE: 'east-northeast', E: 'east', ESE: 'east-southeast', SE: 'southeast', SSE: 'south-southeast', S: 'south', SSW: 'south-southwest', SW: 'southwest', WSW: 'west-southwest', W: 'west', WNW: 'west-northwest', NW: 'northwest', NNW: 'north-northwest' };

// Phone compasses point to magnetic north; sun and star bearings are true north. Approximate magnetic
// declination (degrees east, around 2025) for Australia and New Zealand, blended by distance.
const DECLINATION = [
  [-37.81, 144.96, 11.8], [-33.87, 151.21, 12.9], [-27.47, 153.03, 11.2], [-34.93, 138.6, 8.6], [-42.88, 147.33, 15.2],
  [-35.28, 149.13, 12.5], [-31.95, 115.86, -0.5], [-12.46, 130.84, 3.6], [-16.92, 145.77, 7.8], [-23.7, 133.88, 5.0],
  [-34.19, 142.16, 9.8], [-38.15, 144.36, 11.4], [-37.56, 143.85, 11.0], [-36.76, 144.28, 11.2], [-38.34, 141.6, 10.5],
  [-37.0, 147.5, 12.6], [-36.85, 174.76, 20.0], [-43.53, 172.64, 24.0], [-41.29, 174.78, 22.5], [-19.26, 146.82, 8.3],
];
function declinationAt(lat, lon) {
  let wsum = 0, dsum = 0, nearest = Infinity;
  for (const [la, lo, d] of DECLINATION) {
    const km = haversineKm({ lat, lon }, { lat: la, lon: lo });
    nearest = Math.min(nearest, km);
    const w = 1 / Math.max(1, km) ** 2;
    wsum += w; dsum += w * d;
  }
  return nearest > 2500 ? null : dsum / wsum;   // too far from the table: no correction
}

function compassTargets(e) {
  const sp = e.spot, out = [];
  if (window.SunCalc && e.type !== 'night') {
    const pos = window.SunCalc.getPosition(new Date(e.t * 1000), sp.lat, sp.lon);
    out.push({ id: 'sun', label: e.type === 'sunrise' ? 'Sunrise' : e.type === 'sunset' ? 'Sunset' : `Sun at ${fmtTime(e.t, e.offset)}`, az: (pos.azimuth * 180 / Math.PI + 180 + 360) % 360, color: '#D9A066' });
  }
  if (e.hunts?.astro?.core && e.hunts.astro.score > 0) out.push({ id: 'core', label: `Milky Way core at ${fmtTime(e.hunts.astro.peak, e.offset)}`, az: e.hunts.astro.core.az, color: '#9DADB1' });
  if (e.hunts?.aurora && e.hunts.aurora.score > 0) out.push({ id: 'aurora', label: 'Aurora, low on the horizon', az: sp.lat < 0 ? 180 : 0, color: '#9CCB8E' });
  if (e.hunts?.rainbow?.look != null && e.hunts.rainbow.score > 0) out.push({ id: 'rainbow', label: 'Rainbow, sun at your back', az: e.hunts.rainbow.look, color: '#C7A6D9' });
  if (sp.facing !== '' && sp.facing != null && !isNaN(Number(sp.facing))) out.push({ id: 'facing', label: 'Your composition', az: Number(sp.facing), color: '#ECE8E1' });
  return out;
}

// Open with a session key, or with { name, lat, lon, targets } for a compass that isn't tied to a session.
function openCompass(key, custom = null) {
  const ev0 = custom ? null : eventIndex.get(key);
  if (!custom && !ev0) return;
  const e = custom ? { spot: { name: custom.name, lat: custom.lat, lon: custom.lon } } : ev0;
  const cpTitle = custom ? custom.name : `${ev0.spot.name}, ${sessionName(ev0)}`;
  const targets = custom ? custom.targets : compassTargets(ev0);
  if (!targets.length) { toast('Nothing to point at for this session. Add a facing direction to the spot to see your composition here.', 6000); return; }
  let primary = targets[0].id;
  const pt = (deg, r) => [r * Math.sin(deg * Math.PI / 180), -r * Math.cos(deg * Math.PI / 180)];
  const ticks = Array.from({ length: 24 }, (_, i) => {
    const d = i * 15, major = d % 90 === 0;
    const [x1, y1] = pt(d, major ? 104 : 110), [x2, y2] = pt(d, 118);
    return `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${major ? '#ECE8E1' : '#4A5050'}" stroke-width="${major ? 2 : 1}"/>`;
  }).join('');
  const letters = [['N', 0], ['E', 90], ['S', 180], ['W', 270]].map(([l, d]) => { const [x, y] = pt(d, 88); return `<text x="${x.toFixed(1)}" y="${(y + 6).toFixed(1)}" data-cx="${x.toFixed(1)}" data-cy="${y.toFixed(1)}" text-anchor="middle" class="cp-letter ${l === 'N' ? 'n' : ''}">${l}</text>`; }).join('');
  const decl = declinationAt(e.spot.lat, e.spot.lon);
  const dots = () => targets.map(t => {
    const [x, y] = pt(t.az, 118), [lx, ly] = pt(t.az, 72);
    return `${t.id === primary ? `<line x1="0" y1="0" x2="${lx.toFixed(1)}" y2="${ly.toFixed(1)}" stroke="${t.color}" stroke-width="3" stroke-linecap="round"/>` : ''}
      <circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${t.id === primary ? 11 : 8}" fill="${t.color}" stroke="#0F1111" stroke-width="2"/>`;
  }).join('');
  openSheet(`
    <h2>Compass</h2>
    <p class="small muted">${esc(cpTitle)}. Bearings are from true north${decl != null ? `; your phone's magnetic reading is corrected by about ${Math.round(Math.abs(decl))}° ${decl >= 0 ? 'east' : 'west'}` : ''}.</p>
    <div class="compass">
      <svg viewBox="-150 -150 300 300" role="img" aria-label="${esc(targets.map(t => `${t.label} at ${Math.round(t.az)} degrees`).join('. '))}">
        <circle r="122" fill="#151818" stroke="#2A2F2F"/>
        <g id="cpDial">${ticks}${letters}<g id="cpDots">${dots()}</g></g>
        <polygon points="0,-146 -9,-128 9,-128" fill="#ECE8E1"/>
        <circle r="4" fill="#ECE8E1"/>
      </svg>
    </div>
    <p class="compass-guide" id="cpGuide" aria-live="polite"></p>
    <div class="compass-targets">${targets.map(t => `<button class="cp-target ${t.id === primary ? 'on' : ''}" data-target="${t.id}"><i style="background:${t.color}"></i><span>${esc(t.label)}</span><b class="num">${Math.round(t.az)}° ${compass(t.az)}</b></button>`).join('')}</div>
    <div class="row"><button class="btn primary block" id="cpStart">Point with my phone</button></div>
    <p class="small muted">Hold the phone flat and away from cars, tripods and other metal. If the reading drifts, move the phone in a figure of eight to recalibrate.</p>`);

  let heading = null, smooth = null, raf = 0, listening = false;
  const guide = () => {
    const t = targets.find(x => x.id === primary);
    const g = $('#cpGuide');
    if (!g || !t) return;
    if (heading == null) { g.textContent = `${t.label}: ${Math.round(t.az)}°, ${WIND_WORDS[compass(t.az)]}.`; return; }
    const diff = ((t.az - heading + 540) % 360) - 180;
    g.textContent = Math.abs(diff) <= 8 ? `You're facing it: ${t.label.toLowerCase()}.` : `Turn ${diff > 0 ? 'right' : 'left'} ${Math.round(Math.abs(diff))}° for ${t.label.toLowerCase()}.`;
  };
  const draw = () => {
    raf = 0;
    if (heading == null) return;
    if (smooth == null) smooth = heading;
    smooth = (smooth + ((((heading - smooth) % 360) + 540) % 360 - 180) * 0.25 + 360) % 360;   // ease towards the reading
    const dial = $('#cpDial');
    if (dial) dial.setAttribute('transform', `rotate(${(-smooth).toFixed(1)})`);
    $$('.cp-letter').forEach(l => l.setAttribute('transform', `rotate(${smooth.toFixed(1)} ${l.dataset.cx} ${l.dataset.cy})`));   // keep N/E/S/W upright
    guide();
  };
  const onOrient = ev => {
    let h = null;
    if (typeof ev.webkitCompassHeading === 'number') h = ev.webkitCompassHeading;            // iPhone
    else if (ev.absolute && typeof ev.alpha === 'number') h = (360 - ev.alpha) % 360;         // Android
    if (h == null) return;
    const angle = (screen.orientation && screen.orientation.angle) || 0;
    heading = (h + angle + (decl || 0) + 720) % 360;   // magnetic → true north
    if (!raf) raf = requestAnimationFrame(draw);
  };
  const stop = () => {
    if (!listening) return;
    window.removeEventListener('deviceorientation', onOrient, true);
    window.removeEventListener('deviceorientationabsolute', onOrient, true);
    if (raf) cancelAnimationFrame(raf);
    listening = false;
  };
  onSheetClose = stop;
  guide();

  $$('.cp-target').forEach(b => b.onclick = () => {
    primary = b.dataset.target;
    $$('.cp-target').forEach(x => x.classList.toggle('on', x === b));
    $('#cpDots').innerHTML = dots();
    guide();
  });
  $('#cpStart').onclick = async () => {
    const btn = $('#cpStart');
    try {
      if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
        const res = await DeviceOrientationEvent.requestPermission();
        if (res !== 'granted') throw new Error("Compass access wasn't allowed. To try again, close and reopen Tidelight.");
      }
      if (typeof DeviceOrientationEvent === 'undefined') throw new Error("This device doesn't have a compass the app can read.");
      window.addEventListener('deviceorientationabsolute', onOrient, true);
      window.addEventListener('deviceorientation', onOrient, true);
      listening = true;
      btn.textContent = 'Following your phone';
      btn.disabled = true;
      setTimeout(() => { if (heading == null && listening) { btn.disabled = false; btn.textContent = 'Point with my phone'; toast("No compass reading came through. On a computer that's expected; on a phone, try again away from metal.", 6000); } }, 3000);
    } catch (err) { toast(err.message, 6000); }
  };
}

/* ================= phone heading (shared by the compass and scouting) ================= */
// Calls onHeading(degrees from true north). Handles the iPhone permission prompt and magnetic declination.
function phoneHeading(onHeading, lat, lon) {
  const decl = declinationAt(lat, lon) || 0;
  let on = false;
  const handler = ev => {
    let h = null;
    if (typeof ev.webkitCompassHeading === 'number') h = ev.webkitCompassHeading;
    else if (ev.absolute && typeof ev.alpha === 'number') h = (360 - ev.alpha) % 360;
    if (h == null) return;
    const angle = (screen.orientation && screen.orientation.angle) || 0;
    onHeading((h + angle + decl + 720) % 360);
  };
  return {
    async start() {
      if (typeof DeviceOrientationEvent === 'undefined') throw new Error("This device doesn't have a compass the app can read.");
      if (typeof DeviceOrientationEvent.requestPermission === 'function') {
        const res = await DeviceOrientationEvent.requestPermission();
        if (res !== 'granted') throw new Error("Compass access wasn't allowed. To try again, close and reopen Tidelight.");
      }
      window.addEventListener('deviceorientationabsolute', handler, true);
      window.addEventListener('deviceorientation', handler, true);
      on = true;
    },
    stop() {
      if (!on) return;
      window.removeEventListener('deviceorientationabsolute', handler, true);
      window.removeEventListener('deviceorientation', handler, true);
      on = false;
    },
  };
}

/* ================= when the sun lines up with a view ================= */
// Dates in the next year when sunrise or sunset sits within ~1.5° of the spot's facing direction.
function alignmentDates(lat, lon, facing) {
  if (!window.SunCalc || facing === '' || facing == null || isNaN(Number(facing))) return null;
  const f = Number(facing), runs = [];
  const start = new Date(); start.setHours(12, 0, 0, 0);
  for (let d = 0; d < 366; d++) {
    const day = new Date(start.getTime() + d * 86400000);
    const T = window.SunCalc.getTimes(day, lat, lon);
    for (const kind of ['sunrise', 'sunset']) {
      const at = T[kind];
      if (!(at instanceof Date) || isNaN(at)) continue;
      const az = (window.SunCalc.getPosition(at, lat, lon).azimuth * 180 / Math.PI + 180 + 360) % 360;
      const diff = angleDiff(az, f);
      if (diff > 1.5) continue;
      const last = runs[runs.length - 1];
      if (last && last.kind === kind && d - last.lastDay <= 2) { last.lastDay = d; if (diff < last.diff) Object.assign(last, { diff, at }); }
      else runs.push({ kind, at, diff, lastDay: d });
    }
  }
  return runs.sort((a, b) => a.at - b.at).slice(0, 4);
}
function alignmentText(sp) {
  const runs = alignmentDates(sp.lat, sp.lon, sp.facing);
  if (runs == null) return '';
  if (!runs.length) return `The sun never rises or sets in this direction (${Math.round(Number(sp.facing))}° ${compass(Number(sp.facing))}), though it can still light the scene from the side.`;
  const fmt = r => `${r.kind} around ${r.at.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })}`;
  return `The sun lines up with this view: ${runs.map(fmt).join(', ')}.`;
}

/* ================= field mode ================= */
let fieldState = null;   // { key, timer, wake, night }

function fieldMoments(e) {
  const out = [], sp = e.spot;
  const ok = d => d instanceof Date && !isNaN(d);
  const add = (d, label, cls = '') => { const t = d instanceof Date ? d.getTime() / 1000 : d; if (t && isFinite(t)) out.push({ t, label, cls }); };
  if (window.SunCalc && (e.type === 'sunrise' || e.type === 'sunset')) {
    const T = window.SunCalc.getTimes(new Date(e.t * 1000), sp.lat, sp.lon);
    const g = k => (ok(T[k]) ? T[k] : null);
    if (e.type === 'sunrise') {
      if (g('nauticalDawn')) add(g('nauticalDawn'), 'First light');
      if (g('dawn')) add(g('dawn'), 'Blue hour starts');
      if (g('blueHourEndAM')) add(g('blueHourEndAM'), 'Blue hour ends');
      add(e.t, 'Sunrise', 'key');
      if (g('goldenHourEnd')) add(g('goldenHourEnd'), 'Golden hour ends');
    } else {
      if (g('goldenHour')) add(g('goldenHour'), 'Golden hour starts');
      add(e.t, 'Sunset', 'key');
      if (g('blueHourStartPM')) add(g('blueHourStartPM'), 'Blue hour starts');
      if (g('dusk')) add(g('dusk'), 'Blue hour ends');
      if (g('night')) add(g('night'), 'Full darkness');
    }
  } else if (e.type === 'day') {
    const H = e.hunts?.[e.topHunt];
    if (H?.from && H.from < e.t) add(H.from, 'Good light from');
    add(e.t, `Best for ${HUNT_LABEL[e.topHunt].toLowerCase()}`, 'key');
    if (H?.to && H.to > e.t) add(H.to, 'Good light until');
  } else if (e.timeline) {
    e.timeline.forEach(x => add(x.t, x.label, x.cls || ''));
  } else {
    add(e.t, TYPE_NAME[e.type] || 'Session', 'key');
  }
  if (e.access && !e.access.none) {
    if (!e.access.openStart) add(e.access.start, 'Tide access opens');
    add(e.access.backBy, 'Be back off the rocks', 'warn');
  }
  if (e.tide?.low && Math.abs(e.tide.low.t - e.t) < 4 * 3600) add(e.tide.low.t, 'Low tide');
  if (e.tide?.high && Math.abs(e.tide.high.t - e.t) < 4 * 3600) add(e.tide.high.t, 'High tide');
  return out.sort((a, b) => a.t - b.t);
}

const untilText = secs => {
  if (secs < 60) return `${Math.max(0, Math.round(secs))} s`;
  if (secs < 3600) { const m = Math.floor(secs / 60), s2 = Math.floor(secs % 60); return `${m}:${String(s2).padStart(2, '0')}`; }
  const h = Math.floor(secs / 3600), m = Math.round((secs % 3600) / 60);
  return `${h} h ${m} min`;
};

function fieldConditions(e) {
  const data = forecasts[e.spot.id];
  if (!data) return '<p class="small muted">No forecast saved for this spot yet. Open it once with reception.</p>';
  const now = Date.now() / 1000;
  const i = nearestIndex(data.hours, now);
  if (i < 0) return '<p class="small muted">The saved forecast doesn\'t cover right now. Refresh when you have reception.</p>';
  const rows = [0, 1, 2].map(k => data.hours[i + k]).filter(Boolean).map((h, k) => `<div class="fc-row">
      <span class="fc-time num">${k === 0 ? 'Now' : fmtTime(h.t, data.offset).replace(':00', '')}</span>
      <span>Cloud ${Math.round(h.low ?? 0)}/${Math.round(h.mid ?? 0)}/${Math.round(h.high ?? 0)}%</span>
      <span>Rain ${Math.round(h.pp ?? 0)}%</span>
      <span>${Math.round(h.wind ?? 0)} km/h</span>
    </div>`).join('');
  let tide = '';
  if (e.spot.coastal) {
    const td = tideInfo(data.hours, i);
    if (td) tide = `<p class="fc-tide">Tide ${Math.round(td.pos * 100)}% of its range and ${td.rising ? 'rising' : 'falling'}.</p>`;
  }
  const saved = Number(localStorage.getItem('tidelight:lastFetch') || 0);
  return `${rows}${tide}<p class="small muted">From the forecast saved ${saved ? syncAgo(saved) : 'earlier'}. Low, mid and high cloud shown.</p>`;
}

function drawField() {
  const st = fieldState;
  const el = $('#field');
  if (!st || !el) return;
  const e = eventIndex.get(st.key);
  if (!e) { closeField(); return; }
  const now = Date.now() / 1000;
  const moments = fieldMoments(e);
  const next = moments.find(m => m.t > now);
  const nextHtml = next
    ? `<p class="fm-next-label">${esc(next.label)} in</p><p class="fm-count num ${next.cls}">${untilText(next.t - now)}</p><p class="fm-at">at ${fmtTime(next.t, e.offset)}</p>`
    : `<p class="fm-next-label">That's the session done.</p><p class="fm-at">Rate it later in Plans so your personal score learns.</p>`;
  el.querySelector('#fmNext').innerHTML = nextHtml;
  el.querySelector('#fmList').innerHTML = moments.map(m => `<li class="${m.t <= now ? 'past' : ''} ${m.cls}">
      <time class="num">${fmtTime(m.t, e.offset)}</time><span>${esc(m.label)}</span><em class="num">${m.t > now ? `in ${untilText(m.t - now)}` : 'done'}</em></li>`).join('');
}

async function openField(key) {
  const e = eventIndex.get(key);
  if (!e) return;
  closeSheet();
  closeField();
  const el = document.createElement('div');
  el.id = 'field';
  el.className = 'field';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', `Field mode for ${e.spot.name}`);
  el.innerHTML = `
    <div class="fm-top">
      <div><p class="fm-spot">${esc(e.spot.name)}</p><p class="fm-sub">${esc(cap(sessionName(e)))}, score ${e.score}${e.topHunt !== 'colour' ? ` for ${HUNT_LABEL[e.topHunt].toLowerCase()}` : ''}</p></div>
      <button class="icon-btn" id="fmClose" aria-label="Close field mode"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
    </div>
    <section class="fm-next" id="fmNext" aria-live="polite"></section>
    <ol class="fm-list" id="fmList"></ol>
    <h3 class="fm-h">The sky</h3>
    <div class="fm-cond">${fieldConditions(e)}</div>
    <div class="fm-actions">
      <button class="btn" data-compass="${esc(e.key)}">Compass</button>
      <button class="btn" id="fmRadar">Radar and hourly</button>
      <button class="btn" id="fmNight" aria-pressed="false">Night vision</button>
    </div>
    <p class="small muted fm-wake" id="fmWake"></p>`;
  document.body.appendChild(el);
  document.body.classList.add('noscroll');
  fieldState = { key, timer: setInterval(drawField, 1000), wake: null, night: false };
  drawField();

  // Keep the screen on while field mode is open (re-acquired if the app comes back to the front).
  const wakeNote = $('#fmWake');
  const lock = async () => {
    if (!('wakeLock' in navigator)) { wakeNote.textContent = "This device can't keep the screen awake from a web app; it may dim as usual."; return; }
    try { fieldState.wake = await navigator.wakeLock.request('screen'); wakeNote.textContent = 'The screen stays on while field mode is open.'; }
    catch { wakeNote.textContent = 'The screen may dim as usual (low battery mode can block keeping it on).'; }
  };
  fieldState.relock = () => { if (document.visibilityState === 'visible' && fieldState) lock(); };
  document.addEventListener('visibilitychange', fieldState.relock);
  lock();

  $('#fmClose').onclick = closeField;
  $('#fmRadar').onclick = () => openNow({ kind: 'spot', id: e.spot.id, lat: e.spot.lat, lon: e.spot.lon, name: e.spot.name });
  $('#fmNight').onclick = () => {
    fieldState.night = !fieldState.night;
    el.classList.toggle('nightvision', fieldState.night);
    document.body.classList.toggle('nv-sheets', fieldState.night);   // pop-ups opened from field mode go red too
    $('#fmNight').setAttribute('aria-pressed', String(fieldState.night));
    $('#fmNight').textContent = fieldState.night ? 'Normal colours' : 'Night vision';
  };
}
function closeField() {
  const st = fieldState;
  if (st) {
    clearInterval(st.timer);
    if (st.wake) st.wake.release().catch(() => {});
    if (st.relock) document.removeEventListener('visibilitychange', st.relock);
  }
  fieldState = null;
  document.body.classList.remove('nv-sheets');
  const el = $('#field');
  if (el) el.remove();
  if ($('#sheet').classList.contains('hidden')) document.body.classList.remove('noscroll');
}

/* ================= scout a spot ================= */
function openScout() {
  let pos = null, facing = null, photoFile = null, live = null, heading = null;
  openSheet(`
    <h2>Scout this spot</h2>
    <p class="small muted">Stand where you'd set up. Tidelight records the location and the direction of your composition, then scores the spot from here on.</p>
    <div class="scout-step"><strong>1. Location</strong><p id="scLoc" class="small muted">Finding you…</p></div>
    <div class="scout-step"><strong>2. Which way you're shooting</strong>
      <p class="small muted">Point the top of the phone at your composition, then tap Capture.</p>
      <p class="scout-heading num" id="scHeading" aria-live="polite">–</p>
      <div class="row"><button class="btn" id="scPoint">Use the phone's compass</button><button class="btn primary" id="scCapture" disabled>Capture direction</button></div>
      <label class="small">Or type a bearing (°)<input id="scManual" inputmode="numeric" placeholder="e.g. 270 for west"></label>
      <p class="small" id="scAlign"></p>
    </div>
    <form class="form" id="scForm">
      <div class="scout-step"><strong>3. A photo and details (optional)</strong>
        <label class="btn ghost" id="scPhotoBtn">Take or choose a photo<input type="file" id="scPhoto" class="file-input" accept="image/*" capture="environment"></label>
        <p class="small muted" id="scPhotoNote"></p>
      </div>
      <label>Name<input name="name" required placeholder="e.g. North ledge"></label>
      <fieldset><legend>What to hunt for here</legend>
        <div class="checks">${HUNT_ORDER.map(k => `<label class="check"><input type="checkbox" name="hunt_${k}" ${k === 'colour' ? 'checked' : ''}> ${HUNT_LABEL[k]}</label>`).join('')}</div>
      </fieldset>
      <label class="check"><input type="checkbox" name="coastal"> Coastal spot (use tide and wave data)</label>
      <label>Notes<textarea name="notes" placeholder="Access, parking, hazards, compositions"></textarea></label>
      <div class="row"><button class="btn primary" type="submit" id="scSave" disabled>Save spot</button><button class="btn ghost" type="button" data-close>Cancel</button></div>
    </form>`);
  const form = $('#scForm');
  const showAlign = () => {
    if (!pos || facing == null) { $('#scAlign').textContent = ''; return; }
    $('#scAlign').textContent = alignmentText({ lat: pos.lat, lon: pos.lon, facing });
  };
  const setFacing = f => {
    facing = Math.round(((f % 360) + 360) % 360);
    $('#scHeading').textContent = `${facing}° ${compass(facing)}, captured`;
    showAlign();
  };
  onSheetClose = () => { if (live) live.stop(); };

  getPosition().then(async p => {
    pos = p;
    if (!$('#scLoc')) return;
    $('#scLoc').textContent = `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}`;
    $('#scSave').disabled = false;
    const name = await placeName(p.lat, p.lon).catch(() => null);
    if (name && form && !form.name.value) form.name.value = `Near ${name}`;
    showAlign();
  }).catch(err => { if ($('#scLoc')) $('#scLoc').textContent = `${err.message} You can still add the spot from the map instead.`; });

  $('#scPoint').onclick = async () => {
    try {
      live = phoneHeading(h => {
        heading = h;
        const el = $('#scHeading');
        if (el && facing == null) el.textContent = `${Math.round(h)}° ${compass(h)}`;
        $('#scCapture').disabled = false;
      }, pos?.lat ?? -37.8, pos?.lon ?? 145);
      await live.start();
      $('#scPoint').textContent = 'Following your phone';
      $('#scPoint').disabled = true;
      setTimeout(() => { if (heading == null && $('#scPoint')) { $('#scPoint').disabled = false; $('#scPoint').textContent = 'Use the phone\'s compass'; toast('No compass reading came through. Type the bearing instead.', 5000); } }, 3000);
    } catch (err) { toast(err.message, 6000); }
  };
  $('#scCapture').onclick = () => { if (heading != null) { setFacing(heading); live?.stop(); $('#scPoint').disabled = false; $('#scPoint').textContent = 'Recapture'; } };
  $('#scManual').oninput = ev => { const v = parseFloat(ev.target.value); if (!isNaN(v)) setFacing(v); };
  $('#scPhoto').onchange = ev => { photoFile = ev.target.files[0] || null; $('#scPhotoNote').textContent = photoFile ? 'Photo ready. It becomes the spot\'s cover.' : ''; };

  form.onsubmit = async ev => {
    ev.preventDefault();
    if (!pos) return toast('Waiting for your location');
    const f = new FormData(form);
    const name = String(f.get('name') || '').trim();
    if (!name) return toast('Give the spot a name');
    const btn = $('#scSave'); btn.disabled = true; btn.textContent = 'Saving…';
    let photos = [];
    if (photoFile) { try { photos = [await addPhotoFile(photoFile)]; } catch (err) { toast(err.message, 5000); } }
    const hunts = HUNT_ORDER.filter(k => f.get(`hunt_${k}`));
    const id = uid();
    update(st => st.spots.push({
      id, name, lat: pos.lat, lon: pos.lon, events: ['sunrise', 'sunset'], coastal: !!f.get('coastal'), tide: 'any',
      driveMin: '', facing: facing ?? '', notes: String(f.get('notes') || ''), photos,
      hunts: hunts.length ? hunts : ['colour'], fogMode: 'in', scoutedAt: Date.now(),
    }));
    if (live) live.stop();
    closeSheet();
    toast('Spot saved. Scoring it now.');
    tab = 'spots'; render();
    openSpotDetail(id);
  };
}

async function openCompassHere() {
  let pos;
  try { pos = await getPosition(); } catch (err) { toast(err.message, 5000); return; }
  if (!window.SunCalc) { toast("The sun data didn't load. Check your connection and try again."); return; }
  const az = p => (p.azimuth * 180 / Math.PI + 180 + 360) % 360;
  const now = new Date();
  const T = window.SunCalc.getTimes(now, pos.lat, pos.lon);
  const ok = d => d instanceof Date && !isNaN(d);
  const hhmm = d => d.toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' }).replace(' ', '');
  const targets = [];
  if (ok(T.sunrise)) targets.push({ id: 'rise', label: `Sunrise today, ${hhmm(T.sunrise)}`, az: az(window.SunCalc.getPosition(T.sunrise, pos.lat, pos.lon)), color: '#D9A066' });
  if (ok(T.sunset)) targets.push({ id: 'set', label: `Sunset today, ${hhmm(T.sunset)}`, az: az(window.SunCalc.getPosition(T.sunset, pos.lat, pos.lon)), color: '#B9824E' });
  const sunNow = window.SunCalc.getPosition(now, pos.lat, pos.lon);
  if (sunNow.altitude > 0) targets.push({ id: 'sun', label: 'The sun right now', az: az(sunNow), color: '#ECE8E1' });
  const moon = window.SunCalc.getMoonPosition(now, pos.lat, pos.lon);
  if (moon.altitude > 0) targets.push({ id: 'moon', label: 'The moon right now', az: (moon.azimuth * 180 / Math.PI + 180 + 360) % 360, color: '#9DADB1' });
  const core = coreAltAz(Date.now() / 1000, pos.lat, pos.lon);
  if (core.alt > 5 && sunNow.altitude < -0.2) targets.push({ id: 'core', label: 'Milky Way core right now', az: core.az, color: '#7F93A8' });
  openCompass(null, { name: 'Where you are now', lat: pos.lat, lon: pos.lon, targets });
}

/* ================= the light dial ================= */
// The moon's phase as a picture. phase: 0 new, 0.25 first quarter, 0.5 full, 0.75 last quarter.
// In the southern hemisphere the lit side is mirrored (a waxing moon is lit on the left).
function moonSvg(phase, lat, size = 72) {
  const r = 40, rx = Math.abs(Math.cos(2 * Math.PI * phase)) * r;
  const waxing = phase < 0.5, gibbous = phase > 0.25 && phase < 0.75;
  let lit = '';
  if (phase > 0.015 && phase < 0.985) {
    lit = waxing
      ? `M0,${-r} A${r},${r} 0 0 1 0,${r} A${rx.toFixed(2)},${r} 0 0 ${gibbous ? 1 : 0} 0,${-r} Z`
      : `M0,${-r} A${r},${r} 0 0 0 0,${r} A${rx.toFixed(2)},${r} 0 0 ${gibbous ? 0 : 1} 0,${-r} Z`;
  }
  return `<svg class="moon-pic" viewBox="-46 -46 92 92" width="${size}" height="${size}" aria-hidden="true">
    <defs><radialGradient id="moonGlow" cx="35%" cy="30%" r="80%"><stop offset="0%" stop-color="#F4EFE4"/><stop offset="100%" stop-color="#C9C1B0"/></radialGradient></defs>
    <circle r="${r}" fill="#1E2326" stroke="#3A4246" stroke-width="1"/>
    <g transform="${lat < 0 ? 'scale(-1,1)' : ''}">${lit ? `<path d="${lit}" fill="url(#moonGlow)"/>` : ''}</g>
    <circle cx="-12" cy="-10" r="6" fill="rgba(0,0,0,.08)"/><circle cx="10" cy="12" r="8" fill="rgba(0,0,0,.07)"/><circle cx="15" cy="-14" r="4" fill="rgba(0,0,0,.07)"/>
  </svg>`;
}
function moonPhaseName(p) {
  if (p < 0.03 || p > 0.97) return 'New moon';
  if (p < 0.22) return 'Waxing crescent';
  if (p < 0.28) return 'First quarter';
  if (p < 0.47) return 'Waxing gibbous';
  if (p < 0.53) return 'Full moon';
  if (p < 0.72) return 'Waning gibbous';
  if (p < 0.78) return 'Last quarter';
  return 'Waning crescent';
}
// Every light phase of a day in order, with start and end times (matching the colours on the ring).
function dayPhases(place, midnight) {
  const T = window.SunCalc.getTimes(new Date((midnight + 43200) * 1000), place.lat, place.lon);
  const ok = d => d instanceof Date && !isNaN(d);
  const t = k => (ok(T[k]) ? T[k].getTime() / 1000 : null);
  const end = midnight + 86400;
  const raw = [
    ['dark', 'Dark', midnight, t('nightEnd')],
    ['twilight', 'Twilight: first light', t('nightEnd'), t('dawn')],
    ['blue hour', 'Blue hour', t('dawn'), t('sunrise')],
    ['sunrise', 'Sunrise', t('sunrise'), null],
    ['golden hour', 'Golden hour', t('sunrise'), t('goldenHourEnd')],
    ['daylight', 'Daylight', t('goldenHourEnd'), t('goldenHour')],
    ['golden hour', 'Golden hour', t('goldenHour'), t('sunset')],
    ['sunset', 'Sunset', t('sunset'), null],
    ['blue hour', 'Blue hour', t('sunset'), t('dusk')],
    ['twilight', 'Twilight: last light', t('dusk'), t('night')],
    ['dark', 'Dark', t('night'), end],
  ];
  const inDay = x => x >= midnight && x < end;
  return raw
    .filter(([kind, , a, b]) => a != null && ((kind === 'sunrise' || kind === 'sunset') ? inDay(a) : b != null && b > a))
    .map(([kind, label, a, b]) => [kind, label, kind === 'sunrise' || kind === 'sunset' ? a : Math.max(a, midnight), b == null ? null : Math.min(b, end)])
    .filter(([kind, , a, b]) => kind === 'sunrise' || kind === 'sunset' || b > a)
    .sort((x, y) => x[2] - y[2] || (x[3] == null ? -1 : 1));
}

// A 24-hour ring coloured by the day's light (noon at the top, midnight at the bottom). Drag the handle
// to any time to see the light phase and where the sun and moon are.
function openLightDial({ name, lat, lon, offset, t }) {
  if (!window.SunCalc) { toast("The sun data didn't load. Check your connection and try again."); return; }
  const place = { lat, lon };
  const dayStart = x => { const d = new Date((x + offset) * 1000); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000 - offset; };
  let cur = Math.round(t / 300) * 300;
  let midnight = dayStart(cur);
  const deg = r => r * 180 / Math.PI;
  const ringGradient = () => {
    const noon = midnight + 43200, stops = [];
    for (let k = 0; k <= 96; k++) {
      const tt = noon + k * 900 - (k > 48 ? 86400 : 0);   // noon → midnight on the right, midnight → noon on the left
      stops.push(`${phaseColor(place, tt, offset)} ${(k / 96 * 360).toFixed(1)}deg`);
    }
    return `conic-gradient(from 0deg, ${stops.join(', ')})`;
  };
  openSheet(`
    <h2 class="bf-name">Light dial</h2>
    <p class="bf-when">${esc(name)}. Drag the handle around the day.</p>
    <div class="dial-day">
      <button class="icon-btn" id="dialPrev" aria-label="Previous day"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg></button>
      <span id="dialDate"></span>
      <button class="icon-btn" id="dialNext" aria-label="Next day"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg></button>
    </div>
    <div class="dial" id="dial" tabindex="0" role="slider" aria-label="Time of day" aria-valuemin="0" aria-valuemax="1435" aria-valuenow="0">
      <div class="dial-ring" id="dialRing"></div>
      <span class="dial-lab n">Noon</span><span class="dial-lab e">6pm</span><span class="dial-lab s">Midnight</span><span class="dial-lab w">6am</span>
      <div class="dial-arm" id="dialArm"><span class="dial-knob"></span></div>
      <div class="dial-centre">
        <p class="dial-time num" id="dialTime"></p>
        <p class="dial-phase" id="dialPhase"></p>
      </div>
    </div>
    <dl class="bf-cond dial-read">
      <div><dt>Sun</dt><dd id="dialSun"></dd></div>
    </dl>
    <div class="row"><button class="btn" id="dialNow">Jump to now</button></div>
    <h3 class="sec">The day's light</h3>
    <p class="small muted">Tap a phase to move the dial there.</p>
    <ol class="phase-list" id="phaseList"></ol>
    <h3 class="sec">The moon</h3>
    <div class="moon-card">
      <div id="moonPic"></div>
      <div class="moon-text">
        <p class="moon-name" id="moonName"></p>
        <p class="moon-lit" id="moonLit"></p>
        <p class="moon-pos" id="dialMoon"></p>
        <p class="moon-times" id="moonTimes"></p>
      </div>
    </div>`);
  const dial = $('#dial');
  const draw = () => {
    const noon = midnight + 43200;
    $('#dialArm').style.transform = `rotate(${((cur - noon) / 86400 * 360).toFixed(2)}deg)`;
    $('#dialTime').textContent = fmtTime(cur, offset);
    const marks = lightBand(day3am(cur, offset), place).marks;
    $('#dialPhase').textContent = cap(phaseAt(marks, cur));
    $('#dialDate').textContent = fmtDayDate(midnight + 43200, offset);
    const sp = window.SunCalc.getPosition(new Date(cur * 1000), lat, lon), sAlt = deg(sp.altitude), sAz = (deg(sp.azimuth) + 180 + 360) % 360;
    $('#dialSun').textContent = `${Math.round(sAz)}° ${compass(sAz)}, ${sAlt >= 0 ? `${Math.round(sAlt)}° up` : `${Math.round(-sAlt)}° below the horizon`}`;
    const mp = window.SunCalc.getMoonPosition(new Date(cur * 1000), lat, lon), mAlt = deg(mp.altitude), mAz = (deg(mp.azimuth) + 180 + 360) % 360;
    $('#dialMoon').textContent = mAlt >= 0 ? `At ${fmtTime(cur, offset)}: ${Math.round(mAz)}° ${compass(mAz)}, ${Math.round(mAlt)}° up.` : `At ${fmtTime(cur, offset)}: below the horizon.`;
    $$('#phaseList li').forEach(li => {
      const a = Number(li.dataset.a), b = li.dataset.b ? Number(li.dataset.b) : null;
      li.classList.toggle('on', b == null ? Math.abs(cur - a) < 600 : cur >= a && cur < b);
    });
    dial.setAttribute('aria-valuenow', String(Math.round((cur - midnight) / 60)));
    dial.setAttribute('aria-valuetext', `${fmtTime(cur, offset)}, ${phaseAt(marks, cur)}`);
  };
  const COL = { dark: BAND.night, twilight: BAND.twilight, 'blue hour': BAND.blue, 'golden hour': BAND.golden, daylight: BAND.day, sunrise: '#E8B27A', sunset: '#E8B27A' };
  const setDay = () => {
    $('#dialRing').style.background = ringGradient();
    // The day's phases, in order.
    $('#phaseList').innerHTML = dayPhases(place, midnight).map(([kind, label, a, b]) => {
      const len = b ? Math.round((b - a) / 60) : 0;
      return `<li class="${kind === 'sunrise' || kind === 'sunset' ? 'event' : ''}" data-a="${a}" ${b ? `data-b="${b}"` : ''}>
        <button data-jump="${b ? Math.round((a + Math.min(b, a + 1800)) / 2) : a}">
          <i style="background:${COL[kind]}"></i>
          <span class="ph-name">${label}</span>
          <span class="ph-time num">${b ? `${fmtTime(a, offset)} to ${fmtTime(b, offset)}` : fmtTime(a, offset)}</span>
          ${b ? `<span class="ph-len">${len >= 120 ? `${Math.floor(len / 60)} h ${len % 60 ? `${len % 60} min` : ''}`.trim() : `${len} min`}</span>` : '<span class="ph-len"></span>'}
        </button></li>`;
    }).join('');
    $$('#phaseList [data-jump]').forEach(btn => btn.onclick = () => setTime(Number(btn.dataset.jump)));
    // The moon for this day.
    const noonD = new Date((midnight + 43200) * 1000);
    const ill = window.SunCalc.getMoonIllumination(noonD);
    const phase = typeof ill.phase === 'number' ? ill.phase : 0.5;
    $('#moonPic').innerHTML = moonSvg(phase, lat, 84);
    $('#moonName').textContent = moonPhaseName(phase);
    const pct = Math.round((ill.fraction || 0) * 100);
    const days = Math.round(phase * 29.53);
    $('#moonLit').textContent = `${pct}% lit, ${phase < 0.5 ? 'growing' : 'shrinking'}. Day ${days} of the 29.5-day cycle.`;
    const mt = window.SunCalc.getMoonTimes ? window.SunCalc.getMoonTimes(new Date(midnight * 1000 + 1), lat, lon) : {};
    const okd = d => d instanceof Date && !isNaN(d);
    const parts = [okd(mt.rise) ? `Rises ${fmtTime(mt.rise.getTime() / 1000, offset)}` : '', okd(mt.set) ? `sets ${fmtTime(mt.set.getTime() / 1000, offset)}` : ''].filter(Boolean);
    $('#moonTimes').textContent = mt.alwaysUp ? 'Up all day and night.' : mt.alwaysDown ? 'Below the horizon all day.' : parts.length ? `${cap(parts.join(', '))}.` : '';
    draw();
  };
  const setTime = x => { cur = Math.max(midnight, Math.min(midnight + 86100, Math.round(x / 300) * 300)); draw(); };
  const fromPointer = ev => {
    const r = dial.getBoundingClientRect();
    const a = Math.atan2(ev.clientX - (r.left + r.width / 2), -(ev.clientY - (r.top + r.height / 2))) * 180 / Math.PI;   // 0 at the top, clockwise
    setTime(midnight + 43200 + a / 360 * 86400);
  };
  let dragging = false;
  dial.addEventListener('pointerdown', ev => { dragging = true; try { dial.setPointerCapture(ev.pointerId); } catch {} dial.classList.add('dragging'); fromPointer(ev); });
  dial.addEventListener('pointermove', ev => { if (dragging) fromPointer(ev); });
  const end = () => { dragging = false; dial.classList.remove('dragging'); };
  dial.addEventListener('pointerup', end); dial.addEventListener('pointercancel', end);
  dial.addEventListener('keydown', ev => {
    const step = { ArrowRight: 300, ArrowUp: 300, ArrowLeft: -300, ArrowDown: -300, PageUp: 3600, PageDown: -3600 }[ev.key];
    if (step) { ev.preventDefault(); setTime(cur + step); }
  });
  $('#dialPrev').onclick = () => { midnight -= 86400; cur -= 86400; setDay(); };
  $('#dialNext').onclick = () => { midnight += 86400; cur += 86400; setDay(); };
  $('#dialNow').onclick = () => { const n = Date.now() / 1000; midnight = dayStart(n); setDay(); setTime(n); };
  setDay();
}
async function openLightDialHere() {
  let pos = null;
  try { pos = await getPosition(); } catch { pos = S().settings.home || S().spots[0] || null; }
  if (!pos) { toast('Turn on location, or set your home under You, to use the light dial.', 5000); return; }
  openLightDial({ name: pos.name || 'Where you are now', lat: pos.lat, lon: pos.lon, offset: -new Date().getTimezoneOffset() * 60, t: Date.now() / 1000 });
}

/* ================= the tide slider (coastal briefings) ================= */
function tideChart(e) {
  const data = forecasts[e.spot.id];
  if (!e.spot.coastal || !data || e.idx == null) return '';
  const pts = [];
  for (let i = Math.max(0, e.idx - 6); i <= Math.min(data.hours.length - 1, e.idx + 6); i++) if (data.hours[i].sea != null) pts.push({ t: data.hours[i].t, v: data.hours[i].sea });
  if (pts.length < 8) return '';
  const lo = Math.max(0, e.idx - 12), hi = Math.min(data.hours.length - 1, e.idx + 12);
  const all = data.hours.slice(lo, hi + 1).map(x => x.sea).filter(x => x != null);
  const min = Math.min(...all), max = Math.max(...all);
  if (max - min < 0.05) return '';
  const W = 320, Hh = 110, t0 = pts[0].t, t1 = pts[pts.length - 1].t;
  const x = t => ((t - t0) / (t1 - t0)) * W, y = val => 8 + (1 - (val - min) / (max - min)) * (Hh - 16);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
  const acc = e.spot.tideAccess && e.access && !e.access.none ? e.access : null;
  const level = e.spot.tideAccess ? min + ((Number(e.spot.accessPct) || 40) / 100) * (max - min) : null;
  const clampT = t => Math.max(t0, Math.min(t1, t));
  return `<h3 class="sec">The tide</h3>
    <div class="tide" id="tide" tabindex="0" role="slider" aria-label="Tide through the session. Drag to see the height at any time." aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"
      data-t0="${t0}" data-t1="${t1}" data-min="${min}" data-max="${max}">
      <svg viewBox="0 0 ${W} ${Hh}" preserveAspectRatio="none" aria-hidden="true">
        ${acc ? `<rect class="tide-safe" x="${x(clampT(acc.start)).toFixed(1)}" y="0" width="${Math.max(0, x(clampT(acc.backBy)) - x(clampT(acc.start))).toFixed(1)}" height="${Hh}"/>` : ''}
        <path class="tide-fill" d="${line} L${W},${Hh} L0,${Hh} Z"/>
        <path class="tide-line" d="${line}"/>
        ${level != null ? `<line class="tide-level" x1="0" x2="${W}" y1="${y(level).toFixed(1)}" y2="${y(level).toFixed(1)}"/>` : ''}
        <line class="tide-event" x1="${x(e.t).toFixed(1)}" x2="${x(e.t).toFixed(1)}" y1="0" y2="${Hh}"/>
      </svg>
      <span class="tide-handle" id="tideHandle"><i></i></span>
    </div>
    <div class="tide-axis" aria-hidden="true"><span>${fmtTime(t0, e.offset)}</span><span>${e.type === 'sunrise' || e.type === 'sunset' ? cap(e.type) : 'Best time'} ${fmtTime(e.t, e.offset)}</span><span>${fmtTime(t1, e.offset)}</span></div>
    <p class="tide-read" id="tideRead" aria-live="polite"></p>
    ${level != null ? '<p class="small muted">The dashed line is your access level; the shaded window is when you can be out there, with your safety buffer.</p>' : ''}`;
}
function wireTide(e) {
  const el = $('#tide');
  if (!el) return;
  const data = forecasts[e.spot.id];
  const t0 = Number(el.dataset.t0), t1 = Number(el.dataset.t1), min = Number(el.dataset.min), max = Number(el.dataset.max);
  const seaAt = t => {
    const hs = data.hours;
    for (let i = 0; i < hs.length - 1; i++) if (hs[i].t <= t && hs[i + 1].t >= t && hs[i].sea != null && hs[i + 1].sea != null) {
      const k = (t - hs[i].t) / (hs[i + 1].t - hs[i].t);
      return { v: hs[i].sea + k * (hs[i + 1].sea - hs[i].sea), rising: hs[i + 1].sea > hs[i].sea };
    }
    return null;
  };
  const show = t => {
    const tt = Math.max(t0, Math.min(t1, t)), sea = seaAt(tt);
    if (!sea) return;
    const fx = (tt - t0) / (t1 - t0), pos = (sea.v - min) / (max - min);
    const h = $('#tideHandle');
    h.style.left = `${(fx * 100).toFixed(2)}%`;
    h.firstElementChild.style.top = `${(8 + (1 - pos) * (110 - 16)) / 110 * 100}%`;
    const acc = e.spot.tideAccess && e.access && !e.access.none ? (tt >= e.access.start && tt <= e.access.backBy ? ' Access is open.' : ' Access is closed.') : '';
    $('#tideRead').textContent = `${fmtTime(tt, e.offset)}: tide at ${Math.round(Math.max(0, Math.min(1, pos)) * 100)}% of its range and ${sea.rising ? 'rising' : 'falling'}.${acc}`;
    el.setAttribute('aria-valuenow', String(Math.round(fx * 100)));
    el.setAttribute('aria-valuetext', $('#tideRead').textContent);
    el.dataset.cur = String(tt);
  };
  const tAt = cx => { const r = el.getBoundingClientRect(); return t0 + Math.max(0, Math.min(1, (cx - r.left) / r.width)) * (t1 - t0); };
  let drag = false;
  el.addEventListener('pointerdown', ev => { drag = true; try { el.setPointerCapture(ev.pointerId); } catch {} show(tAt(ev.clientX)); });
  el.addEventListener('pointermove', ev => { if (drag) show(tAt(ev.clientX)); });
  el.addEventListener('pointerup', () => { drag = false; }); el.addEventListener('pointercancel', () => { drag = false; });
  el.addEventListener('keydown', ev => { const st2 = { ArrowRight: 600, ArrowLeft: -600 }[ev.key]; if (st2) { ev.preventDefault(); show(Number(el.dataset.cur || e.t) + st2); } });
  show(e.t);
}

/* ================= tools tab ================= */
function renderTools(v) {
  const now = Date.now() / 1000;
  const nextPlan = S().plans.filter(p => p.t >= now - 3600 && eventIndex.has(p.key)).sort((a, b) => a.t - b.t)[0];
  const tool = (attr, title, text) => `<button class="tool-row" ${attr}>
      <span class="tool-text"><span class="tool-title">${title}</span><span class="tool-desc">${text}</span></span>
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>
    </button>`;
  v.innerHTML = `
    <h1 class="page-title">Tools</h1>
    <p class="page-lede">For when you're out there. Most of these work without reception.</p>
    <div class="tool-list">
      ${nextPlan ? tool(`data-field="${esc(nextPlan.key)}"`, 'Field mode', `Countdowns and the sky for ${esc(nextPlan.spotName)}, your next plan.`) : ''}
      ${tool('id="toolNow"', 'Right now', 'The next 48 hours where you are, conditions at your spots, and rain radar.')}
      ${tool('id="toolCompass"', 'Compass', "Where the sun rises and sets today, and where the sun, moon and Milky Way are now.")}
      ${tool('id="toolDial"', 'Light dial', 'Drag around a 24-hour dial to see the light, the sun and the moon at any time.')}
      ${tool('data-lightning', 'Lightning distance', 'Time the gap between flash and thunder to see how far away a storm is.')}
      ${tool('id="toolScout"', 'Scout this spot', 'Save where you stand as a new spot, with the direction of your composition.')}
    </div>
    ${!nextPlan ? '<p class="small muted tool-note">Field mode opens from any session. Plan a shoot and it appears here for the next one.</p>' : ''}`;
  $('#toolNow').onclick = () => openNow();
  $('#toolCompass').onclick = () => openCompassHere();
  $('#toolDial').onclick = () => openLightDialHere();
  $('#toolScout').onclick = () => openScout();
  // Field mode needs the live forecast for the next plan: load it, then redraw once.
  if (!nextPlan && S().plans.some(p => p.t >= now - 3600) && S().spots.length) {
    ensureForecasts().then(() => { allEvents({ includePast: true }); if (tab === 'tools' && S().plans.some(p => p.t >= now - 3600 && eventIndex.has(p.key))) renderTools(v); });
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

/* ================= you tab: your light profile, account, alerts and setup ================= */
let youPage = null;   // null shows the list; otherwise profile | recreate | account | alerts | home | kit | ai | data

const TEXT_SIZES = { standard: 'Standard', large: 'Large', larger: 'Larger' };
function applyTextSize() {
  const size = S().settings.textSize || 'standard';
  if (size === 'standard') delete document.documentElement.dataset.text; else document.documentElement.dataset.text = size;
}

const youHead = (title, lede = '') => `<button class="link-btn back" id="youBack">‹ You</button>
    <h1 class="page-title">${title}</h1>${lede ? `<p class="page-lede">${lede}</p>` : ''}`;

function renderYou(v, logLines = []) {
  const st = S(), s = st.settings;
  if (youPage) {
    ({ profile: pageProfile, recreate: pageRecreate, account: pageAccount, alerts: pageAlerts, home: pageHome, kit: pageKit, display: pageDisplay, ai: pageAI, data: pageData })[youPage](v, logLines);
    const back = $('#youBack', v);
    if (back) back.onclick = () => { youPage = null; renderYou(v); window.scrollTo(0, 0); };
    return;
  }
  const good = st.keepers.filter(k => k.label === 'keeper').length;
  const sync = syncStatus();
  const kit = (s.gearAlways || []).length;
  const row = (id, title, status) => `<button class="you-row" data-you="${id}">
      <span class="you-text"><span class="you-title">${title}</span><span class="you-status">${esc(status)}</span></span>
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>
    </button>`;
  v.innerHTML = `
    <h1 class="page-title">You</h1>
    <p class="page-lede">${sync.email ? `Signed in as ${esc(sync.email)}.` : 'Your light profile, account and setup.'}</p>

    <h3 class="sec">Your light</h3>
    <div class="you-list">
      ${row('profile', 'Light profile and keepers', good >= MIN_KEEPERS ? `${good} keepers. Your personal score is on.` : `${good} keeper${good === 1 ? '' : 's'}. Add ${MIN_KEEPERS - good} more to switch on your personal score.`)}
      ${row('recreate', 'Recreate a shot', 'Find upcoming sessions that match a photo.')}
    </div>

    <h3 class="sec">Account</h3>
    <div class="you-list">
      ${row('account', 'Account and sync', !sync.configured ? 'Not set up yet.' : sync.email ? (sync.state === 'error' ? 'Sync needs attention.' : `Synced ${syncAgo(sync.lastSync)}.`) : 'Not signed in. Sign in to sync across devices.')}
      ${row('alerts', 'Alerts', !sync.email ? 'Sign in to turn on alerts.' : s.alerts.go ? `Sessions scoring ${s.alerts.threshold}+${s.alerts.digest ? `, plus a ${DAYS[s.alerts.digestDay]} digest` : ''}.` : 'Go alerts are off.')}
    </div>

    <h3 class="sec">Setup</h3>
    <div class="you-list">
      ${row('home', 'Home and travel', s.home ? `Home set. Arrive ${s.arriveBeforeMin} min before each session.` : 'Home not set. Needed for leave times.')}
      ${row('kit', 'My kit', kit ? `${kit} item${kit === 1 ? '' : 's'} you always bring.` : 'Nothing added yet.')}
      ${row('display', 'Display', `${TEXT_SIZES[s.textSize || 'standard']} text, ${(s.motion || 'full') === 'reduced' ? 'reduced' : 'full'} motion.`)}
      ${row('ai', 'AI coach', hasAI(s) ? 'On, using your Claude key.' : 'Off. Optional.')}
      ${row('data', 'Your data', 'Back up, restore or delete.')}
    </div>
    <p class="small muted you-foot">Tidelight version ${APP_VERSION}. Weather, tide and sea data from Open-Meteo (CC BY 4.0). Aurora forecast from NOAA. Maps from OpenStreetMap. Tide heights are modelled and can differ from official tide tables; check local warnings before heading out.</p>
    <button class="link-btn" id="replayWelcome">Show the welcome again</button>`;
  $('#replayWelcome').onclick = () => openWelcome();
  $$('[data-you]', v).forEach(b => b.onclick = () => { youPage = b.dataset.you; renderYou(v); window.scrollTo(0, 0); });
}

function pageProfile(v, logLines = []) {
  const st = S();
  const good = st.keepers.filter(k => k.label === 'keeper').length;
  const duds = st.keepers.filter(k => k.label === 'dud').length;
  const mehs = st.keepers.filter(k => k.label === 'meh').length;
  const summary = personalModelSummary(st.keepers);
  const active = good >= MIN_KEEPERS;
  const sorted = [...st.keepers].sort((a, b) => b.date - a.date);
  v.innerHTML = `
    ${youHead('Light profile', summary ? `Your best shots tend to have ${esc(summary.text)}.` : 'Once you add keepers, this is where you\'ll see the conditions you shoot best in.')}
    <div class="meter" role="img" aria-label="${good} of 10 keepers"><i style="width:${Math.min(100, good / 10 * 100)}%"></i></div>
    <p class="small muted">${good} keeper${good === 1 ? '' : 's'}, ${mehs} so-so, ${duds} dud${duds === 1 ? '' : 's'}. ${active ? 'Your personal score is on.' : `Add ${MIN_KEEPERS - good} more keeper${MIN_KEEPERS - good === 1 ? '' : 's'} to switch on your personal score.`} It gets more confident up to 10.</p>

    <h3 class="sec">Teach it your keepers</h3>
    <p class="you-copy">Import your favourite shots. Tidelight reads the time and location saved in each photo, looks up the sky, tide and sea at that moment, and learns what your best sessions look like. Photos stay on this device.</p>
    <label class="form" style="margin-bottom:12px">
      <span class="small"><strong>If a photo has no location, use this spot</strong></span>
      <select id="fallbackSpot">
        <option value="">Skip photos without location</option>
        ${st.spots.map(sp => `<option value="${sp.id}">${esc(sp.name)}</option>`).join('')}
      </select>
    </label>
    <label class="btn primary block">Import photos<input type="file" id="keeperFiles" class="file-input" accept="image/*" multiple></label>
    <div class="log" id="importLog">${logLines.map(l => `<div>${esc(l)}</div>`).join('')}</div>
    ${sorted.length ? `<h3 class="sec">Your keepers and rated sessions</h3>
      <p class="small muted">Tap a label to change it between keeper, so-so and dud.</p>` : ''}
    <div class="thumbs">${sorted.map(k => `
      <div class="thumb">
        ${k.thumb ? `<img src="${k.thumb}" alt="">` : `<div class="ph">${k.source === 'session' ? 'Session' : 'Photo'}<br>${esc(k.spotName || '')}<br>${fmtDate(k.date)}</div>`}
        <button class="tag ${k.label}" data-flip="${k.id}" title="Tap to change: keeper, so-so, dud">${k.label === 'keeper' ? 'Keeper' : k.label === 'meh' ? 'So-so' : 'Dud'}</button>
        <button class="x" data-rm="${k.id}" aria-label="Remove">×</button>
      </div>`).join('')}</div>`;
  $('#keeperFiles').onchange = ev => importKeepers([...ev.target.files]);
  $$('[data-flip]', v).forEach(b => b.onclick = () => {
    update(s2 => { const k = s2.keepers.find(x => x.id === b.dataset.flip); k.label = { keeper: 'meh', meh: 'dud', dud: 'keeper' }[k.label] || 'keeper'; });
    renderYou(v);
  });
  $$('[data-rm]', v).forEach(b => b.onclick = () => {
    update(s2 => { s2.keepers = s2.keepers.filter(x => x.id !== b.dataset.rm); });
    renderYou(v);
  });
}

function pageRecreate(v) {
  v.innerHTML = `
    ${youHead('Recreate a shot', "Pick any photo you'd love to recreate, yours or an inspiration shot. Tidelight works out the conditions it needed and finds the upcoming sessions across your spots that match best.")}
    ${!hasAI(S().settings) ? '<p class="small muted">Photos without location data need the AI coach. Add your Claude key under You, in AI coach.</p>' : ''}
    <label class="btn primary block">Choose a photo<input type="file" id="refFile" class="file-input" accept="image/*"></label>
    <div id="refResult"></div>`;
  $('#refFile').onchange = ev => ev.target.files[0] && recreateShot(ev.target.files[0]);
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
  if (tab === 'you' && youPage === 'profile') renderYou($('#view'), log);
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
    out.innerHTML = `<div class="alert info">This photo has no saved location and time, so there's nothing to look up. Add your Claude key under You, in AI coach, and the AI coach will read the sky from the image itself.</div>`;
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
    <p class="small muted">First time? Tap Create account once on any device, then Sign in everywhere else with the same details.</p>
    <button class="link-btn" id="forgotBtn" type="button">Forgot your password?</button>`;
  $('#forgotBtn').onclick = async () => {
    const email = $('#authForm').email.value.trim();
    if (!email) { toast('Type your email above first, then tap "Forgot your password?"'); $('#authForm').email.focus(); return; }
    try { await sendPasswordReset(email); toast('Check your email for a reset link. Open it on this device.', 7000); }
    catch (e) { toast(e.message, 7000); }
  };
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

/* ---------- alerts panel ---------- */
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const hourLabel = h => `${h % 12 || 12}${h < 12 ? 'am' : 'pm'}`;
const b64urlToBytes = s => {
  const pad = '='.repeat((4 - s.length % 4) % 4);
  const raw = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, c => c.charCodeAt(0));
};
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

async function currentPushSub() {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return reg ? reg.pushManager.getSubscription() : null;
}

async function renderAlerts() {
  const box = $('#alertsPanel');
  if (!box) return;
  const st = syncStatus();
  const a = S().settings.alerts;
  if (!st.email) {
    box.innerHTML = `<h2>Alerts</h2><p class="small muted">Sign in above to turn on alerts. Your spots are checked every hour, and you get a notification when the light lines up.</p>`;
    return;
  }
  let device = '';
  if (VAPID_PUBLIC_KEY.startsWith('PASTE')) {
    device = `<p class="small muted">Alerts aren't set up yet. Follow the "Alerts" steps in the README to add your keys and the alerts function.</p>`;
  } else if (!pushSupported() || (isIOS() && !isStandalone())) {
    device = `<p class="small muted">${isIOS() ? 'On iPhone, alerts work in the home-screen app. Open Tidelight from your home screen (Share → Add to Home Screen) and turn them on there.' : "This browser can't receive notifications."}</p>`;
  } else {
    const sub = await currentPushSub();
    const blocked = Notification.permission === 'denied';
    // Self-heal: if this device is subscribed but the server lost (or never got) the record, save it again.
    if (sub && Notification.permission === 'granted') savePushSubscription(sub.toJSON()).catch(() => {});
    device = sub && Notification.permission === 'granted'
      ? `<p class="small"><strong class="caramel">Alerts are on for this device.</strong></p>
         <div class="row"><button class="btn" id="testAlert">Send a test</button><button class="btn ghost" id="pushOff">Turn off on this device</button></div>`
      : blocked
        ? `<p class="small sync-err">Notifications are blocked for Tidelight. Allow them in your phone's Settings → Notifications → Tidelight, then come back here.</p>`
        : `<div class="row"><button class="btn primary block" id="pushOn">Turn on alerts on this device</button></div>`;
  }
  const opt = (v, cur, label) => `<option value="${v}" ${String(v) === String(cur) ? 'selected' : ''}>${label}</option>`;
  function thPreview(v) {
    if (!Object.keys(forecasts).length) return 'Lower catches more sessions; higher means fewer, surer alerts.';
    const n = next3Days().filter(e => e.score >= v).length;
    return `Right now, ${n} of your sessions in the next 3 days score${n === 1 ? 's' : ''} ${v} or more.`;
  }
  box.innerHTML = `<h2>Alerts</h2>
    <p class="small muted">Checked every hour from your Supabase account, using the same scores as the app (including your personal score).</p>
    ${device}
    <form class="form alert-prefs" id="alertForm">
      <label class="check"><input type="checkbox" name="go" ${a.go ? 'checked' : ''}> Tell me when a session in the next 36 hours is worth the alarm</label>
      <label class="slider">
        <span class="slider-head"><span>Alert me at a score of</span><output class="num" id="thOut">${a.threshold}+</output></span>
        <input type="range" name="threshold" id="thRange" min="60" max="95" step="5" value="${a.threshold}" aria-label="Score threshold" style="--val:${((a.threshold - 60) / 35 * 100).toFixed(0)}%">
        <span class="slider-foot" id="thPreview">${esc(thPreview(a.threshold))}</span>
      </label>
      <label class="check"><input type="checkbox" name="confident" ${a.confident !== false ? 'checked' : ''}> Skip colour alerts when the weather models disagree (fewer false alarms)</label>
      <label class="check"><input type="checkbox" name="crew" ${a.crew !== false ? 'checked' : ''}> Tell me when someone in my crew plans a shoot</label>
      <label class="check"><input type="checkbox" name="calledOff" ${a.calledOff ? 'checked' : ''}> Tell me if a session I was alerted about falls through</label>
      <label class="check"><input type="checkbox" name="digest" ${a.digest ? 'checked' : ''}> Weekly digest of the best 3 sessions, every
        <select name="digestDay" aria-label="Digest day">${DAYS.map((d, i) => opt(i, a.digestDay, d)).join('')}</select>
        at <select name="digestHour" aria-label="Digest time">${[7, 8, 12, 17, 18, 19, 20].map(h => opt(h, a.digestHour, hourLabel(h))).join('')}</select></label>
      <div class="two">
        <label>Quiet from<select name="quietStart">${opt(-1, a.quietStart === a.quietEnd ? -1 : a.quietStart, 'No quiet hours')}${[20, 21, 22, 23].map(h => opt(h, a.quietStart, hourLabel(h))).join('')}</select></label>
        <label>Until<select name="quietEnd">${[5, 6, 7, 8].map(h => opt(h, a.quietEnd, hourLabel(h))).join('')}</select></label>
      </div>
      <div class="row"><button class="btn primary" type="submit">Save alert settings</button></div>
    </form>`;

  const on = $('#pushOn');
  if (on) on.onclick = async () => {
    on.disabled = true; on.textContent = 'Turning on…';
    try {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') throw new Error('Notifications weren\'t allowed. You can allow them in your phone\'s Settings → Notifications → Tidelight.');
      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64urlToBytes(VAPID_PUBLIC_KEY) });
      await savePushSubscription(sub.toJSON());
      toast('Alerts are on. Tap "Send a test" to check.');
    } catch (e) { toast(e.message, 7000); }
    renderAlerts();
  };
  const off = $('#pushOff');
  if (off) off.onclick = async () => {
    const sub = await currentPushSub();
    if (sub) { await removePushSubscription(sub.endpoint).catch(() => {}); await sub.unsubscribe().catch(() => {}); }
    toast('Alerts turned off on this device.');
    renderAlerts();
  };
  const test = $('#testAlert');
  if (test) test.onclick = async () => {
    test.disabled = true; test.textContent = 'Sending…';
    try {
      const sub = await currentPushSub();
      if (sub) await savePushSubscription(sub.toJSON());   // make sure Supabase knows this device
      await sendTestAlert();
      toast('Test sent. It should arrive in a few seconds.');
    }
    catch (e) { toast(e.message, 7000); }
    test.disabled = false; test.textContent = 'Send a test';
  };
  const thr = $('#thRange');
  if (thr) thr.oninput = () => {
    $('#thOut').textContent = `${thr.value}+`;
    $('#thPreview').textContent = thPreview(Number(thr.value));
    thr.style.setProperty('--val', `${((thr.value - 60) / 35 * 100).toFixed(0)}%`);
  };
  $('#alertForm').onsubmit = ev => {
    ev.preventDefault();
    const f = new FormData(ev.target);
    const qs = parseInt(f.get('quietStart'), 10), qe = parseInt(f.get('quietEnd'), 10);
    update(s => {
      s.settings.alerts = {
        go: !!f.get('go'), threshold: parseInt(f.get('threshold'), 10),
        calledOff: !!f.get('calledOff'), confident: !!f.get('confident'), crew: !!f.get('crew'),
        digest: !!f.get('digest'), digestDay: parseInt(f.get('digestDay'), 10), digestHour: parseInt(f.get('digestHour'), 10),
        quietStart: qs < 0 ? 0 : qs, quietEnd: qs < 0 ? 0 : qe,
      };
    });
    toast('Alert settings saved. They sync to your account.');
  };
}

function pageAccount(v) {
  v.innerHTML = `${youHead('Account and sync')}<section class="you-page" id="accountPanel"></section>`;
  renderAccount();
}

function pageAlerts(v) {
  v.innerHTML = `${youHead('Alerts')}<section class="you-page" id="alertsPanel"></section>`;
  renderAlerts();
}

function pageHome(v) {
  const s = S().settings;
  v.innerHTML = `
    ${youHead('Home and travel', 'Used to work out drive times and when to leave. Your home location syncs with your account.')}
    <form class="form" id="homeForm">
      <div class="two">
        <label>Latitude<input name="lat" inputmode="decimal" value="${s.home ? s.home.lat.toFixed(5) : ''}"></label>
        <label>Longitude<input name="lon" inputmode="decimal" value="${s.home ? s.home.lon.toFixed(5) : ''}"></label>
      </div>
      <button type="button" class="btn" id="homeHere">Use where I am now</button>
      <label class="slider">
        <span class="slider-head"><span>Arrive before each session</span><output class="num" id="arriveOut">${s.arriveBeforeMin} min</output></span>
        <input type="range" name="arrive" id="arriveRange" min="0" max="90" step="5" value="${s.arriveBeforeMin}" style="--val:${(s.arriveBeforeMin / 90 * 100).toFixed(0)}%">
      </label>
      <label class="slider">
        <span class="slider-head"><span>Average drive speed</span><output class="num" id="speedOut">${s.driveSpeedKmh} km/h</output></span>
        <input type="range" name="speed" id="speedRange" min="30" max="110" step="5" value="${s.driveSpeedKmh}" style="--val:${((s.driveSpeedKmh - 30) / 80 * 100).toFixed(0)}%">
        <span class="slider-foot" id="travelExample"></span>
      </label>
      <button type="submit" class="btn primary">Save home and travel</button>
    </form>`;
  const ar = $('#arriveRange'), sr = $('#speedRange');
  const example = () => {
    const mins = Math.round(40 / Number(sr.value) * 60), lead = Number(ar.value) + mins;
    const at = 6 * 60 - lead, hh = Math.floor(at / 60), mm = String(at % 60).padStart(2, '0');
    $('#arriveOut').textContent = `${ar.value} min`;
    $('#speedOut').textContent = `${sr.value} km/h`;
    ar.style.setProperty('--val', `${(ar.value / 90 * 100).toFixed(0)}%`);
    sr.style.setProperty('--val', `${((sr.value - 30) / 80 * 100).toFixed(0)}%`);
    $('#travelExample').textContent = `Example: for a 6:00am sunrise 40 km away, that's a ${mins} min drive, leaving at ${hh}:${mm}am.`;
  };
  ar.oninput = example; sr.oninput = example; example();
  $('#homeHere').onclick = async () => {
    try {
      const p = await getPosition();
      $('#homeForm').lat.value = p.lat.toFixed(5);
      $('#homeForm').lon.value = p.lon.toFixed(5);
      toast('Location filled in. Tap Save home and travel.');
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
    toast('Home and travel saved.');
  };
}

function pageKit(v) {
  v.innerHTML = `
    ${youHead('My kit', "Things you always bring. They're added to every session's gear checklist, alongside what the conditions call for.")}
    <form class="form" id="kitForm">
      <label>One item per line<textarea name="kit" rows="8" placeholder="Camera and spare battery&#10;Tripod&#10;Memory cards&#10;Phone charger">${esc((S().settings.gearAlways || []).join('\n'))}</textarea></label>
      <button class="btn primary" type="submit">Save my kit</button>
    </form>`;
  $('#kitForm').onsubmit = ev => {
    ev.preventDefault();
    const items = String(new FormData(ev.target).get('kit') || '').split('\n').map(x => x.trim()).filter(Boolean).slice(0, 40);
    update(s2 => { s2.settings.gearAlways = items; });
    toast('My kit saved.');
  };
}

function pageDisplay(v) {
  const cur = S().settings.textSize || 'standard';
  v.innerHTML = `
    ${youHead('Display', 'Text size and motion. These apply to this device only.')}
    <h3 class="sec">Text size</h3>
    <div class="size-options" role="radiogroup" aria-label="Text size">
      ${Object.entries(TEXT_SIZES).map(([k, label]) => `<button class="size-opt ${cur === k ? 'on' : ''}" role="radio" aria-checked="${cur === k}" data-size="${k}"><span class="size-a size-${k}">Aa</span><span>${label}</span></button>`).join('')}
    </div>
    <h3 class="sec">Preview</h3>
    <p class="bf-verdict" style="margin-top:0">Worth the alarm. Clear horizon towards the sunrise.</p>
    <p class="you-copy">Leave at 4:20am, a 47 minute drive and a 25 minute walk in. Low cloud 8%, wind 6 km/h.</p>
    <h3 class="sec">Motion</h3>
    <p class="you-copy">Full motion shows drifting cloud, rain and stars on the light band, counting scores and moving pages. Reduced keeps everything still. Your phone's own Reduce Motion setting is always respected.</p>
    <div class="size-options two-up" role="radiogroup" aria-label="Motion">
      ${[['full', 'Full motion'], ['reduced', 'Reduced']].map(([k, label]) => `<button class="size-opt ${(S().settings.motion || 'full') === k ? 'on' : ''}" role="radio" aria-checked="${(S().settings.motion || 'full') === k}" data-motion="${k}"><span>${label}</span></button>`).join('')}
    </div>`;
  $$('[data-motion]', v).forEach(b => b.onclick = () => {
    update(s2 => { s2.settings.motion = b.dataset.motion; });
    applyMotion();
    renderYou(v);
  });
  $$('[data-size]', v).forEach(b => b.onclick = () => {
    update(s2 => { s2.settings.textSize = b.dataset.size; });
    applyTextSize();
    renderYou(v);
  });
}

function pageAI(v) {
  const s = S().settings;
  v.innerHTML = `
    ${youHead('AI coach', 'Optional. Rewrites briefings in plain English and reads the sky from reference photos.')}
    <p class="you-copy">Get a key at console.anthropic.com. It's stored only in this browser, and is never included in backups, sync or your GitHub repo. Each briefing costs a fraction of a cent.</p>
    <form class="form" id="aiForm">
      <label>Claude API key<input name="key" type="password" autocomplete="off" value="${esc(s.claudeKey)}" placeholder="sk-ant-…"></label>
      <label>Model<input name="model" value="${esc(s.claudeModel)}"></label>
      <div class="row">
        <button type="submit" class="btn primary">Save AI coach</button>
        <button type="button" class="btn" id="testKey">Test key</button>
      </div>
    </form>`;
  $('#aiForm').onsubmit = ev => {
    ev.preventDefault();
    const f = new FormData(ev.target);
    update(st2 => { st2.settings.claudeKey = String(f.get('key')).trim(); st2.settings.claudeModel = String(f.get('model')).trim() || 'claude-sonnet-5-5'; });
    toast('AI coach saved.');
  };
  $('#testKey').onclick = async () => {
    const f = new FormData($('#aiForm'));
    const tmp = { claudeKey: String(f.get('key')), claudeModel: String(f.get('model')) };
    if (!hasAI(tmp)) return toast('Paste a key first');
    const b = $('#testKey'); b.disabled = true; b.textContent = 'Testing…';
    try { await testKey(tmp); toast('Key works.'); } catch (e) { toast(e.message, 6000); }
    b.disabled = false; b.textContent = 'Test key';
  };
}

function pageData(v) {
  v.innerHTML = `
    ${youHead('Your data', 'Everything is saved in this browser, and in your account when you\'re signed in. A backup file is another way to move it between devices.')}
    <div class="you-actions">
      <button class="btn" id="exportBtn">Export a backup</button>
      <label class="btn">Restore from a backup<input type="file" id="importFile" class="file-input" accept="application/json,.json"></label>
    </div>
    <h3 class="sec">Start again</h3>
    <p class="you-copy">Deletes all spots, photos, plans, keepers and settings from this browser. If you're signed in, you'll be signed out and your synced copy stays safe in your account.</p>
    <button class="btn danger" id="resetBtn">Delete everything on this device</button>`;
  $('#exportBtn').onclick = async () => {
    const b = $('#exportBtn'); b.disabled = true; b.textContent = 'Preparing…';
    try {
      const backup = JSON.parse(exportData());
      backup.photos = await exportPhotos(S().spots.flatMap(sp => sp.photos || []));
      downloadFile(`tidelight-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(backup), 'application/json');
    } catch (e) { toast(e.message, 5000); }
    b.disabled = false; b.textContent = 'Export a backup';
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
      toast('Backup restored.'); youPage = null; render();
    }
    catch (e) { toast(e.message, 5000); }
  };
  $('#resetBtn').onclick = async () => {
    if (!confirm('Delete all spots, photos, plans, keepers and settings from this browser?')) return;
    await signOut().catch(() => {});
    resetAll(); clearPhotos(); for (const k in forecasts) delete forecasts[k];
    toast('Everything on this device was deleted.'); youPage = null; setTab('forecast');
  };
}

/* ================= first-run welcome ================= */
const WELCOMED = 'tidelight:welcomed';
let welcome = null;   // { steps, i, picked, signedIn, returning }

const isIosBrowser = () => /iphone|ipad|ipod/i.test(navigator.userAgent) && !navigator.standalone && !matchMedia('(display-mode: standalone)').matches;

function maybeWelcome() {
  if (localStorage.getItem(WELCOMED) || S().spots.length) return;
  openWelcome();
}
function openWelcome() {
  closeWelcome(false);
  const steps = [...(isIosBrowser() ? ['install'] : []), 'intro', 'home', 'spot', ...(isConfigured() ? ['account'] : []), 'done'];
  welcome = { steps, i: 0, picked: null, returning: false };
  const el = document.createElement('div');
  el.id = 'welcome';
  el.className = 'welcome';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', 'Welcome to Tidelight');
  document.body.appendChild(el);
  document.body.classList.add('noscroll');
  drawWelcome();
}
function closeWelcome(done = true) {
  if (done) localStorage.setItem(WELCOMED, '1');
  welcome = null;
  const el = $('#welcome');
  if (el) el.remove();
  if ($('#sheet').classList.contains('hidden') && !$('#field')) document.body.classList.remove('noscroll');
}
function welcomeGo(step) {
  if (!welcome) return;
  welcome.i = typeof step === 'number' ? Math.max(0, Math.min(welcome.steps.length - 1, welcome.i + step)) : welcome.steps.indexOf(step);
  welcome.picked = null;
  drawWelcome();
  $('#welcome').scrollTop = 0;
}

function drawWelcome() {
  const el = $('#welcome');
  if (!el || !welcome) return;
  const step = welcome.steps[welcome.i];
  const numbered = welcome.steps.filter(x => !['install', 'intro', 'done'].includes(x));
  const n = numbered.indexOf(step);
  const top = `<div class="wl-top">
      <span class="wl-progress">${n >= 0 ? `Step ${n + 1} of ${numbered.length}` : ''}</span>
      ${step !== 'done' ? '<button class="link-btn" id="wlSkipAll">Skip setup</button>' : ''}
    </div>`;
  const results = id => `<div class="wl-results" id="${id}" hidden></div>`;
  const st = S();

  if (step === 'install') {
    el.innerHTML = `${top}
      <h1 class="page-title">Put Tidelight on your Home Screen first</h1>
      <p class="page-lede">It opens full screen, works without reception and can send alerts. Anything you set up here in Safari stays in Safari, so install it first and set up once.</p>
      <ol class="wl-steps">
        <li>Tap the Share button at the bottom of Safari.</li>
        <li>Choose <strong>Add to Home Screen</strong>, then <strong>Add</strong>.</li>
        <li>Open Tidelight from your Home Screen and set up there.</li>
      </ol>
      <div class="wl-actions"><button class="btn" id="wlNext">Set up here in Safari anyway</button></div>`;
  } else if (step === 'intro') {
    const offset = -new Date().getTimezoneOffset() * 60;
    const b = lightBand(day3am(Date.now() / 1000, offset), st.settings.home);
    el.innerHTML = `${top}
      <h1 class="page-title wl-hero">Know before the alarm</h1>
      <p class="page-lede">Tidelight scores sunrise, sunset, daytime and night sessions at your own spots, tells you when to leave, and explains why.</p>
      <figure class="band-wrap wl-band">
        <div class="band reveal" style="background:${b.gradient}" role="img" aria-label="A day's light from dark through blue hour, golden hour and daylight"></div>
        <div class="band-ticks" aria-hidden="true">${[['6am', 12.5], ['Noon', 37.5], ['6pm', 62.5], ['Midnight', 87.5]].map(([l, x]) => `<span class="band-tick" style="left:${x}%">${l}</span>`).join('')}</div>
      </figure>
      <p class="you-copy">Every day is drawn as its light, with your sessions marked on it. Setting up takes about a minute.</p>
      <div class="wl-actions">
        <button class="btn primary" id="wlNext">Set up Tidelight</button>
        ${isConfigured() ? '<button class="btn" id="wlHave">I already have an account</button>' : ''}
      </div>`;
  } else if (step === 'home') {
    el.innerHTML = `${top}
      <h1 class="page-title">Where do you set out from?</h1>
      <p class="page-lede">Used to work out drive times and when to leave for each session.</p>
      <div class="wl-actions"><button class="btn primary" id="wlHere">Use where I am now</button></div>
      <form class="search" id="wlHomeSearch" role="search">
        <input type="search" id="wlHomeQ" placeholder="Or search for your town or suburb" autocomplete="off" enterkeyhint="search" aria-label="Search for your town or suburb">
        <button class="btn" type="submit">Search</button>
      </form>
      ${results('wlHomeRes')}
      ${st.settings.home ? `<p class="small muted">Home is already set. <button class="link-btn" id="wlNext">Keep it and continue</button></p>` : ''}
      <button class="link-btn wl-skip" id="wlSkip">Skip for now</button>`;
  } else if (step === 'spot') {
    const pk = welcome.picked;
    el.innerHTML = `${top}
      <h1 class="page-title">Add your first spot</h1>
      <p class="page-lede">A beach, lookout, waterfall or forest you already shoot. You can add the rest later.</p>
      ${pk ? `<form class="form" id="wlSpotForm">
          <label>Name<input name="name" required value="${esc(pk.name || '')}" placeholder="e.g. North jetty"></label>
          <fieldset><legend>What do you shoot here?</legend>
            <div class="checks">${HUNT_ORDER.map(k => `<label class="check"><input type="checkbox" name="hunt_${k}" ${k === 'colour' ? 'checked' : ''}> ${HUNT_LABEL[k]}</label>`).join('')}</div>
            <span class="hint">Colour is sunrise and sunset colour. Pick any others that suit the place.</span>
          </fieldset>
          <label class="check"><input type="checkbox" name="coastal"> It's on the coast (use tide and wave data)</label>
          <div class="wl-actions">
            <button class="btn primary" type="submit">Add this spot</button>
            <button class="btn" type="button" id="wlRepick">Choose a different place</button>
          </div>
        </form>` : `<form class="search" id="wlSpotSearch" role="search">
          <input type="search" id="wlSpotQ" placeholder="Search for a place, e.g. Cape Schanck" autocomplete="off" enterkeyhint="search" aria-label="Search for a place you shoot">
          <button class="btn primary" type="submit">Search</button>
        </form>
        ${results('wlSpotRes')}
        <div class="wl-actions"><button class="btn" id="wlSpotHere">I'm standing at it: use where I am</button></div>`}
      <button class="link-btn wl-skip" id="wlSkip">Skip for now</button>`;
  } else if (step === 'account') {
    const user = currentUser();
    el.innerHTML = `${top}
      <h1 class="page-title">${welcome.returning ? 'Sign in' : 'Keep it safe, and bring your crew'}</h1>
      <p class="page-lede">${welcome.returning ? 'Your spots, plans and settings will follow you onto this device.' : 'An account syncs your spots and plans between devices, turns on alerts, and lets you share plans with the people you shoot with. Optional.'}</p>
      ${user ? `<p class="you-copy">Signed in as <strong>${esc(user.email)}</strong>.</p>
        <form class="form" id="wlCrew">
          <div class="two"><label>Crew invite code, if you have one<input name="code" maxlength="6" autocapitalize="characters" placeholder="ABC123"></label><label>Your name in the crew<input name="me" maxlength="40" value="${esc((user.email || '').split('@')[0])}"></label></div>
          <div class="wl-actions"><button class="btn primary" type="submit">Continue</button></div>
        </form>` : `<form class="form" id="wlAuth">
          <label>Email<input type="email" name="email" autocomplete="email" required></label>
          <label>Password<span class="hint">At least 8 characters</span><input type="password" name="password" autocomplete="${welcome.returning ? 'current-password' : 'new-password'}" minlength="8" required></label>
          <div class="wl-actions">
            ${welcome.returning ? '<button class="btn primary" type="submit" value="signin">Sign in</button>' : '<button class="btn primary" type="submit" value="create">Create account</button><button class="btn" type="submit" value="signin">Sign in instead</button>'}
          </div>
        </form>
        <button class="link-btn wl-skip" id="wlSkip">${welcome.returning ? 'Back to setup' : 'Skip for now'}</button>`}`;
  } else {
    const spot = st.spots[0];
    el.innerHTML = `${top}
      <h1 class="page-title">${welcome.returning && spot ? 'Welcome back' : "You're set"}</h1>
      <p class="page-lede">${spot ? (welcome.returning ? `Your ${st.spots.length} spot${st.spots.length === 1 ? ' is' : 's are'} here.` : `${esc(spot.name)} is being scored now.`) : 'Add a spot from the Spots tab whenever you\'re ready.'}</p>
      <ul class="wl-tips">
        <li><strong>Forecast</strong> draws each day as its light, with your sessions marked on it. Tap one to see why it scored that way.</li>
        <li><strong>Plan this shoot</strong> gives you a leave time, a gear list to pack and field mode for when you arrive.</li>
        <li><strong>Rate sessions afterwards.</strong> Three keepers switch on a score that's personal to you.</li>
        ${currentUser() ? '<li><strong>Alerts</strong> tell you when a session is worth the alarm. Turn them on under You, in Alerts.</li>' : ''}
      </ul>
      <div class="wl-actions"><button class="btn primary" id="wlFinish">${spot ? 'Show me the forecast' : 'Go to Spots'}</button></div>`;
  }

  // ----- wiring -----
  const on = (id, fn) => { const b = $(`#${id}`, el); if (b) b.onclick = fn; };
  on('wlSkipAll', () => { closeWelcome(); render(); });
  on('wlNext', () => welcomeGo(1));
  on('wlSkip', () => { if (step === 'account' && welcome.returning) { welcome.returning = false; welcomeGo('home'); } else welcomeGo(1); });
  on('wlHave', () => { welcome.returning = true; welcomeGo('account'); });
  on('wlFinish', () => { const has = S().spots.length; closeWelcome(); for (const k in forecasts) delete forecasts[k]; setTab(has ? 'forecast' : 'spots'); });
  on('wlRepick', () => { welcome.picked = null; drawWelcome(); });

  const runSearch = async (inputId, resId, pick) => {
    const q = $(`#${inputId}`, el).value.trim(), box = $(`#${resId}`, el);
    if (q.length < 2) return;
    box.hidden = false; box.innerHTML = '<p class="small muted">Searching…</p>';
    try {
      const found2 = await searchPlaces(q, S().settings.home);
      if (!$(`#${resId}`)) return;
      box.innerHTML = found2.length ? found2.slice(0, 6).map((r, i) => `<button class="wl-result" data-i="${i}"><span>${esc(r.name)}</span><small>${esc(r.detail || '')}</small></button>`).join('')
        : '<p class="small muted">Nothing found. Try a nearby town or a simpler name.</p>';
      $$('[data-i]', box).forEach(b => b.onclick = () => pick(found2[Number(b.dataset.i)]));
    } catch { box.innerHTML = '<p class="small muted">The search didn\'t respond. Check your connection and try again.</p>'; }
  };
  const setHome = p => { update(s2 => { s2.settings.home = { lat: p.lat, lon: p.lon }; }); toast('Home set.'); welcomeGo(1); };
  on('wlHere', async () => { try { setHome(await getPosition()); } catch (e) { toast(e.message, 5000); } });
  const hs = $('#wlHomeSearch', el);
  if (hs) hs.onsubmit = ev => { ev.preventDefault(); runSearch('wlHomeQ', 'wlHomeRes', setHome); };
  const ss = $('#wlSpotSearch', el);
  if (ss) ss.onsubmit = ev => { ev.preventDefault(); runSearch('wlSpotQ', 'wlSpotRes', r => { welcome.picked = r; drawWelcome(); }); };
  on('wlSpotHere', async () => {
    try {
      const p = await getPosition();
      welcome.picked = { name: '', lat: p.lat, lon: p.lon };
      drawWelcome();
      placeName(p.lat, p.lon).then(nm => { const f = $('#wlSpotForm'); if (nm && f && !f.name.value) f.name.value = `Near ${nm}`; }).catch(() => {});
    } catch (e) { toast(e.message, 5000); }
  });
  const sf = $('#wlSpotForm', el);
  if (sf) sf.onsubmit = ev => {
    ev.preventDefault();
    const f = new FormData(sf), name = String(f.get('name') || '').trim();
    if (!name) return toast('Give the spot a name');
    const hunts = HUNT_ORDER.filter(k => f.get(`hunt_${k}`));
    const pk = welcome.picked;
    update(s2 => s2.spots.push({
      id: uid(), name, lat: pk.lat, lon: pk.lon, events: ['sunrise', 'sunset'], coastal: !!f.get('coastal'), tide: 'any',
      driveMin: '', facing: '', notes: '', photos: [], hunts: hunts.length ? hunts : ['colour'], fogMode: 'in',
    }));
    toast(`${name} added.`);
    welcomeGo(1);
  };
  const af = $('#wlAuth', el);
  if (af) af.onsubmit = async ev => {
    ev.preventDefault();
    const f = new FormData(af), mode = ev.submitter?.value || (welcome.returning ? 'signin' : 'create');
    const btns = $$('button[type=submit]', af); btns.forEach(b => { b.disabled = true; });
    try {
      const email = String(f.get('email')).trim(), pw = String(f.get('password'));
      if (mode === 'create') await createAccount(email, pw); else await signInWithPassword(email, pw);
      await syncNow().catch(() => {});
      await loadCrew();
      if (!welcome) return;
      if (S().spots.length && welcome.returning) return welcomeGo('done');   // their data arrived: nothing more to set up
      if (welcome.returning) { welcome.returning = false; toast('Signed in. Nothing saved in this account yet, so let\'s set up.', 5000); return welcomeGo('home'); }
      drawWelcome();
    } catch (e) { toast(e.message, 6000); btns.forEach(b => { b.disabled = false; }); }
  };
  const cf = $('#wlCrew', el);
  if (cf) cf.onsubmit = async ev => {
    ev.preventDefault();
    const f = new FormData(cf), code = String(f.get('code') || '').trim();
    if (code) {
      try { const c = await joinCrew(code, String(f.get('me') || '').trim() || 'Me'); await loadCrew(); toast(`You've joined ${c.name}.`); }
      catch (e) { return toast(e.message, 6000); }
    }
    welcomeGo(1);
  };
}

/* ================= boot ================= */

document.addEventListener('click', ev => {
  if (ev.target.closest('[data-lightning]')) { openLightningTimer(); return; }
  const labBtn = ev.target.closest('[data-lab]');
  if (labBtn) { openLab(labBtn.dataset.lab); return; }
  const dialBtn = ev.target.closest('[data-dial]');
  if (dialBtn) { const de = eventIndex.get(dialBtn.dataset.dial); if (de) openLightDial({ name: de.spot.name, lat: de.spot.lat, lon: de.spot.lon, offset: de.offset, t: de.t }); return; }
  const fmBtn = ev.target.closest('[data-field]');
  if (fmBtn) { openField(fmBtn.dataset.field); return; }
  const cpBtn = ev.target.closest('[data-compass]');
  if (cpBtn) { openCompass(cpBtn.dataset.compass); return; }
  if (ev.target.closest('[data-add-here]') && found) { openSpotForm({ lat: found.lat, lon: found.lon, name: found.name }); return; }
  const evBtn = ev.target.closest('[data-ev]');
  if (evBtn) { openEvent(evBtn.dataset.ev); return; }
  if (ev.target.closest('[data-close]')) closeSheet();
});
document.addEventListener('keydown', ev => { if (ev.key === 'Escape') { if (!$('#sheet').classList.contains('hidden')) closeSheet(); else closeField(); } });
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

// Opened from a password-reset email: choose a new password.
function openRecoverySheet() {
  openSheet(`
    <h2>Choose a new password</h2>
    <p class="small muted">You opened a password reset link. Pick a new password (at least 8 characters). Then sign in with it on your other devices and in the home-screen app.</p>
    <form class="form" id="recoverForm">
      <label>New password<input type="password" name="pw" autocomplete="new-password" minlength="8" required></label>
      <div class="row"><button class="btn primary" type="submit">Save new password</button></div>
    </form>`);
  $('#recoverForm').onsubmit = async ev => {
    ev.preventDefault();
    try { await setNewPassword(new FormData(ev.target).get('pw')); closeSheet(); toast('Password changed. Use it to sign in everywhere.', 6000); }
    catch (e) { toast(e.message, 6000); }
  };
}

async function openLink(hash) {
  const m = /^#crew(?:-([0-9a-f-]{8,}))?$/i.exec(hash || '');
  if (!m) return;
  history.replaceState(null, '', location.pathname + location.search);
  closeWelcome(false);
  plansView = 'crew';
  setTab('plans');
  if (!m[1]) return;
  if (!crewState.loaded || !crewState.plans.some(x => x.id === m[1])) { crewState.loaded = false; await loadCrew(); }
  openSharedSpot(m[1]);
}
navigator.serviceWorker?.addEventListener('message', ev => {
  if (ev.data?.type === 'open') openLink(new URL(ev.data.url).hash);
});
window.addEventListener('hashchange', () => openLink(location.hash));

function backfillRatings() {
  const st = S();
  const linked = new Set(st.keepers.map(k => k.planId).filter(Boolean));
  const missing = st.plans.filter(p => p.rating === 'meh' && !linked.has(p.id) && p.features);
  if (!missing.length) return;
  update(s => {
    for (const p of missing) s.keepers.push({ id: uid(), label: 'meh', source: 'session', planId: p.id, date: p.t * 1000, lat: p.lat, lon: p.lon, spotName: p.spotName, features: p.features, thumb: null });
  });
}

applyTextSize();
applyMotion();
loadAllPhotos().finally(() => {
  backfillRatings();
  render();
  maybeWelcome();
  onPasswordRecovery(openRecoverySheet);
  initSync(() => {
    for (const k in forecasts) delete forecasts[k];
    // Signed in already and the data has arrived: no need for the welcome.
    if (welcome && S().spots.length && currentUser() && ['install', 'intro'].includes(welcome.steps[welcome.i])) closeWelcome();
    if (!$('#sheet').classList.contains('hidden')) return;
    render();
  })
    .then(() => loadCrew()).then(() => {
      if (location.hash.startsWith('#crew')) return openLink(location.hash);
      if (['forecast', 'plans', 'spots'].includes(tab) && $('#sheet').classList.contains('hidden')) render();
    })
    .catch(() => {});
  let wasSignedIn = !!currentUser();
  onSyncStatus(st => {
    if (tab === 'you') { if (youPage === 'account') renderAccount(); else if (youPage === 'alerts') renderAlerts(); else if (!youPage) render(); }
    const signedIn = !!st.email;
    if (signedIn !== wasSignedIn) { wasSignedIn = signedIn; crewState.loaded = false; loadCrew().then(() => { if (tab === 'plans') render(); }); }
  });
});
