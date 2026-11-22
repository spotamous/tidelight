// Tidelight: In the field: right now, the field compass, phone heading, sun line-ups with a view, and field mode.
import { fmtTime, dayKey, fmtDay, esc, getPosition, haversineKm, toast, compass, angleDiff, cap } from './util.js?v=7.2.1';
import { WEATHER_TEXT, placeName, fetchHourly, searchPlaces, fetchCurrent, fetchRadarFrames } from './api.js?v=7.2.1';
import { nearestIndex, tideInfo } from './scoring.js?v=7.2.1';
import { coverUrl } from './photos.js?v=7.2.1';
import { HUNT_LABEL } from './hunts.js?v=7.2.1';
import { $, $$, BEHIND_SHEET, closeSheet, eventIndex, forecasts, openSheet, placeTz, S, sessionName, ui } from './core.js?v=7.2.1';
import { TYPE_NAME, spotTile } from './forecast.js?v=7.2.1';
import { syncAgo } from './you.js?v=7.2.1';
import { openExposure } from './tools.js?v=7.2.1';
import { QUICK, dueToAsk, markAsked, openQuickRate } from './accuracy.js?v=7.2.1';
import { ratePlan } from './plans.js?v=7.2.1';

/* ================= right now ================= */

export let nowPlace = { kind: 'here' };   // last place chosen in the hourly forecast
export const WX_ICON = (code, day) => {
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
export function hourlySummary(fc) {
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
export function hourlyChart(fc) {
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
export function hourlyRows(fc, count) {
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
export async function loadHourly(place) {
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
export async function openNow(start) {
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
  ui.onSheetClose = () => { clearInterval(timer); if (radarMap) { radarMap.remove(); radarMap = null; } };

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
        ${coverUrl(sp) ? `<img class="spot-thumb" src="${coverUrl(sp)}" alt="">` : spotTile(sp, 'spot-thumb')}
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

export const WIND_WORDS = { N: 'north', NNE: 'north-northeast', NE: 'northeast', ENE: 'east-northeast', E: 'east', ESE: 'east-southeast', SE: 'southeast', SSE: 'south-southeast', S: 'south', SSW: 'south-southwest', SW: 'southwest', WSW: 'west-southwest', W: 'west', WNW: 'west-northwest', NW: 'northwest', NNW: 'north-northwest' };
// Phone compasses point to magnetic north; sun and star bearings are true north. Approximate magnetic
// declination (degrees east, around 2025) for Australia and New Zealand, blended by distance.
export const DECLINATION = [
  [-37.81, 144.96, 11.8], [-33.87, 151.21, 12.9], [-27.47, 153.03, 11.2], [-34.93, 138.6, 8.6], [-42.88, 147.33, 15.2],
  [-35.28, 149.13, 12.5], [-31.95, 115.86, -0.5], [-12.46, 130.84, 3.6], [-16.92, 145.77, 7.8], [-23.7, 133.88, 5.0],
  [-34.19, 142.16, 9.8], [-38.15, 144.36, 11.4], [-37.56, 143.85, 11.0], [-36.76, 144.28, 11.2], [-38.34, 141.6, 10.5],
  [-37.0, 147.5, 12.6], [-36.85, 174.76, 20.0], [-43.53, 172.64, 24.0], [-41.29, 174.78, 22.5], [-19.26, 146.82, 8.3],
];
export function declinationAt(lat, lon) {
  let wsum = 0, dsum = 0, nearest = Infinity;
  for (const [la, lo, d] of DECLINATION) {
    const km = haversineKm({ lat, lon }, { lat: la, lon: lo });
    nearest = Math.min(nearest, km);
    const w = 1 / Math.max(1, km) ** 2;
    wsum += w; dsum += w * d;
  }
  return nearest > 2500 ? null : dsum / wsum;   // too far from the table: no correction
}
export function compassTargets(e) {
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
export function openCompass(key, custom = null) {
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
  ui.onSheetClose = stop;
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
export function phoneHeading(onHeading, lat, lon) {
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
export function alignmentDates(lat, lon, facing) {
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
export function alignmentText(sp) {
  const runs = alignmentDates(sp.lat, sp.lon, sp.facing);
  if (runs == null) return '';
  if (!runs.length) return `The sun never rises or sets in this direction (${Math.round(Number(sp.facing))}° ${compass(Number(sp.facing))}), though it can still light the scene from the side.`;
  const fmt = r => `${r.kind} around ${r.at.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', timeZone: placeTz(sp) || undefined })}`;   // (the spot's own calendar)
  return `The sun lines up with this view: ${runs.map(fmt).join(', ')}.`;
}
/* ================= field mode ================= */
export let fieldState = null;   // { key, timer, wake, night }
export function fieldMoments(e) {
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
// "3 h 12 min", "25 min", "40 s". With precise (field mode's big countdown), minutes carry seconds: "4 min 07 s".
export function untilText(secs, precise = false) {
  secs = Math.max(0, secs);
  if (secs < 60) return `${Math.round(secs)} s`;
  if (secs < 3600) {
    const m = Math.floor(secs / 60), s2 = Math.floor(secs % 60);
    return precise && m < 10 ? `${m} min ${String(s2).padStart(2, '0')} s` : `${precise ? m : Math.round(secs / 60)} min`;
  }
  const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60);
  return m ? `${h} h ${m} min` : `${h} h`;
}
export function fieldConditions(e) {
  const data = forecasts[e.spot.id];
  if (!data) return '<p class="small muted">No forecast saved for this spot yet. Open it once with reception.</p>';
  const now = Date.now() / 1000;
  const i = nearestIndex(data.hours, now);
  if (i < 0) return '<p class="small muted">The saved forecast doesn\'t cover right now. Refresh when you have reception.</p>';
  const rows = [0, 1, 2].map(k => data.hours[i + k]).filter(Boolean).map((h, k) => `<div class="fc-row">
      <span class="fc-time num">${k === 0 ? 'Now' : fmtTime(h.t, data.offset).replace(':00', '')}</span>
      <span>Cloud: low ${Math.round(h.low ?? 0)}%, mid ${Math.round(h.mid ?? 0)}%, high ${Math.round(h.high ?? 0)}%</span>
      <span>Rain ${Math.round(h.pp ?? 0)}%, wind ${Math.round(h.wind ?? 0)} km/h</span>
    </div>`).join('');
  let tide = '';
  if (e.spot.coastal) {
    const td = tideInfo(data.hours, i);
    if (td) tide = `<p class="fc-tide">Tide ${Math.round(td.pos * 100)}% of its range and ${td.rising ? 'rising' : 'falling'}.</p>`;
  }
  const saved = Number(localStorage.getItem('tidelight:lastFetch') || 0);
  return `${rows}${tide}<p class="small muted">From the forecast saved ${saved ? syncAgo(saved) : 'earlier'}.</p>`;
}
export function drawField() {
  const st = fieldState;
  const el = $('#field');
  if (!st || !el) return;
  // (Keep our own copy: a session drops off the forecast soon after it ends, but field mode stays
  // open through the afterglow and blue hour, and asks how it was at the end.)
  const e = eventIndex.get(st.key) || st.e;
  if (!e) { closeField(); return; }
  st.e = e;
  const now = Date.now() / 1000;
  const moments = fieldMoments(e);
  const next = moments.find(m => m.t > now);
  // The light's done and this was a planned shoot: ask how it was, right here, while it's fresh.
  const plan = S().plans.find(x => x.key === st.key);
  if (st.rating) { /* the rating card (or its thanks) is showing: leave it be */ }
  else if (plan && !plan.rating && (!next || dueToAsk(plan, now))) {
    st.rating = true;
    markAsked(plan.id);
    const box = el.querySelector('#fmNext');
    box.innerHTML = `<p class="fm-next-label">The light's done. How was it?</p>
      <div class="qr-grid fm-rate">${QUICK.map((q, i) => `<button class="qr-btn ${i === 0 ? 'best' : ''}" data-fmq="${q.s10}">${q.ic}<span class="qr-t">${q.t}</span><span class="qr-s">${q.s}</span></button>`).join('')}</div>
      <div class="qr-more"><span>One tap is enough.</span><button class="link-btn" id="fmRateMore">More detail ›</button></div>`;
    box.querySelectorAll('[data-fmq]').forEach(b => b.onclick = async () => {
      box.querySelectorAll('[data-fmq]').forEach(x => { x.disabled = true; });
      b.classList.add('sel');
      await ratePlan(plan.id, Number(b.dataset.fmq), plan.tags || [], document.createElement('button'), { quiet: true });
      const word = QUICK.find(q => String(q.s10) === b.dataset.fmq)?.t || 'Rated';
      box.innerHTML = `<p class="fm-next-label">Rated: ${esc(word)}</p><p class="fm-at">Thanks. Your score learns from this. The real weather is checked in a few hours.</p>`;
    });
    box.querySelector('#fmRateMore').onclick = () => openQuickRate(plan.id);
  }
  const nextHtml = next
    ? `<p class="fm-next-label">${esc(next.label)} in</p><p class="fm-count num ${next.cls}">${untilText(next.t - now, true)}</p><p class="fm-at">at ${fmtTime(next.t, e.offset)}</p>`
    : `<p class="fm-next-label">That's the session done.</p><p class="fm-at">${plan?.rating ? 'Rated. Thanks.' : 'Plan a session before you go and Tidelight asks how it was, right here.'}</p>`;
  if (!st.rating) el.querySelector('#fmNext').innerHTML = nextHtml;
  // Announce only when the next moment changes, never every second.
  const said = next ? `Next: ${next.label} at ${fmtTime(next.t, e.offset)}.` : "That's the session done.";
  const sr = el.querySelector('#fmSay');
  if (sr && sr.textContent !== said) sr.textContent = said;
  el.querySelector('#fmList').innerHTML = moments.map(m => `<li class="${m.t <= now ? 'past' : ''} ${m.cls}">
      <time class="num">${fmtTime(m.t, e.offset)}</time><span>${esc(m.label)}</span><em class="num">${m.t > now ? `in ${untilText(m.t - now)}` : 'done'}</em></li>`).join('');
}
export async function openField(key) {
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
      <div><p class="fm-spot">${esc(e.spot.name)}</p><p class="fm-sub">${esc(cap(sessionName(e)))}, score ${e.score}${e.topHunt !== 'colour' ? ` for ${HUNT_LABEL[e.topHunt].toLowerCase()}` : ''}</p>
        ${(() => { const p = S().plans.find(x => x.key === e.key); if (!p || p.score == null) return ''; const d = e.score - p.score; return `<p class="fm-still ${d <= -10 ? 'down' : ''}">${Math.abs(d) < 5 ? 'Still on: the forecast has held since you planned it.' : d > 0 ? `Better than planned: up ${d} to ${e.score}.` : `Down ${-d} since you planned it, to ${e.score}.${e.score < 50 ? ' Check the radar before you commit.' : ''}`}</p>`; })()}</div>
      <button class="icon-btn" id="fmClose" aria-label="Close field mode"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
    </div>
    <section class="fm-next" id="fmNext"></section>
    <p class="sr-only" id="fmSay" aria-live="polite"></p>
    <ol class="fm-list" id="fmList"></ol>
    <h3 class="fm-h">The sky</h3>
    <div class="fm-cond">${fieldConditions(e)}</div>
    <div class="fm-actions">
      <button class="btn" data-compass="${esc(e.key)}">Compass</button>
      <button class="btn" id="fmRadar">Radar and hourly</button>
      <button class="btn" id="fmExposure">Exposure</button>
      <button class="btn" id="fmNight" aria-pressed="false">Night vision</button>
    </div>
    <p class="small muted fm-wake" id="fmWake"></p>`;
  el.setAttribute('aria-modal', 'true');
  document.body.appendChild(el);
  document.body.classList.add('noscroll');
  const returnTo = document.activeElement;
  BEHIND_SHEET.forEach(s => { const x = $(s); if (x) x.inert = true; });
  fieldState = { key, timer: setInterval(drawField, 1000), wake: null, night: false, returnTo };
  requestAnimationFrame(() => $('#fmClose')?.focus({ preventScroll: true }));
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
  $('#fmExposure').onclick = () => openExposure(['aurora', 'astro'].includes(e.topHunt) ? 'stars' : e.topHunt === 'waterfall' ? 'nd' : undefined);
  $('#fmRadar').onclick = () => openNow({ kind: 'spot', id: e.spot.id, lat: e.spot.lat, lon: e.spot.lon, name: e.spot.name });
  $('#fmNight').onclick = () => {
    fieldState.night = !fieldState.night;
    el.classList.toggle('nightvision', fieldState.night);
    document.body.classList.toggle('nv-sheets', fieldState.night);   // pop-ups opened from field mode go red too
    $('#fmNight').setAttribute('aria-pressed', String(fieldState.night));
  };
}
export function closeField() {
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
  if ($('#sheet').classList.contains('hidden')) {
    document.body.classList.remove('noscroll');
    BEHIND_SHEET.forEach(s => { const x = $(s); if (x) x.inert = false; });
  }
  if (el && st?.returnTo?.isConnected) st.returnTo.focus({ preventScroll: true });
}
