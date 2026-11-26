// Tidelight: The planners: moon planner, tide windows, through the year, and the shareable plan card.
import { esc, haversineKm, fmtWeekday, fmtDayDate, cap, fmtTime, compass, getPosition, toast, downloadFile, dayKey, fmtDay, angleDiff, localMidnight } from './util.js?v=7.3';
import { openSkyAR } from './skyar.js?v=7.3';
import { fetchSpotForecast } from './api.js?v=7.3';
import { tideInfo, evaluateSpot } from './scoring.js?v=7.3';
import { update } from './storage.js?v=7.3';
import { huntsOf } from './hunts.js?v=7.3';
import { coverUrl } from './photos.js?v=7.3';
import { $, $$, forecasts, indexEvents, offsetFor, openSheet, placeTz, S, ui, verdict } from './core.js?v=7.3';
import { moonSvg } from './tools.js?v=7.3';
import { pickPlace } from './here.js?v=7.3';
import { G, TYPE_NAME, horizonScene, huntPhrase, skeleton, skyOf, toneDot } from './forecast.js?v=7.3';
import { openEvent } from './event.js?v=7.3';

/* ================= moon planner ================= */
// When does the moon (or the sun) rise or set right behind something: a lighthouse, an arch, a peak?
// Stand somewhere, pick the landmark (or a direction), and it searches the next year, day by day.
export const AL_DAYS = 365;
export let al = null;   // { stand: {lat, lon, name, spotId}, target: {lat, lon, name}|null, bearing, body, events, full, tol, clear, open }
export const toDeg = r => r * 180 / Math.PI;
export function bearingTo(a, b) {
  const f1 = a.lat * Math.PI / 180, f2 = b.lat * Math.PI / 180, dl = (b.lon - a.lon) * Math.PI / 180;
  const y = Math.sin(dl) * Math.cos(f2), x = Math.cos(f1) * Math.sin(f2) - Math.sin(f1) * Math.cos(f2) * Math.cos(dl);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}
// The local offset where you'd stand (its own time zone, daylight saving included), not the phone's:
// planning a moonrise in Canada from Melbourne shows Canadian times.
export const localOffset = (t, place = al?.stand) => offsetFor(place, t);
export function alignState() {
  if (al) return al;
  const st = S();
  const faced = st.spots.find(sp => sp.facing !== '' && sp.facing != null && !isNaN(Number(sp.facing)));
  const first = faced || st.spots[0];
  const stand = first ? { lat: first.lat, lon: first.lon, name: first.name, spotId: first.id } : st.settings.home ? { ...st.settings.home, name: 'Home' } : null;
  al = { stand, target: null, bearing: faced ? Number(faced.facing) : 90, body: 'moon', events: 'both', full: true, tol: 2, clear: 0, open: null };
  return al;
}
// Every rise or set in the next year that lines up with the bearing, within the tolerance.
export function findAlignments(a) {
  const SC = window.SunCalc;
  if (!SC || !a.stand) return [];
  const { lat, lon } = a.stand;
  const pos = a.body === 'moon' ? (d => SC.getMoonPosition(d, lat, lon)) : (d => SC.getPosition(d, lat, lon));
  const out = [];
  // Days run midnight to midnight at the stand point, in its own time zone (not the phone's).
  const nowS = Date.now() / 1000;
  let mid = localMidnight(nowS, offsetFor(a.stand, nowS));
  const moonIn = (from, to, key) => {   // a moonrise or moonset between two moments, searching whole UTC days
    for (const dd of [from, from + 86400]) {
      const m = SC.getMoonTimes(new Date(dd * 1000), lat, lon, true);
      if (m[key] instanceof Date && m[key] / 1000 >= from && m[key] / 1000 < to) return m[key];
    }
    return null;
  };
  for (let i = 0; i < AL_DAYS; i++) {
    const next = localMidnight(mid + 36 * 3600, offsetFor(a.stand, mid + 36 * 3600));   // (daylight saving changes keep the days whole)
    let rise, set;
    if (a.body === 'moon') { rise = moonIn(mid, next, 'rise'); set = moonIn(mid, next, 'set'); }
    else { const tm = SC.getTimes(new Date((mid + 12 * 3600) * 1000), lat, lon); rise = tm.sunrise; set = tm.sunset; }
    mid = next;
    for (const [kind, t0] of [['rise', rise], ['set', set]]) {
      if (a.events !== 'both' && a.events !== kind) continue;
      if (!(t0 instanceof Date) || isNaN(t0)) continue;
      let t = t0;
      if (a.clear > 0) {
        // When it clears hills or the landmark itself: walk forward from the rise (back from the set) in 2-minute steps.
        let found = null;
        for (let k = 0; k <= 120; k++) {
          const d = new Date(t0.getTime() + (kind === 'rise' ? 1 : -1) * k * 120e3);
          if (toDeg(pos(d).altitude) >= a.clear) { found = d; break; }
        }
        if (!found) continue;
        t = found;
      }
      const az = (toDeg(pos(t).azimuth) + 180 + 360) % 360;
      const off = ((az - a.bearing + 540) % 360) - 180;
      if (Math.abs(off) > a.tol) continue;
      const ill = a.body === 'moon' ? SC.getMoonIllumination(t) : null;
      if (ill && a.full && ill.fraction < 0.85) continue;
      const sunAlt = toDeg(SC.getPosition(t, lat, lon).altitude);
      out.push({ t: t.getTime() / 1000, kind, az, off, ill, sunAlt });
    }
  }
  return out;
}
// The light on the land when it happens: what makes a moonrise photo work is a lit landscape with the moon in it.
export function alignLight(r) {
  const s = r.sunAlt;
  if (s > 6) return { word: 'Daylight', note: 'bright sky, a faint moon', good: false };
  if (s > 0) return { word: 'Golden hour', note: 'warm light on the land', good: true };
  if (s > -6) return { word: 'Blue hour', note: 'the land still lit, the moon bright', good: true };
  if (s > -12) return { word: 'Twilight', note: 'the moon bright, the land going dark', good: false };
  return { word: 'Dark', note: 'a bright moon over a dark landscape', good: false };
}
export function alignIcs(r, a) {
  const stamp = d => new Date(d * 1000).toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const what = `${a.body === 'moon' ? 'Moon' : 'Sun'}${r.kind === 'rise' ? 'rise' : 'set'}${a.target?.name ? ` behind ${a.target.name}` : ''}`;
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Tidelight//Moon planner//EN', 'BEGIN:VEVENT',
    `UID:${Math.round(r.t)}-${a.stand.lat.toFixed(3)}@tidelight`, `DTSTAMP:${stamp(Date.now() / 1000)}`,
    `DTSTART:${stamp(r.t - 1800)}`, `DTEND:${stamp(r.t + 1800)}`,
    `SUMMARY:${what}`, `LOCATION:${a.stand.name || ''} (${a.stand.lat.toFixed(5)}, ${a.stand.lon.toFixed(5)})`,
    `DESCRIPTION:Stand at ${a.stand.lat.toFixed(5)}\\, ${a.stand.lon.toFixed(5)}. ${r.kind === 'rise' ? 'Rises' : 'Sets'} at ${r.az.toFixed(1)}°. Planned with Tidelight.`,
    'BEGIN:VALARM', 'TRIGGER:-PT2H', 'ACTION:DISPLAY', `DESCRIPTION:${what} in 2 hours`, 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
}
export function openAligner() {
  const a = alignState();
  const st = S();
  const spotOpts = st.spots.map(sp => `<option value="spot:${esc(sp.id)}" ${a.stand?.spotId === sp.id ? 'selected' : ''}>${esc(sp.name)}</option>`).join('');
  const custom = a.stand && !a.stand.spotId;
  const results = a.stand ? findAlignments(a) : [];
  const dist = a.target && a.stand ? haversineKm(a.stand, a.target) : null;
  const seg = (name, val, opts) => `<div class="day-pills al-seg" role="radiogroup" aria-label="${esc(name)}">${opts.map(([k, l]) => `<button type="button" role="radio" class="${a[val] === k ? 'on' : ''}" aria-checked="${a[val] === k}" data-al="${val}" data-v="${k}">${l}</button>`).join('')}</div>`;
  const body = a.body === 'moon' ? 'moon' : 'sun';
  const goodCount = results.filter(r => alignLight(r).good).length;
  const row = (r, i) => {
    const o = localOffset(r.t), L = alignLight(r);
    const side = Math.abs(r.off) < 0.3 ? 'dead centre' : `${Math.abs(r.off).toFixed(1)}° ${r.off < 0 ? 'left' : 'right'}`;
    return `<details class="al-row ${L.good ? 'good' : ''}" data-ai="${i}" ${a.open === i ? 'open' : ''}>
      <summary>
        <span class="al-icon" aria-hidden="true">${a.body === 'moon' ? moonSvg(r.ill.phase, a.stand.lat, 34) : '<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="#F2C27A" stroke-width="1.8" stroke-linecap="round"><path d="M3 17.5h18M7.5 17.5a4.5 4.5 0 0 1 9 0M12 9.5V8M7.6 11.6l-1.1-1.1M16.4 11.6l1.1-1.1"/></svg>'}</span>
        <span class="al-main"><b>${fmtWeekday(r.t, o).slice(0, 3)} ${fmtDayDate(r.t, o).split(' ').slice(1).join(' ')} ${new Date((r.t + o) * 1000).getUTCFullYear()}</b>
          <small>${cap(body)}${r.kind} ${fmtTime(r.t, o)}${r.ill ? `, ${Math.round(r.ill.fraction * 100)}% full` : ''}. ${side}</small></span>
        <span class="al-light ${L.good ? 'good' : ''}">${L.word}</span>
      </summary>
      <div class="al-more">
        <p class="small">${cap(body)} ${r.kind === 'rise' ? 'rises' : 'sets'} at <b>${r.az.toFixed(1)}°</b> ${compass(r.az)}${a.clear > 0 ? `, clearing ${a.clear}°` : ''}; you're lining up with ${a.bearing.toFixed(1)}°. ${a.body === 'moon' ? `The sun is ${Math.abs(r.sunAlt).toFixed(0)}° ${r.sunAlt >= 0 ? 'up' : 'down'}: ${L.note}.` : ''}</p>
        ${r.t - Date.now() / 1000 < 6.5 * 86400 ? '<p class="small muted al-wx" data-wx="' + r.t + '">Checking the forecast…</p>' : '<p class="small muted">Inside a week out, the forecast for it shows here.</p>'}
        <div class="row"><button class="btn" data-ar="${i}">See it in Sky view</button><button class="btn" data-ics="${i}">Add to calendar</button></div>
      </div>
    </details>`;
  };
  openSheet(`<p class="eyebrow here-eyebrow"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/></svg>Moon planner</p>
    <h2>Line it up</h2>
    <p class="small muted">When the ${body} ${a.events === 'set' ? 'sets' : a.events === 'rise' ? 'rises' : 'rises or sets'} right behind a lighthouse, an arch or a peak. Searches the next 12 months.</p>

    <h3 class="sec">Where you'll stand</h3>
    <label class="al-field"><select id="alStand" aria-label="Where you'll stand">
      ${spotOpts}<option value="here">My location</option><option value="pick" ${custom ? 'selected' : ''}>${custom ? esc(a.stand.name || 'Pinned place') : 'Search or pick on the map…'}</option>
    </select></label>

    <h3 class="sec">What you're lining up with</h3>
    <div class="al-target">
      ${a.target ? `<p class="al-t"><b>${esc(a.target.name || 'Pinned landmark')}</b><small>${dist < 10 ? dist.toFixed(1) : Math.round(dist)} km away, at ${a.bearing.toFixed(1)}° ${compass(a.bearing)}</small></p>` : `<p class="al-t"><b>${a.bearing.toFixed(0)}° ${compass(a.bearing)}</b><small>Pick the landmark on the map for an exact line.</small></p>`}
      <button class="tool-chip" id="alPickT">${a.target ? 'Change landmark' : 'Pick the landmark'}</button>
    </div>
    <label class="al-slider">Direction <span class="num" id="alBearV">${a.bearing.toFixed(0)}°</span><input type="range" id="alBear" min="0" max="359" step="1" value="${Math.round(a.bearing)}" style="--val:${(a.bearing / 359 * 100).toFixed(1)}%" aria-label="Direction in degrees"></label>

    <div class="al-opts">
      ${seg('Moon or sun', 'body', [['moon', 'Moon'], ['sun', 'Sun']])}
      ${seg('Rising or setting', 'events', [['both', 'Both'], ['rise', 'Rising'], ['set', 'Setting']])}
      ${a.body === 'moon' ? `<div class="day-pills al-seg" role="radiogroup" aria-label="Phase"><button type="button" role="radio" class="${a.full ? 'on' : ''}" aria-checked="${a.full}" data-full="1">Full or nearly</button><button type="button" role="radio" class="${!a.full ? 'on' : ''}" aria-checked="${!a.full}" data-full="0">Any phase</button></div>` : ''}
    </div>
    <label class="al-slider">How close <span class="num" id="alTolV">within ${a.tol}°</span><input type="range" id="alTol" min="0.5" max="6" step="0.5" value="${a.tol}" style="--val:${((a.tol - 0.5) / 5.5 * 100).toFixed(1)}%"></label>
    <label class="al-slider">Clears the horizon at <span class="num" id="alClearV">${a.clear ? `${a.clear}°` : 'the horizon'}</span><input type="range" id="alClear" min="0" max="8" step="0.5" value="${a.clear}" style="--val:${(a.clear / 8 * 100).toFixed(1)}%"><small>Raise this when hills, or the landmark itself, sit above the horizon. A finger at arm's length is about 1°.</small></label>

    <h3 class="sec">${results.length ? `${results.length} line-up${results.length === 1 ? '' : 's'} in the next 12 months` : 'No line-ups in the next 12 months'}</h3>
    ${results.length && a.body === 'moon' ? `<p class="small muted">${goodCount ? `${goodCount} in golden or blue hour, marked: the moon bright and the land still lit. ` : ''}Times are in your phone's time zone.</p>` : ''}
    ${results.length ? `<div class="al-list">${results.map(row).join('')}</div>`
      : `<p class="small muted">${a.stand ? `Try a wider "How close", ${a.body === 'moon' && a.full ? 'any phase, ' : ''}or check the direction: the ${body} only rises and sets within a band of directions through the year.` : 'Choose where you\'ll stand.'}</p>`}
  `);
  const redraw = () => { const y = $('#sheetBody').scrollTop; openAligner(); $('#sheetBody').scrollTop = y; };
  $('#alStand').onchange = async e => {
    const v = e.target.value;
    if (v.startsWith('spot:')) { const sp = st.spots.find(x => x.id === v.slice(5)); a.stand = { lat: sp.lat, lon: sp.lon, name: sp.name, spotId: sp.id }; if (!a.target && sp.facing !== '' && sp.facing != null && !isNaN(Number(sp.facing))) a.bearing = Number(sp.facing); }
    else if (v === 'here') { try { const p = await getPosition(); a.stand = { lat: p.lat, lon: p.lon, name: 'My location' }; } catch (err) { toast(err.message, 4000); } }
    else return pickPlace({ title: "Where you'll stand", start: a.stand, onPick: p => { a.stand = { lat: p.lat, lon: p.lon, name: p.name || 'Pinned place' }; if (a.target) a.bearing = bearingTo(a.stand, a.target); a.open = null; openAligner(); }, onBack: () => openAligner() });
    if (a.target) a.bearing = bearingTo(a.stand, a.target);
    a.open = null; redraw();
  };
  $('#alPickT').onclick = () => pickPlace({
    title: 'Pick the landmark', note: 'Tap the lighthouse, peak or rock you want the moon behind. The white dot is where you\'ll stand.',
    start: a.target || a.stand, mark: a.stand ? { lat: a.stand.lat, lon: a.stand.lon, label: 'You' } : null,
    onPick: p => { a.target = { lat: p.lat, lon: p.lon, name: p.name }; a.bearing = bearingTo(a.stand, a.target); a.open = null; openAligner(); },
    onBack: () => openAligner(),
  });
  const live = (id, fmt, apply) => {
    const el = $(id);
    el.oninput = () => { $(id + 'V').textContent = fmt(Number(el.value)); el.style.setProperty('--val', `${((el.value - el.min) / (el.max - el.min) * 100).toFixed(1)}%`); };
    el.onchange = () => { apply(Number(el.value)); a.open = null; redraw(); };
  };
  live('#alBear', v => `${v}°`, v => { a.bearing = v; a.target = null; });
  live('#alTol', v => `within ${v}°`, v => { a.tol = v; });
  live('#alClear', v => (v ? `${v}°` : 'the horizon'), v => { a.clear = v; });
  $$('#sheetBody [data-al]').forEach(b => b.onclick = () => { a[b.dataset.al] = b.dataset.v; a.open = null; redraw(); });
  $$('#sheetBody [data-full]').forEach(b => b.onclick = () => { a.full = b.dataset.full === '1'; a.open = null; redraw(); });
  $$('#sheetBody [data-ar]').forEach(b => b.onclick = () => {
    const r = results[Number(b.dataset.ar)];
    openSkyAR({ time: r.t, focus: a.body === 'moon' ? 'moon' : 'sun', lat: a.stand.lat, lon: a.stand.lon, name: a.stand.name, tz: placeTz(a.stand) });   // the sky from where you'd stand
  });
  $$('#sheetBody [data-ics]').forEach(b => b.onclick = () => {
    const r = results[Number(b.dataset.ics)];
    downloadFile(`${a.body}${r.kind}-${new Date(r.t * 1000).toISOString().slice(0, 10)}.ics`, alignIcs(r, a), 'text/calendar');
  });
  // Forecast for line-ups in the next week, when they're opened.
  $$('#sheetBody .al-row').forEach(d => d.addEventListener('toggle', async () => {
    if (!d.open) return;
    a.open = Number(d.dataset.ai);
    const wx = d.querySelector('[data-wx]');
    if (!wx || wx.dataset.done) return;
    wx.dataset.done = '1';
    try {
      const sp = st.spots.find(x => x.id === a.stand.spotId) || { id: 'al', lat: a.stand.lat, lon: a.stand.lon, hunts: ['colour'], events: [], coastal: false, name: a.stand.name };
      const data = forecasts[sp.id] || await fetchSpotForecast(sp);
      const t = Number(wx.dataset.wx);
      const hr = data.hours.reduce((b, h) => (Math.abs(h.t - t) < Math.abs(b.t - t) ? h : b), data.hours[0]);
      const cover = Math.round(hr.total ?? Math.max(hr.low ?? 0, hr.mid ?? 0, hr.high ?? 0));
      const verdict = (hr.low ?? 0) >= 60 ? 'Low cloud is likely to hide it.' : cover <= 30 ? 'Looking clear.' : (hr.low ?? 0) < 30 ? 'Some cloud, but the horizon looks open.' : 'Mixed: watch the low cloud.';
      wx.innerHTML = `<b>Forecast:</b> low ${Math.round(hr.low ?? 0)}%, mid ${Math.round(hr.mid ?? 0)}%, high ${Math.round(hr.high ?? 0)}%. ${verdict}`;
      wx.classList.remove('muted');
    } catch { wx.textContent = "Couldn't load the forecast right now."; }
  }));
}
/* ================= tide windows ================= */
// Every stretch in the next week when the tide at a spot is where you need it: below or above a level,
// rising or falling. Levels are a share of the local tide range, the same way the score reads the tide.
export const TW_DEFAULT = { rule: 'below', level: 0.35, dir: 'any' };
export let twSpotId = null;
export function tidePositions(hours) {
  return hours.map((h, i) => { const ti = tideInfo(hours, i); return ti ? { t: h.t, pos: ti.pos, sea: h.sea, rising: ti.rising } : { t: h.t, pos: null }; });
}
export function tideWindows(hours, rule, now) {
  const P = tidePositions(hours);
  const ok = p => p.pos != null && (rule.rule === 'below' ? p.pos <= rule.level : p.pos >= rule.level)
    && (rule.dir === 'any' || (rule.dir === 'rising' ? p.rising === true : p.rising === false));
  const out = [];
  let cur = null;
  for (let i = 0; i < P.length; i++) {
    const p = P[i], good = ok(p);
    if (good && !cur) {
      // Starts between the last hour and this one: interpolate on the level.
      let start = p.t;
      const q = P[i - 1];
      if (q && q.pos != null && p.pos != null && q.pos !== p.pos) {
        const f = (rule.level - q.pos) / (p.pos - q.pos);
        if (f > 0 && f < 1) start = q.t + f * (p.t - q.t);
      }
      cur = { start };
    }
    if (!good && cur) {
      let end = P[i - 1].t;
      const q = P[i - 1];
      if (q.pos != null && p.pos != null && q.pos !== p.pos) {
        const f = (rule.level - q.pos) / (p.pos - q.pos);
        if (f > 0 && f < 1) end = q.t + f * (p.t - q.t);
      }
      cur.end = end; out.push(cur); cur = null;
    }
  }
  if (cur) { cur.end = P[P.length - 1].t; cur.open = true; out.push(cur); }
  return out.filter(w => w.end > now && w.end - w.start >= 20 * 60);
}
export async function openTideWindows(spotId) {
  const st = S();
  const coastal = st.spots.filter(sp => sp.coastal);
  if (!coastal.length) {
    openSheet(`<h2>Tide windows</h2><p>Tide windows work for coastal spots. Mark a spot as coastal in its settings, and its tides show up here.</p>`);
    return;
  }
  twSpotId = spotId || twSpotId || coastal[0].id;
  const sp = coastal.find(x => x.id === twSpotId) || coastal[0];
  twSpotId = sp.id;
  const rule = { ...TW_DEFAULT, ...(sp.tideRule || {}) };
  openSheet(`<h2>Tide windows</h2>${skeleton('week', 'Reading the tides…')}`);
  let data;
  try { data = forecasts[sp.id] || (forecasts[sp.id] = await fetchSpotForecast(sp)); }
  catch (err) { $('#sheetBody').innerHTML = `<h2>Tide windows</h2><div class="alert danger">${esc(err.message)}</div>`; return; }
  if (!$('#sheetBody')) return;
  const o = data.offset, now = Date.now() / 1000;
  const hours = data.hours.filter(h => h.t >= now - 12 * 3600);
  const seas = hours.map(h => h.sea).filter(v => v != null);
  if (seas.length < 24 || Math.max(...seas) - Math.min(...seas) < 0.05) {
    $('#sheetBody').innerHTML = `<h2>Tide windows</h2><p class="bf-name">${esc(sp.name)}</p><p>There's no tide data at this exact point. Try moving the spot's pin slightly offshore.</p>`;
    return;
  }
  const lo = Math.min(...seas), hi = Math.max(...seas);
  const wins = tideWindows(hours, rule, now);
  const evs = evaluateSpot(sp, data, st.keepers, st.settings);
  indexEvents(evs);
  const overlaps = w => evs.filter(e => e.t >= w.start - 1800 && e.t <= w.end + 1800);
  const dur = s => { const m = Math.round(s / 60); return m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}` : `${m} min`; };
  // Seven days of curve, one row a day, with the windows shaded and sunrise/sunset marked.
  const days = [];
  for (let i = 0; i < 7; i++) {
    const t = now + i * 86400, k = dayKey(t, o);
    const hs = hours.filter(h => dayKey(h.t, o) === k && h.sea != null);
    if (hs.length < 6) continue;
    const d0 = hs[0].t - ((hs[0].t + o) % 3600 === 0 ? 0 : 0);
    const dayStart = Math.floor((hs[0].t + o) / 86400) * 86400 - o;
    const x = tt => ((tt - dayStart) / 86400 * 100).toFixed(2);
    const y = v => (34 - (v - lo) / (hi - lo || 1) * 28).toFixed(1);
    const path = hs.map((h, j) => `${j ? 'L' : 'M'}${x(h.t)} ${y(h.sea)}`).join(' ');
    const shade = wins.filter(w => w.end > dayStart && w.start < dayStart + 86400)
      .map(w => `<rect x="${x(Math.max(w.start, dayStart))}" y="0" width="${(Math.min(w.end, dayStart + 86400) - Math.max(w.start, dayStart)) / 86400 * 100}" height="40" class="tw-win"/>`).join('');
    const marks = evs.filter(e => dayKey(e.t, o) === k && (e.type === 'sunrise' || e.type === 'sunset'))
      .map(e => `<line x1="${x(e.t)}" x2="${x(e.t)}" y1="2" y2="38" class="tw-sun"/>`).join('');
    const levelY = y(lo + rule.level * (hi - lo));
    days.push(`<div class="tw-day"><span class="tw-dl">${i === 0 ? 'Today' : fmtWeekday(t, o).slice(0, 3)}<small>${fmtDayDate(t, o).split(' ')[1]}</small></span>
      <svg viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden="true">${shade}<line x1="0" x2="100" y1="${levelY}" y2="${levelY}" class="tw-level"/>${marks}<path d="${path}" class="tw-curve" vector-effect="non-scaling-stroke"/></svg></div>`);
    void d0;
  }
  const levelM = lo + rule.level * (hi - lo);
  const seg = (key, opts) => `<div class="day-pills al-seg" role="radiogroup">${opts.map(([k, l]) => `<button type="button" role="radio" class="${rule[key] === k ? 'on' : ''}" aria-checked="${rule[key] === k}" data-tw="${key}" data-v="${k}">${l}</button>`).join('')}</div>`;
  $('#sheetBody').innerHTML = `
    <p class="eyebrow here-eyebrow">Tide windows</p>
    <h2>When the tide's right</h2>
    <label class="al-field"><select id="twSpot" aria-label="Spot">${coastal.map(x => `<option value="${esc(x.id)}" ${x.id === sp.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label>
    <div class="al-opts">${seg('rule', [['below', 'Below'], ['above', 'Above']])}${seg('dir', [['any', 'Rising or falling'], ['rising', 'Rising'], ['falling', 'Falling']])}</div>
    <label class="al-slider">Tide level <span class="num" id="twLevelV">${Math.round(rule.level * 100)}% of the range</span>
      <input type="range" id="twLevel" min="0.05" max="0.95" step="0.05" value="${rule.level}" style="--val:${((rule.level - 0.05) / 0.9 * 100).toFixed(1)}%">
      <small>About ${levelM >= 0 ? '+' : ''}${levelM.toFixed(2)} m from mean sea level here this week (lowest ${lo.toFixed(2)} m, highest ${hi.toFixed(2)} m). Saved for this spot.</small></label>
    <div class="tw-chart">${days.join('')}<p class="tw-key"><i class="tw-k-win"></i>Your window <i class="tw-k-sun"></i>Sunrise and sunset <i class="tw-k-lvl"></i>Your level</p></div>
    <h3 class="sec">${wins.length ? `${wins.length} window${wins.length === 1 ? '' : 's'} this week` : 'No windows this week'}</h3>
    ${wins.length ? `<div class="tw-list">${wins.map(w => {
      const ov = overlaps(w).sort((a, b) => b.score - a.score);
      return `<div class="tw-row ${ov.length ? 'with-light' : ''}">
        <p><b>${fmtDay(w.start, o)}, ${fmtTime(w.start, o)} to ${w.open ? 'beyond the forecast' : fmtTime(w.end, o)}</b><small>${w.open ? 'At least ' : ''}${dur(w.end - w.start)}</small></p>
        ${ov.length ? ov.map(e => `<button class="tw-sess" data-ev="${esc(e.key)}">${toneDot(e.score)}${TYPE_NAME[e.type]} ${fmtTime(e.t, o)}, ${e.score}: ${esc(huntPhrase(e).toLowerCase())}</button>`).join('') : '<small class="muted">No light session inside it.</small>'}
      </div>`;
    }).join('')}</div>` : `<p class="small muted">Try a ${rule.rule === 'below' ? 'higher' : 'lower'} level${rule.dir !== 'any' ? ', or rising or falling' : ''}.</p>`}
    <p class="small muted">Tide heights come from the marine forecast, measured from mean sea level, not the chart datum on printed tide tables. Check local tide tables before relying on access.</p>`;
  const save = patch => { update(s2 => { const x = s2.spots.find(q => q.id === sp.id); if (x) x.tideRule = { ...rule, ...patch }; }); const y = $('#sheetBody').scrollTop; openTideWindows(sp.id).then(() => { $('#sheetBody').scrollTop = y; }); };
  $('#twSpot').onchange = e => openTideWindows(e.target.value);
  $$('#sheetBody [data-tw]').forEach(b => b.onclick = () => save({ [b.dataset.tw]: b.dataset.v }));
  const lv = $('#twLevel');
  lv.oninput = () => { $('#twLevelV').textContent = `${Math.round(lv.value * 100)}% of the range`; lv.style.setProperty('--val', `${((lv.value - 0.05) / 0.9 * 100).toFixed(1)}%`); };
  lv.onchange = () => save({ level: Number(lv.value) });
}
/* ================= through the year: a spot's seasons ================= */
export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// The Milky Way's core (Sagittarius A*): right ascension 266.4°, declination -29.0°.
export function coreAltAt(d, lat, lon) {
  const days = d.getTime() / 864e5 - 10957.5;            // days since J2000
  const lst = (280.16 + 360.9856235 * days + lon) * Math.PI / 180;
  const H = lst - 266.4 * Math.PI / 180, dec = -29.0 * Math.PI / 180, phi = lat * Math.PI / 180;
  return Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H)) * 180 / Math.PI;
}
// For each month: hours the core is 10°+ up in full dark, and whether the sun rises or sets in your view.
export function seasonFacts(sp) {
  const SC = window.SunCalc;
  const year = new Date().getFullYear();
  const facing = sp.facing !== '' && sp.facing != null && !isNaN(Number(sp.facing)) ? Number(sp.facing) : null;
  return MONTHS.map((m, i) => {
    const mid = new Date(year, i, 15, 12);
    let core = 0, sunIn = [];
    if (SC) {
      const T = SC.getTimes(mid, sp.lat, sp.lon);
      for (const [kind, d] of [['sunrise', T.sunrise], ['sunset', T.sunset]]) {
        if (facing == null || !(d instanceof Date) || isNaN(d)) continue;
        const az = (SC.getPosition(d, sp.lat, sp.lon).azimuth * 180 / Math.PI + 180) % 360;
        if (angleDiff(az, facing) <= 15) sunIn.push(kind);
      }
      for (let k = 0; k < 24 * 6; k++) {   // 10-minute steps from noon to noon
        const d = new Date(mid.getTime() + k * 600e3);
        if (SC.getPosition(d, sp.lat, sp.lon).altitude * 180 / Math.PI > -18) continue;
        if (coreAltAt(d, sp.lat, sp.lon) >= 10) core += 1 / 6;
      }
    }
    return { m, i, core, sunIn };
  });
}
// Fog climatology: share of mornings (5 to 8am) with near-saturated, near-still air over the last two years.
export async function fogByMonth(sp) {
  const key = `tidelight:fogclim:${sp.lat.toFixed(2)},${sp.lon.toFixed(2)}`;
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(key) || 'null'); if (saved && Date.now() - saved.at < 30 * 864e5) return saved.pct; } catch {}
  const end = new Date(Date.now() - 8 * 864e5), start = new Date(end.getTime() - 730 * 864e5);
  const ymd = d => d.toISOString().slice(0, 10);
  let j;
  try { j = await getJSONPublic(`https://archive-api.open-meteo.com/v1/archive?latitude=${sp.lat}&longitude=${sp.lon}&start_date=${ymd(start)}&end_date=${ymd(end)}&hourly=relative_humidity_2m,wind_speed_10m&timezone=auto&timeformat=unixtime`); }
  catch (err) { if (saved?.pct) return saved.pct; throw err; }   // offline: an older tally is still good, fog seasons don't move
  const H = j.hourly, off = j.utc_offset_seconds || 0;
  const tally = MONTHS.map(() => ({ days: new Set(), fog: new Set() }));
  H.time.forEach((t, i) => {
    const d = new Date((t + off) * 1000), h = d.getUTCHours();
    if (h < 5 || h > 8) return;
    const m = d.getUTCMonth(), day = d.toISOString().slice(0, 10);
    tally[m].days.add(day);
    if ((H.relative_humidity_2m[i] ?? 0) >= 96 && (H.wind_speed_10m[i] ?? 99) <= 7) tally[m].fog.add(day);
  });
  const pct = tally.map(x => (x.days.size ? Math.round(x.fog.size / x.days.size * 100) : null));
  try { localStorage.setItem(key, JSON.stringify({ at: Date.now(), pct })); } catch {}
  return pct;
}
export async function getJSONPublic(url) {
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 20000);
  try { const r = await fetch(url, { signal: ctl.signal }); if (!r.ok) throw new Error(`Weather archive: ${r.status}`); return await r.json(); }
  finally { clearTimeout(timer); }
}
export function seasonView(sp) {
  const facts = seasonFacts(sp);
  const st = S();
  const mine = MONTHS.map(() => 0);
  st.keepers.filter(k => (k.spotId === sp.id || k.spotName === sp.name) && (k.label === 'keeper' || (k.score10 ?? 0) >= 7) && k.date).forEach(k => { mine[new Date(k.date).getMonth()]++; });
  const nowM = new Date().getMonth();
  const hunts = huntsOf(sp);
  const showCore = hunts.includes('astro');
  const showSun = sp.facing !== '' && sp.facing != null && !isNaN(Number(sp.facing));
  const head = `<span></span>${MONTHS.map((m, i) => `<span class="yr-m ${i === nowM ? 'now' : ''}">${m[0]}<small>${m.slice(1)}</small></span>`).join('')}`;
  const rowSun = showSun ? `<span class="yr-l">Sun in view</span>${facts.map(f => `<span class="yr-c ${f.sunIn.length ? 'on' : ''}" title="${f.m}: ${f.sunIn.join(' and ') || 'not in line'}">${f.sunIn.length ? G(f.sunIn.includes('sunset') && !f.sunIn.includes('sunrise') ? '<path d="M3 17.5h18M7.5 17.5a4.5 4.5 0 0 1 9 0"/><path d="M12 9.5V13M10.4 11.4 12 13l1.6-1.6"/>' : '<path d="M3 17.5h18M7.5 17.5a4.5 4.5 0 0 1 9 0"/><path d="M12 13V9.5M10.4 11.1 12 9.5l1.6 1.6"/>') : ''}</span>`).join('')}` : '';
  const rowCore = showCore ? `<span class="yr-l">Milky Way</span>${facts.map(f => `<span class="yr-c core" style="--a:${Math.min(1, f.core / 6).toFixed(2)}" title="${f.m}: ${f.core.toFixed(1)} h of the core up in full dark">${f.core >= 0.5 ? `<b class="num">${Math.round(f.core)}h</b>` : ''}</span>`).join('')}` : '';
  const rowFog = hunts.includes('fog') ? `<span class="yr-l">Fog</span>${MONTHS.map((m, i) => `<span class="yr-c fog" data-fogm="${i}"></span>`).join('')}` : '';
  const rowMine = `<span class="yr-l">Keepers</span>${mine.map((n, i) => `<span class="yr-c mine" title="${MONTHS[i]}: ${n} keeper${n === 1 ? '' : 's'}">${n ? `<b class="num">${n}</b>` : ''}</span>`).join('')}`;
  const best = [];
  const sunM = facts.filter(f => f.sunIn.length).map(f => f.m);
  if (sunM.length) best.push(`the sun lines up with your view in ${listMonths(sunM)}`);
  const coreM = facts.filter(f => f.core >= 2).map(f => f.m);
  if (showCore && coreM.length) best.push(`the core is up for 2+ hours of full dark in ${listMonths(coreM)}`);
  const mineM = mine.map((n, i) => (n ? MONTHS[i] : null)).filter(Boolean);
  if (mineM.length) best.push(`your keepers here came in ${listMonths(mineM)}`);
  return `<h3 class="sec">Through the year</h3>
    <div class="yr-wrap"><div class="yr">${head}${rowSun}${rowCore}${rowFog}${rowMine}</div></div>
    <p class="small muted">${best.length ? `${cap(best.join('; '))}.` : 'Set the direction you face in the spot\'s settings to see when the sun lines up.'}${showCore ? ' Milky Way: hours the core is well up in full dark, mid-month.' : ''}${hunts.includes('fog') ? ' Fog: the share of mornings in the last two years with still, saturated air at dawn.' : ''} Keepers: your 7+ ratings here.</p>`;
}
// "Mar to Jul" for a run of months, "Jan, Apr, Nov" otherwise.
export function listMonths(ms) {
  const idx = ms.map(m => MONTHS.indexOf(m)).sort((a, b) => a - b);
  const runs = [];
  for (const i of idx) { const r = runs[runs.length - 1]; if (r && i === r[1] + 1) r[1] = i; else runs.push([i, i]); }
  // a run that wraps from December into January
  if (runs.length > 1 && runs[0][0] === 0 && runs[runs.length - 1][1] === 11) { const last = runs.pop(); runs[0][0] = last[0]; }
  return runs.map(([a, b]) => (a === b ? MONTHS[a] : `${MONTHS[a]} to ${MONTHS[b]}`)).join(', ');
}
export function wireSeason(sp) {
  if (!huntsOf(sp).includes('fog')) return;
  fogByMonth(sp).then(pct => {
    $$('[data-fogm]').forEach(c => {
      const p = pct[Number(c.dataset.fogm)];
      c.style.setProperty('--a', p == null ? 0 : Math.min(1, p / 35).toFixed(2));
      c.innerHTML = p == null ? '' : `<b class="num">${p}%</b>`;
      c.title = `${MONTHS[Number(c.dataset.fogm)]}: ${p ?? '?'}% of mornings`;
    });
  }).catch(() => {
    $$('[data-fogm]').forEach(c => { c.textContent = '–'; c.title = 'Fog history needs a connection the first time'; });
    const note = $('.yr-wrap + p');
    if (note && !note.querySelector('.yr-offline')) note.insertAdjacentHTML('beforeend', ' <span class="yr-offline">Fog history needs a connection the first time you open this spot.</span>');
  });
}
/* ================= shareable plan card ================= */
// A picture of a session to send anyone: the spot, the time, the score and the sky. Drawn on a canvas
// from the spot's photo (or its horizon scene), so it shares as an ordinary image.
export function loadImg(src) { return new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = src; }); }
export async function shareCardBlob(e) {
  const W = 1080, H = 1350, c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  try { await Promise.all([document.fonts.load('400 120px "Instrument Serif"'), document.fonts.load('italic 400 60px "Instrument Serif"'), document.fonts.load('600 30px Manrope'), document.fonts.load('700 30px Manrope')]); } catch {}
  const SERIF = '"Instrument Serif", Georgia, serif', SANS = 'Manrope, Helvetica, Arial, sans-serif';
  // the sky: colours from the session's own sky gradient
  const cols = (skyOf(e).match(/#[0-9a-f]{6}/gi) || ['#1A2233', '#C98A55']);
  const sky = g.createLinearGradient(0, 0, 0, H * 0.62);
  cols.forEach((col, i) => sky.addColorStop(i / Math.max(1, cols.length - 1), col));
  g.fillStyle = sky; g.fillRect(0, 0, W, H);
  const photo = coverUrl(e.spot);
  const drawCover = (im, h) => { const s = Math.max(W / im.width, h / im.height); g.drawImage(im, (W - im.width * s) / 2, (h - im.height * s) / 2, im.width * s, im.height * s); };
  try {
    if (photo) drawCover(await loadImg(photo), H * 0.66);
    else {
      const svg = horizonScene(e).replace('<svg ', `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${Math.round(H * 0.66)}" `);
      drawCover(await loadImg(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`), H * 0.66);
    }
  } catch {}
  // fade into the panel
  const fade = g.createLinearGradient(0, H * 0.38, 0, H * 0.7);
  fade.addColorStop(0, 'rgba(12,14,16,0)'); fade.addColorStop(1, 'rgba(12,14,16,1)');
  g.fillStyle = fade; g.fillRect(0, 0, W, H); g.fillStyle = '#0C0E10'; g.fillRect(0, H * 0.7, W, H * 0.3);
  const top = g.createLinearGradient(0, 0, 0, 220); top.addColorStop(0, 'rgba(0,0,0,.45)'); top.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = top; g.fillRect(0, 0, W, 220);
  const o = e.offset;
  const text = (t, x, y, font, color, align = 'left') => { g.font = font; g.fillStyle = color; g.textAlign = align; g.fillText(t, x, y); };
  g.shadowColor = 'rgba(0,0,0,.35)'; g.shadowBlur = 18;
  text('TIDELIGHT', 72, 110, `700 30px ${SANS}`, '#F2DFC6');
  g.letterSpacing = '0px';
  text(`${TYPE_NAME[e.type]} · ${fmtDay(e.t, o)} ${fmtDayDate(e.t, o)}`, W - 72, 110, `600 30px ${SANS}`, '#F4EFE7', 'right');
  g.shadowBlur = 0;
  // score and verdict
  const P = H * 0.62;
  g.font = `400 200px ${SERIF}`;
  const scoreW = g.measureText(String(e.score)).width;
  text(String(e.score), W - 72, P + 70, `400 200px ${SERIF}`, e.score >= 75 ? '#E2AA6E' : '#F4EFE7', 'right');
  // Verdict and spot name shrink to fit beside the score.
  const room = W - 144 - scoreW - 36;
  const fit = (t, size, style) => { let px = size; g.font = `${style} ${px}px ${SERIF}`; while (g.measureText(t).width > room && px > 34) { px -= 2; g.font = `${style} ${px}px ${SERIF}`; } return `${style} ${px}px ${SERIF}`; };
  text(`${huntPhrase(e)}.`, 72, P + 24, fit(`${huntPhrase(e)}.`, 76, 'italic 400'), '#F4EFE7');
  text(e.spot.name, 72, P + 112, fit(e.spot.name, 64, '400'), '#F4EFE7');
  // facts
  const facts = [['Be there', fmtTime(e.t - ((e.type === 'sunrise' ? 30 : 15) * 60), o)], [cap(TYPE_NAME[e.type]), fmtTime(e.t, o)]];
  const h = e.hour || {};
  facts.push(['Cloud', `${Math.round(h.high ?? 0)}/${Math.round(h.mid ?? 0)}/${Math.round(h.low ?? 0)}%`]);
  if (e.tide) facts.push(['Tide', `${Math.round(e.tide.pos * 100)}%, ${e.tide.rising ? 'rising' : 'falling'}`]);
  const cw = (W - 144) / facts.length;
  facts.forEach(([k, v], i) => {
    text(k.toUpperCase(), 72 + i * cw, P + 210, `700 24px ${SANS}`, '#9DA3A3');
    // shrink a value that would run into the next column
    let px = facts.length > 3 ? 36 : 40; g.font = `600 ${px}px ${SANS}`;
    while (g.measureText(v).width > cw - 18 && px > 24) { px -= 2; g.font = `600 ${px}px ${SANS}`; }
    text(v, 72 + i * cw, P + 262, `600 ${px}px ${SANS}`, '#F4EFE7');
  });
  g.fillStyle = 'rgba(255,255,255,.12)'; g.fillRect(72, P + 160, W - 144, 2);
  text('Cloud high / mid / low', 72, H - 96, `600 24px ${SANS}`, '#6F7576');
  text('Planned with Tidelight', W - 72, H - 96, `600 24px ${SANS}`, '#C98A55', 'right');
  return new Promise(res => c.toBlob(res, 'image/png'));
}
export async function openShareCard(e) {
  openSheet(`<h2>Share card</h2>${skeleton('here', 'Drawing the card…')}`);
  let blob;
  try { blob = await shareCardBlob(e); } catch { blob = null; }
  if (!$('#sheetBody')) return;
  if (!blob) { $('#sheetBody').innerHTML = '<h2>Share card</h2><p>Couldn\'t draw the card on this device.</p>'; return; }
  const url = URL.createObjectURL(blob);
  const name = `${e.spot.name.replace(/[^\w]+/g, '-').toLowerCase()}-${e.type}-${new Date(e.t * 1000).toISOString().slice(0, 10)}.png`;
  const file = new File([blob], name, { type: 'image/png' });
  const canShare = !!(navigator.canShare && navigator.canShare({ files: [file] }));
  $('#sheetBody').innerHTML = `<h2>Share card</h2>
    <p class="small muted">A picture of this session to send anyone, or post as a story.</p>
    <img class="share-card" src="${url}" alt="Share card: ${esc(e.spot.name)}, ${esc(TYPE_NAME[e.type].toLowerCase())} ${esc(fmtDay(e.t, e.offset).toLowerCase())}, score ${e.score}">
    <div class="sheet-actions sc-actions">${canShare ? '<button class="btn primary" id="scShare">Share</button>' : ''}<div class="row"><a class="btn ${canShare ? '' : 'primary'}" id="scSave" href="${url}" download="${name}">Save image</a><button class="btn" id="scBack">Back</button></div></div>`;
  if (canShare) $('#scShare').onclick = () => navigator.share({ files: [file], title: `${e.spot.name}, ${TYPE_NAME[e.type].toLowerCase()}` }).catch(() => {});
  $('#scBack').onclick = () => openEvent(e.key);
  ui.onSheetClose = () => setTimeout(() => URL.revokeObjectURL(url), 1000);
}
