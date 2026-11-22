// Tidelight: The entry point: the tab router and start-up. Everything else lives in the modules it imports.
import { startErrorReports, flushErrors, report } from './report.js?v=7.2';
import { fillActuals } from './records.js?v=7.2';
import { maybePromptRating, openQuickRate } from './accuracy.js?v=7.2';
import { esc, toast, fmtTime, uid } from './util.js?v=7.2';
import { setNewPassword, onPasswordRecovery, initSync, currentUser, onSyncStatus } from './sync.js?v=7.2';
import { update } from './storage.js?v=7.2';
import { loadAllPhotos } from './photos.js?v=7.2';
import { restoreForecasts } from './api.js?v=7.2';
import { $, $$, S, closeSheet, eventIndex, forecasts, openSheet, refreshInBackground, ui } from './core.js?v=7.2';
import { TYPE_NAME, applyMotion, applyTheme, commitPanel, homeTimer, motionOK, openLab, renderForecast, undoPlan } from './forecast.js?v=7.2';
import { addPlan, downloadIcs, openGear, plansTimer, renderPlans } from './plans.js?v=7.2';
import { openSpotForm, renderSpots } from './spots.js?v=7.2';
import { openLightDial, openLightningTimer, renderTools } from './tools.js?v=7.2';
import { applyTextSize, renderAccount, renderAlerts, renderYou } from './you.js?v=7.2';
import { afterPlanned, crewState, loadCrew, openSharedSpot } from './crews.js?v=7.2';
import { closeField, openCompass, openField, openNow } from './field.js?v=7.2';
import { openEvent } from './event.js?v=7.2';
import { closeWelcome, hasNews, maybeWelcome, openWhatsNew, welcome } from './welcome.js?v=7.2';

/* ================= router ================= */

// Switching tabs: the page slides the way you're moving along the tab bar, while the header and the
// tab bar stay put. Each tab keeps where you'd scrolled to (the forecast always opens at the top).
export const TAB_ORDER = ['forecast', 'spots', 'plans', 'tools', 'you'];
export const tabScroll = {};
export let tabVT = null;
export function setTab(t) {
  if (t === ui.tab) {   // tapping the tab you're on: back to the top, like iOS
    if (t === 'you' && ui.youPage) { ui.youPage = null; render(); window.scrollTo(0, 0); return; }
    closeSheet(); window.scrollTo({ top: 0, behavior: motionOK() ? 'smooth' : 'auto' }); return;
  }
  if (t === 'you') ui.lastScreen = { forecast: 'Forecast', spots: 'Spots', plans: 'Plans', tools: 'Tools' }[ui.tab] || 'You';
  ui.homeAnimate = true;
  if (t === 'forecast') { ui.homeDay = null; ui.homeSel = null; }
  if (t === 'you') ui.youPage = null;
  tabScroll[ui.tab] = window.scrollY;
  const dir = TAB_ORDER.indexOf(t) > TAB_ORDER.indexOf(ui.tab) ? 'fwd' : 'back';
  const restore = () => window.scrollTo(0, t === 'forecast' ? 0 : (tabScroll[t] || 0));
  const swap = () => { ui.tab = t; closeSheet(); return render(); };
  const html = document.documentElement;
  if (document.startViewTransition && motionOK() && !tabVT) {
    ui.tabChanged = false;
    html.dataset.tabdir = dir; html.classList.add('tab-vt');
    // Hold the old picture only briefly: if a page is still loading, it slides in with its placeholder.
    tabVT = document.startViewTransition(async () => { const p = swap(); await Promise.race([p, new Promise(r => setTimeout(r, 220))]); restore(); });
    tabVT.finished.finally(() => { html.classList.remove('tab-vt'); delete html.dataset.tabdir; tabVT = null; });
  } else {
    ui.tabChanged = true; html.dataset.tabdir = dir;
    swap().finally?.(restore); restore();
  }
}
export function render() {
  if (ui.map) { ui.map.remove(); ui.map = null; }
  clearInterval(plansTimer);
  $$('.tabbar button').forEach((b, i) => { b.classList.toggle('active', b.dataset.tab === ui.tab); if (b.dataset.tab === ui.tab) $('.tabbar').style.setProperty('--tab', i); });
  const v = $('#view');
  v.dataset.view = ui.tab;   // lets wide screens size each page appropriately
  clearInterval(homeTimer);
  v.classList.remove('view-in');
  if (ui.tabChanged) { void v.offsetWidth; v.classList.add('view-in'); ui.tabChanged = false; }
  const shown = ui.tab;
  return Promise.resolve()
    .then(() => ({ forecast: renderForecast, spots: renderSpots, plans: renderPlans, tools: renderTools, you: renderYou })[shown](v))
    .catch(err => {
      console.error(err);
      if (!/Failed to fetch|Load failed|No connection|took too long/i.test(err?.message || '')) report('caught', err);
      if (ui.tab !== shown) return;
      v.innerHTML = `<div class="empty load-error">
        <h2>That page didn't load</h2>
        <p>${esc(err?.message || 'Something went wrong')}.</p>
        <p class="small muted">Your spots and plans are safe. Try again, and if it keeps happening, send feedback from the You tab with what you were doing.</p>
        <div class="row"><button class="btn primary" id="retryLoad">Try again</button></div>
      </div>`;
      $('#retryLoad').onclick = () => { for (const k in forecasts) delete forecasts[k]; render(); };
    });
}
/* ================= boot ================= */
startErrorReports();
// Remember the phone's time zone (synced), so alerts use your quiet hours wherever your spots are.
try { const tz = Intl.DateTimeFormat().resolvedOptions().timeZone; if (tz && S().settings.tz !== tz) update(s => { s.settings.tz = tz; }); } catch {}

document.addEventListener('click', ev => {
  const planBtn = ev.target.closest('[data-plan]');
  if (planBtn) {
    const e = eventIndex.get(planBtn.dataset.plan);
    if (!e) return;
    const clash = S().plans.find(p => p.key !== e.key && Math.abs(p.t - e.t) < 4 * 3600 && (p.spotId === e.spot.id || Math.abs(p.leave - e.leave) < 2 * 3600));
    addPlan(e);
    if (clash) toast(`Heads up: you also have ${clash.spotName} ${(TYPE_NAME[clash.type] || clash.type).toLowerCase()} planned at ${fmtTime(clash.t, clash.offset)}.`, 6000);
    const box = planBtn.closest('.call-actions, .sheet-actions');
    if (box) { box.innerHTML = commitPanel(e, true); $('[data-ics-ev]', box)?.focus({ preventScroll: true }); }
    afterPlanned(e.key);
    return;
  }
  const undoBtn = ev.target.closest('[data-undo-plan]');
  if (undoBtn) {
    const key = undoBtn.dataset.undoPlan, e = eventIndex.get(key);
    undoPlan(key).then(() => {
      const box = undoBtn.closest('.call-actions, .sheet-actions');
      if (box && e) { box.innerHTML = box.classList.contains('call-actions') ? `<button class="btn primary" data-plan="${esc(e.key)}">Plan this shoot</button><button class="btn" data-ev="${esc(e.key)}">Briefing</button>` : `<button class="btn primary" data-plan="${esc(e.key)}">Plan this shoot</button>`; $('[data-plan]', box)?.focus({ preventScroll: true }); }
    });
    return;
  }
  const icsBtn = ev.target.closest('[data-ics-ev]');
  if (icsBtn) { const e = eventIndex.get(icsBtn.dataset.icsEv); if (e) downloadIcs(e); return; }
  const goPl = ev.target.closest('[data-goplans]');
  if (goPl) { ui.plansView = 'upcoming'; ui.focusPlanKey = goPl.dataset.goplans || null; const pl = S().plans.find(p => p.key === ui.focusPlanKey); if (pl) openGear.add('item:' + pl.id); setTab('plans'); return; }
  if (ev.target.closest('[data-lightning]')) { openLightningTimer(); return; }
  const labBtn = ev.target.closest('[data-lab]');
  if (labBtn) { openLab(labBtn.dataset.lab); return; }
  const dialBtn = ev.target.closest('[data-dial]');
  if (dialBtn) { const de = eventIndex.get(dialBtn.dataset.dial); if (de) openLightDial({ name: de.spot.name, lat: de.spot.lat, lon: de.spot.lon, offset: de.offset, t: de.t }); return; }
  const fmBtn = ev.target.closest('[data-field]');
  if (fmBtn) { openField(fmBtn.dataset.field); return; }
  const cpBtn = ev.target.closest('[data-compass]');
  if (cpBtn) { openCompass(cpBtn.dataset.compass); return; }
  if (ev.target.closest('[data-add-here]') && ui.found) { openSpotForm({ lat: ui.found.lat, lon: ui.found.lon, name: ui.found.name }); return; }
  if (ev.target.closest('[data-step], .call-slide')) return;   // the call's slide arrows sit inside its tappable photo
  const evBtn = ev.target.closest('[data-ev]');
  if (evBtn) { openEvent(evBtn.dataset.ev); return; }
  if (ev.target.closest('[data-close]')) closeSheet();
});
// The logo takes you home: today's forecast, scrolled to the top.
$('.brand')?.addEventListener('click', () => {
  if (!$('#sheet').classList.contains('hidden')) closeSheet();
  if (ui.tab === 'forecast') { ui.homeDay = null; ui.homeSel = null; render(); window.scrollTo({ top: 0, behavior: motionOK() ? 'smooth' : 'auto' }); return; }
  ui.homeDay = null; ui.homeSel = null;
  setTab('forecast');
  window.scrollTo(0, 0);
});
$('.brand')?.addEventListener('keydown', ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); ev.currentTarget.click(); } });
document.addEventListener('keydown', ev => { if (ev.key === 'Escape') { if (!$('#sheet').classList.contains('hidden')) closeSheet(); else closeField(); } });
$$('.tabbar button').forEach(b => b.onclick = () => setTab(b.dataset.tab));
$('#nowBtn').onclick = () => openNow();
window.addEventListener('online', () => { toast('Back online'); refreshInBackground(S().spots); fillActuals(); });
window.addEventListener('offline', () => toast("You're offline. Showing saved forecasts."));
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
// Opened from a password-reset email: choose a new password.
export function openRecoverySheet() {
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
export async function openLink(hash) {
  // from the morning-after notification: rate that shoot
  const rate = /^#rate-([\w-]+)$/.exec(hash || '');
  if (rate) {
    history.replaceState(null, '', location.pathname + location.search);
    closeWelcome(false);
    if (S().plans.some(p => p.id === rate[1])) openQuickRate(rate[1]);
    return;
  }
  const m = /^#crew(?:-([0-9a-f-]{8,}))?$/i.exec(hash || '');
  if (!m) return;
  history.replaceState(null, '', location.pathname + location.search);
  closeWelcome(false);
  ui.plansView = 'crew';
  setTab('plans');
  if (!m[1]) return;
  if (!crewState.loaded || !crewState.plans.some(x => x.id === m[1])) { crewState.loaded = false; await loadCrew(); }
  openSharedSpot(m[1]);
}
navigator.serviceWorker?.addEventListener('message', ev => {
  if (ev.data?.type === 'open') openLink(new URL(ev.data.url).hash);
});
window.addEventListener('hashchange', () => openLink(location.hash));
export function backfillRatings() {
  // Older ratings: copy each one's session type, hunt and spot from its plan, so fog and night
  // sessions never teach the colour score.
  const plansById = new Map(S().plans.map(p => [p.id, p]));
  if (S().keepers.some(k => k.planId && !k.type && plansById.get(k.planId)?.type)) {
    update(s2 => { for (const k of s2.keepers) { const p = plansById.get(k.planId); if (p && !k.type) { k.type = p.type; k.hunt = p.hunt || k.hunt || null; k.spotId = p.spotId || k.spotId || null; } } });
  }
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
applyTheme();
Promise.allSettled([loadAllPhotos(), restoreForecasts()]).finally(() => {
  backfillRatings();
  render();
  maybeWelcome();
  // After an update, show testers what's new, once. Otherwise, the morning after a shoot, ask how it was.
  const opening = location.hash;
  if (!$('#welcome') && hasNews()) setTimeout(() => { if (!$('#welcome') && $('#sheet').classList.contains('hidden') && !document.querySelector('.skyar')) openWhatsNew(); }, 1400);
  else if (/^#rate-/.test(opening)) openLink(opening);
  else setTimeout(() => maybePromptRating(), 1400);
  // Coming back to the app after a shoot (say, in the car after sunset): ask then, while it's fresh.
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') setTimeout(() => maybePromptRating(), 800); });
  onPasswordRecovery(openRecoverySheet);
  initSync(() => {
    for (const k in forecasts) delete forecasts[k];
    // Signed in already and the data has arrived: no need for the welcome.
    if (welcome && S().spots.length && currentUser() && ['install', 'intro'].includes(welcome.steps[welcome.i])) closeWelcome();
    if (!$('#sheet').classList.contains('hidden')) return;
    render();
  })
    .then(() => { flushErrors(); fillActuals(); return loadCrew(); }).then(() => {
      if (location.hash.startsWith('#crew')) return openLink(location.hash);
      if (['forecast', 'plans', 'spots'].includes(ui.tab) && $('#sheet').classList.contains('hidden')) render();
    })
    .catch(() => {});
  let wasSignedIn = !!currentUser();
  onSyncStatus(st => {
    if (ui.tab === 'you') { if (ui.youPage === 'account') renderAccount(); else if (ui.youPage === 'alerts') renderAlerts(); else if (!ui.youPage) render(); }
    const signedIn = !!st.email;
    if (signedIn !== wasSignedIn) { wasSignedIn = signedIn; crewState.loaded = false; loadCrew().then(() => { if (ui.tab === 'plans') render(); }); }
  });
});
