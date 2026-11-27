// Tidelight: The Tools tab: scouting, the light dial, tide slider, exposure tools, lightning timer and coach.
import { HUNT_ORDER, HUNT_LABEL, coreAltAz } from './hunts.js?v=7.4.2';
import { compass, getPosition, toast, uid, esc, fmtTime, cap, fmtDayDate } from './util.js?v=7.4.2';
import { placeName } from './api.js?v=7.4.2';
import { addPhotoFile } from './photos.js?v=7.4.2';
import { update } from './storage.js?v=7.4.2';
import { openSkyAR } from './skyar.js?v=7.4.2';
import { $, $$, S, allEvents, closeSheet, ensureForecasts, eventIndex, forecasts, openSheet, ui } from './core.js?v=7.4.2';
import { alignmentText, openCompass, phoneHeading } from './field.js?v=7.4.2';
import { render } from './app.js?v=7.4.2';
import { openSpotDetail } from './spots.js?v=7.4.2';
import { BAND, day3am, lightBand, phaseAt, phaseColor } from './forecast.js?v=7.4.2';
import { openHere } from './here.js?v=7.4.2';
import { openAligner, openTideWindows } from './planners.js?v=7.4.2';

/* ================= scout a spot ================= */
export function openScout() {
  let pos = null, facing = null, photoFile = null, live = null, heading = null;
  openSheet(`
    <h2>Scout this spot</h2>
    <p class="small muted">Stand where you'd set up. Tidelight records the location and the direction of your composition, then scores the spot from here on.</p>
    <div class="scout-step"><strong>1. Location</strong><p id="scLoc" class="small muted">Finding you…</p></div>
    <div class="scout-step"><strong>2. Which way you're shooting</strong>
      <p class="small muted">Point the top of the phone at your composition, then tap Capture.</p>
      <p class="scout-heading num" id="scHeading">–</p>
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
  ui.onSheetClose = () => { if (live) live.stop(); };

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
    ui.tab = 'spots'; render();
    openSpotDetail(id);
  };
}
export async function openCompassHere() {
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
export function moonSvg(phase, lat, size = 72) {
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
export function moonPhaseName(p) {
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
export function dayPhases(place, midnight) {
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
export function openLightDial({ name, lat, lon, offset, t }) {
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
export async function openLightDialHere() {
  let pos = null;
  try { pos = await getPosition(); } catch { pos = S().settings.home || S().spots[0] || null; }
  if (!pos) { toast('Turn on location, or set your home under You, to use the light dial.', 5000); return; }
  openLightDial({ name: pos.name || 'Where you are now', lat: pos.lat, lon: pos.lon, offset: -new Date().getTimezoneOffset() * 60, t: Date.now() / 1000 });
}
/* ================= the tide slider (coastal briefings) ================= */
export function tideChart(e) {
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
export function wireTide(e) {
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
    $('#tideRead').textContent = `${fmtTime(tt, e.offset)}: sea level ${sea.v.toFixed(1)} m and ${sea.rising ? 'rising' : 'falling'}.${acc}`;
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
/* ================= exposure tools: ND filter, sharp stars, hyperfocal ================= */
export const SHUTTERS = [1/8000, 1/6400, 1/5000, 1/4000, 1/3200, 1/2500, 1/2000, 1/1600, 1/1250, 1/1000, 1/800, 1/640, 1/500, 1/400, 1/320, 1/250, 1/200, 1/160, 1/125, 1/100, 1/80, 1/60, 1/50, 1/40, 1/30, 1/25, 1/20, 1/15, 1/13, 1/10, 1/8, 1/6, 1/5, 1/4, 0.3, 0.4, 0.5, 0.6, 0.8, 1, 1.3, 1.6, 2, 2.5, 3.2, 4, 5, 6, 8, 10, 13, 15, 20, 25, 30];
export const APERTURES = [1.2, 1.4, 1.8, 2, 2.2, 2.5, 2.8, 3.2, 3.5, 4, 4.5, 5, 5.6, 6.3, 7.1, 8, 9, 10, 11, 13, 16, 18, 22];
export const SENSORS = {
  full: { label: 'Full frame', w: 36, crop: 1, coc: 0.03, ratio: 1.5 },
  apsc: { label: 'APS-C (Sony, Nikon, Fuji)', w: 23.5, crop: 1.5, coc: 0.02, ratio: 1.5 },
  canon: { label: 'APS-C (Canon)', w: 22.3, crop: 1.6, coc: 0.019, ratio: 1.5 },
  m43: { label: 'Micro Four Thirds', w: 17.3, crop: 2, coc: 0.015, ratio: 4 / 3 },
};
export const ND_PRESETS = [[3, 'ND8'], [6, 'ND64'], [10, 'ND1000'], [15, '15 stop']];
export function fmtShutter(t) {
  if (t < 0.95) { const d = Math.round(1 / t); return `1/${d} s`; }
  if (t < 60) return `${t < 10 && Math.abs(t - Math.round(t)) > 0.05 ? t.toFixed(1) : Math.round(t)} s`;
  if (t < 3600) { const m = Math.floor(t / 60), sec = Math.round(t % 60); return sec ? `${m} min ${sec} s` : `${m} min`; }
  const h = Math.floor(t / 3600), m = Math.round((t % 3600) / 60);
  return `${h} h ${m} min`;
}
export const fmtF = n => `f/${n % 1 ? n.toFixed(1) : n}`;
export const fmtDist = m => (!isFinite(m) ? 'infinity' : m >= 10 ? `${Math.round(m)} m` : m >= 1 ? `${m.toFixed(1)} m` : `${Math.round(m * 100)} cm`);
export const nearIndex = (arr, v) => arr.reduce((bi, x, i) => (Math.abs(Math.log(x / v)) < Math.abs(Math.log(arr[bi] / v)) ? i : bi), 0);
export const ISOS = [400, 640, 800, 1250, 1600, 2500, 3200, 5000, 6400, 10000, 12800, 25600];
export let exposureTab = 'nd';
export let ndTimer = null;   // { end, total, raf, wake }
export function expSettings() {
  const e = S().settings.exposure || {};
  return { sensor: 'full', mp: 24, base: 1/60, stops: 6, focal: 16, aperture: 2.8, hfFocal: 24, hfAperture: 11, focus: 2, ...e };
}
export function saveExp(patch) { update(s2 => { s2.settings.exposure = { ...expSettings(), ...patch }; }); }
export function rangeRow(id, label, out, min, max, step, value, foot = '') {
  const pct = ((value - min) / (max - min) * 100).toFixed(1);
  return `<label class="slider">
    <span class="slider-head"><span>${label}</span><output class="num" id="${id}Out">${out}</output></span>
    <input type="range" id="${id}" min="${min}" max="${max}" step="${step}" value="${value}" style="--val:${pct}%">
    ${foot ? `<span class="slider-foot" id="${id}Foot">${foot}</span>` : ''}
  </label>`;
}
export const setFill = el => el.style.setProperty('--val', `${((el.value - el.min) / (el.max - el.min) * 100).toFixed(1)}%`);
export function cameraLine(c) {
  return `<div class="cam-line">
    <span>${esc(SENSORS[c.sensor].label)}, ${c.mp} MP</span>
    <button class="link-btn" id="camEdit" type="button">Change camera</button>
  </div>
  <div class="cam-edit" id="camBox" hidden>
    <label>Sensor<select id="camSensor">${Object.entries(SENSORS).map(([k, v]) => `<option value="${k}" ${k === c.sensor ? 'selected' : ''}>${v.label}</option>`).join('')}</select></label>
    <label>Megapixels<input id="camMp" inputmode="numeric" value="${c.mp}"></label>
    <button class="btn" id="camSave" type="button">Save camera</button>
  </div>`;
}
export function wireCamera(redraw) {
  $('#camEdit').onclick = () => { $('#camBox').hidden = !$('#camBox').hidden; };
  $('#camSave').onclick = () => {
    const mp = Math.max(4, Math.min(120, parseFloat($('#camMp').value) || 24));
    saveExp({ sensor: $('#camSensor').value, mp });
    toast('Camera saved.');
    redraw();
  };
}
export function openExposure(tabName) {
  if (tabName) exposureTab = tabName;
  const tabs = [['nd', 'ND filter'], ['stars', 'Sharp stars'], ['hf', 'Hyperfocal']];
  openSheet(`
    <h2 class="bf-name">Exposure</h2>
    <div class="day-pills exp-tabs" role="tablist" aria-label="Exposure tools">
      ${tabs.map(([k, l]) => `<button role="tab" aria-selected="${exposureTab === k}" class="${exposureTab === k ? 'on' : ''}" data-exp="${k}">${l}</button>`).join('')}
    </div>
    <div id="expBody"></div>`);
  $$('[data-exp]').forEach(b => b.onclick = () => { stopNdTimer(); exposureTab = b.dataset.exp; $$('[data-exp]').forEach(x => { x.classList.toggle('on', x === b); x.setAttribute('aria-selected', String(x === b)); }); drawExposure(); });
  ui.onSheetClose = stopNdTimer;
  drawExposure();
}
export function drawExposure() {
  const box = $('#expBody');
  if (!box) return;
  const c = expSettings();
  const sensor = SENSORS[c.sensor];

  if (exposureTab === 'nd') {
    let bi = nearIndex(SHUTTERS, c.base), stops = c.stops;
    box.innerHTML = `
      <p class="bf-when">Meter without the filter, then dial in that shutter speed and your filter.</p>
      <div class="exp-result"><p class="exp-big num" id="ndResult"></p><p class="exp-sub" id="ndSub"></p></div>
      ${rangeRow('ndBase', 'Shutter speed without the filter', fmtShutter(SHUTTERS[bi]), 0, SHUTTERS.length - 1, 1, bi)}
      ${rangeRow('ndStops', 'Filter strength', `${stops} stops`, 0, 20, 1, stops)}
      <div class="chip-row">${ND_PRESETS.map(([n, l]) => `<button class="chip-btn" data-nd="${n}">${l}</button>`).join('')}</div>
      <div class="timer" id="ndTimerBox" hidden>
        <svg viewBox="0 0 120 120" aria-hidden="true"><circle class="t-track" cx="60" cy="60" r="52"/><circle class="t-val" id="ndRing" cx="60" cy="60" r="52" transform="rotate(-90 60 60)"/></svg>
        <p class="timer-left num" id="ndLeft" role="timer" aria-live="off"></p>
      </div>
      <div class="sheet-actions"><button class="btn primary" id="ndStart">Start timer</button></div>`;
    const draw = () => {
      const t = SHUTTERS[bi] * 2 ** stops;
      $('#ndResult').textContent = fmtShutter(t);
      $('#ndSub').textContent = stops === 0 ? 'No filter.' : `${fmtShutter(SHUTTERS[bi])} with ${stops} stops of ND${t > 30 ? '. Use bulb mode with a remote, and cover the viewfinder.' : '.'}`;
      $('#ndBaseOut').textContent = fmtShutter(SHUTTERS[bi]);
      $('#ndStopsOut').textContent = `${stops} stop${stops === 1 ? '' : 's'}`;
      const start = $('#ndStart');
      if (!ndTimer) { start.disabled = t < 1; start.textContent = t < 1 ? 'Too short to need a timer' : `Start timer: ${fmtShutter(t)}`; }
      $$('[data-nd]').forEach(x => x.classList.toggle('on', Number(x.dataset.nd) === stops));
    };
    $('#ndBase').oninput = ev => { bi = Number(ev.target.value); setFill(ev.target); draw(); saveExp({ base: SHUTTERS[bi] }); };
    $('#ndStops').oninput = ev => { stops = Number(ev.target.value); setFill(ev.target); draw(); saveExp({ stops }); };
    $$('[data-nd]').forEach(x => x.onclick = () => { stops = Number(x.dataset.nd); const r = $('#ndStops'); r.value = stops; setFill(r); draw(); saveExp({ stops }); });
    $('#ndStart').onclick = () => (ndTimer ? stopNdTimer(true) : startNdTimer(SHUTTERS[bi] * 2 ** stops));
    draw();
    return;
  }

  if (exposureTab === 'stars') {
    let focal = c.focal, ai = nearIndex(APERTURES, c.aperture);
    box.innerHTML = `
      ${cameraLine(c)}
      <div class="exp-result"><p class="exp-big num" id="stResult"></p><p class="exp-sub" id="stSub"></p></div>
      ${rangeRow('stFocal', 'Focal length', `${focal} mm`, 8, 135, 1, focal)}
      ${rangeRow('stAp', 'Aperture', fmtF(APERTURES[ai]), 0, 12, 1, Math.min(ai, 12))}
      <dl class="bf-cond exp-facts">
        <div><dt>Old 500 rule</dt><dd id="st500"></dd></div>
        <div><dt>Starting ISO</dt><dd id="stIso"></dd></div>
      </dl>
      <p class="small muted">The NPF rule accounts for your sensor's pixel size and aperture, so stars stay pin-sharp when viewed full size. The 500 rule allows slight trailing. Stars near the south celestial pole move more slowly and can take longer exposures.</p>`;
    const draw = () => {
      const N = APERTURES[ai];
      const px = sensor.w * 1000 / Math.sqrt(c.mp * 1e6 * sensor.ratio);   // pixel pitch in microns
      const t = (35 * N + 30 * px) / focal;
      const r500 = 500 / (focal * sensor.crop);
      const iso = ISOS[nearIndex(ISOS, Math.max(400, Math.min(25600, 3200 * (N / 2.8) ** 2 * (20 / t))))];
      $('#stResult').textContent = fmtShutter(t);
      $('#stSub').textContent = `Longest exposure for sharp stars at ${focal} mm, ${fmtF(N)}.`;
      $('#st500').textContent = fmtShutter(r500);
      $('#stIso').textContent = `ISO ${iso.toLocaleString('en-AU')} in a dark sky`;
      $('#stFocalOut').textContent = `${focal} mm`;
      $('#stApOut').textContent = fmtF(N);
    };
    $('#stFocal').oninput = ev => { focal = Number(ev.target.value); setFill(ev.target); draw(); saveExp({ focal }); };
    $('#stAp').oninput = ev => { ai = Number(ev.target.value); setFill(ev.target); draw(); saveExp({ aperture: APERTURES[ai] }); };
    wireCamera(drawExposure);
    draw();
    return;
  }

  // Hyperfocal and depth of field
  let focal = c.hfFocal, ai = nearIndex(APERTURES, c.hfAperture);
  const fToSlider = d => Math.round(Math.log(d / 0.3) / Math.log(100 / 0.3) * 100), sliderToF = v => 0.3 * (100 / 0.3) ** (v / 100);
  let fv = fToSlider(c.focus);
  box.innerHTML = `
    ${cameraLine(c)}
    <div class="exp-result"><p class="exp-big num" id="hfResult"></p><p class="exp-sub" id="hfSub"></p></div>
    ${rangeRow('hfFocal', 'Focal length', `${focal} mm`, 8, 200, 1, focal)}
    ${rangeRow('hfAp', 'Aperture', fmtF(APERTURES[ai]), 0, APERTURES.length - 1, 1, ai)}
    <h3 class="sec">Try a focus distance</h3>
    ${rangeRow('hfFocus', 'Focus at', fmtDist(sliderToF(fv)), 0, 100, 1, fv)}
    <div class="dof" aria-hidden="true">
      <div class="dof-scale">${['30 cm', '1 m', '3 m', '10 m', '30 m', '∞'].map((l, i) => `<span style="left:${i * 20}%">${l}</span>`).join('')}</div>
      <div class="dof-bar"><i id="dofZone"></i><b id="dofFocus"></b></div>
    </div>
    <p class="dof-read" id="dofRead" aria-live="polite"></p>`;
  const pos = d => (!isFinite(d) ? 100 : Math.max(0, Math.min(100, Math.log(d / 0.3) / Math.log(100 / 0.3) * 100)));
  const draw = () => {
    const N = APERTURES[ai], f = focal, coc = sensor.coc;
    const H = (f * f) / (N * coc) / 1000 + f / 1000;   // metres
    const s0 = sliderToF(fv);
    const near = (H * s0) / (H + s0), far = s0 >= H ? Infinity : (H * s0) / (H - s0);
    $('#hfResult').textContent = fmtDist(H);
    $('#hfSub').textContent = `Focus here and everything from ${fmtDist(H / 2)} to the horizon is sharp, at ${f} mm, ${fmtF(N)}.`;
    $('#hfFocalOut').textContent = `${f} mm`;
    $('#hfApOut').textContent = fmtF(N);
    $('#hfFocusOut').textContent = fmtDist(s0);
    $('#dofZone').style.left = `${pos(near)}%`;
    $('#dofZone').style.width = `${pos(far) - pos(near)}%`;
    $('#dofFocus').style.left = `${pos(s0)}%`;
    $('#dofRead').textContent = `Sharp from ${fmtDist(near)} to ${fmtDist(far)}.${s0 < H / 2 ? ' Focus further away to bring the horizon into the sharp zone.' : s0 > H * 1.2 ? ' Focusing this far loses near detail; try the hyperfocal distance.' : ''}`;
  };
  $('#hfFocal').oninput = ev => { focal = Number(ev.target.value); setFill(ev.target); draw(); saveExp({ hfFocal: focal }); };
  $('#hfAp').oninput = ev => { ai = Number(ev.target.value); setFill(ev.target); draw(); saveExp({ hfAperture: APERTURES[ai] }); };
  $('#hfFocus').oninput = ev => { fv = Number(ev.target.value); setFill(ev.target); draw(); saveExp({ focus: sliderToF(fv) }); };
  wireCamera(drawExposure);
  draw();
}
// The long-exposure timer: a ring counting down, three beeps at the end, screen kept on while it runs.
export function startNdTimer(total) {
  stopNdTimer();
  const end = performance.now() + total * 1000;
  ndTimer = { end, total, raf: 0, wake: null };
  if ('wakeLock' in navigator) navigator.wakeLock.request('screen').then(w => { if (ndTimer) ndTimer.wake = w; }).catch(() => {});
  try { (window.__ac ||= new (window.AudioContext || window.webkitAudioContext)()).resume(); } catch {}   // unlock sound on this tap
  $('#ndTimerBox').hidden = false;
  const btn = $('#ndStart'); btn.disabled = false; btn.textContent = 'Stop timer'; btn.classList.remove('primary');
  const C = 2 * Math.PI * 52;
  $('#ndRing').style.strokeDasharray = `${C}`;
  const tick = () => {
    if (!ndTimer) return;
    const left = Math.max(0, (ndTimer.end - performance.now()) / 1000);
    const el = $('#ndLeft'), ring = $('#ndRing');
    if (!el) { stopNdTimer(); return; }
    el.textContent = left >= 60 ? `${Math.floor(left / 60)}:${String(Math.floor(left % 60)).padStart(2, '0')}` : left >= 10 ? `${Math.ceil(left)}` : left.toFixed(1);
    ring.style.strokeDashoffset = `${C * (1 - left / total)}`;
    if (left <= 0) { finishNdTimer(); return; }
    ndTimer.raf = requestAnimationFrame(tick);
  };
  tick();
}
export function finishNdTimer() {
  try {
    const ac = window.__ac;
    if (ac) [0, 0.35, 0.7].forEach(d => { const o = ac.createOscillator(), g = ac.createGain(); o.frequency.value = 880; g.gain.setValueAtTime(0.0001, ac.currentTime + d); g.gain.exponentialRampToValueAtTime(0.4, ac.currentTime + d + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + d + 0.25); o.connect(g).connect(ac.destination); o.start(ac.currentTime + d); o.stop(ac.currentTime + d + 0.3); });
  } catch {}
  navigator.vibrate?.([200, 100, 200, 100, 200]);
  const el = $('#ndLeft'); if (el) el.textContent = 'Done';
  $('#ndTimerBox')?.classList.add('done');
  stopNdTimer();
  toast('Exposure done. Close the shutter.', 5000);
}
export function stopNdTimer(byUser = false) {
  if (!ndTimer) return;
  cancelAnimationFrame(ndTimer.raf);
  ndTimer.wake?.release().catch(() => {});
  ndTimer = null;
  const btn = $('#ndStart');
  if (btn) { btn.classList.add('primary'); }
  if (byUser) { $('#ndTimerBox').hidden = true; drawExposure(); }
}
/* ================= tools tab ================= */
export function renderTools(v) {
  const now = Date.now() / 1000;
  const nextPlan = S().plans.filter(p => p.t >= now - 3600 && eventIndex.has(p.key)).sort((a, b) => a.t - b.t)[0];
  const tool = (attr, title, text) => `<button class="tool-row" ${attr}>
      <span class="tool-text"><span class="tool-title">${title}</span><span class="tool-desc">${text}</span></span>
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>
    </button>`;
  v.innerHTML = `
    <h1 class="page-title">Tools</h1>
    <p class="page-lede">For when you're out there. These work without reception. Radar and the hourly forecast are under Now, at the top.</p>
    <div class="tool-list">
      ${nextPlan ? tool(`data-field="${esc(nextPlan.key)}"`, 'Field mode', `Countdowns and the sky for ${esc(nextPlan.spotName)}, your next plan.`) : ''}
      ${tool('id="toolHere"', 'Right here, or anywhere', "Scores and the week's forecast for where you're standing, or anywhere you search or pin. No spot needed.")}
      ${tool('id="toolSky"', 'Sky view', 'Hold your phone up to see where the sun, moon and Milky Way will be, drawn over the camera, at any time.')}
      ${tool('id="toolTide"', 'Tide windows', 'When the tide is below or above the level you need this week, and which light sessions fall inside.')}
      ${tool('id="toolAlign"', 'Moon planner', 'When the full moon (or the sun) rises or sets right behind a landmark, over the next year.')}
      ${tool('id="toolCompass"', 'Compass', "Where the sun rises and sets today, and where the sun, moon and Milky Way are now.")}
      ${tool('id="toolExposure"', 'Exposure', 'ND filter times with a countdown, the longest exposure for sharp stars, and hyperfocal distance.')}
      ${tool('id="toolDial"', 'Light dial', 'Drag around a 24-hour dial to see the light, the sun and the moon at any time.')}
      ${tool('data-lightning', 'Lightning distance', 'Time the gap between flash and thunder to see how far away a storm is.')}
    </div>
    ${!nextPlan ? '<p class="small muted tool-note">Field mode opens from any session. Plan a shoot and it appears here for the next one.</p>' : ''}`;
  $('#toolHere').onclick = () => openHere();
  $('#toolAlign').onclick = () => openAligner();
  $('#toolTide').onclick = () => openTideWindows();
  $('#toolSky').onclick = () => openSkyAR({ autostart: false });
  $('#toolCompass').onclick = () => openCompassHere();
  $('#toolDial').onclick = () => openLightDialHere();
  $('#toolExposure').onclick = () => openExposure();
  // Field mode needs the live forecast for the next plan: load it, then redraw once.
  if (!nextPlan && S().plans.some(p => p.t >= now - 3600) && S().spots.length) {
    ensureForecasts().then(() => { allEvents({ includePast: true }); if (ui.tab === 'tools' && S().plans.some(p => p.t >= now - 3600 && eventIndex.has(p.key))) renderTools(v); });
  }
}
/* ================= lightning distance timer ================= */

export function openLightningTimer() {
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
  ui.onSheetClose = stop;

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
