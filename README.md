# Tidelight

A personal light planner for seascape and landscape photographers. It scores every sunrise and sunset at your spots for the next 7 days using sky, tide and sea conditions. It also tells you when to leave and learns which conditions produce *your* best shots.

It's a static web app: no server, no build step, no accounts. It runs free on GitHub Pages and works on your phone like an app.

## What it does

- **Forecast page: The Call + spot matrix.** The page opens on the single best session in the next 3 days: your spot photo, a plain verdict ("Go for *fog.*"), the score, leave time and the main reason, with *Read the briefing* and *Plan it*. Below that are three runners-up, preferring different spots. *All 3 days* opens a grid of every spot against every session (sunrise, sunset, night), shaded in four score bands, with tide-blocked sessions marked. Tap a square for its summary and briefing.
- **Hunts per spot: Colour, Fog, Storm, Lightning, Rainbow.** Choose what you shoot at each spot. Each hunt gets its own 0–100 score, and the session shows the best one:
  - *Fog* (sunrise) uses the dew point gap, humidity, overnight wind and cloud, forecast visibility and recent rain. Mark a spot "above the fog" for lookouts; it then also checks the spot's elevation.
  - *Storm* uses storm energy (CAPE), lifted index, convective inhibition, gusts and thunderstorm forecasts in the hours around the session.
  - *Lightning* looks for storm potential in the dark hours after sunset or before sunrise, when lightning is easiest to shoot.
  - *Rainbow* needs showers, breaks in the cloud and the sun below 42°, and tells you which way to look.
- **Night sessions: Aurora and Milky Way.** Tick these hunts on a spot and each day gets a *Night* session, timed to the best hour between sunset and sunrise.
  - *Aurora* uses NOAA's free 3-day Kp forecast, your spot's geomagnetic latitude (Melbourne needs roughly Kp 5.5, Hobart about Kp 4), darkness, cloud and moonlight.
  - *Milky Way* calculates where the galactic core sits each hour, and combines that with true darkness, moon phase and position, and cloud. If you've set a facing direction, it tells you how well the core lines up with your composition.
- **Tide access windows.** For rock shelves, caves and sandbars, set the tide level (as a % of the range) the spot is reachable below, plus a safety buffer. The app shows when access opens, when to be back off, and flags sessions the tide blocks.
- **Hit-rate tracker** (Plans). Shows how often the app's call matched your rating, the average predicted score of sessions that delivered versus those that didn't, and accuracy per spot. You can also log sessions you shot without planning them.
- **Hourly forecast** (top of Right now, or *Hourly forecast* on any spot). The next 48 hours for your current location, any spot or any searched place: a plain summary ("Dry until about 4pm, then rain likely until 9pm"), a 24-hour rain and temperature chart, and hour-by-hour rows (conditions, temperature, rain chance and amount, wind and gusts with direction, cloud), with sunrise and sunset marked.
- **Right now** (radar button in the header). Current modelled conditions at every spot, the tide right now, an animated rain radar, and quick links to the Bureau of Meteorology radar, satellite loop and warnings.
- **Offline mode.** Once you've opened the app with reception, it works without it: the app, your last forecasts, tides and viewed map tiles are saved on the device.
- **Lightning distance timer** (Coach → Field tools, or from any lightning score). Tap on the flash, tap on the thunder, and it shows the distance, whether the storm is closing in, and a shelter warning inside 10 km.
- **Go/no-go scores (0–100)** for every sunrise and sunset at each spot, built from low, mid and high cloud, rain, visibility, wind, tide and waves.
- **Leave times** based on drive time from home, plus how early you like to be on location.
- **Light timeline** showing blue hour, golden hour, sun azimuth, and the nearest high or low tide.
- **Place search on the Spots map.** Search a beach, landmark, lookout or town (OpenStreetMap, preferring results near home), or paste coordinates. The map jumps there with an *Add spot here* button, and the spot name is filled in for you.
- **Your own photos on each spot.** Add as many as you like and choose a cover. The cover appears in the spot list, the session details and the forecast's top pick. A new spot can take its location from a photo's GPS data.
- **Plans with calendar export (.ics)**, including a 15-minute alarm.
- **Personal score.** Import your keeper photos. The app reads each photo's capture time and location, looks up the conditions at that moment, and blends a "your style" score into every forecast once you have 3 or more keepers.
- **Feedback loop.** After a planned session, rate it (delivered, so-so, or not worth it). The app fetches what *actually* happened and learns from it.
- **Recreate a shot.** Upload any photo and it finds the upcoming sessions across your spots whose conditions match best.
- **Optional AI coach (Claude).** It writes plain-English briefings with shooting suggestions and reads the sky from reference photos that have no metadata.

## Put it on GitHub Pages (about 5 minutes, no coding)

1. Sign in at [github.com](https://github.com) and click **New repository**. Name it `tidelight`, set it to **Public** (free Pages needs public, unless you have GitHub Pro), and click **Create repository**.
2. On the new repo page, click **uploading an existing file**. Drag in **everything inside this folder**: `index.html`, `manifest.webmanifest`, `.nojekyll`, and the `css`, `js` and `icons` folders. Click **Commit changes**.
   - If drag-and-drop skips `.nojekyll`, that's fine. The app works without it.
3. Go to **Settings → Pages**. Under *Build and deployment*, set **Source: Deploy from a branch**, **Branch: main**, folder **/(root)**, and click **Save**.
4. Wait about a minute, then refresh. Your app is live at `https://YOUR-USERNAME.github.io/tidelight/`.
5. On iPhone, open that link in Safari, tap **Share → Add to Home Screen**.

### Or with git

```bash
cd tidelight
git init && git add . && git commit -m "Tidelight"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/tidelight.git
git push -u origin main
```
Then enable Pages as in step 3. Any later `git push` redeploys automatically.

## Sign-in and sync (Supabase)

Sync keeps spots, photos, plans, keepers and settings in step across devices. The Claude key never syncs.

1. **Add your anon key.** In Supabase, open Project Settings → API, copy the **anon public** key, and paste it into `js/config.js` in place of `PASTE_YOUR_ANON_KEY_HERE`. The anon key is safe in a public repo. **Never** use the `service_role` key.
2. **Create the table and photo bucket.** In Supabase, open SQL Editor → New query, paste all of `supabase/schema.sql`, and click Run.
3. **Point sign-in at your site.** Authentication → URL Configuration: set **Site URL** to your GitHub Pages address (for example `https://YOUR-USERNAME.github.io/tidelight/`) and add the same address under **Redirect URLs**.
4. **Turn off email confirmation (personal use).** Authentication → Sign In / Providers → Email → switch off **Confirm email** and save. This lets you sign in straight away without Supabase sending an email (new free projects can't edit email templates without custom SMTP). Turn it back on, with custom SMTP, before launch.
5. **Create your account and sign in.** In the app, Settings → Account and sync → enter your email and a password (at least 8 characters) → **Create account**. Your existing data uploads straight away. On your other devices, use the same details and tap **Sign in**.

Password reset needs email, so keep your password in your password manager until custom SMTP is set up. The emailed-code sign-in is still in `js/sync.js`, ready to switch back to once custom SMTP unlocks the email templates.

How it works: the app always runs from the device's own copy (so it works offline), then merges with your Supabase copy record by record. The newest change to each spot, plan or keeper wins, and deletions are remembered for 120 days so they don't come back. Before launch, set up custom SMTP: Supabase's built-in email sender only allows a couple of emails an hour, and new free projects can't edit email templates without it.

Free-plan note: Supabase pauses free projects after a week without use. Opening the app syncs and counts as use; if it does pause, restore it from the Supabase dashboard.

## Updating without stale caches

Phones, and especially home-screen web apps, cache files aggressively. Every file is loaded with a version tag (`?v=2.5`), so a new version always loads fresh. When you change the code yourself, bump the number in `index.html` (two places) and in the `import` lines at the top of each file in `js/`. The current version is shown at the bottom of **Settings**.

### Releasing a new version
Bump the version in three places so phones pick it up straight away:
1. `?v=` tags in `index.html` and in the `import` lines at the top of each file in `js/`
2. `APP_VERSION` in `js/app.js`
3. `VERSION` in `sw.js`

## Run it locally

ES modules need a web server (opening `index.html` directly won't work):

```bash
cd tidelight
python3 -m http.server 8000
# open http://localhost:8000
```

## First-time setup in the app

1. **Settings → Home:** tap *Use my location*, then **Save**. This enables leave times.
2. **Spots:** search for a place or tap the map where you shoot, name the spot, choose sunrise and/or sunset, and best tide. Optionally add a fixed drive time and the compass bearing you face.
3. **Coach:** import 3–10 of your best photos to switch on your personal score.
4. *(Optional)* **Settings → AI coach:** paste a Claude API key from [console.anthropic.com](https://console.anthropic.com) and tap **Test key**.

## About the AI key

The key is saved only in your browser's local storage on that device. It is **never** written into your GitHub repo or into exported backups. Because the app calls the Claude API directly from your browser, only use it on your own devices. Don't share your browser profile with others while a key is saved. You can set a monthly spend limit in the Anthropic console. Each briefing costs a fraction of a cent.

If a model name stops working, change it under **Settings → AI coach → Model**.

## How the score works

The **base score** (`js/scoring.js → baseScore`) is a set of transparent rules:

| Factor | Effect |
|---|---|
| Mid/high cloud ("canvas") | Best around 50% cover. Clear skies give clean light but little colour; full cover mutes it. |
| Low cloud | Blocks the horizon, so it's a heavy penalty above about 60%. |
| Rain chance, fog | Penalised, though fog is noted as "moody". |
| Tide | Compared with the tide you want at that spot. |
| Wind | A small penalty for long exposures. |

The **personal score** compares the conditions of each upcoming session with your keepers and duds. It uses a nearest-neighbour similarity across low, mid and high cloud, rain, wind, tide position and wave height. Its weight grows with the number of keepers, up to 60% at 10.

Tune any of this in `js/scoring.js`. It's commented and self-contained.

## Data and privacy

- Place search uses OpenStreetMap's Nominatim service (free, one search per second, which the app respects), falling back to Open-Meteo's town search.
- Aurora forecasts come from NOAA's Space Weather Prediction Center (free). Live radar comes from RainViewer's free tier, which may change; if it stops, the Right now view falls back to Bureau of Meteorology links.
- Weather, tide (modelled sea level) and waves come from [Open-Meteo](https://open-meteo.com), which is free and keyless for non-commercial use (CC BY 4.0). Historical conditions for keepers come from the Open-Meteo archive.
- The map uses standard OpenStreetMap tiles (no key needed), darkened with CSS to match the theme.
- The header loads your logo from tysonwaldron.com. If it can't load, it shows "Tyson Waldron" in text.
- Spots, plans, keeper thumbnails and settings live in your browser's localStorage. Spot photos are stored in the browser's IndexedDB, resized to 1600 px. **Settings → Export backup** includes your spot photos, so you can move everything to another device.

## Known limits

- **Tides are modelled**, not official tide tables, and can be off near estuaries, bays and harbours. If a coastal spot shows no tide or wave data, move the pin slightly offshore.
- **iPhone photo location:** Safari can strip GPS data from photos you pick. If imports say "no location", choose a fallback spot on the Coach screen.
- **Photo time zone:** photo times are read as your device's current time zone, so photos taken while travelling across time zones may match the wrong hour.
- **No background alerts:** it's a static site, so notifications only happen through the calendar alarms you export. A future upgrade could add a scheduled GitHub Action that checks your spots and emails you.
- **Not a safety tool.** Always check official marine and weather warnings and conditions on the ground.

## Project structure

```
index.html            App shell, loads CDN libraries (Leaflet, SunCalc, exifr)
manifest.webmanifest  Home-screen install
css/styles.css        All styling, matched to tysonwaldron.com
js/app.js             Views: forecast, spots, plans, coach, settings
js/scoring.js         Colour score, tide analysis, personal model, event builder
js/hunts.js           Fog, storm, lightning, rainbow, aurora and Milky Way scores
js/api.js             Open-Meteo forecast, marine and archive calls
js/ai.js              Claude API calls and photo/EXIF helpers
js/storage.js         localStorage state, backup and restore
js/photos.js          Spot photos (IndexedDB), resize, backup
js/sync.js            Sign-in and sync with Supabase
js/config.js          Supabase project URL and anon key
supabase/schema.sql   Table, photo bucket and security rules to run in Supabase
sw.js                 Offline support (service worker)
js/util.js            Formatting and small helpers
icons/                App icons
```
