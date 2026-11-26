// Tidelight: The Spots tab: your spot library, the map, search and the spot form.
import { fmtWeekday, fmtDayDate, esc, cap, toast, uid, dayKey } from './util.js?v=7.3';
import { coverUrl, deletePhotos, photoUrl, addPhotoFile } from './photos.js?v=7.3';
import { huntsOf, HUNT_LABEL, HUNT_ORDER } from './hunts.js?v=7.3';
import { searchPlaces, fetchSpotForecast } from './api.js?v=7.3';
import { DIFFICULTIES, evaluateSpot, spotFloor } from './scoring.js?v=7.3';
import { readExif } from './ai.js?v=7.3';
import { update } from './storage.js?v=7.3';
import { SESSION_TYPES, SUN_ICON, TYPE_NAME, band, huntPhrase, nextDays, sessionWhen, skeleton, spotTile } from './forecast.js?v=7.3';
import { $, $$, S, closeSheet, ensureForecasts, forecasts, hikeSummary, indexEvents, openSheet, sessionName, ui, unsure } from './core.js?v=7.3';
import { openScout } from './tools.js?v=7.3';
import { render } from './app.js?v=7.3';
import { alignmentText, openNow } from './field.js?v=7.3';
import { openTideWindows, seasonView, wireSeason } from './planners.js?v=7.3';

/* ================= spots ================= */

export let spotsShowMap = false;
// Spots: where to go. Every spot against the next 7 days (best session per day), then your spot library.
export function spotGrid(evs, st, offset) {
  const now = Date.now() / 1000;
  const bestOf = (spId, i) => evs.filter(e => e.spot.id === spId && e.dayIdx === i).sort((a, b) => b.score - a.score)[0];
  const weekBest = sp => Math.max(-1, ...evs.filter(e => e.spot.id === sp.id).map(e => e.score));
  const spots = [...st.spots].sort((a, b) => weekBest(b) - weekBest(a));
  const days = [0, 1, 2, 3, 4, 5, 6].map(i => {
    const t = now + i * 86400;
    return { i, label: i === 0 ? 'Today' : i === 1 ? 'Tmrw' : fmtWeekday(t, offset).slice(0, 3), date: fmtDayDate(t, offset).split(' ')[1] || '' };
  });
  return `<div class="sg-wrap"><table class="sg">
    <caption class="sr-only">Best session score for each spot over the next 7 days</caption>
    <thead><tr>${days.map(d => `<th scope="col"><span>${d.label}</span><small class="num">${esc(d.date)}</small></th>`).join('')}</tr></thead>
    <tbody>${spots.map(sp => `<tr class="sg-name-row"><th colspan="7" scope="colgroup"><button class="sg-spot" data-spot="${sp.id}">${esc(sp.name)}</button></th></tr>
      <tr>${days.map(d => {
        const e = bestOf(sp.id, d.i);
        if (!e) return '<td><span class="sg-none" aria-label="No session">–</span></td>';
        return `<td><button class="sg-cell ${band(e.score)} ${unsure(e) ? 'unsure' : ''} ${S().plans.some(p => p.key === e.key) ? 'planned' : ''}" data-ev="${esc(e.key)}" aria-label="${esc(sp.name)}, ${esc(sessionName(e))}, score ${e.score}${unsure(e) ? ', models disagree' : ''}${e.access && !e.access.inside ? ', tide blocks access' : ''}${S().plans.some(p => p.key === e.key) ? ', planned' : ''}">
          <b class="num">${e.score}</b><span class="sg-type" aria-hidden="true">${SUN_ICON[e.type]}</span>${e.access && !e.access.inside ? '<i class="mx-tide" aria-hidden="true"></i>' : ''}</button></td>`;
      }).join('')}
    </tr>`).join('')}</tbody>
  </table></div>
  <p class="sg-legend"><span><i class="b4"></i>75+ go</span><span><i class="b3"></i>50–74 maybe</span><span><i class="b1"></i>Under 50 skip</span><span><i class="plan-key"></i>Planned</span>${evs.some(unsure) ? '<span><i class="unsure-key"></i>Models disagree</span>' : ''}${evs.some(e => e.access && !e.access.inside) ? '<span><i class="tide-key"></i>Tide blocks access</span>' : ''}</p>`;
}
export function spotRow(sp) {
  const hk = hikeSummary(sp);
  return `<button class="lib-row" data-spot="${sp.id}">
    ${coverUrl(sp) ? `<img class="lib-img" src="${coverUrl(sp)}" alt="">` : spotTile(sp)}
    <span class="lib-text"><span class="lib-name">${esc(sp.name)}</span><span class="lib-sub">${esc([huntsOf(sp).map(k => HUNT_LABEL[k]).filter(Boolean).join(', '), sp.coastal ? 'coastal' : '', hk.replace('Hike: ', 'hike ')].filter(Boolean).join(' · '))}</span></span>
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>
  </button>`;
}
export async function renderSpots(v) {
  if (ui.map) { ui.map.remove(); ui.map = null; }
  const st = S();
  v.innerHTML = `
    <h1 class="page-title">Spots</h1>
    ${st.spots.length ? `<p class="page-lede">Your spots against the next 7 days. Each square is that day's best session; tap it for the briefing.</p>
    <section id="spotGrid" aria-live="off">${skeleton('week', 'Scoring your spots…')}</section>` : '<p class="page-lede">Add the places you shoot. Tidelight scores every session there for the next 7 days.</p>'}
    <h2 class="sec-title">${st.spots.length ? 'Your spots' : 'Add a spot'}</h2>
    <form class="search" id="placeSearch" role="search">
      <input type="search" id="placeQ" placeholder="Beach, falls or lookout" autocomplete="off" enterkeyhint="search" aria-label="Search for a place to add as a spot">
      <button class="btn primary" type="submit">Search</button>
    </form>
    <div id="placeResults" class="results" hidden></div>
    <div class="spot-actions">
      <button class="btn" id="scoutBtn">Add where I'm standing</button>
      <button class="btn ${spotsShowMap ? 'primary' : ''}" id="mapToggle" aria-pressed="${spotsShowMap}">${spotsShowMap ? 'Hide map' : 'Pick on a map'}</button>
    </div>
    ${spotsShowMap ? `<div id="map" role="application" aria-label="Map of your spots. Tap to add a spot."></div>
      <p class="small muted map-hint">Tap anywhere on the map to add a spot there.</p>` : ''}
    <div class="lib">${st.spots.map(spotRow).join('')}</div>
    <button class="link-btn" id="addSpot">Enter coordinates instead</button>`;

  $('#addSpot').onclick = () => openSpotForm();
  ui.found = null;
  $('#placeSearch').onsubmit = ev => { ev.preventDefault(); runPlaceSearch(); };
  $('#scoutBtn').onclick = () => openScout();
  $('#mapToggle').onclick = () => { spotsShowMap = !spotsShowMap; renderSpots(v); };
  $$('.lib [data-spot]', v).forEach(b => b.onclick = () => openSpotDetail(b.dataset.spot));
  if (spotsShowMap) initSpotsMap(st);

  if (!st.spots.length) return;
  await ensureForecasts();
  if (ui.tab !== 'spots' || !$('#spotGrid')) return;
  const evs = nextDays(7);
  indexEvents(evs);
  $('#spotGrid').innerHTML = spotGrid(evs, st, evs[0]?.offset ?? -new Date().getTimezoneOffset() * 60);
  $$('#spotGrid [data-spot]').forEach(b => b.onclick = () => openSpotDetail(b.dataset.spot));
}
export function initSpotsMap(st) {
  if (!window.L || !$('#map')) return;
  const home = st.settings.home;
  ui.map = window.L.map('map', { zoomControl: false, attributionControl: true })
    .setView(home ? [home.lat, home.lon] : [10, 0], home ? 9 : 2);
  window.L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, className: 'base-tiles', attribution: '&copy; OpenStreetMap contributors',
  }).addTo(ui.map);
  const pts = [];
  st.spots.forEach(s => {
    window.L.circleMarker([s.lat, s.lon], { radius: 9, color: '#0F1111', weight: 2, fillColor: '#D9A066', fillOpacity: 1 })
      .addTo(ui.map).bindTooltip(s.name).on('click', ev => { window.L.DomEvent.stopPropagation(ev); openSpotDetail(s.id); });
    pts.push([s.lat, s.lon]);
  });
  if (home) window.L.circleMarker([home.lat, home.lon], { radius: 6, color: '#ECE8E1', fillColor: '#ECE8E1', fillOpacity: 1 }).addTo(ui.map).bindTooltip('Home');
  if (pts.length > 1) ui.map.fitBounds(pts, { padding: [30, 30], maxZoom: 12 });
  else if (pts.length === 1) ui.map.setView(pts[0], 11);
  ui.map.on('click', ev => {
    // Fine-tuning near a searched place keeps its name.
    const near = ui.found && Math.abs(ui.found.lat - ev.latlng.lat) < 0.03 && Math.abs(ui.found.lon - ev.latlng.lng) < 0.03;
    openSpotForm({ lat: ev.latlng.lat, lon: ev.latlng.lng, name: near ? ui.found.name : '' });
  });
  setTimeout(() => ui.map && ui.map.invalidateSize(), 60);
}
export let lastSearchAt = 0;
export async function runPlaceSearch() {
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
export function showFoundPlace(r) {
  if (window.L && !ui.map && ui.tab === 'spots') {
    spotsShowMap = true;
    renderSpots($('#view'));
    if (ui.map) return showFoundPlace(r);
  }
  if (!ui.map || !window.L) { openSpotForm({ lat: r.lat, lon: r.lon, name: r.name }); return; }
  if (ui.found?.marker) ui.found.marker.remove();
  ui.map.setView([r.lat, r.lon], 15);
  const marker = window.L.circleMarker([r.lat, r.lon], { radius: 11, color: '#ECE8E1', weight: 3, fillColor: '#D9A066', fillOpacity: 1 }).addTo(ui.map);
  marker.bindPopup(`<div class="pop">
      <strong>${esc(r.name || 'Dropped pin')}</strong>
      <button type="button" class="btn primary small-btn" data-add-here>Add spot here</button>
      <span>Or tap the map nearby to place it exactly.</span>
    </div>`, { closeButton: false, minWidth: 200 }).openPopup();
  ui.found = { name: r.name, lat: r.lat, lon: r.lon, marker };
  $('#map').scrollIntoView({ behavior: 'smooth', block: 'center' });
}
export function openSpotForm(prefill = {}, existing = null) {
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
        <label>Light at this spot<span class="hint">Does a clear sky work here, or does it need cloud to catch colour?</span><select name="cleanLight">
          <option value="" ${!s.cleanLight ? 'selected' : ''}>Learn from my ratings</option>
          <option value="no" ${s.cleanLight === 'no' ? 'selected' : ''}>Needs cloud for colour</option>
          <option value="yes" ${s.cleanLight === 'yes' ? 'selected' : ''}>Shines in clean light too</option>
        </select></label>
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
  ui.onSheetClose = () => { if (!saved) deletePhotos([...added]); };

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
      cleanLight: f.get('cleanLight') || '',
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
export async function openSpotDetail(id) {
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
        return e ? `<button class="mx-cell ${band(e.score)} ${unsure(e) ? 'unsure' : ''}" style="--n:${ti + di}" data-ev="${esc(e.key)}" aria-label="${TYPE_NAME[type]} ${d.label} ${d.date}, score ${e.score}">${e.score}${e.access && !e.access.inside ? '<i class="mx-tide" aria-hidden="true"></i>' : ''}</button>` : '<span class="mx-none" aria-hidden="true">–</span>';
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

    ${(() => {
      const fl = spotFloor(s, S().keepers, S().settings);
      if (fl.floor <= 0.35 && fl.source !== 'yours') return '';
      return `<p class="bf-note crew">${fl.source === 'yours'
        ? (s.cleanLight === 'yes' ? 'You\'ve set this spot as shining in clean light, so clear skies still score well here.' : 'You\'ve set this spot as needing cloud for colour.')
        : `Shines in clean light: learned from ${fl.k} clear-sky keepers here, so clear skies still score well.`}</p>`;
    })()}
    ${alignmentText(s) || s.notes ? `<h3 class="sec">About this spot</h3>
      ${alignmentText(s) ? `<p class="align-line">${esc(alignmentText(s))}</p>` : ''}
      ${s.notes ? `<p class="bf-brief">${esc(s.notes)}</p>` : ''}` : ''}
    ${seasonView(s)}
    <p class="small muted">${s.lat.toFixed(4)}, ${s.lon.toFixed(4)}${s.coastal && !data.hasMarine ? '. No tide or wave data at this exact point; try moving the pin slightly offshore.' : ''}</p>
    <div class="bf-quiet">
      <button class="link-btn" id="spotHourly">Hourly forecast</button>
      ${s.coastal && data.hasMarine ? '<button class="link-btn" id="spotTide">Tide windows</button>' : ''}
      <a class="link-btn" target="_blank" rel="noopener" href="https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lon}">Directions</a>
    </div>
    <div class="sheet-actions">
      ${best ? `<button class="btn primary" data-ev="${esc(best.key)}">Best session</button>` : ''}
      <button class="btn" id="editSpot">Edit spot</button>
    </div>`;
  $('#editSpot').onclick = () => openSpotForm({}, s);
  $('#spotHourly').onclick = () => openNow({ kind: 'spot', id: s.id, lat: s.lat, lon: s.lon, name: s.name });
  if ($('#spotTide')) $('#spotTide').onclick = () => openTideWindows(s.id);
  wireSeason(s);
  $$('[data-show]').forEach(b => b.onclick = () => {
    $('#spotBanner').src = photoUrl(b.dataset.show);
    $$('[data-show]').forEach(x => x.classList.toggle('on', x === b));
  });
}
