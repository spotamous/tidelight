/* ===== Tidelight hourly alerts (Supabase Edge Function) =====
   Runs every hour (pg_cron → POST with x-cron-secret). For each user with a device signed up for alerts:
   loads their spots, keepers and settings, scores the next 36 hours with the app's own engine,
   and sends web-push notifications: Go alerts, called-off alerts, and a weekly digest.
   Also answers { action: 'test' } from the app (with the user's sign-in token) to send a test. */

const { evaluateSpot } = M_scoring;
const { setKp, HUNT_LABEL, HUNT_VERB, huntWord } = M_hunts;
const { fetchSpotForecast, fetchKp, clearCache } = M_api;
const { fmtTime, fmtDay, tzOffset } = M_util;
const { seasForSpots, seasReady, seasSwell, seasWhen, seasLightLine } = M_seas;

const DEFAULT_ALERTS = { go: true, threshold: 80, confident: true, calledOff: true, crew: true, rate: true, digest: true, digestDay: 4, digestHour: 19, quietStart: 21, quietEnd: 6, seas: true, seasEve: true, seasFade: true };
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
// The server-side admin key. Newer projects expose secret keys as JSON in SUPABASE_SECRET_KEYS;
// older ones as SUPABASE_SERVICE_ROLE_KEY. TIDELIGHT_SECRET_KEY lets you set one explicitly.
function adminKey() {
  const own = Deno.env.get('TIDELIGHT_SECRET_KEY');
  if (own) return { key: own, from: 'TIDELIGHT_SECRET_KEY' };
  try {
    const keys = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') || '{}');
    const k = keys.default || Object.values(keys)[0];
    if (k) return { key: k, from: 'SUPABASE_SECRET_KEYS' };
  } catch { /* not set */ }
  const legacy = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  return { key: legacy, from: legacy ? 'SUPABASE_SERVICE_ROLE_KEY' : 'none' };
}
const keyKind = k => (!k ? 'missing' : k.startsWith('sb_secret_') ? 'secret' : k.startsWith('sb_publishable_') ? 'publishable (wrong kind)' : k.startsWith('eyJ') ? 'legacy JWT' : 'unknown');

const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

const inQuiet = (h, s, e) => (s === e ? false : s < e ? h >= s && h < e : h >= s || h < e);
function sessionLabel(e) {
  const day = fmtDay(e.dayT ?? e.t, e.offset);
  if (e.type === 'night') return day === 'Today' ? 'Tonight' : `${day} night`;
  if (e.type === 'day') return `${day} daytime`;
  return `${day} ${e.type}`;
}
const goTitle = e => (e.topHunt === 'colour' ? `Worth the alarm: ${e.spot.name}` : `Go for ${HUNT_VERB[e.topHunt]} at ${e.spot.name}`);
function goBody(e) {
  const when = e.type === 'night' || e.type === 'day' ? `${sessionLabel(e)}, best around ${fmtTime(e.t, e.offset)}` : `${sessionLabel(e)} ${fmtTime(e.t, e.offset)}`;
  const hunt = e.topHunt !== 'colour' ? ` (${huntWord(e.topHunt)})` : '';
  const access = e.access && !e.access.inside ? ' Tide blocks access, check the briefing.' : '';
  const walk = e.hike ? ` (incl. ${e.hike} min hike)` : '';
  const sure = e.topHunt === 'colour' && e.confidence?.level === 'high' ? ' Models agree.' : '';
  return `${when}. Score ${e.score}${hunt}.${sure} Leave ${fmtTime(e.leave, e.offset)}${walk}.${access}`;
}

async function sendToUser(admin, uid, payload) {
  const { data: subs, error } = await admin.from('push_subscriptions').select('id, subscription').eq('user_id', uid);
  if (error) throw new Error(`Couldn't read your devices from the database: ${error.message}`);
  let sent = 0, failed = 0, lastFail = '';
  for (const s of subs || []) {
    try {
      await webpush.sendNotification(s.subscription, JSON.stringify(payload), { TTL: 6 * 3600 });
      sent++;
    } catch (err) {
      if (err?.statusCode === 404 || err?.statusCode === 410) await admin.from('push_subscriptions').delete().eq('id', s.id); // device gone
      else { failed++; lastFail = `${err?.statusCode || ''} ${err?.body || err?.message || ''}`.trim(); console.error('push failed', lastFail); }
    }
  }
  console.log(`push to ${uid}: ${subs?.length || 0} devices, ${sent} sent, ${failed} failed`);
  if (!sent && failed) throw new Error(`Apple/Google rejected the notification: ${lastFail.slice(0, 200)}`);
  return sent;
}

async function checkUser(admin, uid) {
  const { data: row } = await admin.from('user_state').select('data').eq('user_id', uid).maybeSingle();
  const d = row?.data;
  if (!d || !d.spots?.length) return { sent: 0 };
  const prefs = { ...DEFAULT_ALERTS, ...(d.settings?.alerts || {}) };
  const settings = { driveSpeedKmh: 60, arriveBeforeMin: 30, ...(d.settings || {}) };
  const wantsSeas = (prefs.seas || prefs.seasEve || prefs.seasFade) && d.spots.some(seasReady);
  if (!prefs.go && !prefs.calledOff && !prefs.digest && !prefs.rate && !wantsSeas) return { sent: 0 };

  if (d.spots.some(s => (s.hunts || []).includes('aurora'))) { try { setKp(await fetchKp()); } catch { setKp([]); } }
  const events = [];
  const dataOf = {};
  let offset = null;
  for (const spot of d.spots) {
    try {
      const data = await fetchSpotForecast(spot);
      dataOf[spot.id] = data;
      if (offset == null) offset = data.offset;
      events.push(...evaluateSpot(spot, data, d.keepers || [], settings));
    } catch (e) { console.error('forecast failed', spot.name, e?.message); }
  }
  if (offset == null) return { sent: 0 };

  const now = Date.now() / 1000;
  // Your hour of the day (quiet hours, the digest, morning asks) is where you are, from the phone's time
  // zone; older app versions didn't send it, so fall back to your first spot's.
  const userOff = tzOffset(settings.tz, now) ?? offset;
  const local = new Date((now + userOff) * 1000);
  const hour = local.getUTCHours(), day = local.getUTCDay();
  const quiet = inQuiet(hour, prefs.quietStart, prefs.quietEnd);
  const { data: log } = await admin.from('alert_log').select('kind, key, score').eq('user_id', uid)
    .gte('sent_at', new Date(Date.now() - 10 * 86400000).toISOString());
  const done = new Map((log || []).map(l => [`${l.kind}|${l.key}`, l]));
  const byKey = new Map(events.map(e => [e.key, e]));
  const toSend = [], toLog = [];

  // Go alerts: sessions in the next 36 hours at or above the threshold, still time to leave.
  if (prefs.go && !quiet) {
    const fresh = events
      .filter(e => e.t > now + 1800 && e.t < now + 36 * 3600 && e.leave > now && e.score >= prefs.threshold && !done.has(`go|${e.key}`))
      .filter(e => !(prefs.confident && e.topHunt === 'colour' && e.confidence?.level === 'low'))   // skip coin tosses
      .sort((a, b) => b.score - a.score);
    if (fresh.length && fresh.length <= 2) fresh.forEach(e => toSend.push({ title: goTitle(e), body: goBody(e), tag: `go-${e.key}`, url: './' }));
    else if (fresh.length > 2) toSend.push({
      title: `${fresh.length} sessions worth the alarm`,
      body: fresh.slice(0, 3).map(e => `${sessionLabel(e)}: ${e.spot.name}, ${e.score}`).join('\n'),
      tag: 'go-group', url: './',
    });
    fresh.forEach(e => toLog.push({ kind: 'go', key: e.key, score: e.score }));
  }

  // Called off: a session you were alerted about has dropped 20+ points and below your threshold.
  if (prefs.calledOff && !quiet) {
    const off = [];
    for (const l of log || []) {
      if (l.kind !== 'go' || done.has(`off|${l.key}`)) continue;
      const e = byKey.get(l.key);
      if (e && e.t > now + 2 * 3600 && e.score <= (l.score ?? 0) - 20 && e.score < prefs.threshold) off.push({ e, was: l.score });
    }
    if (off.length && off.length <= 2) off.forEach(({ e, was }) => {
      const why = (e.factors || []).find(f => f.k === 'bad')?.t;
      toSend.push({ title: `Called off: ${e.spot.name}`, body: `${sessionLabel(e)} has dropped to ${e.score} (was ${was}).${why ? ` ${why}.` : ''}`, tag: `off-${e.key}`, url: './' });
    });
    else if (off.length > 2) toSend.push({
      title: `${off.length} sessions called off`,
      body: off.slice(0, 3).map(({ e, was }) => `${sessionLabel(e)}: ${e.spot.name}, ${was} → ${e.score}`).join('\n'),
      tag: 'off-group', url: './',
    });
    off.forEach(({ e }) => toLog.push({ kind: 'off', key: e.key, score: e.score }));
  }

  // How was the light? Asked once the light has finished, while it's fresh: sunset + 45 min, sunrise + 1 h,
  // daytime + 2 h. This first ask goes through quiet hours (you've just been out shooting), but never
  // after 11pm or before 5am. Night shoots wait for 7am. If it's not answered, one follow-up the next
  // morning (7am to 8pm, outside quiet hours), then never again. Several waiting at once become one.
  if (prefs.rate) {
    const startOfDay = (t, off) => Math.floor((t + off) / 86400) * 86400 - off;
    const morningAfter = p => startOfDay(p.t - 12 * 3600, p.offset ?? offset) + 86400 + 7 * 3600;
    const lightDone = p => p.type === 'sunset' ? p.t + 45 * 60 : p.type === 'sunrise' ? p.t + 3600 : p.type === 'day' || p.type === 'seas' ? p.t + 2 * 3600 : morningAfter(p);
    const daytime = !quiet && hour >= 7 && hour <= 20;
    const fresh = [], again = [];
    for (const p of d.plans || []) {
      if (p.rating || !p.t || p.t < now - 30 * 3600) continue;
      const asked = done.has(`rate|${p.id}`), followed = done.has(`rate|${p.id}|am`);
      if (!asked) {
        if (now < lightDone(p)) continue;
        const stillFresh = now <= lightDone(p) + 3 * 3600 && hour >= 5 && hour < 23;
        if (stillFresh || (now >= morningAfter(p) && daytime)) fresh.push(p);
      } else if (!followed && p.type !== 'night' && now >= morningAfter(p) && daytime) {
        again.push(p);
      }
    }
    const word = p => (p.type === 'sunrise' ? 'sunrise' : p.type === 'sunset' ? 'sunset' : p.type === 'night' ? 'night shoot' : p.type === 'seas' ? 'big-seas shoot' : 'shoot');
    const all = [...fresh, ...again].sort((a, b) => b.t - a.t);
    if (all.length) {
      const p = all[0];
      const isFresh = fresh.includes(p) && now <= lightDone(p) + 3 * 3600;
      toSend.push(all.length > 1
        ? { title: 'How was the light?', body: `${all.length} shoots to rate, starting with ${p.spotName}. One tap each.`, tag: 'rate-group', url: `./#rate-${p.id}` }
        : isFresh
          ? { title: `How was the light at ${p.spotName}?`, body: `${p.type === 'sunset' ? "Tonight's" : p.type === 'sunrise' ? "This morning's" : "Today's"} ${word(p)}${p.score != null ? ` scored ${p.score}` : ''}. Tap to rate it while it's fresh.`, tag: `rate-${p.id}`, url: `./#rate-${p.id}` }
          : { title: `How was the light at ${p.spotName}?`, body: `${p.type === 'sunrise' || p.type === 'day' ? "Yesterday's" : "Last night's"} ${word(p)}${p.score != null ? ` scored ${p.score}` : ''}. One tap to rate it.`, tag: `rate-${p.id}`, url: `./#rate-${p.id}` });
      fresh.forEach(x => toLog.push({ kind: 'rate', key: x.id, score: x.score ?? null }));
      again.forEach(x => toLog.push({ kind: 'rate', key: `${x.id}|am`, score: x.score ?? null }));
    }
  }

  // Big seas: one of a coastal spot's biggest swells of the year. First word up to 5 days ahead, an update
  // the evening before, and word if it fades. A swell whose peak shifts a day stays the same swell.
  if (wantsSeas && !quiet) {
    let list = [];
    try { list = await seasForSpots(d.spots, { now, hoursFor: sp => dataOf[sp.id]?.hours || null }); } catch (e) { console.error('seas failed', e?.message); }
    const ymdDays = (a, b) => Math.round((Date.parse(a) - Date.parse(b)) / 86400000);
    const logged = kind => (log || []).filter(l => l.kind === kind);
    const sameSwell = (key, ev) => { const [sid, ymd] = key.split(':'); return sid === ev.spot.id && Math.abs(ymdDays(ymd, ev.ymd)) <= 1; };
    const dayLocal = (t, off) => new Date((t + off) * 1000).toISOString().slice(0, 10);
    for (const x of list) {
      if (x.error) continue;
      for (const e of x.events) {
        const first = logged('seas').find(l => sameSwell(l.key, e));
        const name = e.spot.name, day = fmtDay(e.t, e.offset);
        const light = e.night ? ` ${seasLightLine(e)}` : '';
        if (!first) {
          if (!prefs.seas || e.t > now + 5 * 86400 || e.t < now + 2 * 3600) continue;
          toSend.push({ title: `Big seas ${day} at ${name}`, body: `${seasSwell(e)}: ${e.rankText.charAt(0).toLowerCase()}${e.rankText.slice(1)}. ${e.night ? '' : `Peak ${seasWhen(e).split(', peak ')[1]}.`}${e.tide && e.best && Math.abs(e.tide - e.best.t) <= 3 * 3600 ? ` High tide ${fmtTime(e.tide, e.offset)}.` : ''}${light}`.replace(/\s+/g, ' ').trim(), tag: `seas-${e.key}`, url: './#seas' });
          toLog.push({ kind: 'seas', key: e.key, score: Math.round(e.ratio * 100) });
          continue;
        }
        // The evening before (5pm on), once.
        const eveDay = dayLocal(e.t - 86400, e.offset), today = dayLocal(now, e.offset);
        if (prefs.seasEve && today === eveDay && hour >= 17 && !done.has(`seas-eve|${first.key}`) && !done.has(`seas-off|${first.key}`)) {
          const leave = e.best ? (() => { const sp = e.spot; const drive = Number(sp.driveMin) || null; return drive ? ` Leave by ${fmtTime(e.best.t - (drive + Number(settings.arriveBeforeMin ?? 30)) * 60, e.offset)}.` : ''; })() : '';
          toSend.push({ title: `Still on for tomorrow: big seas at ${name}`, body: `Now ${seasSwell(e)}, peak ${seasWhen(e).split(', peak ')[1]}.${light}${leave}`.replace(/\s+/g, ' ').trim(), tag: `seas-${first.key}`, url: './#seas' });
          toLog.push({ kind: 'seas-eve', key: first.key, score: Math.round(e.ratio * 100) });
        }
      }
    }
    // Faded: alerted, still ahead, and now well under the line (or gone from the outlook).
    if (prefs.seasFade) {
      for (const l of logged('seas')) {
        if (done.has(`seas-off|${l.key}`)) continue;
        const [sid, ymd] = l.key.split(':');
        const x = list.find(y => y.spot.id === sid);
        if (!x || x.error) continue;
        const ahead = Date.parse(ymd) / 1000 + 86400 > now;
        if (!ahead) continue;
        const still = x.events.some(e => sameSwell(l.key, e));
        const near = (x.days || []).filter(dd => Math.abs(ymdDays(dd.ymd, ymd)) <= 1).sort((a, b) => b.ratio - a.ratio)[0];
        if (still || !near || near.ratio >= 0.85) continue;
        toSend.push({ title: `Big seas ${fmtDay(near.t, x.offset)}: downgraded`, body: `${x.spot.name}: the swell now tops out at ${(+near.h).toFixed(1)} m (${Math.round(near.ratio * 100)}% of a top-${x.spot.seas.top ?? 6} swell). No need to go for the big seas.`, tag: `seas-${l.key}`, url: './#seas' });
        toLog.push({ kind: 'seas-off', key: l.key, score: Math.round(near.ratio * 100) });
      }
    }
  }

  // Weekly digest: the best 3 sessions in the next 3 days, on your chosen day and hour.
  if (prefs.digest && day === prefs.digestDay && hour === prefs.digestHour) {
    const dkey = `digest-${local.toISOString().slice(0, 10)}`;
    if (!done.has(`digest|${dkey}`)) {
      const top = events.filter(e => e.t > now && e.t < now + 3 * 86400).sort((a, b) => b.score - a.score).slice(0, 3);
      if (top.length) {
        toSend.push({
          title: 'Your best light, next 3 days',
          body: top.map(e => `${sessionLabel(e)}: ${e.spot.name}, ${e.score}${e.topHunt !== 'colour' ? ` (${huntWord(e.topHunt)})` : ''}`).join('\n'),
          tag: 'digest', url: './',
        });
        toLog.push({ kind: 'digest', key: dkey, score: top[0].score });
      }
    }
  }

  let sent = 0;
  for (const p of toSend) sent += await sendToUser(admin, uid, p);
  if (sent && toLog.length) {
    await admin.from('alert_log').upsert(toLog.map(l => ({ ...l, user_id: uid })), { onConflict: 'user_id,kind,key', ignoreDuplicates: true });
  }
  return { sent };
}

async function handler(req) {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const ak = adminKey();
  if (!ak.key) return json({ error: 'The function has no admin key. Add your Secret key (sb_secret_…) as an Edge Function secret named TIDELIGHT_SECRET_KEY.' }, 500);
  const admin = createClient(Deno.env.get('SUPABASE_URL'), ak.key, { auth: { persistSession: false, autoRefreshToken: false } });
  try {
    webpush.setVapidDetails(Deno.env.get('VAPID_SUBJECT') || 'mailto:hello@example.com', Deno.env.get('VAPID_PUBLIC_KEY'), Deno.env.get('VAPID_PRIVATE_KEY'));
  } catch {
    return json({ error: 'The VAPID keys are missing or invalid in Edge Function secrets.' }, 500);
  }
  let body = {};
  try { body = await req.json(); } catch { /* empty body from cron is fine */ }

  // A crewmate shared a plan: tell everyone else in that crew.
  if (body.action === 'crew') {
    const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    const { data, error } = await admin.auth.getUser(jwt);
    if (error || !data?.user) return json({ error: 'Not signed in.' }, 401);
    const { data: cp, error: e1 } = await admin.from('crew_plans').select('*').eq('id', body.crewPlanId).maybeSingle();
    if (e1 || !cp) return json({ error: 'That crew plan was not found.' }, 404);
    if (cp.user_id !== data.user.id) return json({ error: 'You can only announce your own plans.' }, 403);
    // Announce a plan once, when it's first shared (editing its note later doesn't notify everyone again).
    if (!body.force && Date.now() - new Date(cp.created_at).getTime() > 10 * 60 * 1000) return json({ sent: 0, skipped: 'already announced' });
    const { data: mates } = await admin.from('crew_members').select('user_id').eq('crew_id', cp.crew_id).neq('user_id', data.user.id);
    // Respect each crewmate's own setting (You → Alerts → crew notifications).
    const ids = (mates || []).map(m => m.user_id);
    const { data: states } = ids.length ? await admin.from('user_state').select('user_id, data').in('user_id', ids) : { data: [] };
    const muted = new Set((states || []).filter(r => r.data?.settings?.alerts?.crew === false).map(r => r.user_id));
    const e = { type: cp.type, t: cp.t, dayT: cp.day_t ?? cp.t, offset: cp.offset_s || 0 };
    const hunt = cp.hunt && cp.hunt !== 'colour' && HUNT_LABEL[cp.hunt] ? ` (${huntWord(cp.hunt)})` : '';
    const payload = {
      title: `${cp.display_name} is heading to ${cp.spot_name}`,
      body: `${sessionLabel(e)} ${fmtTime(cp.t, e.offset)}${cp.score != null ? `, score ${cp.score}${hunt}` : ''}.${cp.note ? ` "${cp.note}"` : ''} Tap to see the spot.`,
      tag: `crew-${cp.session_key}`, url: `./#crew-${cp.id}`,
    };
    let sent = 0;
    for (const m of mates || []) { if (muted.has(m.user_id)) continue; try { sent += await sendToUser(admin, m.user_id, payload); } catch (err) { console.error('crew push failed', err?.message); } }
    console.log(`crew plan ${cp.id}: ${mates?.length || 0} crewmates, ${sent} notifications`);
    return json({ sent });
  }

  if (body.action === 'test') {
    const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    const { data, error } = await admin.auth.getUser(jwt);
    if (error || !data?.user) return json({ error: 'Not signed in.' }, 401);
    console.log(`test for ${data.user.id} using admin key from ${ak.from} (${keyKind(ak.key)})`);
    try {
      const sent = await sendToUser(admin, data.user.id, { title: 'Tidelight alerts are on', body: "You'll hear from me when the light lines up.", tag: 'test', url: './' });
      return json(sent ? { sent } : { sent: 0, error: `No devices found for your account (admin key: ${keyKind(ak.key)} from ${ak.from}). Turn alerts on first.` });
    } catch (e) {
      console.error('test failed:', e?.message);
      return json({ sent: 0, error: `${e?.message} (admin key: ${keyKind(ak.key)} from ${ak.from})` });
    }
  }

  const secret = Deno.env.get('CRON_SECRET');
  if (!secret || req.headers.get('x-cron-secret') !== secret) return json({ error: 'Forbidden' }, 403);
  const { data: subs, error } = await admin.from('push_subscriptions').select('user_id');
  if (error) { console.error('cron: could not read devices:', error.message, `(admin key from ${ak.from}, ${keyKind(ak.key)})`); return json({ error: error.message }, 500); }
  console.log(`cron: ${subs?.length || 0} devices found (admin key from ${ak.from}, ${keyKind(ak.key)})`);
  const users = [...new Set((subs || []).map(s => s.user_id))];
  clearCache();   // a warm function keeps memory between runs: always score with fresh forecasts
  let sent = 0;
  for (const uid of users) {
    try { sent += (await checkUser(admin, uid)).sent; } catch (e) { console.error('user check failed', uid, e?.message); }
  }
  return json({ users: users.length, sent });
}

Deno.serve(handler);
