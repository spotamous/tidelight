// Tidelight: quiet error reports, so a crash on a tester's phone reaches Tyson without screenshots.
// What's sent: the error message and where in the code it happened, the app version, which screen was
// open, and the phone/browser type. Never your email, spots, plans or location.
// Reports go to Supabase (table app_errors, write-only: nobody can read them back through the app).
// Offline errors wait on this device (up to 10) and go when you're back online.
import { APP_VERSION } from './version.js?v=7.1';
import { reportError } from './sync.js?v=7.1';
import { ui } from './core.js?v=7.1';

const MAX_PER_SESSION = 8;
const PENDING = 'tidelight:pendingErrors';
const seen = new Set();
let sent = 0, flushing = false;

// Not bugs: no reception, a request we cancelled, and noise browsers raise on their own.
const IGNORE = [/Failed to fetch/i, /Load failed/i, /NetworkError/i, /No connection/i, /took too long/i, /AbortError/i, /aborted/i,
  /ResizeObserver loop/i, /^Script error\.?$/i, /Weather service error 5\d\d/i];

const clip = (s, n) => (s == null || s === '' ? null : String(s).slice(0, n));

function device() {
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  return clip(`${navigator.userAgent.slice(0, 170)} | ${innerWidth}x${innerHeight} | ${standalone ? 'home screen' : 'browser'}${navigator.onLine ? '' : ' | offline'}`, 240);
}
function screenName() {
  try {
    const sheet = document.querySelector('#sheet:not(.hidden) .eyebrow, #sheet:not(.hidden) h2')?.textContent?.trim();
    const sky = document.querySelector('.skyar') ? 'sky view' : '';
    return clip([ui.tab, ui.youPage, sky, sheet && `sheet: ${sheet}`].filter(Boolean).join(' / '), 60);
  } catch { return null; }
}
function sourceOf(err, fallback) {
  if (fallback) return fallback;
  // first line of the stack that points into our own files: "forecast.js:120:14"
  const m = String(err?.stack || '').match(/\/(js\/[\w-]+\.js)[^:\s]*:(\d+):(\d+)/);
  return m ? `${m[1]}:${m[2]}:${m[3]}` : null;
}
// Strip the ?v= tags and the host from stack traces so they're short and identical across versions.
const tidyStack = s => clip(String(s || '').replace(/https?:\/\/[^/\s)]+\//g, '').replace(/\?v=[\d.]+/g, ''), 2000);

export function report(kind, err, source) {
  try {
    const message = clip(err?.message || (typeof err === 'string' ? err : err && JSON.stringify(err)) || 'Unknown error', 500);
    if (IGNORE.some(re => re.test(message))) return;
    const src = clip(sourceOf(err, source), 200);
    const key = `${message}|${src}`;
    if (seen.has(key) || sent >= MAX_PER_SESSION) return;
    seen.add(key); sent++;
    queue({ kind, message, source: src, stack: tidyStack(err?.stack), app_version: APP_VERSION, screen: screenName(), device: device() });
  } catch {}   // reporting must never cause an error of its own
}

function readPending() { try { return JSON.parse(localStorage.getItem(PENDING) || '[]'); } catch { return []; } }
function writePending(rows) { try { rows.length ? localStorage.setItem(PENDING, JSON.stringify(rows.slice(-10))) : localStorage.removeItem(PENDING); } catch {} }
function queue(row) { writePending([...readPending(), row]); flushErrors(); }

// Send whatever is waiting. Safe to call any time; does nothing offline or before Supabase is ready.
export async function flushErrors() {
  if (flushing || !navigator.onLine) return;
  flushing = true;
  try {
    let rows = readPending();
    while (rows.length) {
      let ok = false;
      try { ok = await reportError(rows[0]); } catch (e) {
        if (/violates|check constraint|invalid input/i.test(e?.message || '')) ok = true;   // a bad row: drop it rather than retry forever
      }
      if (!ok) break;
      rows = rows.slice(1); writePending(rows);
    }
  } finally { flushing = false; }
}

// Start listening. Picks up anything the page caught before the app finished loading (see index.html).
export function startErrorReports() {
  const early = window.__tl?.errs || [];
  if (window.__tl) { window.__tl.booted = true; window.__tl.report = report; }
  early.forEach(e => report(e.kind, { message: e.message, stack: e.stack }, e.source));
  window.addEventListener('error', ev => {
    if (ev.target && ev.target !== window) return;   // a failed image or tile: not a bug
    report('error', ev.error || { message: ev.message }, ev.error ? null : `${ev.filename || ''}:${ev.lineno || 0}`);
  });
  window.addEventListener('unhandledrejection', ev => report('rejection', ev.reason));
  window.addEventListener('online', () => flushErrors());
}
