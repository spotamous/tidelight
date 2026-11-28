// Tidelight: big seas on screen (7.5): the Big seas view on the Forecast page, the banner that points to
// it, the spot's history check, and planning a big-seas shoot. The maths is in seas.js.
import { esc, fmtTime, fmtDay, toast, uid } from './util.js?v=7.5.1';
import { update } from './storage.js?v=7.5.1';
import { driveMinutes, hikeMinutes } from './scoring.js?v=7.5.1';
import { S, forecasts } from './core.js?v=7.5.1';
import { seasForSpots, seasOn, seasReady, seasWhen, seasSwell, seasLightLine, seasNotes, compass16, COMPASS_NAME, thresholdOf, buildClimate, SEAS_DEFAULT_TOP } from './seas.js?v=7.5.1';

const WAVE_ICON = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 16c2 0 2-1.5 4-1.5S8 16 10 16s2-1.5 4-1.5 2 1.5 4 1.5 2-1.5 4-1.5"/><path d="M3 12c1.5-4 5-7 9-7 2.5 0 4 1.5 4 3.5S14.5 11 13 11c-1.2 0-2-.8-2-1.8"/><path d="M2 20c2 0 2-1.5 4-1.5S8 20 10 20s2-1.5 4-1.5 2 1.5 4 1.5 2-1.5 4-1.5"/></svg>';
export const anySeas = () => S().spots.some(seasReady);

/* ---------- the outlook, fetched with the forecasts ---------- */
let seas = { at: 0, sig: '', list: [] };
const sigOf = spots => spots.filter(seasReady).map(s => `${s.id}:${s.seas.clim.at}:${s.seas.top}`).join('|');
export async function ensureSeas(force = false) {
  const spots = S().spots, sig = sigOf(spots);
  if (!sig) { seas = { at: 0, sig: '', list: [] }; return seas.list; }
  if (!force && seas.sig === sig && Date.now() - seas.at < 30 * 60e3) return seas.list;
  const list = await seasForSpots(spots, { hoursFor: sp => forecasts[sp.id]?.hours || null });
  seas = { at: Date.now(), sig, list };
  return list;
}
export const seasEvents = () => seas.list.flatMap(x => x.events || []).sort((a, b) => a.t - b.t);

/* ---------- the banner on the normal forecast ---------- */
export function seasBanner() {
  const e = seasEvents()[0];
  if (!e) return '';
  const more = seasEvents().length - 1;
  return `<button class="seas-banner" data-weektype="seas">
    <span class="sb-icon">${WAVE_ICON}</span>
    <span class="sb-text"><b>Big seas ${esc(fmtDay(e.t, e.offset))} at ${esc(e.spot.name)}</b><small>${esc(seasSwell(e))}. ${esc(e.rankText)}.${more > 0 ? ` +${more} more` : ''}</small></span>
    <span class="sb-go" aria-hidden="true">›</span>
  </button>`;
}

/* ---------- the Big seas view ---------- */
function chart(x) {
  const days = (x.days || []).slice(0, 8);
  if (!days.length) return '';
  const W = 350, Hh = 110, top = Math.max(1.4, ...days.map(d => d.ratio)) * 1.08;
  const xAt = i => (i + 0.5) * (W / days.length), yAt = r => Hh - 8 - (Math.min(r, top) / top) * (Hh - 20);
  const pts = days.map((d, i) => [xAt(i), yAt(d.ratio)]);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ');
  const ty = yAt(1);
  const big = days.findIndex(d => d.ratio >= 1);
  const label = big >= 0 ? `Swell power crosses the top-${x.spot.seas.top ?? SEAS_DEFAULT_TOP} line on ${fmtDay(days[big].t, x.offset)}` : `Swell power stays below the top-${x.spot.seas.top ?? SEAS_DEFAULT_TOP} line this week`;
  return `<figure class="seas-chart"><div class="sc-plot">
    <svg viewBox="0 0 ${W} ${Hh}" role="img" aria-label="${esc(label)}" preserveAspectRatio="none">
      <path d="${line} L${pts[pts.length - 1][0].toFixed(1)} ${Hh} L${pts[0][0].toFixed(1)} ${Hh} Z" class="sc-fill"/>
      <path d="${line}" class="sc-line"/>
      <line x1="0" x2="${W}" y1="${ty.toFixed(1)}" y2="${ty.toFixed(1)}" class="sc-thr"/>
      ${pts.map((p, i) => days[i].ratio >= 1 ? `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="5" class="sc-dot"/>` : '').join('')}
    </svg>
    <span class="sc-thr-label" style="top:${(ty / Hh * 100).toFixed(1)}%">Top ${x.spot.seas.top ?? SEAS_DEFAULT_TOP} a year</span></div>
    <figcaption class="sc-days">${days.map(d => `<span class="${d.ratio >= 1 ? 'on' : ''}">${esc(new Date((d.t + x.offset) * 1000).toUTCString().slice(0, 3))}</span>`).join('')}</figcaption>
  </figure>`;
}
function card(e) {
  const o = e.offset;
  const standout = e.ratio >= 1.3;
  const tideOk = e.tide && e.best && Math.abs(e.tide - e.best.t) <= 3 * 3600;
  const planned = S().plans.some(p => p.key === `seas:${e.key}`);
  return `<article class="seas-card">
    <div class="sc-head">
      <div><p class="sc-eyebrow">Big seas</p><h2 class="sc-title">${standout ? 'A standout.' : 'A rare one.'}</h2></div>
      <div class="sc-rank"><b class="num">#${e.rank.perYear}</b><small>of a typical year</small></div>
    </div>
    <p class="sc-where">${esc(e.spot.name)} · ${esc(seasWhen(e))}</p>
    ${e.night ? `<p class="sc-night">${esc(seasLightLine(e))}</p>` : ''}
    <dl class="sc-stats">
      <div><dt>Swell</dt><dd class="num">${(+e.h).toFixed(1)} m</dd><dd class="sub">${Math.round(e.T)} s · ${compass16(e.dir)}</dd></div>
      <div><dt>High tide</dt><dd class="num">${tideOk ? fmtTime(e.tide, o) : '–'}</dd><dd class="sub">${tideOk ? 'near the best hour' : 'not near the peak'}</dd></div>
      <div><dt>Wind</dt><dd class="num">${e.wind != null ? `${Math.round(e.wind)} km/h` : '–'}</dd><dd class="sub">${e.best ? `at ${fmtTime(e.best.t, o)}` : ''}</dd></div>
    </dl>
    <ul class="sc-notes">${seasNotes(e).map(n => `<li class="${n.k}">${esc(n.t)}</li>`).join('')}
      <li class="neutral">${esc(e.rankText)}</li></ul>
    <div class="sc-actions">
      ${e.best ? `<button class="btn ${planned ? '' : 'primary'}" data-seasplan="${esc(e.key)}" ${planned ? 'disabled' : ''}>${planned ? 'Planned' : `Plan for ${fmtTime(e.best.t, o)}`}</button>` : ''}
      <button class="btn" data-seasspot="${esc(e.spot.id)}">The spot</button>
    </div>
  </article>`;
}
export function seasView() {
  const list = seas.list;
  const safety = `<div class="seas-safety" role="note"><b>Stay back.</b> Waves up to twice the forecast height are normal in seas like these. Keep well away from cliff edges, rock platforms and the beach, and check the Bureau of Meteorology's warnings before you go.</div>`;
  if (!list.length) return `<section class="call-empty"><p>No spots with Big seas on yet.</p><p class="small muted">Turn it on for a coastal spot under Edit spot → Coast and tide.</p></section>`;
  return `<div class="seas-view">
    ${list.map(x => {
      if (x.error) return `<section class="seas-spot"><h2 class="ss-name">${esc(x.spot.name)}</h2><p class="muted">${esc(x.error)}</p></section>`;
      const peak = [...(x.days || [])].sort((a, b) => b.ratio - a.ratio)[0];
      return `<section class="seas-spot">
        <div class="ss-head"><h2 class="ss-name">${esc(x.spot.name)}</h2><span class="small muted">Faces ${esc(COMPASS_NAME[compass16(x.clim.facing)] || '')}</span></div>
        ${chart(x)}
        ${x.events.length ? x.events.map(card).join('') : `<p class="ss-none">No big seas in the next week.${peak ? ` The biggest is ${esc(fmtDay(peak.t, x.offset))}, at ${Math.round(peak.ratio * 100)}% of a top-${x.spot.seas.top ?? SEAS_DEFAULT_TOP} swell.` : ''}</p>`}
      </section>`;
    }).join('')}
    ${safety}
  </div>`;
}
export function wireSeasView(v, { onSpot, rerender }) {
  v.querySelectorAll('[data-seasplan]').forEach(b => b.onclick = () => {
    const e = seasEvents().find(x => x.key === b.dataset.seasplan);
    if (!e) return;
    addSeasPlan(e);
    toast(`Planned: big seas at ${e.spot.name}, ${fmtDay(e.best.t, e.offset)} ${fmtTime(e.best.t, e.offset)}`);
    rerender();
  });
  v.querySelectorAll('[data-seasspot]').forEach(b => b.onclick = () => onSpot(b.dataset.seasspot));
}
export function addSeasPlan(e) {
  const st = S(), sp = e.spot, t = e.best.t;
  const leave = t - ((Number(st.settings.arriveBeforeMin ?? 30)) + (driveMinutes(sp, st.settings) || 0) + hikeMinutes(sp)) * 60;
  update(s => {
    const key = `seas:${e.key}`;
    if (s.plans.some(p => p.key === key)) return;
    s.plans.push({
      id: uid(), key, spotId: sp.id, spotName: sp.name, lat: sp.lat, lon: sp.lon,
      type: 'seas', t, dayT: null, leave, offset: e.offset, score: null, hunt: 'seas',
      brief: [`Big seas at ${sp.name}: ${seasSwell(e)}.`, `${e.rankText}.`, e.night ? seasLightLine(e) : `${seasWhen(e)}.`, e.tide ? `High tide ${fmtTime(e.tide, e.offset)}.` : '', 'Stay well back from cliff edges and rock platforms.'].filter(Boolean).join(' '),
      gear: [{ id: 'cloth', label: 'Lens cloths (several)', why: 'Salt spray' }, { id: 'raincover', label: 'Rain cover', why: 'Spray and squalls' }, { id: 'tripod', label: 'Sturdy tripod', why: 'Wind' }, { id: 'nd', label: 'ND filter', why: 'Long exposures of the surge' }],
      packed: [], rating: null,
      fc: { h: Math.round(e.h * 10) / 10, T: Math.round(e.T), dir: Math.round(e.dir), ratio: Math.round(e.ratio * 100) },
    });
  });
}

/* ---------- the spot: setting up and checking history ---------- */
// Work out what's rare at a spot (reads a few years of wave records). Quiet; reports by toast.
const building = new Set();
export async function refreshClimate(spotId, { announce = true } = {}) {
  const sp = S().spots.find(s => s.id === spotId);
  if (!sp || !seasOn(sp) || building.has(spotId)) return;
  building.add(spotId);
  try {
    const clim = await buildClimate(sp);
    update(s => { const x = s.spots.find(y => y.id === spotId); if (x) x.seas = { ...x.seas, clim, err: null }; });
    if (announce) toast(`Big seas ready for ${sp.name}: ${Math.round(clim.years)} years of wave records read.`, 4500);
  } catch (err) {
    update(s => { const x = s.spots.find(y => y.id === spotId); if (x) x.seas = { ...x.seas, err: err?.message || 'Couldn\'t read the wave records' }; });
    if (announce) toast(err?.message || 'Couldn\'t read the wave records', 5000);
  } finally { building.delete(spotId); seas.sig = ''; }
}
export const climateBuilding = id => building.has(id);

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function seasSpotSection(s) {
  if (!seasOn(s)) return '';
  const top = s.seas.top ?? SEAS_DEFAULT_TOP, c = s.seas.clim;
  if (!c) return `<h3 class="sec">Big seas</h3><p class="muted">${building.has(s.id) ? 'Reading this spot\'s wave records…' : s.seas.err ? esc(s.seas.err) : 'Not set up yet.'}</p>
    ${building.has(s.id) ? '' : '<button class="btn" id="seasRetry">Read the wave records</button>'}`;
  const k = Math.max(1, Math.round(top * c.years));
  const off = forecasts[s.id]?.offset ?? 39600;
  const fmtD = t => { const d = new Date((t + off) * 1000); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
  const list = c.storms.slice(0, k);
  const row = (x, i) => `<li><span class="sh-date">${fmtD(x.t)}</span><span class="sh-swell num">${x.h.toFixed(1)} m · ${x.T} s · ${compass16(x.dir)}</span><span class="sh-rank">#${i + 1}</span></li>`;
  return `<h3 class="sec">Big seas</h3>
    <p class="small">Faces ${esc(COMPASS_NAME[compass16(c.facing)] || `${c.facing}°`)}${c.auto ? ' (from where its biggest swells come from; change it under Edit spot)' : ''}. Alerts for the top ${top} swells a year, from ${Math.round(c.years)} years of wave records.</p>
    <p class="small muted">Here's every swell that would have alerted you. Check them against your photos or days you remember: if they don't look wild enough, pick a rarer setting under Edit spot.</p>
    <ol class="seas-history">${list.slice(0, 6).map(row).join('')}</ol>
    ${list.length > 6 ? `<details class="seas-more"><summary>Show all ${list.length}</summary><ol class="seas-history" start="7">${list.slice(6).map((x, i) => row(x, i + 6)).join('')}</ol></details>` : ''}
    <p class="small muted">Each date is that storm's biggest day. Wave records are a model of the open sea, so close to the cliffs the real thing can run bigger or smaller.</p>`;
}
export function wireSeasSpot(s, rerender) {
  const b = document.getElementById('seasRetry');
  if (b) b.onclick = async () => { b.disabled = true; b.textContent = 'Reading…'; await refreshClimate(s.id); rerender(); };
}
// After a spot is saved: read the records if they're missing or the facing changed.
export function afterSpotSave(spotId) {
  const sp = S().spots.find(s => s.id === spotId);
  if (!sp || !seasOn(sp)) return;
  const c = sp.seas.clim;
  const want = sp.seas.facing ?? '';
  const changed = !c || (want === '' ? !c.auto : (c.auto || Number(want) !== c.facing));
  if (changed) { toast(`Reading ${sp.name}'s wave records for Big seas…`, 3500); refreshClimate(spotId); }
}
export { thresholdOf };
