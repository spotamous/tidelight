// Tidelight: Crews: shared plans, crewmates, invites and shared spots.
import { currentUser, myCrews, crewMembers, crewPlans, shareToCrew, createCrew, joinCrew, leaveCrew } from './sync.js?v=7.2.2';
import { photoUrl, addPhotoFile } from './photos.js?v=7.2.2';
import { huntsOf, HUNT_LABEL } from './hunts.js?v=7.2.2';
import { toast, haversineKm, esc, fmtDay, fmtTime, uid, dayKey, fmtWeekday, fmtDayDate } from './util.js?v=7.2.2';
import { update } from './storage.js?v=7.2.2';
import { driveMinutes, evaluateSpot } from './scoring.js?v=7.2.2';
import { gearFor } from './gear.js?v=7.2.2';
import { fetchSpotForecast } from './api.js?v=7.2.2';
import { $, $$, S, closeSheet, forecasts, hikeSummary, indexEvents, openSheet, sessionName } from './core.js?v=7.2.2';
import { SESSION_TYPES, TYPE_NAME, avatar, avatarStack, band, huntPhrase, runCounts, skeleton, toneDot } from './forecast.js?v=7.2.2';
import { render } from './app.js?v=7.2.2';
import { openSpotDetail } from './spots.js?v=7.2.2';

/* ================= crews ================= */

export const crewState = { loaded: false, crews: [], members: [], plans: [], error: null };
export const sessionKeyOf = (lat, lon, type, t) => `${lat.toFixed(3)},${lon.toFixed(3)}:${type}:${Math.round(t / 3600)}`;
export async function loadCrew() {
  if (!currentUser()) { Object.assign(crewState, { loaded: true, crews: [], members: [], plans: [], error: null }); return; }
  try {
    const crews = await myCrews();
    const ids = crews.map(c => c.id);
    const [members, plans] = await Promise.all([crewMembers(ids), crewPlans(ids, Math.floor(Date.now() / 1000) - 3 * 3600)]);
    Object.assign(crewState, { loaded: true, crews, members, plans, error: null });
  } catch (e) {
    Object.assign(crewState, { loaded: true, error: e.message });
  }
}
// What travels with a shared plan so crewmates can see and save the spot: its settings and a small cover photo.
export const thumbCache = new Map();
export async function spotThumb(sp) {
  const id = (sp.photos || []).find(x => photoUrl(x));
  if (!id) return null;
  if (thumbCache.has(id)) return thumbCache.get(id);
  try {
    const img = new Image();
    img.src = photoUrl(id);
    await img.decode();
    const k = Math.min(1, 560 / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    const url = c.toDataURL('image/jpeg', 0.72);
    thumbCache.set(id, url);
    return url;
  } catch { return null; }
}
export async function spotPayload(spotId) {
  const sp = S().spots.find(x => x.id === spotId);
  if (!sp) return null;
  const keep = ['events', 'coastal', 'tide', 'tideAccess', 'accessPct', 'accessBuffer', 'facing', 'hikeMin', 'hikeKm', 'difficulty', 'fogMode', 'notes'];
  const out = { v: 1, hunts: huntsOf(sp) };
  for (const k of keep) if (sp[k] !== undefined && sp[k] !== '') out[k] = sp[k];
  if (typeof out.notes === 'string') out.notes = out.notes.slice(0, 1000);
  const thumb = await spotThumb(sp);
  if (thumb && thumb.length < 150000) out.photo = thumb;
  return out;
}
// Share a plan with every crew you're in (used when you plan a shoot, if auto-sharing is on).
export async function autoShare(planKey) {
  const st = S();
  if (st.settings.crewAutoShare === false || !currentUser()) return false;
  if (!crewState.loaded) await loadCrew();
  if (!crewState.crews.length) return false;
  const plan = S().plans.find(p => p.key === planKey);
  if (!plan) return false;
  const spot = await spotPayload(plan.spotId);
  for (const c of crewState.crews) {
    try { await shareToCrew(c.id, myNameIn(c), plan, '', spot); } catch (e) { toast(e.message, 6000); return false; }
  }
  update(s2 => { const x = s2.plans.find(p => p.key === planKey); if (x) x.sharedTo = crewState.crews.map(c => c.id); });
  loadCrew();
  return true;
}
// After planning: share automatically if that's on, and say so.
export async function afterPlanned(planKey) {
  const shared = await autoShare(planKey);
  const names = crewState.crews.map(c => c.name);
  if (shared) toast(`Shared with ${names.length === 1 ? names[0] : 'your crews'}.`, 4000);
}
// Crewmates heading to roughly the same place and session (within ~1.5 km and 2 hours).
export function crewGoing(e) {
  const me = currentUser()?.id;
  if (!crewState.plans.length || !e?.spot) return [];
  const names = new Set();
  for (const cp of crewState.plans) {
    if (cp.user_id === me || cp.type !== e.type || Math.abs(cp.t - e.t) > 7200) continue;
    if (haversineKm({ lat: cp.lat, lon: cp.lon }, e.spot) > 1.5) continue;
    names.add(cp.display_name);
  }
  return [...names];
}
export function goingText(names) {
  if (!names.length) return '';
  const list = names.length <= 2 ? names.join(' and ') : `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`;
  return `${list} ${names.length === 1 ? 'is' : 'are'} going`;
}
export function myNameIn(crew) { return crew.myName || (currentUser()?.email || 'Me').split('@')[0]; }
// Share one of your plans with one or more crews, with an optional note.
export function openShareSheet(planId) {
  const p = S().plans.find(x => x.id === planId);
  if (!p) return;
  if (!crewState.crews.length) { toast('Make or join a crew first, at the top of Plans.'); return; }
  openSheet(`
    <h2>Share with your crew</h2>
    <p class="muted small">${esc(p.spotName)}, ${esc(fmtDay(p.dayT ?? p.t, p.offset))} ${esc(TYPE_NAME[p.type] || p.type)} ${fmtTime(p.t, p.offset)}. Crewmates see the spot, the time and the score, and get a notification.</p>
    <form class="form" id="shareForm">
      <fieldset><legend>Crews</legend>
        ${crewState.crews.map((c, i) => `<label class="check"><input type="checkbox" name="crew" value="${c.id}" ${i === 0 ? 'checked' : ''}> ${esc(c.name)}</label>`).join('')}
      </fieldset>
      <label>Note (optional)<input name="note" maxlength="200" placeholder="e.g. Meeting at the car park 5:10am"></label>
      <div class="row"><button class="btn primary" type="submit">Share</button><button class="btn ghost" type="button" data-close>Cancel</button></div>
    </form>`);
  $('#shareForm').onsubmit = async ev => {
    ev.preventDefault();
    const f = new FormData(ev.target);
    const ids = f.getAll('crew');
    if (!ids.length) return toast('Pick a crew');
    const btn = ev.target.querySelector('button[type=submit]');
    btn.disabled = true; btn.textContent = 'Sharing…';
    try {
      if (!p.sessionKey) update(s => { const x = s.plans.find(y => y.id === p.id); x.sessionKey = sessionKeyOf(x.lat, x.lon, x.type, x.t); });
      const plan = S().plans.find(x => x.id === p.id);
      for (const id of ids) {
        const crew = crewState.crews.find(c => c.id === id);
        await shareToCrew(id, myNameIn(crew), plan, String(f.get('note') || '').trim(), await spotPayload(plan.spotId));
      }
      update(s => { const x = s.plans.find(y => y.id === p.id); x.sharedTo = [...new Set([...(x.sharedTo || []), ...ids])]; });
      await loadCrew();
      closeSheet();
      toast('Shared. Your crew has been notified.');
      render();
    } catch (e) { toast(e.message, 6000); btn.disabled = false; btn.textContent = 'Share'; }
  };
}
// Join a crewmate's plan: add it to your Plans (with your own leave time) and tell the crew you're in.
export async function joinCrewPlan(cpId) {
  const cp = crewState.plans.find(x => x.id === cpId);
  if (!cp) return;
  const st = S();
  const drive = driveMinutes({ lat: cp.lat, lon: cp.lon }, st.settings);
  const arrive = Number(st.settings.arriveBeforeMin ?? 30);
  const plan = {
    id: uid(), key: `crew:${cp.session_key}`, spotId: null, spotName: cp.spot_name, lat: cp.lat, lon: cp.lon,
    type: cp.type, t: cp.t, dayT: cp.day_t, leave: cp.t - (arrive + (drive || 0)) * 60, offset: cp.offset_s, score: cp.score,
    hunt: cp.hunt, sessionKey: cp.session_key, features: null, brief: cp.note ? `Crew note: ${cp.note}` : '',
    gear: gearFor({ type: cp.type, t: cp.t, topHunt: cp.hunt || 'colour', hunts: { [cp.hunt || 'colour']: { score: 100 } }, spot: {}, hour: {} }, st.settings),
    packed: [], rating: null, sharedTo: [cp.crew_id],
  };
  if (!S().plans.some(p => p.sessionKey === cp.session_key)) update(s => { s.plans.push(plan); });
  const crew = crewState.crews.find(c => c.id === cp.crew_id);
  try { await shareToCrew(cp.crew_id, myNameIn(crew), S().plans.find(p => p.sessionKey === cp.session_key), '', cp.spot || null); } catch (e) { toast(e.message, 6000); }
  await loadCrew();
  toast("You're in. It's in your Plans and the crew knows.");
  render();
}
// Open a crewmate's spot: its forecast for the week, from your point of view (your drive, your personal score).
export const sharedSpotOf = cp => ({
  ...(cp.spot || {}), id: `crew-${cp.id}`, name: cp.spot_name, lat: cp.lat, lon: cp.lon,
  hunts: cp.spot?.hunts || [cp.hunt || 'colour'], events: cp.spot?.events || ['sunrise', 'sunset'], photos: [],
});
export function mySpotNear(lat, lon) { return S().spots.find(sp => haversineKm(sp, { lat, lon }) <= 0.3); }
export async function openSharedSpot(cpId) {
  const cp = crewState.plans.find(x => x.id === cpId);
  if (!cp) { toast('That crew plan has been removed.'); return; }
  const me = currentUser()?.id;
  const sp = sharedSpotOf(cp);
  const who = cp.user_id === me ? 'You' : cp.display_name;
  const photo = cp.spot?.photo || null;
  openSheet(`<h2 class="bf-name">${esc(cp.spot_name)}</h2>${skeleton('week', 'Loading the forecast for this spot…')}`);
  let data;
  try {
    data = forecasts[sp.id] || await fetchSpotForecast(sp);
    forecasts[sp.id] = data;
  } catch (e) { $('#sheetBody').innerHTML = `<h2 class="bf-name">${esc(cp.spot_name)}</h2><div class="alert danger">${esc(e.message)}</div>`; return; }
  const st = S();
  const evs = evaluateSpot(sp, data, st.keepers, st.settings);
  indexEvents(evs);
  const theirs = evs.find(e => e.type === cp.type && Math.abs(e.t - cp.t) < 7200);
  const mine = mySpotNear(cp.lat, cp.lon);
  const going = crewState.plans.filter(x => x.session_key === cp.session_key || (x.type === cp.type && Math.abs(x.t - cp.t) <= 7200 && haversineKm(x, cp) <= 1.5));
  const names = [...new Set(going.map(x => x.user_id === me ? 'You' : x.display_name))];
  const inAlready = going.some(x => x.user_id === me);

  const now = Date.now() / 1000;
  const dayOf = e => dayKey(e.dayT ?? e.t, e.offset);
  const days = [];
  for (let i = 0; i < 7; i++) { const t = now + i * 86400, k = dayKey(t, data.offset); if (evs.some(e => dayOf(e) === k)) days.push({ k, label: i === 0 ? 'Today' : fmtWeekday(t, data.offset).slice(0, 3), date: fmtDayDate(t, data.offset).split(' ')[1] }); }
  const types = SESSION_TYPES.filter(type => evs.some(e => e.type === type));
  const cellFor = (k, type) => evs.find(e => dayOf(e) === k && e.type === type);
  const hunts = (cp.spot?.hunts || []).map(k => HUNT_LABEL[k]).filter(Boolean).join(', ');

  $('#sheetBody').innerHTML = `
    ${photo ? `<img class="banner" src="${photo}" alt="${esc(cp.spot_name)}">` : ''}
    <header class="bf-head"><div>
      <h2 class="bf-name">${esc(cp.spot_name)}</h2>
      <p class="bf-when shared-by">${avatar(who, 26)}<span>Shared by ${esc(who)}${hunts ? `. ${esc(hunts)}` : ''}${cp.spot?.hikeMin || cp.spot?.hikeKm ? `. ${esc(hikeSummary(sp) || '')}` : ''}</span></p>
    </div></header>
    <p class="bf-verdict">${esc(names.join(', '))} ${names.length === 1 && names[0] !== 'You' ? 'is' : 'are'} going ${esc(sessionName({ type: cp.type, t: cp.t, dayT: cp.day_t ?? cp.t, offset: cp.offset_s }))}, ${fmtTime(cp.t, cp.offset_s)}.${theirs ? ` For you it scores ${theirs.score}: ${esc(huntPhrase(theirs).toLowerCase())}, leaving at ${fmtTime(theirs.leave, theirs.offset)}.` : ''}</p>
    ${cp.note ? `<p class="crew-note">“${esc(cp.note)}” <span class="muted">${esc(who)}</span></p>` : ''}
    ${mine ? `<p class="bf-note crew">This is near ${esc(mine.name)}, one of your spots.</p>` : ''}
    <div class="bf-quiet">
      ${theirs ? `<button class="link-btn" data-ev="${esc(theirs.key)}">Briefing for this session</button>` : ''}
      <a class="link-btn" target="_blank" rel="noopener" href="https://www.google.com/maps/dir/?api=1&destination=${cp.lat},${cp.lon}">Directions</a>
    </div>

    <h3 class="sec">The week here, for you</h3>
    ${days.length && types.length ? `<div class="wk-wrap"><div class="wk" style="grid-template-columns: 74px repeat(${days.length}, 44px)">
      <span></span>${days.map(d => `<span class="wk-day">${d.label}<small>${d.date}</small></span>`).join('')}
      ${types.map((type, ti) => `<span class="wk-type">${TYPE_NAME[type]}</span>${days.map((d, di) => {
        const e = cellFor(d.k, type);
        return e ? `<button class="mx-cell ${band(e.score)} ${theirs && e.key === theirs.key ? 'theirs' : ''}" style="--n:${ti + di}" data-ev="${esc(e.key)}" aria-label="${TYPE_NAME[type]} ${d.label}, score ${e.score}">${e.score}</button>` : '<span class="mx-none" aria-hidden="true">–</span>';
      }).join('')}`).join('')}
    </div></div>
    <p class="small muted">Scored with your drive time and personal score. The outlined square is ${esc(who === 'You' ? 'your' : `${who}'s`)} session.</p>` : '<p class="muted">No sessions in the next 7 days.</p>'}
    ${cp.spot?.notes ? `<h3 class="sec">${esc(who === 'You' ? 'Your' : `${who}'s`)} notes</h3><p class="bf-brief">${esc(cp.spot.notes)}</p>` : ''}

    <div class="sheet-actions">
      ${mine ? `<button class="btn" data-open-mine="${mine.id}">Open my copy</button>` : '<button class="btn primary" id="saveShared">Save to my spots</button>'}
      ${cp.user_id !== me && !inAlready ? `<button class="btn ${mine ? 'primary' : ''}" data-join="${cp.id}">I'm in</button>` : ''}
    </div>`;
  runCounts($('#sheetBody'));
  const save = $('#saveShared');
  if (save) save.onclick = async () => {
    save.disabled = true; save.textContent = 'Saving…';
    const id = await saveSharedSpot(cp);
    toast(`${cp.spot_name} saved to your spots.`);
    for (const k in forecasts) if (k.startsWith('crew-')) delete forecasts[k];
    openSpotDetail(id);
  };
  const om = $('[data-open-mine]');
  if (om) om.onclick = () => openSpotDetail(om.dataset.openMine);
  $$('#sheetBody [data-join]').forEach(b => b.onclick = () => { b.disabled = true; closeSheet(); joinCrewPlan(b.dataset.join); });
}
export async function saveSharedSpot(cp) {
  const src = cp.spot || {};
  let photos = [];
  if (src.photo) {
    try {
      const blob = await (await fetch(src.photo)).blob();
      photos = [await addPhotoFile(new File([blob], 'shared.jpg', { type: blob.type || 'image/jpeg' }))];
    } catch { /* keep the spot even if the photo can't be read */ }
  }
  const id = uid();
  const pick = ['events', 'coastal', 'tide', 'tideAccess', 'accessPct', 'accessBuffer', 'facing', 'hikeMin', 'hikeKm', 'difficulty', 'fogMode', 'notes'];
  const spot = { id, name: cp.spot_name, lat: cp.lat, lon: cp.lon, events: ['sunrise', 'sunset'], coastal: false, tide: 'any', driveMin: '', facing: '', notes: '', photos, hunts: src.hunts?.length ? src.hunts : [cp.hunt || 'colour'], fogMode: 'in', sharedFrom: cp.display_name };
  for (const k of pick) if (src[k] !== undefined) spot[k] = src[k];
  update(st => st.spots.push(spot));
  return id;
}
export function crewPanel() {
  if (!currentUser()) return `<section class="panel"><h2>Crew</h2><p class="small muted">Sign in under You, in Account and sync, to make or join a crew and share plans with the people you shoot with.</p></section>`;
  if (!crewState.loaded) return `<section class="panel" id="crewPanel"><h2>Crew</h2><p class="loading">Loading your crew…</p></section>`;
  if (crewState.error) return `<section class="panel"><h2>Crew</h2><p class="small sync-err">${esc(crewState.error)}</p></section>`;
  const me = currentUser().id;
  if (!crewState.crews.length) return `<section class="panel">
    <h2>Crew</h2>
    <p class="small muted">Share plans with the people you shoot with: see who's heading where, join their sessions, and get a notification when someone shares.</p>
    <form class="form" id="crewCreate">
      <div class="two"><label>Crew name<input name="name" maxlength="60" required placeholder="e.g. Dawn patrol"></label><label>Your name<input name="me" maxlength="40" required value="${esc((currentUser().email || '').split('@')[0])}"></label></div>
      <button class="btn primary" type="submit">Create a crew</button>
    </form>
    <form class="form" id="crewJoin" style="margin-top:16px">
      <div class="two"><label>Invite code<input name="code" maxlength="6" required autocapitalize="characters" placeholder="ABC123"></label><label>Your name<input name="me" maxlength="40" required value="${esc((currentUser().email || '').split('@')[0])}"></label></div>
      <button class="btn" type="submit">Join a crew</button>
    </form>
  </section>`;

  // Group crew plans by session: shared sessions show everyone who's in.
  const groups = [];
  for (const cp of crewState.plans) {
    const g = groups.find(x => x.type === cp.type && Math.abs(x.t - cp.t) <= 7200 && haversineKm(x, cp) <= 1.5);
    if (g) g.items.push(cp); else groups.push({ type: cp.type, t: cp.t, lat: cp.lat, lon: cp.lon, items: [cp] });
  }
  const groupRow = g => {
    const first = g.items[0];
    const mine = g.items.some(x => x.user_id === me);
    const people = [...new Set(g.items.map(x => x.user_id === me ? 'You' : x.display_name))];
    const notes = g.items.filter(x => x.note).map(x => `<p class="crew-note">${avatar(x.user_id === me ? 'You' : x.display_name, 22)}<span>“${esc(x.note)}” <span class="muted">${esc(x.user_id === me ? 'You' : x.display_name)}</span></span></p>`).join('');
    const scores = g.items.map(x => x.score).filter(x => x != null);
    return `<div class="plan crew-plan">
      <div class="ev-title">${esc(first.spot_name)}</div>
      <div class="ev-sub"><span><strong>${esc(fmtDay(first.day_t ?? first.t, first.offset_s))}, ${esc(TYPE_NAME[first.type] || first.type)} ${fmtTime(first.t, first.offset_s)}</strong></span>${scores.length ? `<span class="crew-score">${toneDot(Math.max(...scores))}Score ${Math.max(...scores)}</span>` : ''}</div>
      <p class="crew-people">${avatarStack(people, 30)}<span>${esc(people.join(', '))}</span></p>
      ${notes}
      <div class="row">
        <button class="btn ${mine ? '' : 'primary'}" data-view-spot="${first.id}">${first.spot?.photo ? 'View spot' : 'View spot and forecast'}</button>
        ${mine ? '<span class="small caramel crew-in">You\'re in</span>' : `<button class="btn" data-join="${first.id}">I'm in</button>`}
      </div>
      ${mySpotNear(first.lat, first.lon) ? '' : '<p class="small muted">Not in your spots yet. Open it to save a copy.</p>'}
    </div>`;
  };
  return `<section class="panel">
    <h2>Crew</h2>
    ${crewState.crews.map(c => {
      const mem = crewState.members.filter(m => m.crew_id === c.id);
      return `<div class="crew-head">
        <div><div class="ev-title">${esc(c.name)}</div><div class="ev-sub crew-members">${avatarStack(mem.map(m => m.user_id === me ? 'You' : m.display_name), 26)}<span>${esc(mem.map(m => m.user_id === me ? 'You' : m.display_name).join(', '))}</span></div></div>
        <div class="crew-code"><span class="num">${esc(c.invite_code)}</span><button class="btn ghost small-btn" data-invite="${c.id}">Invite</button></div>
      </div>`;
    }).join('')}
    <label class="switch-row"><span><strong>Share my plans automatically</strong><small>Every shoot you plan is shared with your crew, and they get a notification.</small></span>
      <input type="checkbox" id="autoShare" role="switch" ${S().settings.crewAutoShare !== false ? 'checked' : ''}></label>
    <h3>Who's going where</h3>
    ${groups.length ? groups.map(groupRow).join('') : '<p class="small muted">No crew plans yet. Share one of yours from Upcoming below.</p>'}
    <div class="row"><button class="btn ghost small-btn" id="crewMore">Join or make another crew</button>${crewState.crews.length ? `<button class="btn ghost small-btn" id="crewLeave">Leave a crew</button>` : ''}</div>
  </section>`;
}
export function wireCrewPanel(v) {
  const meName = f => String(f.get('me') || '').trim();
  const cf = $('#crewCreate', v);
  if (cf) cf.onsubmit = async ev => {
    ev.preventDefault();
    const f = new FormData(cf);
    try { const c = await createCrew(String(f.get('name')).trim(), meName(f)); await loadCrew(); closeSheet(); toast(`Crew made. Invite code ${c.invite_code}.`, 5000); render(); }
    catch (e) { toast(e.message, 6000); }
  };
  const jf = $('#crewJoin', v);
  if (jf) jf.onsubmit = async ev => {
    ev.preventDefault();
    const f = new FormData(jf);
    try { const c = await joinCrew(String(f.get('code')).trim(), meName(f)); await loadCrew(); closeSheet(); toast(`You've joined ${c.name}.`); render(); }
    catch (e) { toast(e.message, 6000); }
  };
  $$('[data-invite]', v).forEach(b => b.onclick = async () => {
    const c = crewState.crews.find(x => x.id === b.dataset.invite);
    const text = `Join my Tidelight crew "${c.name}" with the code ${c.invite_code}: open Tidelight, then Plans → Crew → Join a crew. ${location.origin + location.pathname}`;
    try {
      if (navigator.share) await navigator.share({ title: 'Join my Tidelight crew', text });
      else { await navigator.clipboard.writeText(text); toast('Invite copied. Paste it in a message.'); }
    } catch { /* cancelled */ }
  });
  $$('[data-join]', v).forEach(b => b.onclick = () => { b.disabled = true; joinCrewPlan(b.dataset.join); });
  $$('[data-view-spot]', v).forEach(b => b.onclick = () => openSharedSpot(b.dataset.viewSpot));
  const as = $('#autoShare', v);
  if (as) as.onchange = () => { update(s2 => { s2.settings.crewAutoShare = as.checked; }); toast(as.checked ? 'New plans will be shared with your crew.' : 'New plans stay private until you share them.'); };
  const more = $('#crewMore', v);
  if (more) more.onclick = () => { openSheet(`<h2>Another crew</h2>
    <form class="form" id="crewCreate"><div class="two"><label>Crew name<input name="name" maxlength="60" required></label><label>Your name<input name="me" maxlength="40" required value="${esc(myNameIn(crewState.crews[0] || {}))}"></label></div><button class="btn primary" type="submit">Create a crew</button></form>
    <form class="form" id="crewJoin" style="margin-top:16px"><div class="two"><label>Invite code<input name="code" maxlength="6" required autocapitalize="characters"></label><label>Your name<input name="me" maxlength="40" required value="${esc(myNameIn(crewState.crews[0] || {}))}"></label></div><button class="btn" type="submit">Join a crew</button></form>`); wireCrewPanel($('#sheetBody')); };
  const leave = $('#crewLeave', v);
  if (leave) leave.onclick = () => {
    openSheet(`<h2>Leave a crew</h2><p class="small muted">Your shared plans in that crew are removed. You can rejoin with the invite code.</p>
      ${crewState.crews.map(c => `<div class="row"><button class="btn danger block" data-leave="${c.id}">Leave ${esc(c.name)}</button></div>`).join('')}`);
    $$('[data-leave]').forEach(b => b.onclick = async () => {
      try { await leaveCrew(b.dataset.leave); await loadCrew(); closeSheet(); toast('Left the crew.'); render(); } catch (e) { toast(e.message, 6000); }
    });
  };
}
