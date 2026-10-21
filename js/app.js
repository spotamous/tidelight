import { getState, update, exportData, importData, resetAll } from './storage.js';
import { fetchSpotForecast, fetchHistorical, clearCache } from './api.js';
import { evaluateSpot, featureVector, similarity, personalModelSummary, MIN_KEEPERS } from './scoring.js';
import { hasAI, testKey, aiBriefing, briefingContext, aiAnalyzeReference, aiResultToFeatures, readExif, resizeImage } from './ai.js';
import { esc, fmtTime, fmtDay, fmtDate, dayKey, cap, uid, toast, downloadFile, getPosition } from './util.js';

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const S = () => getState();

let tab = 'forecast';
let map = null;
let forecastSort = 'time';
const forecasts = {};          // spotId -> normalized forecast
const eventIndex = new Map();  // event key -> event

/* ================= data ================= */

async function loadForecasts(force = false) {
  if (force) { clearCache(); for (const k in forecasts) delete forecasts[k]; }
  const spots = S().spots;
  const res = await Promise.allSettled(spots.map(s => fetchSpotForecast(s)));
  const failed = [];
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
  if (e.unsafe) return 'No-go: safety';
  if (e.score >= 75) return 'Go';
  if (e.score >= 50) return 'Maybe';
  return 'Skip';
}

function briefing(e) {
  const o = e.offset, h = e.hour, s = e.spot;
  const lines = [];
  lines.push(`${verdict(e)}. ${s.name} ${e.type} at ${fmtTime(e.t, o)}.`);
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
  if ((h.high ?? 0) > 30 && !e.unsafe) {
    lines.push(e.type === 'sunset' ? 'Stay 15–20 min after sunset for afterglow on the high cloud.' : 'Arrive early: high cloud often lights up 15–20 min before sunrise.');
  }
  if (e.alignment) lines.push(e.alignment.text + '.');
  return lines.join(' ');
}

/* ================= shared fragments ================= */

function horizon(e, big = false) {
  return `<div class="horizon ${big ? 'big' : ''} ${e.unsafe ? 'unsafe' : ''}" style="--p:${e.score}" aria-label="Score ${e.score} out of 100">${e.score}</div>`;
}

function chips(e) {
  const c = [];
  if (e.unsafe) c.push(`<span class="chip warn">Waves over your limit</span>`);
  if (e.tide) {
    const p = e.tide.pos;
    const label = p < 0.25 ? 'Low tide' : p > 0.75 ? 'High tide' : `Mid tide, ${e.tide.rising ? 'rising' : 'falling'}`;
    c.push(`<span class="chip tide">${label}</span>`);
  }
  if (e.hour.wave != null && !e.unsafe) c.push(`<span class="chip">${e.hour.wave.toFixed(1)} m sea</span>`);
  c.push(`<span class="chip">${Math.round(e.hour.low ?? 0)}/${Math.round(e.hour.mid ?? 0)}/${Math.round(e.hour.high ?? 0)}% cloud</span>`);
  if (e.personal) c.push(`<span class="chip me">Your style ${e.personal.score}</span>`);
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

function openSheet(html) {
  $('#sheetBody').innerHTML = html;
  $('#sheet').classList.remove('hidden');
  document.body.classList.add('noscroll');
  $('.sheet-panel').scrollTop = 0;
}
function closeSheet() {
  $('#sheet').classList.add('hidden');
  document.body.classList.remove('noscroll');
}

/* ================= router ================= */

function setTab(t) { tab = t; closeSheet(); render(); window.scrollTo(0, 0); }

function render() {
  if (map) { map.remove(); map = null; }
  $$('.tabbar button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  const v = $('#view');
  ({ forecast: renderForecast, spots: renderSpots, plans: renderPlans, coach: renderCoach, settings: renderSettings })[tab](v);
}

/* ================= forecast ================= */

function emptySpots(v) {
  v.innerHTML = `<div class="empty">
    <h1>Know before the alarm goes off.</h1>
    <p>Add the spots you shoot. Tidelight scores every sunrise and sunset for the next 7 days using sky, tide and sea, tells you when to leave, and learns which conditions you love.</p>
    <div class="row"><button class="btn primary" id="goAdd">Add your first spot</button></div>
  </div>`;
  $('#goAdd').onclick = () => { tab = 'spots'; render(); openSpotForm(); };
}

async function renderForecast(v) {
  const st = S();
  if (!st.spots.length) return emptySpots(v);
  v.innerHTML = `<p class="loading">Reading the sky for ${st.spots.length} spot${st.spots.length > 1 ? 's' : ''}…</p>`;
  const failed = await ensureForecasts();
  if (tab !== 'forecast') return;

  const evs = allEvents();
  const safe = evs.filter(e => !e.unsafe);
  const best = [...safe].sort((a, b) => b.score - a.score)[0];

  let list = '';
  if (forecastSort === 'best') {
    list = [...evs].sort((a, b) => b.score - a.score).slice(0, 25)
      .map(e => eventRow(e, `<span>${fmtDay(e.t, e.offset)}</span>`)).join('');
  } else {
    let lastDay = '';
    for (const e of evs) {
      const k = dayKey(e.t, e.offset);
      if (k !== lastDay) { list += `<div class="day-label">${fmtDay(e.t, e.offset)}</div>`; lastDay = k; }
      list += eventRow(e);
    }
  }

  v.innerHTML = `
    <section class="hero">
      ${best ? `
        <h1>${best.score >= 75 ? 'Worth the alarm' : best.score >= 50 ? 'Your best chance this week' : 'A quiet week for light'}</h1>
        <p class="muted">${fmtDay(best.t, best.offset)}, ${best.type} at ${esc(best.spot.name)}</p>
        <button class="hero-card" data-ev="${esc(best.key)}">
          ${horizon(best, true)}
          <div class="ev-main">
            <div class="ev-title">${verdict(best)}</div>
            <div class="ev-sub"><span><strong>${cap(best.type)} ${fmtTime(best.t, best.offset)}</strong></span><span>Leave ${fmtTime(best.leave, best.offset)}</span></div>
            <div class="chips">${chips(best)}</div>
          </div>
        </button>` : `<h1>No forecasts yet</h1>`}
    </section>
    ${failed.length ? `<div class="alert danger">Couldn't load: ${esc(failed.join(', '))}. Check your connection and tap refresh.</div>` : ''}
    ${!st.settings.home ? `<div class="alert info">Set your home location in Settings to get drive-aware leave times.</div>` : ''}
    <div class="segmented" role="group" aria-label="Sort">
      <button data-sort="time" class="${forecastSort === 'time' ? 'on' : ''}">By day</button>
      <button data-sort="best" class="${forecastSort === 'best' ? 'on' : ''}">Best first</button>
    </div>
    <div>${list || '<p class="muted">No upcoming events. Check each spot has sunrise or sunset turned on.</p>'}</div>
    <p class="small muted" style="margin-top:24px">Forecasts are estimates. Always check official marine and weather warnings before heading out.</p>`;

  $$('[data-sort]', v).forEach(b => b.onclick = () => { forecastSort = b.dataset.sort; renderForecast(v); });
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
  tl.push({ t: e.t, label: cap(e.type), cls: 'key' });
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
  ];

  openSheet(`
    <div class="sheet-head">
      ${horizon(e, true)}
      <div><h2>${esc(e.spot.name)}</h2><div class="muted">${fmtDay(e.t, o)}, ${e.type} at ${fmtTime(e.t, o)}</div><div><strong>${verdict(e)}</strong></div></div>
    </div>
    ${e.unsafe ? `<div class="alert danger">Forecast waves (${h.wave.toFixed(1)} m) are above the ${e.spot.maxSwell} m limit you set for this spot. Rock shelves and jetties can be deadly in these conditions.</div>` : ''}
    <ul class="timeline">${tl.map(x => `<li class="${x.cls || ''}"><time>${fmtTime(x.t, o)}</time><span>${x.label}</span></li>`).join('')}</ul>

    <h3>Briefing</h3>
    <div class="brief" id="briefText">${esc(briefing(e))}</div>
    <div class="row"><button class="btn ghost" id="aiBriefBtn">Ask the AI coach</button></div>

    <h3>Why this score</h3>
    <ul class="factors">${e.factors.map(f => `<li class="${f.k}">${esc(f.t)}</li>`).join('') || '<li>Nothing stands out either way.</li>'}</ul>
    <p class="small muted" style="margin-top:10px">${e.personal
      ? `Blended score: ${e.base} from conditions, ${e.personal.score} from your ${e.personal.n} keepers (${Math.round(e.personal.weight * 100)}% weight).`
      : `Add ${MIN_KEEPERS}+ keeper photos in Coach and this score will start reflecting your taste.`}</p>

    <h3>Conditions at ${e.type}</h3>
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

function renderPlans(v) {
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
    <h1>Plans</h1>
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
    <h1>Spots</h1>
    <div id="map" role="application" aria-label="Map of your spots. Tap to add a spot."></div>
    <p class="small muted" style="margin-top:8px">Tap anywhere on the map to add a spot there.</p>
    <div class="row">
      <button class="btn primary" id="addSpot">Add spot</button>
      <button class="btn" id="hereSpot">Add where I am</button>
    </div>
    <section>
      ${st.spots.length ? st.spots.map(s => `
        <button class="spot-row" data-spot="${s.id}">
          <div><div class="ev-title">${esc(s.name)}</div>
          <div class="ev-sub"><span>${(s.events || []).map(cap).join(' and ') || 'No events'}</span>${s.coastal ? `<span>Coastal, ${s.tide} tide</span>` : '<span>Inland</span>'}</div></div>
          <span class="muted" aria-hidden="true">›</span>
        </button>`).join('') : '<p class="muted">No spots yet. Your favourite locations go here.</p>'}
    </section>`;

  $('#addSpot').onclick = () => openSpotForm();
  $('#hereSpot').onclick = async () => {
    try { const p = await getPosition(); openSpotForm(p); } catch (e) { toast(e.message, 4000); }
  };
  $$('[data-spot]', v).forEach(b => b.onclick = () => openSpotDetail(b.dataset.spot));

  if (window.L) {
    const home = st.settings.home;
    map = window.L.map('map', { zoomControl: false, attributionControl: true })
      .setView(home ? [home.lat, home.lon] : [10, 0], home ? 9 : 2);
    window.L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 18, attribution: '&copy; OpenStreetMap contributors',
    }).addTo(map);
    const pts = [];
    st.spots.forEach(s => {
      window.L.circleMarker([s.lat, s.lon], { radius: 9, color: '#F2A65A', weight: 2, fillColor: '#F2A65A', fillOpacity: 0.85 })
        .addTo(map).bindTooltip(s.name).on('click', ev => { window.L.DomEvent.stopPropagation(ev); openSpotDetail(s.id); });
      pts.push([s.lat, s.lon]);
    });
    if (home) window.L.circleMarker([home.lat, home.lon], { radius: 6, color: '#6FC3B8', fillOpacity: 1 }).addTo(map).bindTooltip('Home');
    if (pts.length > 1) map.fitBounds(pts, { padding: [30, 30], maxZoom: 12 });
    else if (pts.length === 1) map.setView(pts[0], 11);
    map.on('click', ev => openSpotForm({ lat: ev.latlng.lat, lon: ev.latlng.lng }));
    setTimeout(() => map && map.invalidateSize(), 60);
  }
}

function openSpotForm(prefill = {}, existing = null) {
  const s = existing || {
    name: '', lat: prefill.lat ?? '', lon: prefill.lon ?? '', events: ['sunrise', 'sunset'],
    coastal: true, tide: 'any', maxSwell: 1.5, driveMin: '', facing: '', notes: '',
  };
  const num = x => (x === '' || x == null ? '' : Number(x).toFixed(5));
  openSheet(`
    <h2>${existing ? 'Edit spot' : 'New spot'}</h2>
    <form id="spotForm" class="form" novalidate>
      <label>Name<input name="name" required value="${esc(s.name)}" placeholder="e.g. North jetty"></label>
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
      <label class="check"><input type="checkbox" name="coastal" ${s.coastal ? 'checked' : ''}> Coastal spot (use tide and wave data)</label>
      <div class="two">
        <label>Best tide<select name="tide">
          ${['any', 'low', 'mid', 'high'].map(t => `<option value="${t}" ${s.tide === t ? 'selected' : ''}>${cap(t)}</option>`).join('')}
        </select></label>
        <label>Max safe waves (m)<input name="maxSwell" inputmode="decimal" value="${s.maxSwell ?? ''}"></label>
      </div>
      <div class="two">
        <label>Drive time (min)<span class="hint">Blank = estimate from home</span><input name="driveMin" inputmode="numeric" value="${s.driveMin ?? ''}"></label>
        <label>Facing (°)<span class="hint">Your composition's compass bearing, optional</span><input name="facing" inputmode="numeric" value="${s.facing ?? ''}"></label>
      </div>
      <label>Notes<textarea name="notes" placeholder="Access, parking, hazards, compositions">${esc(s.notes || '')}</textarea></label>
      <div class="row">
        <button type="submit" class="btn primary">${existing ? 'Save spot' : 'Add spot'}</button>
        ${existing ? '<button type="button" class="btn danger" id="delSpot">Delete spot</button>' : ''}
      </div>
    </form>`);

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
      maxSwell: f.get('maxSwell') ? parseFloat(f.get('maxSwell')) : null,
      driveMin: f.get('driveMin') ? parseInt(f.get('driveMin'), 10) : '',
      facing: f.get('facing') !== '' ? parseFloat(f.get('facing')) : '',
      notes: String(f.get('notes') || ''),
    };
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
  $('#sheetBody').innerHTML = `
    <h2>${esc(s.name)}</h2>
    <p class="muted small">${s.lat.toFixed(4)}, ${s.lon.toFixed(4)}${s.coastal && !data.hasMarine ? '. No tide or wave data at this exact point; try moving the pin slightly offshore.' : ''}</p>
    ${s.notes ? `<p>${esc(s.notes)}</p>` : ''}
    <div class="row">
      <button class="btn" id="editSpot">Edit spot</button>
      <a class="btn" target="_blank" rel="noopener" href="https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lon}">Directions</a>
    </div>
    <div>${evs.map(e => eventRow(e, `<span>${fmtDay(e.t, e.offset)}</span>`)).join('') || '<p class="muted">No upcoming events.</p>'}</div>`;
  $('#editSpot').onclick = () => openSpotForm({}, s);
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
    <h1>Coach</h1>
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
    ${ranked.length ? ranked.map(({ e, m }) => eventRow(e, `<span>${fmtDay(e.t, e.offset)}</span><span class="match">${m}% match</span>`)).join('') : '<p class="muted">Add some spots first so there are forecasts to match against.</p>'}`;
}

/* ================= settings ================= */

function renderSettings(v) {
  const st = S(), s = st.settings;
  v.innerHTML = `
    <h1>Settings</h1>
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

    <p class="small muted">Weather, tide and sea data: Open-Meteo (CC BY 4.0). Maps: OpenStreetMap. Tide heights are modelled and can differ from official tide tables; check local warnings before heading out.</p>`;

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
  $('#exportBtn').onclick = () => downloadFile(`tidelight-backup-${new Date().toISOString().slice(0, 10)}.json`, exportData(), 'application/json');
  $('#importFile').onchange = async ev => {
    const file = ev.target.files[0];
    if (!file) return;
    try { importData(await file.text()); for (const k in forecasts) delete forecasts[k]; toast('Backup restored'); render(); }
    catch (e) { toast(e.message, 5000); }
  };
  $('#resetBtn').onclick = () => {
    if (!confirm('Delete all spots, plans, keepers and settings from this browser?')) return;
    resetAll(); for (const k in forecasts) delete forecasts[k];
    toast('All data deleted'); render();
  };
}

/* ================= boot ================= */

document.addEventListener('click', ev => {
  const evBtn = ev.target.closest('[data-ev]');
  if (evBtn) { openEvent(evBtn.dataset.ev); return; }
  if (ev.target.closest('[data-close]')) closeSheet();
});
document.addEventListener('keydown', ev => { if (ev.key === 'Escape') closeSheet(); });
$$('.tabbar button').forEach(b => b.onclick = () => setTab(b.dataset.tab));
$('#refreshBtn').onclick = async () => {
  const b = $('#refreshBtn');
  b.classList.add('spin');
  const failed = await loadForecasts(true);
  b.classList.remove('spin');
  toast(failed.length ? `Some spots failed: ${failed.join(', ')}` : 'Forecasts updated');
  if (tab === 'forecast' || tab === 'spots') render();
};

render();
