// Tidelight: The You tab: light profile, account, alerts, settings, kit, data and feedback.
import { syncStatus, syncNow, signOut, sendPasswordReset, createAccount, signInWithPassword, savePushSubscription, removePushSubscription, sendTestAlert, currentUser, sendFeedback, myFeedback } from './sync.js?v=7.5.2';
import { pageAccuracy } from './accuracy.js?v=7.5.2';
import { accuracyReport, accuracyLine } from './records.js?v=7.5.2';
import { esc, fmtDate, uid, toast, fmtDay, getPosition, cap, downloadFile } from './util.js?v=7.5.2';
import { MIN_KEEPERS, spotFloor, personalModelSummary, featureVector, similarity, tuningReport, colourRatings, ratingScore } from './scoring.js?v=7.5.2';
import { hasAI, readExif, resizeImage, aiAnalyzeReference, aiResultToFeatures, testKey } from './ai.js?v=7.5.2';
import { APP_VERSION } from './version.js?v=7.5.2';
import { update, exportData, importData, resetAll } from './storage.js?v=7.5.2';
import { fetchHistorical } from './api.js?v=7.5.2';
import { VAPID_PUBLIC_KEY } from './config.js?v=7.5.2';
import { exportPhotos, importPhotos, clearPhotos } from './photos.js?v=7.5.2';
import { $, $$, S, allEvents, ensureForecasts, eventRow, forecasts, ui } from './core.js?v=7.5.2';
import { THEMES, applyMotion, applyTheme, next3Days } from './forecast.js?v=7.5.2';
import { hasNews, openTour, openWelcome, openWhatsNew } from './welcome.js?v=7.5.2';
import { openSpotDetail } from './spots.js?v=7.5.2';
import { render, setTab } from './app.js?v=7.5.2';

/* ================= coach ================= */

/* ================= you tab: your light profile, account, alerts and setup ================= */

export const TEXT_SIZES = { standard: 'Standard', large: 'Large', larger: 'Larger' };
export function applyTextSize() {
  const size = S().settings.textSize || 'standard';
  if (size === 'standard') delete document.documentElement.dataset.text; else document.documentElement.dataset.text = size;
}
export const youHead = (title, lede = '') => `<button class="link-btn back" id="youBack">‹ You</button>
    <h1 class="page-title">${title}</h1>${lede ? `<p class="page-lede">${lede}</p>` : ''}`;
export function renderYou(v, logLines = []) {
  const st = S(), s = st.settings;
  if (ui.youPage) {
    ({ profile: pageProfile, recreate: pageRecreate, account: pageAccount, alerts: pageAlerts, home: pageHome, kit: pageKit, display: pageDisplay, ai: pageAI, data: pageData, feedback: pageFeedback, tuning: pageTuning, accuracy: pageAccuracy })[ui.youPage](v, logLines);
    const back = $('#youBack', v);
    if (back) back.onclick = () => { ui.youPage = null; renderYou(v); window.scrollTo(0, 0); };
    return;
  }
  const good = st.keepers.filter(k => k.label === 'keeper').length;
  const sync = syncStatus();
  const kit = (s.gearAlways || []).length;
  const row = (id, title, status) => `<button class="you-row" data-you="${id}">
      <span class="you-text"><span class="you-title">${title}</span><span class="you-status">${esc(status)}</span></span>
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>
    </button>`;
  v.innerHTML = `
    <h1 class="page-title">You</h1>
    <p class="page-lede">${sync.email ? `Signed in as ${esc(sync.email)}.` : 'Your light profile, account and setup.'}</p>

    <h2 class="sec">Your light</h2>
    <div class="you-list">
      ${row('profile', 'Light profile and keepers', good >= MIN_KEEPERS ? `${good} keepers. Your personal score is on.` : `${good} keeper${good === 1 ? '' : 's'}. Add ${MIN_KEEPERS - good} more to switch on your personal score.`)}
      ${row('tuning', 'Score tuning', s.tuning === false ? 'Off. Scores use the standard rules.' : (() => { const n = st.spots.filter(sp => spotFloor(sp, st.keepers, s).floor > 0.35).length; return n ? `Learning from your ratings. ${n} spot${n === 1 ? '' : 's'} adjusted.` : 'Learning from your ratings.'; })())}
      ${row('accuracy', 'How accurate is Tidelight?', accuracyLine())}
      ${row('recreate', 'Recreate a shot', 'Find upcoming sessions that match a photo.')}
    </div>

    <h2 class="sec">Account</h2>
    <div class="you-list">
      ${row('account', 'Account and sync', !sync.configured ? 'Not set up yet.' : sync.email ? (sync.state === 'error' ? 'Sync needs attention.' : `Synced ${syncAgo(sync.lastSync)}.`) : 'Not signed in. Sign in to sync across devices.')}
      ${row('alerts', 'Alerts', !sync.email ? 'Sign in to turn on alerts.' : s.alerts.go ? `Sessions scoring ${s.alerts.threshold}+${s.alerts.digest ? `, plus a ${DAYS[s.alerts.digestDay]} digest` : ''}.` : 'Go alerts are off.')}
    </div>

    <h2 class="sec">Setup</h2>
    <div class="you-list">
      ${row('home', 'Home and travel', s.home ? `Home set. Arrive ${s.arriveBeforeMin} min before each session.` : 'Home not set. Needed for leave times.')}
      ${row('kit', 'My kit', kit ? `${kit} item${kit === 1 ? '' : 's'} you always bring.` : 'Nothing added yet.')}
      ${row('display', 'Display', `${(THEMES.find(t => t[0] === (s.theme || 'dark')) || THEMES[0])[1]} theme, ${TEXT_SIZES[s.textSize || 'standard'].toLowerCase()} text, ${(s.motion || 'full') === 'reduced' ? 'reduced' : 'full'} motion.`)}
      ${row('ai', 'AI coach', hasAI(s) ? 'On, using your Claude key.' : 'Off. Optional.')}
      ${row('data', 'Your data', 'Back up, restore or delete.')}
    </div>

    <h2 class="sec">Tidelight</h2>
    <div class="you-list">
      <button class="you-row" id="youNews"><span class="you-text"><span class="you-title">What's new${hasNews() ? ' <span class="you-badge">New</span>' : ''}</span><span class="you-status">Version ${APP_VERSION}: what's changed for testers.</span></span><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg></button>
      <button class="you-row" id="youTour"><span class="you-text"><span class="you-title">How Tidelight works</span><span class="you-status">A one-minute tour of the score, planning, learning and the tools.</span></span><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg></button>
      ${row('feedback', 'Send feedback', 'Found a bug, or have an idea? Tell Tyson directly.')}
      <a class="you-row" href="https://tysonwaldron.com" target="_blank" rel="noopener">
        <span class="you-text"><span class="you-title">Visit tysonwaldron.com</span><span class="you-status">Prints, workshops and the field journal.</span></span>
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>
      </a>
    </div>
    <p class="small muted you-foot">Tidelight version ${APP_VERSION}. Weather, tide and sea data from Open-Meteo (CC BY 4.0). Aurora forecast from NOAA. Maps from OpenStreetMap. Tide heights are modelled and can differ from official tide tables; check local warnings before heading out.</p>
    <button class="link-btn" id="replayWelcome">Show the welcome again</button>`;
  $('#replayWelcome').onclick = () => openWelcome();
  $$('[data-you]', v).forEach(b => b.onclick = () => { ui.youPage = b.dataset.you; renderYou(v); window.scrollTo(0, 0); });
  if ($('#youNews', v)) $('#youNews', v).onclick = () => openWhatsNew();
  if ($('#youTour', v)) $('#youTour', v).onclick = () => openTour();
}
export function pageProfile(v, logLines = []) {
  const st = S();
  const good = st.keepers.filter(k => k.label === 'keeper').length;
  const duds = st.keepers.filter(k => k.label === 'dud').length;
  const mehs = st.keepers.filter(k => k.label === 'meh').length;
  const summary = personalModelSummary(st.keepers);
  const active = good >= MIN_KEEPERS;
  const sorted = [...st.keepers].sort((a, b) => b.date - a.date);
  v.innerHTML = `
    ${youHead('Light profile', summary ? `Your best shots tend to have ${esc(summary.text)}.` : 'Once you add keepers, this is where you\'ll see the conditions you shoot best in.')}
    <div class="meter" role="img" aria-label="${good} of 10 keepers"><i style="width:${Math.min(100, good / 10 * 100)}%"></i></div>
    <p class="small muted">${good} keeper${good === 1 ? '' : 's'}, ${mehs} so-so, ${duds} dud${duds === 1 ? '' : 's'}. ${active ? 'Your personal score is on.' : `Add ${MIN_KEEPERS - good} more keeper${MIN_KEEPERS - good === 1 ? '' : 's'} to switch on your personal score.`} It gets more confident up to 10.</p>

    <h3 class="sec">Teach it your keepers</h3>
    <p class="you-copy">Import your favourite shots. Tidelight reads the time and location saved in each photo, looks up the sky, tide and sea at that moment, and learns what your best sessions look like. Photos stay on this device.</p>
    <label class="form" style="margin-bottom:12px">
      <span class="small"><strong>If a photo has no location, use this spot</strong></span>
      <select id="fallbackSpot">
        <option value="">Skip photos without location</option>
        ${st.spots.map(sp => `<option value="${sp.id}">${esc(sp.name)}</option>`).join('')}
      </select>
    </label>
    <label class="btn primary block">Import photos<input type="file" id="keeperFiles" class="file-input" accept="image/*" multiple></label>
    <div class="log" id="importLog">${logLines.map(l => `<div>${esc(l)}</div>`).join('')}</div>
    ${sorted.length ? `<h3 class="sec">Your keepers and rated sessions</h3>
      <p class="small muted">Tap a label to change it between keeper, so-so and dud.</p>` : ''}
    <div class="thumbs">${sorted.map(k => `
      <div class="thumb">
        ${k.thumb ? `<img src="${k.thumb}" alt="">` : `<div class="ph">${k.source === 'session' ? 'Session' : 'Photo'}<br>${esc(k.spotName || '')}<br>${fmtDate(k.date)}</div>`}
        <button class="tag ${k.label}" data-flip="${k.id}" title="Tap to change: keeper, so-so, dud">${k.label === 'keeper' ? 'Keeper' : k.label === 'meh' ? 'So-so' : 'Dud'}</button>
        <button class="x" data-rm="${k.id}" aria-label="Remove">×</button>
      </div>`).join('')}</div>`;
  $('#keeperFiles').onchange = ev => importKeepers([...ev.target.files]);
  $$('[data-flip]', v).forEach(b => b.onclick = () => {
    update(s2 => { const k = s2.keepers.find(x => x.id === b.dataset.flip); k.label = { keeper: 'meh', meh: 'dud', dud: 'keeper' }[k.label] || 'keeper'; });
    renderYou(v);
  });
  $$('[data-rm]', v).forEach(b => b.onclick = () => {
    update(s2 => { s2.keepers = s2.keepers.filter(x => x.id !== b.dataset.rm); });
    renderYou(v);
  });
}
export function pageRecreate(v) {
  v.innerHTML = `
    ${youHead('Recreate a shot', "Pick any photo you'd love to recreate, yours or an inspiration shot. Tidelight works out the conditions it needed and finds the upcoming sessions across your spots that match best.")}
    ${!hasAI(S().settings) ? '<p class="small muted">Photos without location data need the AI coach. Add your Claude key under You, in AI coach.</p>' : ''}
    <label class="btn primary block">Choose a photo<input type="file" id="refFile" class="file-input" accept="image/*"></label>
    <div id="refResult"></div>`;
  $('#refFile').onchange = ev => ev.target.files[0] && recreateShot(ev.target.files[0]);
}
export async function importKeepers(files) {
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
  if (ui.tab === 'you' && ui.youPage === 'profile') renderYou($('#view'), log);
}
export async function recreateShot(file) {
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
    out.innerHTML = `<div class="alert info">This photo has no saved location and time, so there's nothing to look up. Add your Claude key under You, in AI coach, and the AI coach will read the sky from the image itself.</div>`;
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
    ${ranked.length ? ranked.map(({ e, m }) => eventRow(e, `<span>${fmtDay(e.dayT ?? e.t, e.offset)}</span><span class="match">${m}% match</span>`)).join('') : '<p class="muted">Add some spots first so there are forecasts to match against.</p>'}`;
}
/* ================= settings ================= */

export function syncAgo(t) {
  if (!t) return 'not yet';
  const m = Math.round((Date.now() - t) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
}
export function renderAccount() {
  const box = $('#accountPanel');
  if (!box) return;
  const st = syncStatus();
  if (!st.configured) {
    box.innerHTML = `<h2>Account and sync</h2>
      <p class="small muted">Sync isn't switched on yet. Add your Supabase anon key to <code>js/config.js</code> and run <code>supabase/schema.sql</code> in Supabase (see the README).</p>`;
    return;
  }
  if (st.email) {
    box.innerHTML = `<h2>Account and sync</h2>
      <p>Signed in as <strong>${esc(st.email)}</strong>.</p>
      <p class="small ${st.state === 'error' ? 'sync-err' : 'muted'}">${st.state === 'syncing' ? 'Syncing…' : st.state === 'error' ? esc(st.error) : `Last synced ${syncAgo(st.lastSync)}. Spots, photos, plans, keepers and settings stay in step across your devices. Your Claude key stays on each device.`}</p>
      <div class="row"><button class="btn primary" id="syncNowBtn" ${st.state === 'syncing' ? 'disabled' : ''}>Sync now</button><button class="btn ghost" id="signOutBtn">Sign out</button></div>`;
    $('#syncNowBtn').onclick = () => syncNow();
    $('#signOutBtn').onclick = async () => { await signOut(); toast('Signed out. Your data stays on this device.'); renderAccount(); };
    return;
  }
  box.innerHTML = `<h2>Account and sync</h2>
    <p class="small muted">Sign in to keep your spots, photos, plans and keepers in step across your phone and computer.</p>
    <form class="form" id="authForm">
      <label>Email<input type="email" name="email" autocomplete="username" inputmode="email" required placeholder="you@example.com"></label>
      <label>Password<input type="password" name="password" autocomplete="current-password" required minlength="8" placeholder="At least 8 characters"></label>
      <div class="row">
        <button class="btn primary" type="submit" value="signin">Sign in</button>
        <button class="btn ghost" type="submit" value="create">Create account</button>
      </div>
    </form>
    <p class="small muted">First time? Tap Create account once on any device, then Sign in everywhere else with the same details.</p>
    <button class="link-btn" id="forgotBtn" type="button">Forgot your password?</button>`;
  $('#forgotBtn').onclick = async () => {
    const email = $('#authForm').email.value.trim();
    if (!email) { toast('Type your email above first, then tap "Forgot your password?"'); $('#authForm').email.focus(); return; }
    try { await sendPasswordReset(email); toast('Check your email for a reset link. Open it on this device.', 7000); }
    catch (e) { toast(e.message, 7000); }
  };
  const form = $('#authForm');
  form.onsubmit = async ev => {
    ev.preventDefault();
    const mode = ev.submitter?.value || 'signin';
    const email = form.email.value.trim(), password = form.password.value;
    const buttons = [...form.querySelectorAll('button')];
    buttons.forEach(b => { b.disabled = true; });
    try {
      if (mode === 'create') {
        const signedIn = await createAccount(email, password);
        if (!signedIn) {
          toast('Account created. Confirm the email Supabase sent you, then tap Sign in.', 7000);
          buttons.forEach(b => { b.disabled = false; });   // keep the details filled in
          return;
        }
        toast('Account created. Syncing your data.');
      } else {
        await signInWithPassword(email, password);
        toast('Signed in. Syncing your data.');
      }
      renderAccount();
    } catch (e) {
      toast(e.message, 7000);
      buttons.forEach(b => { b.disabled = false; });
    }
  };
}
/* ---------- alerts panel ---------- */
export const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const hourLabel = h => `${h % 12 || 12}${h < 12 ? 'am' : 'pm'}`;
export const b64urlToBytes = s => {
  const pad = '='.repeat((4 - s.length % 4) % 4);
  const raw = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, c => c.charCodeAt(0));
};
export const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
export const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
export const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
export async function currentPushSub() {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return reg ? reg.pushManager.getSubscription() : null;
}
export async function renderAlerts() {
  const box = $('#alertsPanel');
  if (!box) return;
  const st = syncStatus();
  const a = S().settings.alerts;
  if (!st.email) {
    box.innerHTML = `<h2>Alerts</h2><p class="small muted">Sign in above to turn on alerts. Your spots are checked every hour, and you get a notification when the light lines up.</p>`;
    return;
  }
  let device = '';
  if (VAPID_PUBLIC_KEY.startsWith('PASTE')) {
    device = `<p class="small muted">Alerts aren't set up yet. Follow the "Alerts" steps in the README to add your keys and the alerts function.</p>`;
  } else if (!pushSupported() || (isIOS() && !isStandalone())) {
    device = `<p class="small muted">${isIOS() ? 'On iPhone, alerts work in the home-screen app. Open Tidelight from your home screen (Share → Add to Home Screen) and turn them on there.' : "This browser can't receive notifications."}</p>`;
  } else {
    const sub = await currentPushSub();
    const blocked = Notification.permission === 'denied';
    // Self-heal: if this device is subscribed but the server lost (or never got) the record, save it again.
    if (sub && Notification.permission === 'granted') savePushSubscription(sub.toJSON()).catch(() => {});
    device = sub && Notification.permission === 'granted'
      ? `<p class="small"><strong class="caramel">Alerts are on for this device.</strong></p>
         <div class="row"><button class="btn" id="testAlert">Send a test</button><button class="btn ghost" id="pushOff">Turn off on this device</button></div>`
      : blocked
        ? `<p class="small sync-err">Notifications are blocked for Tidelight. Allow them in your phone's Settings → Notifications → Tidelight, then come back here.</p>`
        : `<div class="row"><button class="btn primary block" id="pushOn">Turn on alerts on this device</button></div>`;
  }
  const opt = (v, cur, label) => `<option value="${v}" ${String(v) === String(cur) ? 'selected' : ''}>${label}</option>`;
  function thPreview(v) {
    if (!Object.keys(forecasts).length) return 'Lower catches more sessions; higher means fewer, surer alerts.';
    const n = next3Days().filter(e => e.score >= v).length;
    return `Right now, ${n} of your sessions in the next 3 days score${n === 1 ? 's' : ''} ${v} or more.`;
  }
  box.innerHTML = `<h2>Alerts</h2>
    <p class="small muted">Your spots are checked every hour, using the same scores you see in the app, including what it has learned from your ratings.</p>
    ${device}
    <form class="form alert-prefs" id="alertForm">
      <label class="check"><input type="checkbox" name="go" ${a.go ? 'checked' : ''}> Tell me when a session in the next 36 hours is worth the alarm</label>
      <label class="slider">
        <span class="slider-head"><span>Alert me at a score of</span><output class="num" id="thOut">${a.threshold}+</output></span>
        <input type="range" name="threshold" id="thRange" min="60" max="95" step="5" value="${a.threshold}" aria-label="Score threshold" style="--val:${((a.threshold - 60) / 35 * 100).toFixed(0)}%">
        <span class="slider-foot" id="thPreview">${esc(thPreview(a.threshold))}</span>
      </label>
      <label class="check"><input type="checkbox" name="confident" ${a.confident !== false ? 'checked' : ''}> Skip colour alerts when the weather models disagree (fewer false alarms)</label>
      <label class="check"><input type="checkbox" name="crew" ${a.crew !== false ? 'checked' : ''}> Tell me when someone in my crew plans a shoot</label>
      <label class="check"><input type="checkbox" name="calledOff" ${a.calledOff ? 'checked' : ''}> Tell me if a session I was alerted about falls through</label>
      <label class="check"><input type="checkbox" name="rate" ${a.rate !== false ? 'checked' : ''}> After a planned shoot, ask how the light was, once it's finished (one tap to answer; comes through quiet hours, never after 11pm)</label>
      <fieldset class="seas-prefs"><legend>Big seas (coastal spots with Big seas on)</legend>
        <label class="check"><input type="checkbox" name="seas" ${a.seas !== false ? 'checked' : ''}> Tell me when one of a spot's biggest swells of the year is on its way (up to 5 days ahead)</label>
        <label class="check"><input type="checkbox" name="seasEve" ${a.seasEve !== false ? 'checked' : ''}> Update me the evening before, with the latest timing</label>
        <label class="check"><input type="checkbox" name="seasFade" ${a.seasFade !== false ? 'checked' : ''}> Tell me if a big swell I was alerted about fades</label>
      </fieldset>
      <label class="check"><input type="checkbox" name="digest" ${a.digest ? 'checked' : ''}> Weekly digest of the best 3 sessions, every
        <select name="digestDay" aria-label="Digest day">${DAYS.map((d, i) => opt(i, a.digestDay, d)).join('')}</select>
        at <select name="digestHour" aria-label="Digest time">${[7, 8, 12, 17, 18, 19, 20].map(h => opt(h, a.digestHour, hourLabel(h))).join('')}</select></label>
      <div class="two">
        <label>Quiet from<select name="quietStart">${opt(-1, a.quietStart === a.quietEnd ? -1 : a.quietStart, 'No quiet hours')}${[20, 21, 22, 23].map(h => opt(h, a.quietStart, hourLabel(h))).join('')}</select></label>
        <label>Until<select name="quietEnd">${[5, 6, 7, 8].map(h => opt(h, a.quietEnd, hourLabel(h))).join('')}</select></label>
      </div>
      <div class="row"><button class="btn primary" type="submit">Save alert settings</button></div>
    </form>`;

  const on = $('#pushOn');
  if (on) on.onclick = async () => {
    on.disabled = true; on.textContent = 'Turning on…';
    try {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') throw new Error('Notifications weren\'t allowed. You can allow them in your phone\'s Settings → Notifications → Tidelight.');
      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64urlToBytes(VAPID_PUBLIC_KEY) });
      await savePushSubscription(sub.toJSON());
      toast('Alerts are on. Tap "Send a test" to check.');
    } catch (e) { toast(e.message, 7000); }
    renderAlerts();
  };
  const off = $('#pushOff');
  if (off) off.onclick = async () => {
    const sub = await currentPushSub();
    if (sub) { await removePushSubscription(sub.endpoint).catch(() => {}); await sub.unsubscribe().catch(() => {}); }
    toast('Alerts turned off on this device.');
    renderAlerts();
  };
  const test = $('#testAlert');
  if (test) test.onclick = async () => {
    test.disabled = true; test.textContent = 'Sending…';
    try {
      const sub = await currentPushSub();
      if (sub) await savePushSubscription(sub.toJSON());   // make sure Supabase knows this device
      await sendTestAlert();
      toast('Test sent. It should arrive in a few seconds.');
    }
    catch (e) { toast(e.message, 7000); }
    test.disabled = false; test.textContent = 'Send a test';
  };
  const thr = $('#thRange');
  if (thr) thr.oninput = () => {
    $('#thOut').textContent = `${thr.value}+`;
    $('#thPreview').textContent = thPreview(Number(thr.value));
    thr.style.setProperty('--val', `${((thr.value - 60) / 35 * 100).toFixed(0)}%`);
  };
  $('#alertForm').onsubmit = ev => {
    ev.preventDefault();
    const f = new FormData(ev.target);
    const qs = parseInt(f.get('quietStart'), 10), qe = parseInt(f.get('quietEnd'), 10);
    update(s => {
      s.settings.alerts = {
        go: !!f.get('go'), threshold: parseInt(f.get('threshold'), 10),
        calledOff: !!f.get('calledOff'), confident: !!f.get('confident'), crew: !!f.get('crew'), rate: !!f.get('rate'),
        seas: !!f.get('seas'), seasEve: !!f.get('seasEve'), seasFade: !!f.get('seasFade'),
        digest: !!f.get('digest'), digestDay: parseInt(f.get('digestDay'), 10), digestHour: parseInt(f.get('digestHour'), 10),
        quietStart: qs < 0 ? 0 : qs, quietEnd: qs < 0 ? 0 : qe,
      };
    });
    toast('Alert settings saved. They sync to your account.');
  };
}
export function pageAccount(v) {
  v.innerHTML = `${youHead('Account and sync')}<section class="you-page" id="accountPanel"></section>`;
  renderAccount();
}
export function pageAlerts(v) {
  v.innerHTML = `${youHead('Alerts')}<section class="you-page" id="alertsPanel"></section>`;
  renderAlerts();
}
export function pageHome(v) {
  const s = S().settings;
  v.innerHTML = `
    ${youHead('Home and travel', 'Used to work out drive times and when to leave. Your home location syncs with your account.')}
    <form class="form" id="homeForm">
      <div class="two">
        <label>Latitude<input name="lat" inputmode="decimal" value="${s.home ? s.home.lat.toFixed(5) : ''}"></label>
        <label>Longitude<input name="lon" inputmode="decimal" value="${s.home ? s.home.lon.toFixed(5) : ''}"></label>
      </div>
      <button type="button" class="btn" id="homeHere">Use where I am now</button>
      <label class="slider">
        <span class="slider-head"><span>Arrive before each session</span><output class="num" id="arriveOut">${s.arriveBeforeMin} min</output></span>
        <input type="range" name="arrive" id="arriveRange" min="0" max="90" step="5" value="${s.arriveBeforeMin}" style="--val:${(s.arriveBeforeMin / 90 * 100).toFixed(0)}%">
      </label>
      <label class="slider">
        <span class="slider-head"><span>Get ready time</span><output class="num" id="readyOut">${s.readyMin ?? 30} min</output></span>
        <input type="range" name="ready" id="readyRange" min="0" max="90" step="5" value="${s.readyMin ?? 30}" style="--val:${((s.readyMin ?? 30) / 90 * 100).toFixed(0)}%">
        <span class="slider-foot">Time from your alarm to walking out the door. Sets the alarm time on each session.</span>
      </label>
      <label class="slider">
        <span class="slider-head"><span>Average drive speed</span><output class="num" id="speedOut">${s.driveSpeedKmh} km/h</output></span>
        <input type="range" name="speed" id="speedRange" min="30" max="110" step="5" value="${s.driveSpeedKmh}" style="--val:${((s.driveSpeedKmh - 30) / 80 * 100).toFixed(0)}%">
        <span class="slider-foot" id="travelExample"></span>
      </label>
      <button type="submit" class="btn primary">Save home and travel</button>
    </form>`;
  const ar = $('#arriveRange'), sr = $('#speedRange');
  const example = () => {
    const mins = Math.round(40 / Number(sr.value) * 60), lead = Number(ar.value) + mins;
    const at = 6 * 60 - lead, hh = Math.floor(at / 60), mm = String(at % 60).padStart(2, '0');
    $('#arriveOut').textContent = `${ar.value} min`;
    $('#speedOut').textContent = `${sr.value} km/h`;
    ar.style.setProperty('--val', `${(ar.value / 90 * 100).toFixed(0)}%`);
    sr.style.setProperty('--val', `${((sr.value - 30) / 80 * 100).toFixed(0)}%`);
    $('#travelExample').textContent = `Example: for a 6:00am sunrise 40 km away, that's a ${mins} min drive, leaving at ${hh}:${mm}am.`;
  };
  ar.oninput = example; sr.oninput = example; example();
  const rr = $('#readyRange');
  rr.oninput = () => { $('#readyOut').textContent = `${rr.value} min`; rr.style.setProperty('--val', `${(rr.value / 90 * 100).toFixed(0)}%`); };
  $('#homeHere').onclick = async () => {
    try {
      const p = await getPosition();
      $('#homeForm').lat.value = p.lat.toFixed(5);
      $('#homeForm').lon.value = p.lon.toFixed(5);
      toast('Location filled in. Tap Save home and travel.');
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
      st2.settings.readyMin = parseInt(f.get('ready'), 10) || 0;
    });
    toast('Home and travel saved.');
  };
}
export function pageKit(v) {
  v.innerHTML = `
    ${youHead('My kit', "Things you always bring. They're added to every session's gear checklist, alongside what the conditions call for.")}
    <form class="form" id="kitForm">
      <label>One item per line<textarea name="kit" rows="8" placeholder="Camera and spare battery&#10;Tripod&#10;Memory cards&#10;Phone charger">${esc((S().settings.gearAlways || []).join('\n'))}</textarea></label>
      <button class="btn primary" type="submit">Save my kit</button>
    </form>`;
  $('#kitForm').onsubmit = ev => {
    ev.preventDefault();
    const items = String(new FormData(ev.target).get('kit') || '').split('\n').map(x => x.trim()).filter(Boolean).slice(0, 40);
    update(s2 => { s2.settings.gearAlways = items; });
    toast('My kit saved.');
  };
}
// What the score has learned from your ratings, how much it helps, and the sessions it got wrong.
export function pageTuning(v) {
  const st = S(), on = st.settings.tuning !== false;
  const rep2 = tuningReport(st.keepers, st.spots, st.settings);
  const perSpot = st.spots.map(sp => ({ sp, fl: spotFloor(sp, st.keepers, st.settings), n: colourRatings(st.keepers, sp).length })).filter(x => x.n || x.fl.source === 'yours' || x.fl.windK || x.fl.lowK);
  const condText = f => {
    const parts = [`low cloud ${Math.round((f[0] ?? 0) * 100)}%`, `upper cloud ${Math.round(Math.min(100, 0.7 * (f[1] ?? 0) * 100 + 0.9 * (f[2] ?? 0) * 100))}%`];
    if ((f[3] ?? 0) > 0.05) parts.push('some rain');
    parts.push(`wind ${Math.round((f[4] ?? 0) * 40)} km/h`);
    return parts.join(', ');
  };
  const planScore = r => st.plans.find(p => p.id === r.planId)?.score;
  const misses = rep2.items.filter(x => { const s10 = ratingScore(x.rating), pred = planScore(x.rating) ?? x.standard; return (s10 >= 7 && pred < 75) || (s10 <= 3 && pred >= 50); })
    .sort((a, b) => (b.rating.date || 0) - (a.rating.date || 0));
  const lbl = { keeper: 'Delivered', meh: 'So-so', dud: 'Not worth it' };
  const stat = (k, t) => `Usually ${t.gap} points off your rating. ${t.right} of ${rep2.n} in the right band; ${t.keepGo} of ${rep2.keepers} keepers called Go; ${t.dudGo} dud${t.dudGo === 1 ? '' : 's'} called Go.`;
  v.innerHTML = `
    ${youHead('Score tuning', 'Tidelight learns from your ratings which spots shine in clean light and which need cloud to catch colour, and adjusts each spot\'s colour score to match.')}
    <label class="switch-row"><span><strong>Learn from my ratings</strong><small>Applies to the forecast, briefings and alerts. Spots you've set yourself always follow your setting.</small></span>
      <input type="checkbox" id="tuneOn" role="switch" ${on ? 'checked' : ''}></label>

    <h3 class="sec">What it has learned</h3>
    ${perSpot.length ? perSpot.map(({ sp, fl, n }) => `<div class="hist-row">
        <span class="hist-name">${esc(sp.name)}<small>${fl.source === 'yours'
          ? (sp.cleanLight === 'yes' ? 'Set by you: shines in clean light.' : 'Set by you: needs cloud for colour.')
          : fl.floor > 0.35 ? `Shines in clean light: ${fl.k} clear-sky keeper${fl.k === 1 ? '' : 's'}${fl.d ? `, ${fl.d} miss${fl.d === 1 ? '' : 'es'}` : ''}. Clear skies now score well here.`
          : fl.d ? `Needs cloud for colour: ${fl.d} clear-sky session${fl.d === 1 ? ' was a miss' : 's were misses'}. Standard rules.`
          : `${n} rated session${n === 1 ? '' : 's'} so far. Not enough clear-sky sessions to judge yet.`}${fl.windK ? ` Tagged too windy ${fl.windTags} times: wind now counts for more here.` : ''}${fl.lowK ? ` Tagged cloud-blocked ${fl.horizonTags} times: low cloud now counts for more here.` : ''}</small></span>
        <button class="btn small-btn" data-open-spot="${sp.id}">Spot</button>
      </div>`).join('') : '<p class="muted">Rate a few sunrise and sunset sessions in Plans and this fills in.</p>'}

    <h3 class="sec">Does it help?</h3>
    ${rep2.n >= 6 ? `<div class="tune-compare">
        <div><span class="tune-k">Standard rules</span><b class="num">${rep2.std.right}<small>/${rep2.n}</small></b><span class="tune-d">${esc(stat('std', rep2.std))}</span></div>
        <div class="tuned"><span class="tune-k">Tuned to you</span><b class="num">${rep2.tuned.right}<small>/${rep2.n}</small></b><span class="tune-d">${esc(stat('tuned', rep2.tuned))}</span></div>
      </div>
      <p class="small muted">A fair test: each of your ${rep2.n} rated sunrise and sunset sessions is scored using only what was learned from the others. Fog mornings, sessions marked not the light's fault, and duplicate photos are left out. Older three-way ratings count as 8, 5 and 2 out of 10.</p>`
      : `<p class="muted">After about 6 rated sunrise and sunset sessions, this shows how much the tuning improves the score.</p>`}

    <h3 class="sec">Near misses</h3>
    <p class="small muted">Keepers it scored low, and duds it scored high. These are what it learns from.</p>
    ${misses.length ? misses.slice(0, 12).map(x => {
      const before = planScore(x.rating) ?? x.standard;
      return `<div class="miss">
        <div class="miss-head"><span class="miss-name">${esc(x.spot.name)}</span><span class="miss-rate ${x.rating.label}">You rated it ${ratingScore(x.rating)}/10</span></div>
        <p class="miss-when">${esc(x.rating.type ? `${cap(x.rating.type)}, ` : 'Photo, ')}${esc(fmtDate(x.rating.date))}. ${esc(cap(condText(x.rating.features)))}.</p>
        <p class="miss-scores">Scored <b class="num">${before}</b> at the time${x.tuned !== x.standard ? `; tuned, it would score <b class="num tuned">${x.tuned}</b>` : '; the tuning doesn\'t change this one'}.</p>
      </div>`;
    }).join('') : '<p class="muted">No near misses yet.</p>'}
    <p class="small muted">Something it can't learn? Set it yourself: Edit spot, then <em>Light at this spot</em> under Composition and notes.</p>`;
  $('#tuneOn').onchange = ev => {
    update(s2 => { s2.settings.tuning = ev.target.checked; });
    for (const k in forecasts) delete forecasts[k];
    toast(ev.target.checked ? 'Learning from your ratings.' : 'Using the standard rules.');
    renderYou(v);
  };
  $$('[data-open-spot]', v).forEach(b => b.onclick = () => openSpotDetail(b.dataset.openSpot));
}
// Where the tester was before opening feedback, so the note says which screen it's about.
export function pageFeedback(v) {
  const user = currentUser();
  if (!user) {
    v.innerHTML = `${youHead('Send feedback', 'Sign in first, so Tyson knows who it\'s from and can reply.')}
      <button class="btn primary" id="fbSignIn">Go to Account and sync</button>`;
    $('#fbSignIn').onclick = () => { ui.youPage = 'account'; renderYou(v); };
    return;
  }
  const kinds = [['bug', 'Something\'s wrong'], ['idea', 'An idea'], ['praise', 'Something I like'], ['other', 'Other']];
  v.innerHTML = `
    ${youHead('Send feedback', 'Goes straight to Tyson, with the app version and the screen you were on, so it\'s easy to follow up.')}
    <form class="form" id="fbForm">
      <div class="size-options fb-kinds" role="radiogroup" aria-label="What kind of feedback">
        ${kinds.map(([k, label], i) => `<label class="size-opt fb-kind ${i === 0 ? 'on' : ''}"><input type="radio" name="kind" value="${k}" ${i === 0 ? 'checked' : ''}><span>${label}</span></label>`).join('')}
      </div>
      <label>What happened, or what would help?
        <textarea name="message" rows="6" maxlength="4000" required placeholder="e.g. On the Pulpit Rock sunrise, the leave time looked an hour early."></textarea>
      </label>
      <label>Which screen is it about?<input name="screen" value="${esc(ui.lastScreen)}" maxlength="80"></label>
      <p class="small muted">Sent as ${esc(user.email || 'you')}, with Tidelight ${APP_VERSION} and your device type.</p>
      <button class="btn primary" type="submit">Send feedback</button>
    </form>
    <div id="fbPast"></div>`;
  $$('.fb-kind input', v).forEach(r => r.onchange = () => $$('.fb-kind', v).forEach(l => l.classList.toggle('on', l.querySelector('input').checked)));
  $('#fbForm').onsubmit = async ev => {
    ev.preventDefault();
    const f = new FormData(ev.target), btn = ev.target.querySelector('button[type=submit]');
    const message = String(f.get('message') || '').trim();
    if (!message) return toast('Write a few words first');
    btn.disabled = true; btn.textContent = 'Sending…';
    try {
      await sendFeedback({ kind: f.get('kind'), message, appVersion: APP_VERSION, screen: String(f.get('screen') || '').trim() });
      toast('Thanks. Your feedback has been sent.', 4000);
      ui.youPage = null; renderYou(v);
    } catch (e) { toast(e.message, 6000); btn.disabled = false; btn.textContent = 'Send feedback'; }
  };
  myFeedback().then(list => {
    const box = $('#fbPast');
    if (!box || !list.length) return;
    const label = { bug: 'Something\'s wrong', idea: 'An idea', praise: 'Something I like', other: 'Other' };
    box.innerHTML = `<h3 class="sec">You've sent</h3>${list.map(x => `<div class="hist-row"><span class="hist-name fb-past">${esc(x.message.length > 90 ? x.message.slice(0, 90) + '…' : x.message)}<small>${esc(label[x.kind] || '')}, ${esc(fmtDate(new Date(x.created_at).getTime()))}</small></span></div>`).join('')}`;
  }).catch(() => {});
}
export function pageDisplay(v) {
  const cur = S().settings.textSize || 'standard';
  v.innerHTML = `
    ${youHead('Display', 'Theme, text size and motion. These apply to this device only.')}
    <h3 class="sec">Theme</h3>
    <div class="theme-options" role="radiogroup" aria-label="Theme">
      ${THEMES.map(([k, label, note]) => `<button class="size-opt theme-opt ${(S().settings.theme || 'dark') === k ? 'on' : ''}" role="radio" aria-checked="${(S().settings.theme || 'dark') === k}" data-theme-opt="${k}"><span class="theme-swatch ${k}" aria-hidden="true"></span><span>${label}<small>${note}</small></span></button>`).join('')}
    </div>
    <h3 class="sec">Text size</h3>
    <div class="size-options" role="radiogroup" aria-label="Text size">
      ${Object.entries(TEXT_SIZES).map(([k, label]) => `<button class="size-opt ${cur === k ? 'on' : ''}" role="radio" aria-checked="${cur === k}" data-size="${k}"><span class="size-a size-${k}">Aa</span><span>${label}</span></button>`).join('')}
    </div>
    <h3 class="sec">Preview</h3>
    <p class="bf-verdict" style="margin-top:0">Worth the alarm. Clear horizon towards the sunrise.</p>
    <p class="you-copy">Leave at 4:20am, a 47 minute drive and a 25 minute walk in. Low cloud 8%, wind 6 km/h.</p>
    <h3 class="sec">Motion</h3>
    <p class="you-copy">Full motion shows drifting cloud, rain and stars on the light band, counting scores and moving pages. Reduced keeps everything still. Your phone's own Reduce Motion setting is always respected.</p>
    <div class="size-options two-up" role="radiogroup" aria-label="Motion">
      ${[['full', 'Full motion'], ['reduced', 'Reduced']].map(([k, label]) => `<button class="size-opt ${(S().settings.motion || 'full') === k ? 'on' : ''}" role="radio" aria-checked="${(S().settings.motion || 'full') === k}" data-motion="${k}"><span>${label}</span></button>`).join('')}
    </div>`;
  $$('[data-theme-opt]', v).forEach(b => b.onclick = () => {
    update(s2 => { s2.settings.theme = b.dataset.themeOpt; });
    applyTheme();
    renderYou(v);
  });
  $$('[data-motion]', v).forEach(b => b.onclick = () => {
    update(s2 => { s2.settings.motion = b.dataset.motion; });
    applyMotion();
    renderYou(v);
  });
  $$('[data-size]', v).forEach(b => b.onclick = () => {
    update(s2 => { s2.settings.textSize = b.dataset.size; });
    applyTextSize();
    renderYou(v);
  });
}
export function pageAI(v) {
  const s = S().settings;
  v.innerHTML = `
    ${youHead('AI coach', 'Optional. Rewrites briefings in plain English and reads the sky from reference photos.')}
    <p class="you-copy">Get a key at console.anthropic.com. It's stored only in this browser, and is never included in backups, sync or your GitHub repo. Each briefing costs a fraction of a cent.</p>
    <form class="form" id="aiForm">
      <label>Claude API key<input name="key" type="password" autocomplete="off" value="${esc(s.claudeKey)}" placeholder="sk-ant-…"></label>
      <label>Model<input name="model" value="${esc(s.claudeModel)}"></label>
      <div class="row">
        <button type="submit" class="btn primary">Save AI coach</button>
        <button type="button" class="btn" id="testKey">Test key</button>
      </div>
    </form>`;
  $('#aiForm').onsubmit = ev => {
    ev.preventDefault();
    const f = new FormData(ev.target);
    update(st2 => { st2.settings.claudeKey = String(f.get('key')).trim(); st2.settings.claudeModel = String(f.get('model')).trim() || 'claude-sonnet-5-5'; });
    toast('AI coach saved.');
  };
  $('#testKey').onclick = async () => {
    const f = new FormData($('#aiForm'));
    const tmp = { claudeKey: String(f.get('key')), claudeModel: String(f.get('model')) };
    if (!hasAI(tmp)) return toast('Paste a key first');
    const b = $('#testKey'); b.disabled = true; b.textContent = 'Testing…';
    try { await testKey(tmp); toast('Key works.'); } catch (e) { toast(e.message, 6000); }
    b.disabled = false; b.textContent = 'Test key';
  };
}
export function pageData(v) {
  v.innerHTML = `
    ${youHead('Your data', 'Everything is saved in this browser, and in your account when you\'re signed in. A backup file is another way to move it between devices.')}
    <div class="you-actions">
      <button class="btn" id="exportBtn">Export a backup</button>
      <label class="btn">Restore from a backup<input type="file" id="importFile" class="file-input" accept="application/json,.json"></label>
    </div>
    <h3 class="sec">Start again</h3>
    <p class="you-copy">Deletes all spots, photos, plans, keepers and settings from this browser. If you're signed in, you'll be signed out and your synced copy stays safe in your account.</p>
    <button class="btn danger" id="resetBtn">Delete everything on this device</button>`;
  $('#exportBtn').onclick = async () => {
    const b = $('#exportBtn'); b.disabled = true; b.textContent = 'Preparing…';
    try {
      const backup = JSON.parse(exportData());
      backup.photos = await exportPhotos(S().spots.flatMap(sp => sp.photos || []));
      downloadFile(`tidelight-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(backup), 'application/json');
    } catch (e) { toast(e.message, 5000); }
    b.disabled = false; b.textContent = 'Export a backup';
  };
  $('#importFile').onchange = async ev => {
    const file = ev.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      importData(text);
      const parsed = JSON.parse(text);
      if (parsed.photos) await importPhotos(parsed.photos);
      for (const k in forecasts) delete forecasts[k];
      toast('Backup restored.'); ui.youPage = null; render();
    }
    catch (e) { toast(e.message, 5000); }
  };
  $('#resetBtn').onclick = async () => {
    if (!confirm('Delete all spots, photos, plans, keepers and settings from this browser?')) return;
    await signOut().catch(() => {});
    resetAll(); clearPhotos(); for (const k in forecasts) delete forecasts[k];
    toast('Everything on this device was deleted.'); ui.youPage = null; setTab('forecast');
  };
}
