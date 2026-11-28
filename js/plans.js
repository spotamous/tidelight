// Tidelight: The Plans tab: upcoming, crew and history views, gear lists, alarms and rating a shoot.
import { update } from './storage.js?v=7.5.2';
import { uid, downloadFile, esc, fmtDay, fmtTime, fmtWeekday, cap, toast } from './util.js?v=7.5.2';
import { gearFor } from './gear.js?v=7.5.2';
import { currentUser, unshareFromCrew } from './sync.js?v=7.5.2';
import { RATING_TAGS, ratingScore, featureVector, labelFor } from './scoring.js?v=7.5.2';
import { fetchHistorical } from './api.js?v=7.5.2';
import { crewPanel, crewState, loadCrew, openShareSheet, sessionKeyOf, wireCrewPanel } from './crews.js?v=7.5.2';
import { $, $$, S, allEvents, briefing, chips, closeSheet, ensureForecasts, eventIndex, openSheet, sessionName, ui } from './core.js?v=7.5.2';
import { TYPE_NAME, whyLine } from './forecast.js?v=7.5.2';
import { untilText } from './field.js?v=7.5.2';
import { render, setTab } from './app.js?v=7.5.2';
import { snap } from './records.js?v=7.5.2';
import { accuracySummary, openQuickRate, openRecord, verdictMark, wireAccuracySummary } from './accuracy.js?v=7.5.2';

/* ================= plans ================= */

export function addPlan(e) {
  update(s => {
    if (s.plans.some(p => p.key === e.key)) return;
    s.plans.push({
      id: uid(), key: e.key, spotId: e.spot.id, spotName: e.spot.name, lat: e.spot.lat, lon: e.spot.lon,
      type: e.type, t: e.t, dayT: e.dayT ?? null, leave: e.leave, offset: e.offset, score: e.score, hunt: e.topHunt,
      sessionKey: sessionKeyOf(e.spot.lat, e.spot.lon, e.type, e.t), features: e.features,
      brief: briefing(e), gear: gearFor(e, s.settings), packed: [], rating: null,
      fc: snap(e),   // the forecast when you planned it, for the shoot record
    });
  });
}
export function icsText({ id, title, start, end, desc, lat, lon, alarmMin = 15 }) {
  const fmt = t => new Date(t * 1000).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const escI = s => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Tidelight//EN', 'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT', `UID:${id}@tidelight`, `DTSTAMP:${fmt(Date.now() / 1000)}`,
    `DTSTART:${fmt(start)}`, `DTEND:${fmt(end)}`, `SUMMARY:${escI(title)}`,
    `DESCRIPTION:${escI(desc)}`, `GEO:${lat};${lon}`, `LOCATION:${lat.toFixed(5)}\\, ${lon.toFixed(5)}`,
    'BEGIN:VALARM', `TRIGGER:-PT${Math.max(0, Math.round(alarmMin))}M`, 'ACTION:DISPLAY', `DESCRIPTION:${escI(title)}`, 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR',
  ].join('\r\n');
}
export function downloadIcs(e) {
  const txt = icsText({
    id: e.key.replace(/[^a-z0-9]/gi, ''), title: `Leave for ${e.spot.name} ${e.type} (${e.score})`,
    start: e.leave, end: e.t + 30 * 60, desc: briefing(e), lat: e.spot.lat, lon: e.spot.lon, alarmMin: S().settings.readyMin ?? 30,
  });
  downloadFile(`tidelight-${e.type}.ics`, txt, 'text/calendar');
}
// How often the app's call matched your rating. A "go" call is a predicted score of 60+.
export function hitStats(plans) {
  const rated = plans.filter(p => p.rating && p.rating !== 'meh' && p.rating !== 'skipped');
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
export function hitPanel(st) {
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
export const openGear = new Set();   // which plans have their gear list open
export let plansTimer = null;        // keeps the "leave in…" line current
// "tomorrow sunrise, 6:17am" (callers capitalise it when it starts a sentence)
export function planWhen(p) {
  const day = fmtDay(p.dayT ?? p.t, p.offset).replace(/^(Today|Tomorrow|Yesterday)$/, d => d.toLowerCase());
  return `${day} ${(TYPE_NAME[p.type] || p.type).toLowerCase()}, ${fmtTime(p.t, p.offset)}`;
}
export function leaveText(p) {
  const now = Date.now() / 1000;
  if (p.leave - now > 36 * 3600) return `${S().settings.home ? 'Leave' : 'Be there'} ${fmtWeekday(p.leave, p.offset)} at ${fmtTime(p.leave, p.offset)}`;
  if (p.leave > now) return `${S().settings.home ? 'Leave' : 'Be there'} in ${untilText(p.leave - now)}`;
  if (p.t > now) return `Time to go: the session starts in ${untilText(p.t - now)}`;
  return 'The session has started';
}
// How the plan's score has moved since you planned it.
export function planDrift(p) {
  const e = eventIndex.get(p.key);
  if (!e || p.score == null) return '';
  const d = e.score - p.score;
  if (Math.abs(d) < 5) return `<p class="drift">Still ${e.score}. Steady since you planned it.</p>`;
  if (d > 0) return `<p class="drift up">Now ${e.score}, up ${d} since you planned it.</p>`;
  const why = whyLine(e);
  return `<p class="drift down">Now ${e.score}, down ${-d} since you planned it (${p.score}).${why ? ` ${esc(why)}.` : ''}${e.score < 50 ? ' Worth checking another spot.' : ''}</p>`;
}
export const planAlarm = p => p.leave - (S().settings.readyMin ?? 30) * 60;
export function gearChecklist(p, open) {
  const gear = p.gear || [];
  if (!gear.length) return '';
  const packed = new Set(p.packed || []);
  return `<details class="gear-list" ${open || openGear.has(p.id) ? 'open' : ''} data-gearbox="${p.id}">
      <summary>Gear: ${gear.filter(g => packed.has(g.id)).length} of ${gear.length} packed</summary>
      ${gear.map(g => `<label class="check gear-item"><input type="checkbox" data-pack="${p.id}" value="${esc(g.id)}" ${packed.has(g.id) ? 'checked' : ''}><span>${esc(g.label)}<small>${esc(g.why)}</small></span></label>`).join('')}
    </details>`;
}
export function planActions(p, lead) {
  const shared = (p.sharedTo || []).length;
  return `<div class="plan-actions">
      ${eventIndex.has(p.key) ? `<button class="btn ${lead ? 'primary' : ''}" data-field="${esc(p.key)}">Open field mode</button>` : ''}
      ${eventIndex.has(p.key) ? `<button class="btn" data-ev="${esc(p.key)}">Briefing</button>` : ''}
      ${currentUser() ? `<button class="btn" data-share="${p.id}">${shared ? 'Shared with crew' : 'Share with crew'}</button>` : ''}
    </div>
    <div class="bf-quiet">
      <button class="link-btn" data-ics="${p.id}">Add to calendar</button>
      <button class="link-btn danger" data-del="${p.id}">Remove plan</button>
    </div>`;
}
export async function renderPlans(v, refreshed = false) {
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
        <div class="rate-btns"><button class="btn primary" data-quick-open="${p.id}">Rate the light</button></div></div>`).join('')}
    </section>` : ''}
    ${next ? `<section class="next-up">
      <h2 class="nu-name">${esc(next.spotName)}</h2>
      <p class="nu-when">${esc(cap(planWhen(next)))}.</p>
      ${planDrift(next)}
      <dl class="call-times nu-times">
        ${S().settings.home ? `<div><dt>Alarm</dt><dd class="num">${fmtTime(planAlarm(next), next.offset)}</dd></div>` : ''}
        <div><dt>${S().settings.home ? 'Leave' : 'Be there by'}</dt><dd class="num">${fmtTime(next.leave, next.offset)}</dd></div>
      </dl>
      <p class="nu-in num" id="leaveIn">${esc(cap(leaveText(next)))}</p>
      ${gearChecklist(next, true)}
      ${planActions(next, true)}
    </section>` : `<section class="empty-plans">
      <p>Pick a session on the Forecast page and tap <strong>Plan this shoot</strong>. It shows up here with its leave time, a gear list to pack and field mode.</p>
      <button class="btn primary" id="toForecast">Go to Forecast</button>
    </section>`}
    ${later.length ? `<section class="later">
      <h3 class="sec">After that</h3>
      ${later.map(p => `<details class="plan-item" ${openGear.has('item:' + p.id) ? 'open' : ''} data-item="${p.id}">
        <summary><span class="pi-name">${esc(p.spotName)}</span><span class="pi-when">${esc(cap(planWhen(p)))}${eventIndex.get(p.key) ? `, now ${eventIndex.get(p.key).score}` : ''}</span><span class="pi-leave num">Leave ${fmtTime(p.leave, p.offset)}</span></summary>
        ${planDrift(p)}
        ${gearChecklist(p, false)}
        ${planActions(p, false)}
      </details>`).join('')}
    </section>` : ''}`;

  const historyView = () => `
    ${accuracySummary()}
    ${rated.length ? `<section><h3 class="sec">Rated sessions</h3>
      ${rated.slice(0, 40).map(p => {
        const tagNames = (p.tags || []).map(t => Object.values(RATING_TAGS).flat().find(([k]) => k === t)?.[1]).filter(Boolean);
        return `<button class="hist-row hist-btn" data-rec-open="${p.id}" aria-label="What happened at ${esc(p.spotName)}">
        <span class="hist-name">${esc(p.spotName)}<small>${esc(cap(planWhen(p)))}${tagNames.length ? `. ${esc(tagNames.join(', '))}` : ''}</small></span>
        <span class="hist-score num" title="Predicted">${p.score ?? '–'}</span>
        <span class="hist-rating ${p.rating}">${p.rating === 'skipped' ? label.skipped : `${ratingScore(p)}/10`}${verdictMark(p)}</span>
      </button>`;
      }).join('')}
      <p class="small muted">The middle number is what Tidelight predicted. Tap a shoot to see what the weather actually did, or to change its rating.</p></section>` : '<p class="muted">No rated sessions yet. After a planned session passes, it appears under Upcoming to rate.</p>'}
    <div id="unplanned"></div>`;

  v.innerHTML = `
    <h1 class="page-title">Plans</h1>
    <p class="page-lede">${esc(lede)}</p>
    <div class="day-pills" role="tablist" aria-label="Plans views">
      ${[['upcoming', `Upcoming${upcoming.length ? ` (${upcoming.length})` : ''}`], ['crew', 'Crew'], ['history', 'History']]
        .map(([k, t]) => `<button role="tab" aria-selected="${ui.plansView === k}" class="${ui.plansView === k ? 'on' : ''}" data-pview="${k}">${t}</button>`).join('')}
    </div>
    <div class="plans-view">${ui.plansView === 'upcoming' ? upcomingView() : ui.plansView === 'crew' ? crewPanel() : historyView()}</div>`;

  $$('[data-pview]', v).forEach(b => b.onclick = () => { ui.plansView = b.dataset.pview; renderPlans(v); });
  if (ui.focusPlanKey) {
    const fp = S().plans.find(p => p.key === ui.focusPlanKey); ui.focusPlanKey = null;
    const el = fp && ($(`[data-item="${fp.id}"]`, v) || $('.next-up', v));
    if (el) requestAnimationFrame(() => el.scrollIntoView({ block: 'center' }));
  }
  const tf = $('#toForecast', v);
  if (tf) tf.onclick = () => setTab('forecast');
  if (next && $('#leaveIn', v)) plansTimer = setInterval(() => { const el = $('#leaveIn'); if (el && ui.tab === 'plans') { const t = cap(leaveText(next)); if (el.textContent !== t) el.textContent = t; } else clearInterval(plansTimer); }, 15000);

  $$('[data-ics]', v).forEach(b => b.onclick = () => {
    const p = S().plans.find(x => x.id === b.dataset.ics);
    downloadFile(`tidelight-${p.type}.ics`, icsText({
      id: p.id, title: `Leave for ${p.spotName} ${p.type}${p.score != null ? ` (${p.score})` : ''}`, start: p.leave, end: p.t + 1800,
      desc: p.brief || '', lat: p.lat, lon: p.lon, alarmMin: S().settings.readyMin ?? 30,
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
  $$('[data-rate-open]', v).forEach(b => b.onclick = () => openRating(b.dataset.rateOpen));
  $$('[data-quick-open]', v).forEach(b => b.onclick = () => openQuickRate(b.dataset.quickOpen));
  $$('[data-rec-open]', v).forEach(b => b.onclick = () => openRecord(b.dataset.recOpen));
  wireAccuracySummary(v);
  if (ui.plansView === 'crew') {
    wireCrewPanel(v);
    if (currentUser() && !crewState.loaded) loadCrew().then(() => { if (ui.tab === 'plans' && ui.plansView === 'crew') renderPlans(v); });
  }

  // Sessions need their live forecast loaded for field mode, the briefing, and logging unplanned shoots.
  if (!st.spots.length) return;
  const missing = upcoming.some(p => p.spotId && !eventIndex.has(p.key));
  await ensureForecasts();
  if (ui.tab !== 'plans') return;
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
    ui.plansView = 'upcoming';
    toast('Logged. Rate it at the top of Upcoming.');
    renderPlans(v);
  });
}
export const RATING_WORDS = ['Nothing happened', 'Nothing much', 'Not worth it', 'Flat', 'A little something', 'Decent, nothing special', 'Good', 'Really good', 'Properly good', 'Excellent', 'One of the best'];
// Rate a session's light 0–10, with optional reasons. Takes about five seconds.
export function openRating(id) {
  const p = S().plans.find(x => x.id === id);
  if (!p) return;
  let val = typeof p.lightScore === 'number' ? p.lightScore : 5;
  const tags = new Set(p.tags || []);
  const chips = (group, hint) => `<div class="rate-chips">${RATING_TAGS[group].map(([k, l]) => `<button type="button" class="chip-btn rate-chip ${tags.has(k) ? 'on' : ''}" data-tag="${k}" aria-pressed="${tags.has(k)}">${l}</button>`).join('')}</div>${hint ? `<p class="small muted">${hint}</p>` : ''}`;
  openSheet(`
    <h2 class="bf-name">How was the light?</h2>
    <p class="bf-when">${esc(p.spotName)}, ${esc(planWhen(p))}${p.score != null ? `. The app predicted ${p.score}.` : '.'}</p>
    <div class="rate-face" aria-live="polite">
      <p class="rate-num num" id="rNum">${val}</p>
      <p class="rate-word" id="rWord">${RATING_WORDS[val]}</p>
    </div>
    <input type="range" id="rSlider" class="rate-slider" min="0" max="10" step="1" value="${val}" aria-label="Light rating out of 10" aria-valuetext="${val} out of 10, ${RATING_WORDS[val]}">
    <div class="rate-ticks" aria-hidden="true">${[[0, 'Nothing'], [2, ''], [5, 'Decent'], [8, ''], [10, 'Best']].map(([n, l]) => `<span style="left:${n * 10}%"><b>${n}</b>${l}</span>`).join('')}</div>

    <h3 class="sec">What made it?</h3>${chips('made')}
    <h3 class="sec">What spoiled it?</h3>${chips('spoiled')}
    <h3 class="sec">Not the light's fault</h3>${chips('notLight', 'Sessions marked here don\'t teach the score, because the light wasn\'t the problem.')}

    <div class="sheet-actions">
      <button class="btn primary" id="rSave">Save rating</button>
      <button class="btn" id="rSkip">I didn't go</button>
    </div>`);
  const slider = $('#rSlider'), num = $('#rNum'), word = $('#rWord');
  const paint = () => {
    slider.style.setProperty('--val', `${val * 10}%`);
    slider.style.setProperty('--warm', String(val / 10));
    num.style.setProperty('--warm', String(val / 10));
    num.textContent = String(val); word.textContent = RATING_WORDS[val];
    slider.setAttribute('aria-valuetext', `${val} out of 10, ${RATING_WORDS[val]}`);
    num.classList.remove('bump'); void num.offsetWidth; num.classList.add('bump');
  };
  slider.oninput = () => { const n = Number(slider.value); if (n !== val) { val = n; paint(); } };
  $$('[data-tag]').forEach(b => b.onclick = () => {
    const k = b.dataset.tag;
    if (tags.has(k)) tags.delete(k); else tags.add(k);
    b.classList.toggle('on', tags.has(k)); b.setAttribute('aria-pressed', String(tags.has(k)));
  });
  $('#rSave').onclick = () => ratePlan(id, val, [...tags], $('#rSave'));
  $('#rSkip').onclick = () => {
    update(s2 => { const pl = s2.plans.find(x => x.id === id); pl.rating = 'skipped'; delete pl.lightScore; pl.tags = []; s2.keepers = s2.keepers.filter(k => k.planId !== id); });
    closeSheet(); toast("Noted. Sessions you didn't go to don't count."); render();
  };
  paint();
}
export async function ratePlan(id, score10, tags, btn, { quiet = false } = {}) {
  const p = S().plans.find(x => x.id === id);
  if (!p) return;
  btn.disabled = true; btn.textContent = 'Saving…';
  let features = p.features;
  try {
    // Use what actually happened rather than what was forecast.
    const { hour, tide } = await fetchHistorical(p.lat, p.lon, new Date(p.t * 1000));
    features = featureVector(hour, tide);
  } catch { /* fall back to the forecast snapshot */ }
  const label = labelFor(score10);
  update(s => {
    const pl = s.plans.find(x => x.id === id);
    pl.rating = label; pl.lightScore = score10; pl.tags = tags;
    s.keepers = s.keepers.filter(k => k.planId !== id);   // re-rating replaces the earlier rating
    s.keepers.push({
      id: uid(), label, score10, tags, source: 'session', planId: p.id,
      type: p.type, hunt: p.hunt || null, spotId: p.spotId || null,
      date: p.t * 1000, lat: p.lat, lon: p.lon, spotName: p.spotName, features, thumb: null,
    });
  });
  if (quiet) { render(); return; }   // (field mode shows its own thanks)
  closeSheet();
  toast(tags.some(t => RATING_TAGS.notLight.some(([k]) => k === t)) ? `Saved: ${score10}/10. Marked as not the light's fault, so it won't teach the score.` : `Saved: ${score10}/10. Your score just learned from that.`, 4500);
  render();
}
