// Tidelight: First run and testers: What's new, the five-card tour and the welcome.
import { APP_VERSION } from './version.js?v=7.0';
import { esc, toast, getPosition, uid } from './util.js?v=7.0';
import { openSkyAR } from './skyar.js?v=7.0';
import { isConfigured, currentUser, createAccount, signInWithPassword, syncNow, joinCrew } from './sync.js?v=7.0';
import { HUNT_ORDER, HUNT_LABEL } from './hunts.js?v=7.0';
import { searchPlaces, placeName } from './api.js?v=7.0';
import { update } from './storage.js?v=7.0';
import { $, $$, S, closeSheet, forecasts, openSheet, ui } from './core.js?v=7.0';
import { render, setTab } from './app.js?v=7.0';
import { openAligner, openTideWindows } from './planners.js?v=7.0';
import { G, avatar, bandFill, bandInk, bandSky, day3am, demoSkyDay, lightBand, toneDot } from './forecast.js?v=7.0';
import { PIN_ICON } from './here.js?v=7.0';
import { loadCrew } from './crews.js?v=7.0';

/* ================= first-run welcome ================= */
/* ================= what's new ================= */
// For testers: what changed in each update. Opens once after an update, and any time from You.
export const SEEN_VERSION = 'tidelight:seenVersion';
export const WHATS_NEW = [
  { v: '7.0', date: '18 Nov', title: 'Under the hood', items: [
    'No new features this time: Tidelight has been reorganised and tested screen by screen, online, offline and on a slow connection.',
    'If something goes wrong on your phone, Tidelight now quietly tells Tyson what broke (just the error and the screen, never your spots or location), so you don\'t need to send screenshots.',
    'If an update ever fails to load, you\'ll see a Reload button instead of a blank screen.',
    'The whole app is saved for offline use as soon as an update arrives.',
    'Right here no longer calls a place inland just because it couldn\'t check without reception.',
  ] },
  { v: '6.14', date: '18 Nov', title: 'Steadier Sky view', items: [
    'Sky view no longer loses its direction or spins when you tip the phone up high toward the core or the moon.',
    'It now only trusts the compass when it\'s reliable, and holds steady on the gyro the rest of the time.',
  ], tryIt: ['sky', 'Open Sky view'] },
  { v: '6.13', date: '18 Nov', title: 'Welcome touch-ups', items: [
    'The light bar in the welcome and the tour now shows weather, the way it does on the Forecast page.',
    'Crew avatars no longer get clipped.',
  ], tryIt: ['tour', 'Take the tour'] },
  { v: '6.12', date: '18 Nov', title: 'Smoother, with a guided tour', items: [
    'Tabs slide in the direction you\'re moving, and each one remembers where you\'d scrolled to.',
    'A quick tour of how Tidelight works, in the welcome and any time from You.',
    'This What\'s new page.',
  ], tryIt: ['tour', 'Take the tour'] },
  { v: '6.11', date: '18 Nov', title: 'Sky view', items: [
    'Hold your phone up to see the sun\'s path, the moon and its phase, and the Milky Way drawn over the camera.',
    'Scrub the time or pick a date. Jump to sunset, dark, moonrise or when the core rises.',
    'Calibrate on the sun or moon, and save a snapshot with the paths drawn on.',
  ], tryIt: ['sky', 'Open Sky view'] },
  { v: '6.10', date: '18 Nov', title: 'Tide windows, a spot\'s year, share cards', items: [
    'Tide windows: when the tide is below or above the level you need this week, and which light sessions fall inside.',
    'Through the year on every spot: when the sun lines up with your view, Milky Way season, foggy months, and your keepers.',
    'Share card: a picture of any session to send or post.',
  ], tryIt: ['tide', 'Open tide windows'] },
  { v: '6.9', date: '18 Nov', title: 'Anywhere, and the moon planner', items: [
    'Right here works for anywhere: search a place or pin it on the map to plan a trip.',
    'Moon planner: when the full moon (or the sun) rises or sets right behind a landmark, over the next year.',
  ], tryIt: ['moon', 'Open the moon planner'] },
  { v: '6.8', date: '17 Nov', title: 'Daylight theme', items: [
    'A bright theme for reading in the sun, or match your phone (You, Display).',
    'Every score carries a go, maybe or skip mark.',
    'Glass loading placeholders.',
  ] },
  { v: '6.7', date: '17 Nov', title: 'Pictures where there were blanks', items: [
    'Briefings without a photo open on a horizon scene with the sun and cloud layers drawn in.',
    'Spot tiles with an icon for what you shoot there, and initials avatars for your crew.',
  ] },
  { v: '6.6', date: '17 Nov', title: 'Liquid Glass', items: [
    'A new look: a floating glass tab bar, glass buttons and sheets.',
    'The week strip shows each day\'s weather as an icon.',
  ] },
  { v: '6.5', date: '16 Nov', title: 'Right here', items: ['Scores and the week\'s forecast for wherever you\'re standing, no spot needed.'] },
  { v: '6.4', date: '16 Nov', title: 'Opens fast', items: ['The app opens straight away with your last forecast and refreshes in the background.'] },
];
export const hasNews = () => localStorage.getItem(SEEN_VERSION) !== APP_VERSION;
export function markNewsSeen() { try { localStorage.setItem(SEEN_VERSION, APP_VERSION); } catch {} }
export function openWhatsNew() {
  const seen = localStorage.getItem(SEEN_VERSION);
  const newer = v => !seen || v.localeCompare(seen, undefined, { numeric: true }) > 0;
  openSheet(`<p class="eyebrow here-eyebrow">For testers</p>
    <h2>What's new</h2>
    <p class="small muted">Version ${APP_VERSION}. Thanks for testing. Tell Tyson what works and what doesn't from You, Send feedback.</p>
    <div class="wn-list">${WHATS_NEW.map((u, i) => `<details class="wn-item ${newer(u.v) ? 'new' : ''}" ${i === 0 || (newer(u.v) && i < 3) ? 'open' : ''}>
      <summary><span class="wn-v num">${u.v}</span><span class="wn-t">${esc(u.title)}<small>${u.date}${newer(u.v) && seen ? ' · new since you last looked' : ''}</small></span></summary>
      <ul>${u.items.map(x => `<li>${esc(x)}</li>`).join('')}</ul>
      ${u.tryIt ? `<button class="tool-chip" data-try="${u.tryIt[0]}">${esc(u.tryIt[1])}</button>` : ''}
    </details>`).join('')}</div>
    <div class="sheet-actions"><div class="row"><button class="btn primary" id="wnDone">Got it</button><button class="btn" id="wnFeedback">Send feedback</button></div></div>`);
  markNewsSeen();
  $('#wnDone').onclick = () => closeSheet();
  $('#wnFeedback').onclick = () => { closeSheet(); ui.youPage = 'feedback'; setTab('you'); if (ui.tab === 'you') { ui.youPage = 'feedback'; render(); } };
  $$('#sheetBody [data-try]').forEach(b => b.onclick = () => {
    const k = b.dataset.try;
    if (k === 'tour') return openTour();
    closeSheet();
    if (k === 'sky') openSkyAR({});
    else if (k === 'tide') openTideWindows();
    else if (k === 'moon') openAligner();
  });
  const badge = $('.you-badge'); if (badge) badge.remove();
}
/* ================= how Tidelight works: a five-card tour ================= */
export const TOUR = [
  { k: 'score', title: 'One score for the light', text: 'Tidelight reads the whole sky for every session: low, mid and high cloud, the horizon the light has to come through, whether the weather models agree, rain, wind, fog and the tide. Then it gives you one score. Tap any score to see its working.' },
  { k: 'band', title: 'Your days, drawn as light', text: 'Each day is drawn as its light, from dark to golden hour, with your sessions marked on it. The week strip shows the best of each day and its weather. Drag the light bar to read the cloud hour by hour.' },
  { k: 'plan', title: 'Plan it, then go', text: 'Plan this shoot sets your alarm and leave time, builds a gear list, and opens field mode when you get there. Your crew sees your plans, and alerts tell you when the light lines up.' },
  { k: 'learn', title: 'Rate it, and it learns', text: 'After a shoot, rate the light 0 to 10 and tap what made it or spoiled it. Tidelight tunes its scores to your taste and to each spot, so the more you rate, the sharper it gets.' },
  { k: 'tools', title: 'Tools for the field', text: 'Right here scores wherever you\'re standing, or anywhere you pin. The moon planner, Sky view, tide windows and exposure tools help you nail the shot.' },
];
// Two sessions on the sample day, marked the way the Forecast page marks them: at sunrise and sunset.
export function demoMarks(w0) {
  const home = S().settings.home || { lat: -37.81, lon: 144.96 };
  const T = window.SunCalc ? window.SunCalc.getTimes(new Date((w0 + 12 * 3600) * 1000), home.lat, home.lon) : {};
  const pos = (d, fb) => (d instanceof Date && !isNaN(d) ? Math.max(4, Math.min(96, (d.getTime() / 1000 - w0) / 864)) : fb);
  return [[pos(T.sunrise, 12.5), 82], [pos(T.sunset, 70), 67]].map(([x, sc]) => `<span class="band-mark demo" style="left:${x.toFixed(1)}%; --fill:${bandFill(sc)}; --ink:${bandInk(sc)}" aria-hidden="true">${sc}</span>`).join('');
}
export function tourVisual(k) {
  const off = -new Date().getTimezoneOffset() * 60;
  if (k === 'score') return `<div class="tv-score"><div class="tv-num"><b class="num">82</b><span>${toneDot(82)}Worth the alarm</span></div>
    ${[['Cloud to catch colour', 92], ['Clear horizon', 86], ['Models agree', 78], ['Tide', 70]].map(([l, v]) => `<div class="tv-bar"><span>${l}</span><i style="--w:${v}%"></i></div>`).join('')}</div>`;
  if (k === 'band') {
    const w0 = day3am(Date.now() / 1000, off);
    const b = lightBand(w0, S().settings.home);
    return `<div class="tv-band"><div class="band" style="background:${b.gradient}">${bandSky(null, w0, b.marks, demoSkyDay(w0))}${demoMarks(w0)}</div>
      <div class="band-ticks">${[['6am', 12.5], ['Noon', 37.5], ['6pm', 62.5]].map(([l, x]) => `<span class="band-tick" style="left:${x}%">${l}</span>`).join('')}</div></div>`;
  }
  if (k === 'plan') return `<ol class="tv-plan">${[['4:40am', 'Alarm'], ['5:10am', 'Leave home, 35 min drive'], ['5:52am', 'Blue hour'], ['6:20am', 'Sunrise', 1]].map(([t, l, key]) => `<li class="${key ? 'key' : ''}"><b class="num">${t}</b><span>${l}</span></li>`).join('')}</ol>
    <div class="tv-chips"><span>Gear list</span><span>Field mode</span><span>${avatar('Sam', 20)}Crew</span></div>`;
  if (k === 'learn') return `<div class="tv-learn"><div class="tv-card"><b class="num">46</b><small>Before your ratings</small></div><span class="tv-arrow" aria-hidden="true">→</span><div class="tv-card warm"><b class="num">81</b><small>Tuned to you</small></div></div>
    <p class="tv-rated">You rated it <b>9/10</b> · <span>Great colour</span></p>`;
  const tools = [['Right here', PIN_ICON], ['Moon planner', G('<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>')], ['Sky view', G('<path d="M3 17c4-9 14-9 18 0"/><circle cx="12" cy="9" r="1.6"/><path d="M6 6l.6 1.2M18 6l-.6 1.2"/>')],
    ['Tide windows', G('<path d="M3 12c3-4 6-4 9 0s6 4 9 0"/><path d="M3 17c3-4 6-4 9 0s6 4 9 0" opacity=".6"/>')], ['Alerts', G('<path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20a2 2 0 0 0 4 0"/>')], ['Share card', G('<rect x="5" y="3" width="14" height="18" rx="3"/><path d="M8 15l3-3 2 2 3-4"/>')]];
  return `<div class="tv-tools">${tools.map(([l, ic]) => `<span>${ic}<small>${l}</small></span>`).join('')}</div>`;
}
// Standalone (from You or What's new), or as a step of the welcome.
export function openTour() {
  closeSheet();
  openWelcome({ tourOnly: true });
}
export function tourHtml(i, inWelcome) {
  const c = TOUR[i];
  return `<div class="tour" data-tour="${i}">
    <p class="eyebrow here-eyebrow">How Tidelight works · ${i + 1} of ${TOUR.length}</p>
    <div class="tour-visual">${tourVisual(c.k)}</div>
    <h1 class="page-title">${esc(c.title)}</h1>
    <p class="page-lede">${esc(c.text)}</p>
    <div class="tour-dots" aria-hidden="true">${TOUR.map((_, j) => `<i class="${j === i ? 'on' : ''}"></i>`).join('')}</div>
    <div class="wl-actions">
      <button class="btn primary" id="tourNext">${i < TOUR.length - 1 ? 'Next' : inWelcome ? 'Set up Tidelight' : 'Done'}</button>
      ${i > 0 ? '<button class="btn" id="tourBack">Back</button>' : ''}
    </div>
  </div>`;
}
export const WELCOMED = 'tidelight:welcomed';
export let welcome = null;   // { steps, i, picked, signedIn, returning }
export const isIosBrowser = () => /iphone|ipad|ipod/i.test(navigator.userAgent) && !navigator.standalone && !matchMedia('(display-mode: standalone)').matches;
export function maybeWelcome() {
  if (localStorage.getItem(WELCOMED) || S().spots.length) return;
  openWelcome();
}
export function openWelcome(opts = {}) {
  closeWelcome(false);
  const steps = opts.tourOnly ? ['tour'] : [...(isIosBrowser() ? ['install'] : []), 'intro', 'tour', 'home', 'spot', ...(isConfigured() ? ['account'] : []), 'done'];
  welcome = { steps, i: 0, picked: null, returning: false, tourI: 0, tourOnly: !!opts.tourOnly };
  const el = document.createElement('div');
  el.id = 'welcome';
  el.className = 'welcome';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', 'Welcome to Tidelight');
  document.body.appendChild(el);
  document.body.classList.add('noscroll');
  drawWelcome();
}
export function closeWelcome(done = true) {
  if (done) { localStorage.setItem(WELCOMED, '1'); if (!welcome?.tourOnly) markNewsSeen(); }
  welcome = null;
  const el = $('#welcome');
  if (el) el.remove();
  if ($('#sheet').classList.contains('hidden') && !$('#field')) document.body.classList.remove('noscroll');
}
export function welcomeGo(step) {
  if (!welcome) return;
  welcome.i = typeof step === 'number' ? Math.max(0, Math.min(welcome.steps.length - 1, welcome.i + step)) : welcome.steps.indexOf(step);
  welcome.picked = null;
  drawWelcome();
  $('#welcome').scrollTop = 0;
}
export function drawWelcome() {
  const el = $('#welcome');
  if (!el || !welcome) return;
  const step = welcome.steps[welcome.i];
  const numbered = welcome.steps.filter(x => !['install', 'intro', 'tour', 'done'].includes(x));
  const n = numbered.indexOf(step);
  const top = `<div class="wl-top">
      <span class="wl-progress">${n >= 0 ? `Step ${n + 1} of ${numbered.length}` : ''}</span>
      ${welcome.tourOnly ? '<button class="link-btn" id="wlSkipAll">Close</button>' : step === 'tour' ? '<button class="link-btn" id="wlSkipTour">Skip the tour</button>' : step !== 'done' ? '<button class="link-btn" id="wlSkipAll">Skip setup</button>' : ''}
    </div>`;
  const results = id => `<div class="wl-results" id="${id}" hidden></div>`;
  const st = S();

  if (step === 'install') {
    el.innerHTML = `${top}
      <h1 class="page-title">Put Tidelight on your Home Screen first</h1>
      <p class="page-lede">It opens full screen, works without reception and can send alerts. Anything you set up here in Safari stays in Safari, so install it first and set up once.</p>
      <ol class="wl-steps">
        <li>Tap the Share button at the bottom of Safari.</li>
        <li>Choose <strong>Add to Home Screen</strong>, then <strong>Add</strong>.</li>
        <li>Open Tidelight from your Home Screen and set up there.</li>
      </ol>
      <div class="wl-actions"><button class="btn" id="wlNext">Set up here in Safari anyway</button></div>`;
  } else if (step === 'intro') {
    const offset = -new Date().getTimezoneOffset() * 60;
    const b = lightBand(day3am(Date.now() / 1000, offset), st.settings.home);
    el.innerHTML = `${top}
      <h1 class="page-title wl-hero">Know before the alarm</h1>
      <p class="page-lede">Tidelight scores sunrise, sunset, daytime and night sessions at your own spots, tells you when to leave, and explains why.</p>
      <figure class="band-wrap wl-band">
        <div class="band reveal" style="background:${b.gradient}" role="img" aria-label="A day's light from dark through blue hour, golden hour and daylight, with cloud, a shower and a starry night">${bandSky(null, day3am(Date.now() / 1000, offset), b.marks, demoSkyDay(day3am(Date.now() / 1000, offset)))}${demoMarks(day3am(Date.now() / 1000, offset))}</div>
        <div class="band-ticks" aria-hidden="true">${[['6am', 12.5], ['Noon', 37.5], ['6pm', 62.5], ['Midnight', 87.5]].map(([l, x]) => `<span class="band-tick" style="left:${x}%">${l}</span>`).join('')}</div>
      </figure>
      <p class="you-copy">Every day is drawn as its light, with your sessions marked on it. Setting up takes about a minute.</p>
      <div class="wl-actions">
        <button class="btn primary" id="wlNext">Show me how it works</button>
        ${isConfigured() ? '<button class="btn" id="wlHave">I already have an account</button>' : ''}
      </div>`;
  } else if (step === 'tour') {
    el.innerHTML = `${top}${tourHtml(welcome.tourI, !welcome.tourOnly)}`;
  } else if (step === 'home') {
    el.innerHTML = `${top}
      <h1 class="page-title">Where do you set out from?</h1>
      <p class="page-lede">Used to work out drive times and when to leave for each session.</p>
      <div class="wl-actions"><button class="btn primary" id="wlHere">Use where I am now</button></div>
      <form class="search" id="wlHomeSearch" role="search">
        <input type="search" id="wlHomeQ" placeholder="Or search for your town or suburb" autocomplete="off" enterkeyhint="search" aria-label="Search for your town or suburb">
        <button class="btn" type="submit">Search</button>
      </form>
      ${results('wlHomeRes')}
      ${st.settings.home ? `<p class="small muted">Home is already set. <button class="link-btn" id="wlNext">Keep it and continue</button></p>` : ''}
      <button class="link-btn wl-skip" id="wlSkip">Skip for now</button>`;
  } else if (step === 'spot') {
    const pk = welcome.picked;
    el.innerHTML = `${top}
      <h1 class="page-title">Add your first spot</h1>
      <p class="page-lede">A beach, lookout, waterfall or forest you already shoot. You can add the rest later.</p>
      ${pk ? `<form class="form" id="wlSpotForm">
          <label>Name<input name="name" required value="${esc(pk.name || '')}" placeholder="e.g. North jetty"></label>
          <fieldset><legend>What do you shoot here?</legend>
            <div class="checks">${HUNT_ORDER.map(k => `<label class="check"><input type="checkbox" name="hunt_${k}" ${k === 'colour' ? 'checked' : ''}> ${HUNT_LABEL[k]}</label>`).join('')}</div>
            <span class="hint">Colour is sunrise and sunset colour. Pick any others that suit the place.</span>
          </fieldset>
          <label class="check"><input type="checkbox" name="coastal"> It's on the coast (use tide and wave data)</label>
          <div class="wl-actions">
            <button class="btn primary" type="submit">Add this spot</button>
            <button class="btn" type="button" id="wlRepick">Choose a different place</button>
          </div>
        </form>` : `<form class="search" id="wlSpotSearch" role="search">
          <input type="search" id="wlSpotQ" placeholder="Search for a place, e.g. Cape Schanck" autocomplete="off" enterkeyhint="search" aria-label="Search for a place you shoot">
          <button class="btn primary" type="submit">Search</button>
        </form>
        ${results('wlSpotRes')}
        <div class="wl-actions"><button class="btn" id="wlSpotHere">I'm standing at it: use where I am</button></div>`}
      <button class="link-btn wl-skip" id="wlSkip">Skip for now</button>`;
  } else if (step === 'account') {
    const user = currentUser();
    el.innerHTML = `${top}
      <h1 class="page-title">${welcome.returning ? 'Sign in' : 'Keep it safe, and bring your crew'}</h1>
      <p class="page-lede">${welcome.returning ? 'Your spots, plans and settings will follow you onto this device.' : 'An account syncs your spots and plans between devices, turns on alerts, and lets you share plans with the people you shoot with. Optional.'}</p>
      ${user ? `<p class="you-copy">Signed in as <strong>${esc(user.email)}</strong>.</p>
        <form class="form" id="wlCrew">
          <div class="two"><label>Crew invite code, if you have one<input name="code" maxlength="6" autocapitalize="characters" placeholder="ABC123"></label><label>Your name in the crew<input name="me" maxlength="40" value="${esc((user.email || '').split('@')[0])}"></label></div>
          <div class="wl-actions"><button class="btn primary" type="submit">Continue</button></div>
        </form>` : `<form class="form" id="wlAuth">
          <label>Email<input type="email" name="email" autocomplete="email" required></label>
          <label>Password<span class="hint">At least 8 characters</span><input type="password" name="password" autocomplete="${welcome.returning ? 'current-password' : 'new-password'}" minlength="8" required></label>
          <div class="wl-actions">
            ${welcome.returning ? '<button class="btn primary" type="submit" value="signin">Sign in</button>' : '<button class="btn primary" type="submit" value="create">Create account</button><button class="btn" type="submit" value="signin">Sign in instead</button>'}
          </div>
        </form>
        <button class="link-btn wl-skip" id="wlSkip">${welcome.returning ? 'Back to setup' : 'Skip for now'}</button>`}`;
  } else {
    const spot = st.spots[0];
    el.innerHTML = `${top}
      <h1 class="page-title">${welcome.returning && spot ? 'Welcome back' : "You're set"}</h1>
      <p class="page-lede">${spot ? (welcome.returning ? `Your ${st.spots.length} spot${st.spots.length === 1 ? ' is' : 's are'} here.` : `${esc(spot.name)} is being scored now.`) : 'Add a spot from the Spots tab whenever you\'re ready.'}</p>
      <ul class="wl-tips">
        <li><strong>Forecast</strong> draws each day as its light, with your sessions marked on it. Tap one to see why it scored that way.</li>
        <li><strong>Plan this shoot</strong> gives you a leave time, a gear list to pack and field mode for when you arrive.</li>
        <li><strong>Rate sessions afterwards.</strong> Three keepers switch on a score that's personal to you.</li>
        ${currentUser() ? '<li><strong>Alerts</strong> tell you when a session is worth the alarm. Turn them on under You, in Alerts.</li>' : ''}
      </ul>
      <div class="wl-actions"><button class="btn primary" id="wlFinish">${spot ? 'Show me the forecast' : 'Go to Spots'}</button></div>
      <p class="small muted">Made by Tyson Waldron. See his work at <a href="https://tysonwaldron.com" target="_blank" rel="noopener">tysonwaldron.com</a>, and send feedback any time from the You tab.</p>`;
  }

  // ----- wiring -----
  const on = (id, fn) => { const b = $(`#${id}`, el); if (b) b.onclick = fn; };
  on('wlSkipAll', () => { closeWelcome(!welcome.tourOnly); if (!welcome) render(); });
  on('wlSkipTour', () => welcomeGo(1));
  if (step === 'tour') {
    const go = d => {
      const next = welcome.tourI + d;
      if (next >= TOUR.length) { if (welcome.tourOnly) closeWelcome(false); else { welcome.tourI = 0; welcomeGo(1); } return; }
      if (next < 0) return;
      welcome.tourI = next; drawWelcome();
    };
    on('tourNext', () => go(1));
    on('tourBack', () => go(-1));
    // swipe between cards
    const card = $('.tour', el);
    let sx = null;
    card.addEventListener('pointerdown', e => { sx = e.clientX; });
    card.addEventListener('pointerup', e => { if (sx == null) return; const dx = e.clientX - sx; sx = null; if (Math.abs(dx) > 50) go(dx < 0 ? 1 : -1); });
  }
  on('wlNext', () => welcomeGo(1));
  on('wlSkip', () => { if (step === 'account' && welcome.returning) { welcome.returning = false; welcomeGo('home'); } else welcomeGo(1); });
  on('wlHave', () => { welcome.returning = true; welcomeGo('account'); });
  on('wlFinish', () => { const has = S().spots.length; closeWelcome(); for (const k in forecasts) delete forecasts[k]; setTab(has ? 'forecast' : 'spots'); });
  on('wlRepick', () => { welcome.picked = null; drawWelcome(); });

  const runSearch = async (inputId, resId, pick) => {
    const q = $(`#${inputId}`, el).value.trim(), box = $(`#${resId}`, el);
    if (q.length < 2) return;
    box.hidden = false; box.innerHTML = '<p class="small muted">Searching…</p>';
    try {
      const found2 = await searchPlaces(q, S().settings.home);
      if (!$(`#${resId}`)) return;
      box.innerHTML = found2.length ? found2.slice(0, 6).map((r, i) => `<button class="wl-result" data-i="${i}"><span>${esc(r.name)}</span><small>${esc(r.detail || '')}</small></button>`).join('')
        : '<p class="small muted">Nothing found. Try a nearby town or a simpler name.</p>';
      $$('[data-i]', box).forEach(b => b.onclick = () => pick(found2[Number(b.dataset.i)]));
    } catch { box.innerHTML = '<p class="small muted">The search didn\'t respond. Check your connection and try again.</p>'; }
  };
  const setHome = p => { update(s2 => { s2.settings.home = { lat: p.lat, lon: p.lon }; }); toast('Home set.'); welcomeGo(1); };
  on('wlHere', async () => { try { setHome(await getPosition()); } catch (e) { toast(e.message, 5000); } });
  const hs = $('#wlHomeSearch', el);
  if (hs) hs.onsubmit = ev => { ev.preventDefault(); runSearch('wlHomeQ', 'wlHomeRes', setHome); };
  const ss = $('#wlSpotSearch', el);
  if (ss) ss.onsubmit = ev => { ev.preventDefault(); runSearch('wlSpotQ', 'wlSpotRes', r => { welcome.picked = r; drawWelcome(); }); };
  on('wlSpotHere', async () => {
    try {
      const p = await getPosition();
      welcome.picked = { name: '', lat: p.lat, lon: p.lon };
      drawWelcome();
      placeName(p.lat, p.lon).then(nm => { const f = $('#wlSpotForm'); if (nm && f && !f.name.value) f.name.value = `Near ${nm}`; }).catch(() => {});
    } catch (e) { toast(e.message, 5000); }
  });
  const sf = $('#wlSpotForm', el);
  if (sf) sf.onsubmit = ev => {
    ev.preventDefault();
    const f = new FormData(sf), name = String(f.get('name') || '').trim();
    if (!name) return toast('Give the spot a name');
    const hunts = HUNT_ORDER.filter(k => f.get(`hunt_${k}`));
    const pk = welcome.picked;
    update(s2 => s2.spots.push({
      id: uid(), name, lat: pk.lat, lon: pk.lon, events: ['sunrise', 'sunset'], coastal: !!f.get('coastal'), tide: 'any',
      driveMin: '', facing: '', notes: '', photos: [], hunts: hunts.length ? hunts : ['colour'], fogMode: 'in',
    }));
    toast(`${name} added.`);
    welcomeGo(1);
  };
  const af = $('#wlAuth', el);
  if (af) af.onsubmit = async ev => {
    ev.preventDefault();
    const f = new FormData(af), mode = ev.submitter?.value || (welcome.returning ? 'signin' : 'create');
    const btns = $$('button[type=submit]', af); btns.forEach(b => { b.disabled = true; });
    try {
      const email = String(f.get('email')).trim(), pw = String(f.get('password'));
      if (mode === 'create') await createAccount(email, pw); else await signInWithPassword(email, pw);
      await syncNow().catch(() => {});
      await loadCrew();
      if (!welcome) return;
      if (S().spots.length && welcome.returning) return welcomeGo('done');   // their data arrived: nothing more to set up
      if (welcome.returning) { welcome.returning = false; toast('Signed in. Nothing saved in this account yet, so let\'s set up.', 5000); return welcomeGo('home'); }
      drawWelcome();
    } catch (e) { toast(e.message, 6000); btns.forEach(b => { b.disabled = false; }); }
  };
  const cf = $('#wlCrew', el);
  if (cf) cf.onsubmit = async ev => {
    ev.preventDefault();
    const f = new FormData(cf), code = String(f.get('code') || '').trim();
    if (code) {
      try { const c = await joinCrew(code, String(f.get('me') || '').trim() || 'Me'); await loadCrew(); toast(`You've joined ${c.name}.`); }
      catch (e) { return toast(e.message, 6000); }
    }
    welcomeGo(1);
  };
}
