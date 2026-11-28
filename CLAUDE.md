# Tidelight: notes for Claude

Tidelight is Tyson Waldron's photography planning app: a static ES-module PWA on GitHub Pages
(`https://spotamous.github.io/tidelight/`), with Supabase for sign-in, sync, error reports and
the hourly alerts function. Testers use it every day, so every change ships as a release.

## The rules (always)

1. **Never push to `main` without Tyson's go-ahead** ("push it live" or similar). Work on a branch
   (`release/<version>`), push the branch, then ask. Before pushing to main, check
   `git merge-base --is-ancestor origin/main <branch>`.
2. **Every change to anything phones load is a release.** That's any file in `js/`, `css/`,
   `index.html`, `sw.js`, `manifest.webmanifest` or `icons/`. The service worker serves files
   cache-first by version, so without a version bump **testers never see the change**.
3. **Every release gets a What's new entry** for testers (see below). No entry, no release.
4. **Never put keys or secrets in the repo or in chat.** Never share Tyson's email addresses in
   anything sent outside.
5. **Deploying the alerts function needs Tyson's go-ahead too** ("deploy the alerts").

## Releasing a version (the checklist)

1. Branch from main: `git fetch && git checkout -B release/X.Y.Z origin/main`
2. Make the change.
3. Bump the version everywhere: `tools/bump.sh X.Y.Z`. It updates the `?v=` tags in
   `index.html` and every `js/` import, `APP_VERSION` in `js/version.js`, `VERSION` in `sw.js`, the
   README, and rebuilds `supabase/functions/check-alerts/index.ts`.
4. Add the What's new entry at the **top** of `WHATS_NEW` in `js/welcome.js`:
   `{ v: 'X.Y.Z', date: 'D Mon', title: 'Short title', items: ['…', '…'] },`
   Write for testers, not developers: what they'll notice and why it helps, in plain sentences.
5. New file in `js/`? Add it to the `CODE` list in `sw.js` and a `modulepreload` line in `index.html`.
   Changed an icon? Bump the `?v=` on the icon URLs in `index.html`, `manifest.webmanifest` and `sw.js`.
6. Check: `for f in js/*.js; do node --check "$f"; done`, then load the app locally
   (`python3 -m http.server` in this folder) and look at what changed.
7. Commit, push the branch, tell Tyson what changed, and ask before going live.
8. After going live, confirm it: `https://spotamous.github.io/tidelight/js/version.js` shows the new
   `APP_VERSION` within 2–10 minutes.

## The alerts function

- `supabase/functions/check-alerts/index.ts` is **generated**: `node tools/build-alerts.mjs` bundles
  `js/util.js`, `hunts.js`, `scoring.js`, `api.js` and `seas.js` with `tools/alerts-main.js`. Edit those,
  never the generated file. Anything those modules import must also be in the bundle list.
- It's deployed as a tiny `index.ts` that imports the generated file from GitHub **pinned to a commit**:
  `import 'https://raw.githubusercontent.com/spotamous/tidelight/<commit>/supabase/functions/check-alerts/index.ts';`
  (verify_jwt off). Redeploy after a change to scoring, alerts or the bundled modules, once main has
  the commit.
- Runs hourly at :05 (pg_cron). Check the logs for "cron: N devices found" and `POST | 200`.

## Code notes

- `js/app.js` boots; shared screen state lives in the `ui` object in `js/core.js`.
- Scoring is in `js/scoring.js` (colour: `colourCore`), hunts in `js/hunts.js`, big seas in `js/seas.js`
  (logic, shared with alerts) and `js/seasui.js` (screens).
- Shoot records and accuracy: `js/records.js`, `js/accuracy.js`.
- Writing style in the app: plain Australian English, short sentences, sentence-case labels, no
  hype words. Prefer two short sentences over a colon or semicolon.
