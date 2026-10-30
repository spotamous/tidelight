// Data lives in this browser's localStorage. If you sign in (Settings → Account and sync),
// it is also kept in your private Supabase account so your devices stay in step.
// Every change stamps the records it touched (updatedAt) and remembers deletions,
// so two devices can be merged record by record.
const KEY = 'tidelight:v1';

const DEFAULTS = {
  settings: {
    home: null,               // { lat, lon }
    driveSpeedKmh: 60,
    arriveBeforeMin: 30,      // minutes on location before sunrise/sunset
    claudeKey: '',
    claudeModel: 'claude-sonnet-5-5',
    alerts: { go: true, threshold: 80, confident: true, calledOff: true, digest: true, digestDay: 4, digestHour: 19, quietStart: 21, quietEnd: 6 },
  },
  spots: [],                  // { id, name, lat, lon, events[], coastal, tide, driveMin, facing, notes }
  keepers: [],                // { id, label: keeper|dud, source, date(ms), lat, lon, spotName, features[], thumb }
  plans: [],                  // { id, key, spotId, spotName, lat, lon, type, t, leave, offset, score, features, rating }
  meta: { deleted: { spots: {}, plans: {}, keepers: {} }, settingsAt: 0 },
};

export const COLLECTIONS = ['spots', 'plans', 'keepers'];
// Settings that follow you between devices. The Claude key never leaves the device.
export const syncedSettings = s => ({ home: s.home, driveSpeedKmh: s.driveSpeedKmh, arriveBeforeMin: s.arriveBeforeMin, claudeModel: s.claudeModel, alerts: s.alerts });

const clone = o => JSON.parse(JSON.stringify(o));

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return clone(DEFAULTS);
    const s = JSON.parse(raw);
    return {
      ...clone(DEFAULTS), ...s,
      settings: { ...DEFAULTS.settings, ...(s.settings || {}), alerts: { ...DEFAULTS.settings.alerts, ...(s.settings?.alerts || {}) } },
      meta: { ...clone(DEFAULTS.meta), ...(s.meta || {}), deleted: { ...clone(DEFAULTS.meta.deleted), ...(s.meta?.deleted || {}) } },
    };
  } catch {
    return clone(DEFAULTS);
  }
}

let state = load();

export const getState = () => state;

export function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch (e) {
    alert('Storage is full. Delete some keeper photos or export a backup and reset.');
  }
}

const listeners = new Set();
export const onLocalChange = fn => { listeners.add(fn); return () => listeners.delete(fn); };
const bare = r => { const { updatedAt, ...rest } = r; return JSON.stringify(rest); };

export function update(fn) {
  const before = {};
  for (const c of COLLECTIONS) before[c] = new Map(state[c].map(r => [r.id, bare(r)]));
  const settingsBefore = JSON.stringify(syncedSettings(state.settings));
  fn(state);
  const now = Date.now();
  let changed = false;
  for (const c of COLLECTIONS) {
    const seen = new Set();
    for (const r of state[c]) {
      seen.add(r.id);
      if (before[c].get(r.id) !== bare(r)) { r.updatedAt = now; changed = true; delete state.meta.deleted[c][r.id]; }
    }
    for (const id of before[c].keys()) if (!seen.has(id)) { state.meta.deleted[c][id] = now; changed = true; }
  }
  if (JSON.stringify(syncedSettings(state.settings)) !== settingsBefore) { state.meta.settingsAt = now; changed = true; }
  save();
  if (changed) listeners.forEach(f => { try { f(); } catch {} });
}

// Used by sync: replace local data with a merged copy, without stamping it as a new local change.
export function applyMerged(m) {
  for (const c of COLLECTIONS) state[c] = m[c];
  state.meta = m.meta;
  if (m.settings) Object.assign(state.settings, m.settings);
  save();
}

export function exportData() {
  const copy = clone(state);
  copy.settings.claudeKey = ''; // never put the API key in a backup file
  return JSON.stringify({ app: 'tidelight', version: 1, exported: new Date().toISOString(), data: copy }, null, 2);
}

export function importData(text) {
  const parsed = JSON.parse(text);
  const data = parsed.data || parsed;
  if (!Array.isArray(data.spots)) throw new Error('That file is not a Tidelight backup.');
  const key = state.settings.claudeKey;
  state = { ...clone(DEFAULTS), ...data, settings: { ...DEFAULTS.settings, ...(data.settings || {}), claudeKey: key } };
  state.meta = { ...clone(DEFAULTS.meta), ...(data.meta || {}) };
  // Treat restored records as fresh changes so they win when synced.
  const now = Date.now();
  for (const c of COLLECTIONS) state[c].forEach(r => { r.updatedAt = now; });
  state.meta.settingsAt = now;
  save();
  listeners.forEach(f => { try { f(); } catch {} });
}

export function resetAll() {
  localStorage.removeItem(KEY);
  state = clone(DEFAULTS);
}
