// Tidelight: rating a shoot in one tap, what happened at a shoot, and How accurate is Tidelight?
import { update } from './storage.js?v=7.3.1';
import { esc, fmtTime, toast } from './util.js?v=7.3.1';
import { tuningReport } from './scoring.js?v=7.3.1';
import { $, $$, S, closeSheet, openSheet, ui } from './core.js?v=7.3.1';
import { TYPE_NAME } from './forecast.js?v=7.3.1';
import { openRating, planWhen, ratePlan } from './plans.js?v=7.3.1';
import { render, setTab } from './app.js?v=7.3.1';
import { youHead } from './you.js?v=7.3.1';
import { CALL_WORD, KIND_LABEL, accuracyReport, callOf, fillActuals, forecastOf, isRated, missWords, notLightsFault, ratedS10, verdict, weatherRows } from './records.js?v=7.3.1';

const svg = (d, w = 26) => `<svg class="qr-ic" viewBox="0 0 24 24" width="${w}" height="${w}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
// One tap each. The numbers are what they mean on the 0 to 10 scale.
export const QUICK = [
  { k: 'epic', s10: 9, t: 'Epic', s: 'One of the good ones', ic: svg('<circle cx="12" cy="14" r="4"/><path d="M12 5v2M5.6 7.6l1.4 1.4M18.4 7.6 17 9M3 14h2M19 14h2M3 19h18"/>') },
  { k: 'good', s10: 7, t: 'Good', s: 'Worth the trip', ic: svg('<path d="M7 17a5 5 0 0 1 10 0"/><path d="M12 9v2M6.3 11.3l1.4 1.4M17.7 11.3l-1.4 1.4M3 17h18"/>') },
  { k: 'okay', s10: 5, t: 'Okay', s: 'Something, not much', ic: svg('<path d="M7 18h10a4 4 0 0 0 .5-8 5.5 5.5 0 0 0-10.6 1.5A3.3 3.3 0 0 0 7 18z"/>') },
  { k: 'flat', s10: 2, t: 'Flat', s: 'Nothing happened', ic: svg('<path d="M3 12h18M6 16h12"/>') },
];
const sessionWord = p => (TYPE_NAME[p.type] || p.type).toLowerCase();
const dayWord = p => {
  const days = Math.round((startOfDay(Date.now() / 1000, p.offset) - startOfDay(p.t, p.offset)) / 86400);
  return days <= 0 ? (p.type === 'sunset' || p.type === 'night' ? 'Tonight' : p.type === 'sunrise' ? 'This morning' : 'Today') : days === 1 ? (p.type === 'sunrise' || p.type === 'day' ? 'Yesterday' : 'Last night') : `${days} days ago`;
};
const startOfDay = (t, off = 0) => Math.floor((t + off) / 86400) * 86400;

/* ================= quick rate ================= */
export function openQuickRate(id) {
  const p = S().plans.find(x => x.id === id);
  if (!p) return;
  markPrompted(id);
  const call = p.score != null ? callOf(p.score) : null;
  openSheet(`
    <p class="eyebrow">${esc(dayWord(p))} · ${esc(p.spotName)}</p>
    <h2 class="bf-name">How was the light?</h2>
    ${p.score != null ? `<div class="qr-ctx"><span class="qr-sc num">${p.score}</span><p>Tidelight called <b>${CALL_WORD[call]}</b> for ${esc(sessionWord(p))} at ${fmtTime(p.t, p.offset)}. One tap is enough. It's how the score learns what you like.</p></div>` : ''}
    <div class="qr-grid">${QUICK.map((q, i) => `<button class="qr-btn ${i === 0 ? 'best' : ''}" data-quick="${q.s10}">${q.ic}<span class="qr-t">${q.t}</span><span class="qr-s">${q.s}</span></button>`).join('')}</div>
    <div class="qr-more"><span>Want to say why, or rate out of 10?</span><button class="link-btn" id="qrMore">More detail ›</button></div>
    <button class="btn qr-skip" id="qrSkip">I didn't go</button>`);
  $$('[data-quick]').forEach(b => b.onclick = async () => {
    $$('[data-quick]').forEach(x => { x.disabled = true; });
    b.classList.add('sel');
    const s10 = Number(b.dataset.quick);
    await ratePlan(id, s10, p.tags || [], document.createElement('button'));
    fillActuals({ max: 2 });
  });
  $('#qrMore').onclick = () => openRating(id);
  $('#qrSkip').onclick = () => {
    update(s => { const pl = s.plans.find(x => x.id === id); pl.rating = 'skipped'; delete pl.lightScore; pl.tags = []; s.keepers = s.keepers.filter(k => k.planId !== id); });
    closeSheet(); toast("Noted. Sessions you didn't go to don't count."); render();
  };
}

// The morning after: offer to rate a shoot once, when the app opens (the notification does the same).
// When to ask, while it's still fresh: once the light has finished. Sunset: 45 minutes after (the
// afterglow and blue hour are done). Sunrise: an hour after. Daytime: two hours after the window opens.
// Night and Milky Way shoots run late, so those wait for 6am the next morning (local time at the spot).
// If you don't answer, one more ask the next morning, then never again.
const PROMPTED = 'tidelight:ratePrompted';
function prompted() {
  try {
    const v = JSON.parse(localStorage.getItem(PROMPTED) || '{}');
    return Array.isArray(v) ? Object.fromEntries(v.map(id => [id, [2, 0]])) : v;   // (7.1 kept a plain list: count those as asked twice)
  } catch { return {}; }
}
export function markAsked(id) { markPrompted(id); }
function markPrompted(id) {
  try {
    const all = prompted(), [n] = all[id] || [0];
    all[id] = [n + 1, Math.round(Date.now() / 1000)];
    const keep = Object.entries(all).sort((a, b) => b[1][1] - a[1][1]).slice(0, 60);
    localStorage.setItem(PROMPTED, JSON.stringify(Object.fromEntries(keep)));
  } catch {}
}
const nextMorning = p => startOfDay(p.t - 12 * 3600, p.offset) - (p.offset || 0) + 86400 + 6 * 3600;   // 6am local, the day after
export function lightDone(p) {
  if (p.type === 'sunset') return p.t + 45 * 60;
  if (p.type === 'sunrise') return p.t + 60 * 60;
  if (p.type === 'day') return p.t + 2 * 3600;
  return nextMorning(p);   // night
}
export function dueToAsk(p, now = Date.now() / 1000) {
  if (p.rating || !p.t || p.t < now - 3 * 86400) return false;
  return now >= lightDone(p);
}
export function shootToRate(now = Date.now() / 1000) {
  const asked = prompted();
  return S().plans.filter(p => {
    if (!dueToAsk(p, now)) return false;
    const [n, at] = asked[p.id] || [0, 0];
    if (n === 0) return true;
    // the one follow-up: the next morning, if the first ask was the evening before
    return n === 1 && now >= nextMorning(p) && at < nextMorning(p);
  }).sort((a, b) => b.t - a.t)[0] || null;
}
export function maybePromptRating() {
  if (!$('#sheet').classList.contains('hidden') || $('#welcome') || $('.skyar') || $('#field')) return false;   // (field mode asks in its own card)
  const p = shootToRate();
  if (!p) return false;
  openQuickRate(p.id);
  return true;
}

/* ================= what happened ================= */
const VERDICT_TEXT = {
  right: v => ({ h: 'Called it', p: `Tidelight said ${CALL_WORD[v.said]} and you rated it ${v.s10} out of 10.` }),
  forecast: v => ({ h: 'The forecast missed, not the score', p: `With the weather that actually came, Tidelight would have said ${CALL_WORD[v.real]}. Nothing here changes how it scores this kind of sky.` }),
  score: v => ({ h: 'The score missed', p: `Even with the weather that actually came, Tidelight would have said ${v.realScore} (${CALL_WORD[v.real]}), and you rated it ${v.s10}. Shoots like this are what your personal score learns from.` }),
  unknown: v => ({ h: `Tidelight said ${CALL_WORD[v.said]}, you rated it ${v.s10}`, p: 'Whether the forecast or the score missed shows once the weather records for this shoot are in.' }),
};
export function openRecord(id) {
  const p = S().plans.find(x => x.id === id);
  if (!p) return;
  const v = verdict(p);
  const a = p.actual && !p.actual.error ? p.actual : null;
  const fc = p.last?.fc || forecastOf(p);
  const rows = a ? weatherRows(fc, a.fc) : [];
  const s10 = isRated(p) ? ratedS10(p) : null;
  const vt = v ? VERDICT_TEXT[v.kind](v) : null;
  const miss = a && fc ? missWords(fc, a.fc) : '';
  const tone = v?.kind === 'right' ? 'ok' : v?.kind === 'unknown' ? '' : 'off';
  const tiles = [
    [p.score, 'When you planned'],
    p.last ? [p.last.score, 'Last forecast'] : null,
    a ? [a.score, 'With the real weather', callOf(a.score) !== (v?.you || callOf(a.score)) ? 'miss' : ''] : null,
    s10 != null ? [s10, 'Your rating /10', 'you'] : null,
  ].filter(Boolean);
  const series = a?.series || [];
  const maxLow = Math.max(1, ...series.map(h => h.low ?? 0));
  openSheet(`
    <p class="eyebrow">${esc(new Date((p.t + p.offset) * 1000).toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }))} · ${esc(p.spotName)}</p>
    <h2 class="bf-name">What happened</h2>
    <p class="bf-when">${esc(TYPE_NAME[p.type] || p.type)}, ${fmtTime(p.t, p.offset)}.${s10 != null ? ` You rated it <b class="rec-you">${s10} out of 10</b>.` : p.rating === 'skipped' ? " You didn't go." : ' Not rated yet.'}</p>
    <div class="rec-scores" style="--n:${tiles.length}">${tiles.map(([n, l, c]) => `<div class="${c || ''}"><b class="num">${n ?? '–'}</b><span>${l}</span></div>`).join('')}</div>
    ${vt ? `<div class="rec-verdict ${tone}"><h4>${esc(vt.h)}</h4><p>${(v.kind === 'forecast' || v.kind === 'score') && miss ? esc(miss) + ' ' : ''}${esc(vt.p)}</p></div>` : ''}
    ${a ? `<h3 class="sec">Forecast vs what the sky did, at ${fmtTime(p.t, p.offset)}</h3>
      <table class="rec-table">
        <tr><th></th><th>${p.last ? 'Last forecast' : 'Forecast'}</th><th>Actual</th></tr>
        ${rows.map(r => `<tr><td>${r.label}</td><td>${esc(r.fc)}</td><td class="${r.off ? 'off' : ''}">${esc(r.actual)}</td></tr>`).join('')}
      </table>
      ${fc?.fromFeatures ? '<p class="small muted">This plan was made before Tidelight kept the full forecast, so this is the forecast it scored from.</p>' : ''}
      ${series.length > 2 ? `<h3 class="sec">Cloud through the ${p.type === 'sunrise' ? 'morning' : p.type === 'day' ? 'day' : 'evening'}</h3>
        <div class="rec-time" role="img" aria-label="Low cloud each hour around the shoot">${series.map(h => `<i class="${Math.abs(h.t - p.t) < 1800 ? 'at' : ''}" style="--a:${((h.low ?? 0) / maxLow * 0.85 + 0.1).toFixed(2)}" title="${fmtTime(h.t, p.offset)}: low ${h.low ?? '–'}%, mid ${h.mid ?? '–'}%, high ${h.high ?? '–'}%"></i>`).join('')}</div>
        <div class="rec-time-l"><span>${fmtTime(series[0].t, p.offset)}</span><span>${esc(sessionWord(p))} ${fmtTime(p.t, p.offset)}</span><span>${fmtTime(series[series.length - 1].t, p.offset)}</span></div>
        <p class="small muted">Shading is low cloud, the kind that blocks the light. Tap a square for the hour.</p>` : ''}`
    : p.actual?.error ? '<p class="muted">The weather records for this shoot couldn\'t be fetched. Tidelight will try again later.</p>'
    : `<p class="muted">What the weather actually did is fetched a few hours after a shoot${navigator.onLine ? '' : ', once you\'re back online'}.</p>`}
    ${notLightsFault(p) ? '<p class="small muted">Marked as not the light\'s fault, so it isn\'t counted in How accurate is Tidelight?</p>' : ''}
    <div class="sheet-actions"><div class="row">
      <button class="btn" id="recRate">${isRated(p) ? 'Change rating' : 'Rate it'}</button>
      <button class="btn" id="recAcc">How accurate is Tidelight?</button>
    </div></div>
    <p class="small muted">Actual weather is Open-Meteo's record for this spot, fetched after the shoot.</p>`);
  $('#recRate').onclick = () => (isRated(p) ? openRating(id) : openQuickRate(id));
  $('#recAcc').onclick = () => { closeSheet(); openAccuracy(); };
  // fetch it now if it's due and missing
  if (!a && !p.actual?.error && p.t < Date.now() / 1000 - 4 * 3600 && navigator.onLine) {
    fillActuals({ max: 3 }).then(n => { if (n && $('#recRate') && $('#sheetBody .bf-name')?.textContent === 'What happened') openRecord(id); });
  }
}

/* ================= history: one line per shoot ================= */
export function verdictMark(p) {
  const v = verdict(p);
  if (!v) return '';
  const t = { right: ['ok', 'Called it'], forecast: ['fc', 'Forecast off'], score: ['sc', 'Score off'], unknown: ['', ''] }[v.kind];
  return t[1] ? `<span class="hist-v ${t[0]}">${t[1]}</span>` : '';
}
export function accuracySummary() {
  const r = accuracyReport();
  if (r.n < 3) return `<section class="hit acc-mini"><h3 class="sec">How often the score is right</h3>
    <p class="muted">Rate ${3 - r.n} more shoot${3 - r.n === 1 ? '' : 's'} to see how accurate Tidelight is for you. Every rating also trains your personal score.</p></section>`;
  return `<button class="acc-mini acc-link" id="accOpen">
    <span class="acc-mini-k">How accurate is Tidelight?</span>
    <span class="acc-mini-h">Right <b>${r.right}</b> times in ${r.n}</span>
    <span class="acc-mini-s">${r.why.forecast ? `${r.why.forecast} miss${r.why.forecast === 1 ? ' was' : 'es were'} the forecast, not the score. ` : ''}See the full report ›</span>
  </button>`;
}
export function wireAccuracySummary(v) { const b = $('#accOpen', v); if (b) b.onclick = () => openAccuracy(); }
export function openAccuracy() {
  if (ui.tab !== 'you') setTab('you');   // (switching to You resets its page, so choose the page after)
  ui.youPage = 'accuracy'; render(); window.scrollTo(0, 0);
}

/* ================= How accurate is Tidelight? ================= */
function scatter(rows) {
  const W = 320, H = 210, P = 26;
  const x = v => P + v / 100 * (W - P - 8), y = r => H - P - r / 10 * (H - P - 10);
  const dots = rows.map(({ p, v }) => {
    const ok = v.kind === 'right';
    return `<circle cx="${x(p.score).toFixed(1)}" cy="${y(v.s10).toFixed(1)}" r="5.2" class="${ok ? 'dot-ok' : 'dot-miss'}"><title>${esc(p.spotName)}, ${esc(planWhen(p))}: predicted ${p.score}, you rated ${v.s10}</title></circle>`;
  }).join('');
  return `<svg class="acc-plot" viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Each shoot: the score Tidelight gave against your rating">
    <rect x="${x(75)}" y="${y(10)}" width="${x(100) - x(75)}" height="${y(7) - y(10)}" class="zone-go" rx="6"/>
    <rect x="${x(50)}" y="${y(6)}" width="${x(75) - x(50)}" height="${y(4) - y(6)}" class="zone-maybe" rx="6"/>
    <rect x="${x(0)}" y="${y(3)}" width="${x(50) - x(0)}" height="${y(0) - y(3)}" class="zone-skip" rx="6"/>
    <line x1="${x(0)}" y1="${y(0)}" x2="${x(100)}" y2="${y(10)}" class="diag"/>
    ${[0, 50, 75, 100].map(v => `<text x="${x(v)}" y="${H - 8}" text-anchor="middle">${v}</text>`).join('')}
    ${[0, 5, 10].map(r => `<text x="${P - 8}" y="${y(r) + 3}" text-anchor="end">${r}</text>`).join('')}
    ${dots}
  </svg>
  <div class="rec-key"><span class="k-ok">Called it</span><span class="k-miss">Missed</span></div>
  <p class="small muted">Across: the score Tidelight gave. Up: your rating. The shaded boxes are where Go, Maybe and Skip were right.</p>`;
}
export function pageAccuracy(v) {
  const r = accuracyReport();
  const st = S();
  const tune = tuningReport(st.keepers, st.spots, st.settings);
  const pct = n => (r.n ? Math.round(n / r.n * 100) : 0);
  const kinds = Object.entries(r.kinds).sort((a, b) => b[1].n - a[1].n);
  const early = r.n < 40;
  v.innerHTML = `${youHead('How accurate is Tidelight?', "Checked against every shoot you've rated. It gets sharper the more you rate.")}
    ${r.n < 3 ? `<div class="acc-card"><h3>Not enough ratings yet</h3><p>Rate ${3 - r.n} more shoot${3 - r.n === 1 ? '' : 's'} and this page shows how often Tidelight's Go, Maybe and Skip matched the light you got. After a planned shoot, Tidelight asks the next morning.</p></div>` : `
    <div class="acc-hero">
      <p class="k">Your ${r.n === 1 ? '' : `last ${r.n} `}rated shoots</p>
      <h2>Right <em>${r.right}</em> times in ${r.n}</h2>
      <p>Go, Maybe or Skip matched how you rated the light ${pct(r.right)}% of the time.</p>
      <div class="acc-dots" aria-hidden="true">${r.rows.slice().reverse().map(x => `<i class="${x.v.kind === 'right' ? '' : 'no'}"></i>`).join('')}</div>
      ${early ? `<span class="acc-early"><svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M6 1a5 5 0 0 1 5 5H6z" fill="currentColor"/></svg>Early days: steadier after about 40 ratings</span>` : ''}
    </div>
    <div class="acc-card"><h3>Predicted vs your rating</h3><p>Each dot is one shoot. Missed ones are hollow.</p>${scatter(r.rows)}</div>
    ${r.n - r.right ? `<div class="acc-card"><h3>Why it missed</h3><p>Each miss is checked against the weather that actually came.</p>
      <div class="acc-why">
        ${r.why.forecast ? `<div><b class="num">${r.why.forecast}</b><p><strong>The forecast was off.</strong> The weather that came wasn't what was forecast, and with the real weather the score would have been right. Nothing to fix in the score.</p></div>` : ''}
        ${r.why.score ? `<div><b class="num">${r.why.score}</b><p><strong>The score was off.</strong> Even with the weather that actually came, the score would have missed. These are what your personal score learns from.</p></div>` : ''}
        ${r.why.unknown ? `<div><b class="num">${r.why.unknown}</b><p><strong>Still checking.</strong> The weather records for ${r.why.unknown === 1 ? 'this one haven\'t' : 'these haven\'t'} been fetched yet${navigator.onLine ? '' : ' (you\'re offline)'}.</p></div>` : ''}
      </div>
      ${r.actualN >= 3 ? `<p class="small muted">With the weather that really came, the score alone was right ${r.realRight === 1 ? 'once' : `${r.realRight} times`} in ${r.actualN}.</p>` : ''}</div>` : ''}
    ${kinds.length > 1 ? `<div class="acc-card"><h3>By kind of shoot</h3><p>How often it called it right.</p>
      <div class="acc-split">${kinds.map(([k, c]) => `<span>${KIND_LABEL[k] || k}</span><span class="n">${c.right} of ${c.n}</span><div class="bar"><i class="${c.n >= 3 && c.right / c.n < 0.6 ? 'weak' : ''}" style="width:${Math.round(c.right / c.n * 100)}%"></i></div>`).join('')}</div>
      ${kinds.some(([, c]) => c.n < 3) ? '<p class="small muted">Kinds with fewer than three shoots are too early to read much into.</p>' : ''}</div>` : ''}
    ${tune.n >= 5 ? `<div class="acc-card"><h3>Is the learning helping?</h3><p>Your ${tune.n} rated sunrises and sunsets${tune.n > r.n ? ' (including rated photos)' : ''}, scored both ways.</p>
      <div class="acc-vs">
        <div class="${tune.std.right > tune.tuned.right ? 'win' : ''}"><b class="num">${Math.round(tune.std.right / tune.n * 100)}%</b><span>Standard score</span></div>
        <div class="${tune.tuned.right >= tune.std.right ? 'win' : ''}"><b class="num">${Math.round(tune.tuned.right / tune.n * 100)}%</b><span>Tuned to you</span></div>
      </div>
      <p class="small muted">${tune.tuned.right > tune.std.right ? 'Your ratings are making the score more accurate for you.' : tune.tuned.right === tune.std.right ? 'About the same so far. It pulls ahead as ratings build up.' : 'Not helping yet on these shoots. More ratings, especially of so-so light, sharpen it.'} Each shoot is scored without its own rating, so it can't mark its own homework.</p></div>` : ''}
    <h3 class="sec">Shoot by shoot</h3>
    <div class="lib acc-list">${r.rows.slice(0, 30).map(({ p, v: vv }) => `<button class="other-row acc-row" data-rec="${p.id}">
      <span class="acc-row-n">${esc(p.spotName)}<small>${esc(planWhen(p))}</small></span>
      <span class="acc-row-s num">${p.score}<small>${vv.s10}/10</small></span>${verdictMark(p)}</button>`).join('')}</div>
    `}
    <p class="small muted">Only your own ratings are used. Shoots marked "not the light's fault" (crowds, late, gear) are left out.</p>`;
  $$('[data-rec]', v).forEach(b => b.onclick = () => openRecord(b.dataset.rec));
  // first visit after updating: fill in what happened for past shoots, then redraw
  if (r.why.unknown && navigator.onLine) fillActuals({ max: 12 }).then(n => { if (n && ui.tab === 'you' && ui.youPage === 'accuracy') pageAccuracy(v); });
}
