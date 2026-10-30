/* ===== Tidelight hourly alerts (Supabase Edge Function) =====
   Runs every hour (pg_cron → POST with x-cron-secret). For each user with a device signed up for alerts:
   loads their spots, keepers and settings, scores the next 36 hours with the app's own engine,
   and sends web-push notifications: Go alerts, called-off alerts, and a weekly digest.
   Also answers { action: 'test' } from the app (with the user's sign-in token) to send a test. */

const { evaluateSpot } = M_scoring;
const { setKp, HUNT_LABEL, HUNT_VERB } = M_hunts;
const { fetchSpotForecast, fetchKp, clearCache } = M_api;
const { fmtTime, fmtDay } = M_util;

const DEFAULT_ALERTS = { go: true, threshold: 80, confident: true, calledOff: true, digest: true, digestDay: 4, digestHour: 19, quietStart: 21, quietEnd: 6 };
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
  return `${day} ${e.type}`;
}
const goTitle = e => (e.topHunt === 'colour' ? `Worth the alarm: ${e.spot.name}` : `Go for ${HUNT_VERB[e.topHunt]} at ${e.spot.name}`);
function goBody(e) {
  const when = e.type === 'night' ? `${sessionLabel(e)}, best around ${fmtTime(e.t, e.offset)}` : `${sessionLabel(e)} ${fmtTime(e.t, e.offset)}`;
  const hunt = e.topHunt !== 'colour' ? ` (${HUNT_LABEL[e.topHunt].toLowerCase()})` : '';
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
  if (!prefs.go && !prefs.calledOff && !prefs.digest) return { sent: 0 };

  if (d.spots.some(s => (s.hunts || []).includes('aurora'))) { try { setKp(await fetchKp()); } catch { setKp([]); } }
  const events = [];
  let offset = null;
  for (const spot of d.spots) {
    try {
      const data = await fetchSpotForecast(spot);
      if (offset == null) offset = data.offset;
      events.push(...evaluateSpot(spot, data, d.keepers || [], settings));
    } catch (e) { console.error('forecast failed', spot.name, e?.message); }
  }
  if (offset == null) return { sent: 0 };

  const now = Date.now() / 1000;
  const local = new Date((now + offset) * 1000);
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

  // Weekly digest: the best 3 sessions in the next 3 days, on your chosen day and hour.
  if (prefs.digest && day === prefs.digestDay && hour === prefs.digestHour) {
    const dkey = `digest-${local.toISOString().slice(0, 10)}`;
    if (!done.has(`digest|${dkey}`)) {
      const top = events.filter(e => e.t > now && e.t < now + 3 * 86400).sort((a, b) => b.score - a.score).slice(0, 3);
      if (top.length) {
        toSend.push({
          title: 'Your best light, next 3 days',
          body: top.map(e => `${sessionLabel(e)}: ${e.spot.name}, ${e.score}${e.topHunt !== 'colour' ? ` (${HUNT_LABEL[e.topHunt].toLowerCase()})` : ''}`).join('\n'),
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
