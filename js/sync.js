// Sign-in and sync with Supabase (Phase 2).
// Local-first: the app always works from this device's copy. When signed in, it merges with your
// private copy in Supabase record by record (newest change wins, deletions are remembered), then
// uploads the result. Spot photos sync through a private storage bucket. The Claude key never syncs.
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js?v=3.1';
import { getState, applyMerged, onLocalChange, COLLECTIONS, syncedSettings } from './storage.js?v=3.1';
import { getPhotoBlob, putPhotoBlob, hasPhoto } from './photos.js?v=3.1';

const TABLE = 'user_state';
const BUCKET = 'photos';
const TOMBSTONE_DAYS = 120;

let client = null;
let session = null;
let syncing = false, again = false, timer = null;
const status = { state: 'idle', error: null, lastSync: Number(localStorage.getItem('tidelight:lastSync') || 0) };
const statusListeners = new Set();
let onRemoteChange = () => {};

export const isConfigured = () =>
  !!(window.supabase && SUPABASE_URL && SUPABASE_ANON_KEY && !SUPABASE_ANON_KEY.startsWith('PASTE'));
export const currentUser = () => session?.user || null;
export const syncStatus = () => ({ ...status, email: session?.user?.email || null, configured: isConfigured() });
export const onSyncStatus = fn => { statusListeners.add(fn); return () => statusListeners.delete(fn); };
function setStatus(patch) { Object.assign(status, patch); statusListeners.forEach(f => { try { f(syncStatus()); } catch {} }); }

// Call once at start-up. `remoteChanged` runs when a sync brings in changes, so views can redraw.
export async function initSync(remoteChanged) {
  onRemoteChange = remoteChanged || onRemoteChange;
  if (!isConfigured()) return;
  client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: 'tidelight-auth' },
  });
  const { data } = await client.auth.getSession();
  session = data.session;
  client.auth.onAuthStateChange((event, s) => {
    const wasSignedIn = !!session;
    session = s;
    setStatus({});
    if (s && (!wasSignedIn || event === 'SIGNED_IN')) syncNow();
  });
  onLocalChange(() => scheduleSync());
  window.addEventListener('online', () => syncNow());
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') syncNow(); });
  if (session) syncNow();
}

/* ---------- sign-in with email and password (current) ---------- */
function authError(error) {
  const m = error?.message || 'Sign-in failed';
  if (/invalid login credentials/i.test(m)) return 'That email and password don\'t match. Check them, or create an account first.';
  if (/email not confirmed/i.test(m)) return 'This account needs its email confirmed. Tap the link Supabase emailed you, or turn off "Confirm email" in Supabase (see the README), then sign in.';
  if (/already registered|already exists/i.test(m)) return 'There\'s already an account with that email. Use Sign in instead.';
  if (/password/i.test(m) && /least|short|characters/i.test(m)) return 'Choose a password of at least 8 characters.';
  return m;
}
export async function signInWithPassword(email, password) {
  if (!client) throw new Error('Sync is not set up yet. Add your Supabase anon key to js/config.js.');
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(authError(error));
  session = data.session;
  setStatus({});
  await syncNow();
}
// Returns true when signed straight in; false when Supabase wants the email confirmed first.
export async function createAccount(email, password) {
  if (!client) throw new Error('Sync is not set up yet. Add your Supabase anon key to js/config.js.');
  if (password.length < 8) throw new Error('Choose a password of at least 8 characters.');
  const { data, error } = await client.auth.signUp({ email, password, options: { emailRedirectTo: location.origin + location.pathname } });
  if (error) throw new Error(authError(error));
  if (!data.session) return false;
  session = data.session;
  setStatus({});
  await syncNow();
  return true;
}

/* ---------- sign-in by emailed code (for later: needs custom SMTP to edit the email template) ---------- */
export async function sendCode(email) {
  if (!client) throw new Error('Sync is not set up yet. Add your Supabase anon key to js/config.js.');
  const { error } = await client.auth.signInWithOtp({
    email, options: { shouldCreateUser: true, emailRedirectTo: location.origin + location.pathname },
  });
  if (error) throw new Error(error.message);
}
export async function verifyCode(email, code) {
  const { data, error } = await client.auth.verifyOtp({ email, token: code.trim(), type: 'email' });
  if (error) throw new Error(error.message.includes('expired') ? 'That code has expired or is wrong. Request a new one.' : error.message);
  session = data.session;
  setStatus({});
  await syncNow();
}
export async function signOut() {
  if (client) await client.auth.signOut();
  session = null;
  setStatus({ state: 'idle', error: null });
}

/* ---------- merging ---------- */
const emptyRemote = () => ({ spots: [], plans: [], keepers: [], settings: null, meta: { deleted: { spots: {}, plans: {}, keepers: {} }, settingsAt: 0 } });

function mergeCollection(localArr, remoteArr, localDel = {}, remoteDel = {}) {
  const cutoff = Date.now() - TOMBSTONE_DAYS * 86400000;
  const deleted = {};
  for (const [id, t] of Object.entries({ ...remoteDel })) deleted[id] = t;
  for (const [id, t] of Object.entries(localDel)) deleted[id] = Math.max(deleted[id] || 0, t);
  for (const [id, t] of Object.entries(deleted)) if (t < cutoff) delete deleted[id];

  const byId = new Map();
  const order = [];
  for (const r of localArr) { byId.set(r.id, r); order.push(r.id); }
  for (const r of remoteArr) {
    const cur = byId.get(r.id);
    if (!cur) { byId.set(r.id, r); order.push(r.id); }
    else if ((r.updatedAt || 0) > (cur.updatedAt || 0)) byId.set(r.id, r);
  }
  const items = order.map(id => byId.get(id)).filter(r => !(deleted[r.id] && deleted[r.id] >= (r.updatedAt || 0)));
  return { items, deleted };
}

function merge(local, remote) {
  const out = { meta: { deleted: {}, settingsAt: 0 } };
  for (const c of COLLECTIONS) {
    const m = mergeCollection(local[c] || [], remote[c] || [], local.meta?.deleted?.[c], remote.meta?.deleted?.[c]);
    out[c] = m.items;
    out.meta.deleted[c] = m.deleted;
  }
  const lAt = local.meta?.settingsAt || 0, rAt = remote.meta?.settingsAt || 0;
  out.settings = rAt > lAt && remote.settings ? remote.settings : syncedSettings(local.settings);
  out.meta.settingsAt = Math.max(lAt, rAt);
  return out;
}

const toRemote = st => ({
  spots: st.spots, plans: st.plans, keepers: st.keepers,
  settings: syncedSettings(st.settings), meta: st.meta,
});

/* ---------- syncing ---------- */
export function scheduleSync(delay = 2500) {
  if (!session) return;
  clearTimeout(timer);
  timer = setTimeout(syncNow, delay);
}

export async function syncNow() {
  if (!client || !session || !navigator.onLine) return;
  if (syncing) { again = true; return; }
  syncing = true;
  setStatus({ state: 'syncing', error: null });
  try {
    const uid = session.user.id;
    const { data: row, error } = await client.from(TABLE).select('data').eq('user_id', uid).maybeSingle();
    if (error) throw error;
    const remote = row?.data || emptyRemote();
    const local = getState();
    const before = JSON.stringify(toRemote(local));
    const merged = merge(local, remote);
    applyMerged(merged);
    const after = toRemote(getState());
    const afterJson = JSON.stringify(after);
    if (afterJson !== JSON.stringify(remote)) {
      const { error: upErr } = await client.from(TABLE).upsert({ user_id: uid, data: after, updated_at: new Date().toISOString() });
      if (upErr) throw upErr;
    }
    const photosChanged = await syncPhotos(uid);
    const now = Date.now();
    localStorage.setItem('tidelight:lastSync', String(now));
    setStatus({ state: 'idle', lastSync: now, error: null });
    if (afterJson !== before || photosChanged) onRemoteChange();
  } catch (e) {
    setStatus({ state: 'error', error: friendly(e) });
  } finally {
    syncing = false;
    if (again) { again = false; setTimeout(syncNow, 400); }
  }
}

async function syncPhotos(uid) {
  const store = client.storage.from(BUCKET);
  const referenced = new Set(getState().spots.flatMap(s => s.photos || []));
  const { data: files, error } = await store.list(uid, { limit: 1000 });
  if (error) throw error;
  const remoteIds = new Set((files || []).map(f => f.name.replace(/\.jpg$/, '')));
  let changed = false;
  for (const id of referenced) {
    if (!remoteIds.has(id)) {
      const blob = await getPhotoBlob(id);
      if (blob) {
        const { error: e } = await store.upload(`${uid}/${id}.jpg`, blob, { contentType: 'image/jpeg', upsert: true });
        if (e) throw e;
      }
    } else if (!hasPhoto(id)) {
      const { data: blob, error: e } = await store.download(`${uid}/${id}.jpg`);
      if (!e && blob) { await putPhotoBlob(id, blob); changed = true; }
    }
  }
  const orphans = [...remoteIds].filter(id => !referenced.has(id)).map(id => `${uid}/${id}.jpg`);
  if (orphans.length) await store.remove(orphans);
  return changed;
}

function friendly(e) {
  const m = String(e?.message || e || 'Sync failed');
  if (/relation .* does not exist|user_state/i.test(m)) return 'The sync table is missing. Run supabase/schema.sql in the Supabase SQL editor.';
  if (/bucket not found/i.test(m)) return 'The photos bucket is missing. Run supabase/schema.sql in the Supabase SQL editor.';
  if (/JWT|token/i.test(m)) return 'Your sign-in expired. Sign in again.';
  if (/Failed to fetch|NetworkError/i.test(m)) return 'Couldn\'t reach Supabase. Check your connection.';
  return m;
}

/* ---------- alerts: push subscriptions + test (Phase 2) ---------- */
export async function savePushSubscription(subJson) {
  if (!client || !session) throw new Error('Sign in first to turn on alerts.');
  const { error } = await client.from('push_subscriptions')
    .upsert({ user_id: session.user.id, endpoint: subJson.endpoint, subscription: subJson }, { onConflict: 'endpoint' });
  if (error) throw new Error(/push_subscriptions/.test(error.message) ? 'The alerts table is missing. Run supabase/alerts.sql in the Supabase SQL editor.' : error.message);
}
export async function removePushSubscription(endpoint) {
  if (!client || !session) return;
  await client.from('push_subscriptions').delete().eq('endpoint', endpoint);
}
export async function sendTestAlert() {
  if (!client || !session) throw new Error('Sign in first.');
  const { data, error } = await client.functions.invoke('check-alerts', { body: { action: 'test' } });
  if (error) {
    // Pull out what actually went wrong, so setup mistakes are easy to spot.
    const status = error.context?.status;
    let detail = '';
    try {
      const text = await error.context?.text?.();
      detail = text || '';
      try { const j = JSON.parse(text); detail = j.error || j.msg || j.message || text; } catch {}
    } catch {}
    throw new Error(explainFunctionError(error.name, status, String(detail)));
  }
  if (!data?.sent) throw new Error(data?.error || 'No devices found for your account. Turn alerts on first.');
  return data.sent;
}

function explainFunctionError(name, status, detail) {
  const d = detail.toLowerCase();
  if (status === 404 || d.includes('not found')) return 'Supabase can\'t find a function called check-alerts. Check it\'s deployed and named exactly check-alerts (all lower case, with the hyphen).';
  if (d.includes('credentials') || d.includes('apikey') || d.includes('api key')) return 'Supabase didn\'t accept the project key the app sent. In js/config.js, use the Publishable key (Project Settings → API Keys, starts sb_publishable_) as SUPABASE_ANON_KEY, upload it, and try again.';
  if (status === 401 && (d.includes('jwt') || d.includes('authorization'))) return 'The function is rejecting the request. Open check-alerts in Supabase and switch off "Verify JWT" (README step 6), then try again.';
  if (d.includes('vapid')) return 'The function is running but can\'t find your alert keys. Check the four secrets in Edge Functions → Secrets (README step 5): names must match exactly, with no spaces.';
  if (status >= 500 || d.includes('boot') || d.includes('worker')) return `The function failed to start or crashed${status ? ` (error ${status})` : ''}. Open Edge Functions → check-alerts → Logs in Supabase and send me what it says.`;
  if (name === 'FunctionsFetchError') return 'Couldn\'t reach the alerts function. This usually means it isn\'t deployed yet, or it failed to start: check Edge Functions → check-alerts → Logs.';
  return `The alerts function returned an error${status ? ` (${status})` : ''}${detail ? `: ${detail.slice(0, 160)}` : ''}.`;
}
