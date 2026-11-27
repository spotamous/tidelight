// Tidelight: Right here and Anywhere: a forecast where you stand or any place you pick, and the place picker.
import { evaluateSpot } from './scoring.js?v=7.4.1';
import { dayKey, getPosition, esc, haversineKm, fmtDayDate, fmtWeekday, cap, toast, uid } from './util.js?v=7.4.1';
import { FORECAST_TTL, placeName, coastalCheck, fetchSpotForecast, searchPlaces } from './api.js?v=7.4.1';
import { HUNT_LABEL, HUNT_ORDER, DAY_HUNTS } from './hunts.js?v=7.4.1';
import { update } from './storage.js?v=7.4.1';
import { $, $$, S, closeSheet, forecasts, indexEvents, openSheet, sessionName, ui } from './core.js?v=7.4.1';
import { TYPE_NAME, huntPhrase, runCounts, scoreTone, sessionWhen, shortWhen, skeleton, skyClass, skyGlyph, skyOf, toneDot, whyLine } from './forecast.js?v=7.4.1';
import { openCompassHere } from './tools.js?v=7.4.1';
import { render } from './app.js?v=7.4.1';
import { openSpotDetail } from './spots.js?v=7.4.1';

/* ================= right here ================= */
// Scores and the week's sessions for wherever you're standing, without saving it as a spot.
// Handy when travelling or on a random shoot. Nothing here touches your spots, plans or alerts.
export const PIN_ICON = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 21s-6.5-5.6-6.5-11A6.5 6.5 0 0 1 18.5 10c0 5.4-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.4"/></svg>';
export const HERE_HUNTS = ['colour', 'fog', 'astro'];
export let here = null;   // { lat, lon, name, coastal, hunts, data, at, day, error, mode: 'gps' | 'place' }
export const hereIsPlace = () => here?.mode === 'place';
export function hereSpot() {
  return { id: 'here', here: true, hereMode: here.mode || 'gps', name: hereIsPlace() ? here.name || 'Pinned place' : here.name ? `Near ${here.name}` : 'Right here', lat: here.lat, lon: here.lon,
    hunts: here.hunts, events: ['sunrise', 'sunset'], coastal: !!here.coastal, tide: 'any', facing: '', fogMode: 'in', driveMin: '', notes: '', photos: [] };
}
// The sessions for the next 7 days, tagged with their day (0 today). Leave times assume you're already here.
export function hereEvents() {
  const st = S();
  const now = Date.now() / 1000;
  const out = [];
  // Right here: you're already there. Somewhere else: leave times are worked out from home, like your spots.
  for (const e of evaluateSpot(hereSpot(), here.data, st.keepers, hereIsPlace() ? st.settings : { ...st.settings, home: null })) {
    const k = dayKey(e.dayT ?? e.t, e.offset);
    for (let i = 0; i < 7; i++) if (dayKey(now + i * 86400, e.offset) === k) { out.push({ ...e, dayIdx: i }); break; }
  }
  indexEvents(out);
  return out;
}
export async function openHere() {
  openSheet(`<p class="eyebrow here-eyebrow">${PIN_ICON}Right here</p><h2 class="bf-name">Finding you…</h2>${skeleton('here', 'Getting your location')}`);
  let pos;
  try { pos = await getPosition(); }
  catch (err) {
    if (!$('#sheetBody .here-eyebrow')) return;
    openSheet(`<p class="eyebrow here-eyebrow">${PIN_ICON}Right here</p><h2 class="bf-name">Couldn't find you</h2>
      <p>${esc(err.message)}</p><p class="small muted">On iPhone: Settings, Privacy & Security, Location Services, then allow it for Safari Websites (or Tidelight).</p>
      <div class="sheet-actions"><div class="row"><button class="btn primary" id="hereRetry">Try again</button><button class="btn" id="hereElse">Choose a place instead</button></div></div>`);
    $('#hereRetry').onclick = () => openHere();
    $('#hereElse').onclick = () => chooseHerePlace();
    return;
  }
  if (!$('#sheetBody .here-eyebrow')) return;   // closed while we waited
  // Same place (within a kilometre) and fetched in the last half hour: reuse it.
  if (here?.data && !hereIsPlace() && haversineKm(here, pos) < 1 && Date.now() - here.at < FORECAST_TTL) return drawHere();
  const hunts = here?.hunts || S().settings.hereHunts || HERE_HUNTS;
  here = { lat: pos.lat, lon: pos.lon, name: null, coastal: false, hunts, data: null, at: 0, day: null, mode: 'gps' };
  $('#sheetBody .sk-status') && ($('#sheetBody .sk-status').textContent = 'Reading the sky here…');
  const [name, coastal] = await Promise.all([placeName(pos.lat, pos.lon).catch(() => null), coastalCheck(pos.lat, pos.lon)]);
  Object.assign(here, { name, coastal });
  await loadHere();
}
// The same, for a place you search for or pin on the map: plan a trip before you go.
export async function openHereAt(place) {
  const hunts = here?.hunts || S().settings.hereHunts || HERE_HUNTS;
  here = { lat: place.lat, lon: place.lon, name: place.name || null, coastal: false, hunts, data: null, at: 0, day: null, mode: 'place' };
  openSheet(`<p class="eyebrow here-eyebrow">${PIN_ICON}Anywhere</p><h2 class="bf-name">${esc(place.name || 'Pinned place')}</h2>${skeleton('here', 'Reading the sky there…')}`);
  const [name, coastal] = await Promise.all([place.name ? Promise.resolve(place.name) : placeName(place.lat, place.lon).catch(() => null), coastalCheck(place.lat, place.lon)]);
  Object.assign(here, { name, coastal });
  await loadHere();
}
export function chooseHerePlace() {
  pickPlace({
    title: 'Somewhere else',
    note: "Search for a place or tap the map. You'll get its scores and week, with leave times from home.",
    start: here ? { lat: here.lat, lon: here.lon } : S().settings.home,
    onPick: openHereAt,
    onBack: here?.data ? () => drawHere() : null,
  });
}
export async function loadHere() {
  if (here.coastal === null) here.coastal = await coastalCheck(here.lat, here.lon);
  try {
    here.data = await fetchSpotForecast(hereSpot());
    here.at = Date.now(); here.error = null;
  } catch (err) { here.error = err.message; }
  if ($('#sheetBody .here-eyebrow')) drawHere();
}
export function drawHere() {
  if (!here) return openHere();
  const away = hereIsPlace() && S().settings.home ? haversineKm(S().settings.home, here) : null;
  const head = `<p class="eyebrow here-eyebrow">${PIN_ICON}${hereIsPlace() ? 'Anywhere' : 'Right here'}<span>Not a saved spot</span></p>
    <h2 class="bf-name">${esc(hereSpot().name)}</h2>
    <p class="small muted here-where">${here.lat.toFixed(4)}, ${here.lon.toFixed(4)}${away != null ? `, ${away < 10 ? away.toFixed(1) : Math.round(away)} km from home` : ''}. ${here.coastal ? 'On the coast, so tides and waves count.' : here.coastal === null ? "Couldn't check for the coast without a connection, so tides aren't counted." : 'Inland.'}</p>
    <div class="here-switch"><button class="tool-chip" id="hereElse">Somewhere else</button><button class="tool-chip" id="hereAgain">${hereIsPlace() ? 'Use my location' : 'Update location'}</button></div>`;
  if (!here.data) {
    openSheet(`${head}<div class="alert danger"><p>Couldn't load the forecast here. ${esc(here.error || '')}</p></div>
      <div class="sheet-actions"><button class="btn primary" id="hereRetry">Try again</button></div>`);
    $('#hereRetry').onclick = () => { openSheet(`${head}${skeleton('here', 'Reading the sky here…')}`); loadHere(); };
    $('#hereElse').onclick = () => chooseHerePlace();
    $('#hereAgain').onclick = () => { here.mode = 'gps'; openHere(); };
    return;
  }
  const evs = hereEvents();
  const now = Date.now() / 1000;
  const offset = here.data.offset ?? evs[0]?.offset ?? 0;
  const soon = evs.filter(e => e.dayIdx <= 1 && (e.end ?? e.t) > now).sort((a, b) => b.score - a.score)[0];
  if (here.day == null) here.day = soon ? soon.dayIdx : 0;
  const days = [];
  for (let i = 0; i < 7; i++) {
    const t = now + i * 86400;
    const best = evs.filter(e => e.dayIdx === i).sort((a, b) => b.score - a.score)[0];
    const date = fmtDayDate(t, offset).split(' ')[1] || '';
    const label = i === 0 ? 'Today' : i === 1 ? 'Tmrw' : fmtWeekday(t, offset).slice(0, 3);
    days.push(`<button class="wk-d ${i === here.day ? 'on' : ''}" data-hday="${i}" aria-pressed="${i === here.day}" aria-label="${i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : esc(fmtWeekday(t, offset))}${best ? `, best ${best.score}` : ', no sessions'}">
      ${i === here.day ? '<span class="wk-hl" aria-hidden="true"></span>' : ''}<span class="wk-l">${label}<small class="num">${esc(date)}</small></span>
      <span class="wk-sky ${best ? `${skyClass(best)} ${scoreTone(best.score)}` : 'none'}" ${best ? `style="background:${skyOf(best)}"` : ''} aria-hidden="true">${best ? skyGlyph(best) : ''}</span>
      <span class="wk-s num ${best && best.score >= 75 ? 'go' : ''}" aria-hidden="true">${best ? `${toneDot(best.score)}${best.score}` : '–'}</span></button>`);
  }
  const dayEvs = evs.filter(e => e.dayIdx === here.day).sort((a, b) => a.t - b.t);
  const dayWord = here.day === 0 ? 'Today' : here.day === 1 ? 'Tomorrow' : fmtWeekday(now + here.day * 86400, offset);
  const row = (e, i) => `<button class="other-row" style="--i:${i}" data-ev="${esc(e.key)}">
      <span class="other-sky ${skyClass(e)} ${scoreTone(e.score)}" style="background:${skyOf(e)}"><b class="num">${e.score}</b></span>
      <span class="other-name">${TYPE_NAME[e.type]}, ${shortWhen(e)}<small>${esc(huntPhrase(e))}. ${esc(whyLine(e))}</small></span>
      <span class="other-verdict ${e.score >= 75 ? 'go' : ''}">${toneDot(e.score)}${e.score >= 75 ? 'Go' : e.score >= 50 ? 'Maybe' : 'Skip'}</span></button>`;
  openSheet(`${head}
    ${soon ? `<section class="here-best ${skyClass(soon)}" style="--sky:${skyOf(soon)}">
      <div><p class="here-best-k">Best in the next two days</p><p class="here-best-w">${esc(cap(sessionName(soon)))}, ${sessionWhen(soon)}</p><p class="here-best-v">${esc(huntPhrase(soon))}</p></div>
      <p class="here-best-s num" data-count="${soon.score}">${soon.score}</p></section>` : ''}
    <nav class="week here-week" aria-label="Choose a day">${days.join('')}</nav>
    <h3 class="sec">${esc(dayWord)}</h3>
    ${dayEvs.length ? `<div class="here-list">${dayEvs.map(row).join('')}</div>` : `<p class="small muted">${here.day === 0 ? "Today's light is done here." : 'No sessions this day.'}</p>`}
    <details class="here-hunts">
      <summary>Scoring for: ${here.hunts.map(k => HUNT_LABEL[k]).join(', ')}</summary>
      <p class="small muted">Tap to change what to score here. Tidelight remembers your choice for next time.</p>
      <div class="chip-row">${HUNT_ORDER.map(k => `<button class="chip-btn ${here.hunts.includes(k) ? 'on' : ''}" data-hhunt="${k}" aria-pressed="${here.hunts.includes(k)}">${HUNT_LABEL[k]}</button>`).join('')}
        <button class="chip-btn ${here.coastal ? 'on' : ''}" data-hcoast aria-pressed="${!!here.coastal}">Coastal</button></div>
    </details>
    <p class="small muted">General rules plus your keepers. It hasn't learned this place yet, and doesn't know which way you're facing, so the horizon is checked towards the sunrise and sunset.${hereIsPlace() ? ' Leave times are from home.' : ''}</p>
    <div class="sheet-actions"><div class="row"><button class="btn primary" id="hereSave">Save as a spot</button><button class="btn" id="hereCompass">Compass</button></div></div>`);
  runCounts($('#sheetBody'));
  $$('#sheetBody [data-hday]').forEach(b => b.onclick = () => { here.day = Number(b.dataset.hday); const y = $('#sheetBody').scrollTop; drawHere(); $('#sheetBody').scrollTop = y; });
  $$('#sheetBody [data-hhunt]').forEach(b => b.onclick = () => {
    const k = b.dataset.hhunt;
    const next = here.hunts.includes(k) ? here.hunts.filter(x => x !== k) : HUNT_ORDER.filter(x => x === k || here.hunts.includes(x));
    if (!next.length) return toast('Pick at least one thing to score.');
    const neededDay = next.some(x => DAY_HUNTS.includes(x)) && !here.hunts.some(x => DAY_HUNTS.includes(x));
    here.hunts = next;
    update(st => { st.settings.hereHunts = next; });
    rescoreHere(neededDay);
  });
  $('#sheetBody [data-hcoast]').onclick = () => { here.coastal = !here.coastal; rescoreHere(here.coastal); };
  $('#hereSave').onclick = () => saveHere();
  $('#hereCompass').onclick = () => openCompassHere();
  $('#hereAgain').onclick = () => { here.at = 0; here.day = null; here.mode = 'gps'; openHere(); };
  $('#hereElse').onclick = () => chooseHerePlace();
}
// Re-score with the new choices. Day hunts (rainforest, waterfalls) and tides need extra data: fetch it.
export async function rescoreHere(refetch) {
  const y = $('#sheetBody').scrollTop;
  if (refetch) { const btns = $$('#sheetBody .chip-btn'); btns.forEach(b => (b.disabled = true)); await loadHere(); }
  else drawHere();
  const det = $('#sheetBody .here-hunts'); if (det) det.open = true;
  $('#sheetBody').scrollTop = y;
}
export function saveHere() {
  const name = hereSpot().name === 'Right here' ? '' : hereSpot().name;
  openSheet(`<h2>Save as a spot</h2>
    <p class="small muted">It joins your spots: scored on the Forecast page, included in alerts, and Tidelight starts learning it from your ratings.</p>
    <form class="form" id="hsForm"><label>Name<input name="name" required value="${esc(name)}" placeholder="e.g. North ledge"></label>
      <p class="small muted">Scoring for ${here.hunts.map(k => HUNT_LABEL[k].toLowerCase()).join(', ')}${here.coastal ? ', with tides' : ''}. Add the direction you shoot, the drive and notes in the spot's settings.</p>
      <div class="row"><button class="btn primary" type="submit">Save spot</button><button class="btn ghost" type="button" id="hsBack">Back</button></div></form>`);
  $('#hsBack').onclick = () => drawHere();
  $('#hsForm').onsubmit = ev => {
    ev.preventDefault();
    const nm = String(new FormData(ev.target).get('name') || '').trim();
    if (!nm) return toast('Give the spot a name');
    const id = uid();
    update(st => st.spots.push({ ...hereSpot(), id, here: undefined, name: nm, scoutedAt: Date.now() }));
    if (here.data) forecasts[id] = here.data;
    closeSheet();
    toast('Spot saved.');
    ui.tab = 'spots'; render();
    openSpotDetail(id);
  };
}
/* ================= choose a place: search, or tap the map ================= */
// One sheet for "where?" questions: Right here's Somewhere else, and the moon planner's stand and landmark.
// opts: { title, note, start: {lat, lon}, onPick(place), onBack?, mark?: {lat, lon, label} }
export let pickMap = null;
export function pickPlace(opts) {
  let chosen = null;
  openSheet(`<h2>${esc(opts.title)}</h2>
    ${opts.note ? `<p class="small muted">${esc(opts.note)}</p>` : ''}
    <form class="pp-search" id="ppForm" role="search"><input id="ppQ" type="search" placeholder="Search a place, beach or lookout" autocomplete="off" enterkeyhint="search"><button class="btn" type="submit">Search</button></form>
    <div class="pp-results" id="ppResults" hidden></div>
    <div class="pp-map" id="ppMap" role="application" aria-label="Map. Tap to drop a pin."></div>
    <p class="small muted pp-chosen" id="ppChosen" aria-live="polite">Tap the map to drop a pin, or search above.</p>
    <div class="sheet-actions"><div class="row"><button class="btn primary" id="ppUse" disabled>Use this place</button>${opts.onBack ? '<button class="btn" id="ppBack">Back</button>' : ''}</div></div>`);
  const start = opts.start || S().settings.home || { lat: -37.81, lon: 144.96 };
  let pin = null;
  const setChosen = (p, zoom) => {
    chosen = p;
    if (pickMap) {
      if (pin) pin.setLatLng([p.lat, p.lon]); else pin = window.L.circleMarker([p.lat, p.lon], { radius: 9, color: '#0F1111', weight: 2, fillColor: '#D9A066', fillOpacity: 1 }).addTo(pickMap);
      if (zoom) pickMap.setView([p.lat, p.lon], Math.max(pickMap.getZoom(), 12));
    }
    $('#ppChosen').textContent = `${p.name || 'Pinned place'}, ${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}`;
    $('#ppUse').disabled = false;
  };
  if (window.L) {
    pickMap = window.L.map('ppMap', { zoomControl: false, attributionControl: true }).setView([start.lat, start.lon], opts.start ? 12 : 9);
    window.L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, className: 'base-tiles', attribution: '&copy; OpenStreetMap contributors' }).addTo(pickMap);
    if (opts.mark) window.L.circleMarker([opts.mark.lat, opts.mark.lon], { radius: 6, color: '#ECE8E1', fillColor: '#ECE8E1', fillOpacity: 1 }).addTo(pickMap).bindTooltip(opts.mark.label || '', { permanent: !!opts.mark.label, direction: 'top' });
    pickMap.on('click', ev => {
      const p = { lat: ev.latlng.lat, lon: ev.latlng.lng, name: null };
      setChosen(p);
      placeName(p.lat, p.lon).then(n => { if (chosen === p && n) { p.name = n; setChosen(p); } }).catch(() => {});
    });
    setTimeout(() => pickMap && pickMap.invalidateSize(), 80);
    ui.onSheetClose = () => { if (pickMap) { pickMap.remove(); pickMap = null; } };
  } else $('#ppMap').hidden = true;
  $('#ppForm').onsubmit = async ev => {
    ev.preventDefault();
    const q = $('#ppQ').value.trim(), box = $('#ppResults');
    if (q.length < 2) return;
    box.hidden = false; box.innerHTML = '<p class="small muted">Searching…</p>';
    let res = [];
    try { res = await searchPlaces(q, S().settings.home); } catch { box.innerHTML = '<p class="small muted">Search isn\'t available right now. Tap the map instead.</p>'; return; }
    if (!$('#ppResults')) return;
    box.innerHTML = res.length ? res.slice(0, 6).map((r, i) => `<button type="button" class="result" data-pp="${i}"><span class="r-name">${esc(r.name)}</span><span class="r-detail">${esc(r.detail || '')}</span></button>`).join('')
      : '<p class="small muted">Nothing found. Try a nearby town, or tap the map.</p>';
    $$('[data-pp]', box).forEach(b => b.onclick = () => { box.hidden = true; setChosen(res[Number(b.dataset.pp)], true); });
  };
  $('#ppUse').onclick = () => { if (chosen) opts.onPick(chosen); };
  if (opts.onBack) $('#ppBack').onclick = () => opts.onBack();
}
