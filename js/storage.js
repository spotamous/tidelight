// All data lives in this browser's localStorage. Nothing is sent anywhere except
// weather lookups (Open-Meteo) and, if you add a key, the Claude API.
const KEY = 'tidelight:v1';

const DEFAULTS = {
  settings: {
    home: null,               // { lat, lon }
    driveSpeedKmh: 60,
    arriveBeforeMin: 30,      // minutes on location before sunrise/sunset
    claudeKey: '',
    claudeModel: 'claude-sonnet-5-5',
  },
  spots: [],                  // { id, name, lat, lon, events[], coastal, tide, maxSwell, driveMin, facing, notes }
  keepers: [],                // { id, label: keeper|dud, source, date(ms), lat, lon, spotName, features[], thumb }
  plans: [],                  // { id, key, spotId, spotName, lat, lon, type, t, leave, offset, score, features, rating }
};

const clone = o => JSON.parse(JSON.stringify(o));

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return clone(DEFAULTS);
    const s = JSON.parse(raw);
    return {
      ...clone(DEFAULTS), ...s,
      settings: { ...DEFAULTS.settings, ...(s.settings || {}) },
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

export function update(fn) { fn(state); save(); }

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
  save();
}

export function resetAll() {
  localStorage.removeItem(KEY);
  state = clone(DEFAULTS);
}
