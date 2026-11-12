# Tidelight

A personal light planner for seascape and landscape photographers. It scores every sunrise and sunset at your spots for the next 7 days using sky, tide and sea conditions. It also tells you when to leave and learns which conditions produce *your* best shots.

It's a static web app: no server, no build step, no accounts. It runs free on GitHub Pages and works on your phone like an app.

## What it does

- **Home page: the light band.** Pick today, the next two days or *All spots* (the spot matrix). Each day opens with a plain-language headline for its best session, then a band showing that day's real light from 3am to 3am (dark, blue hour, golden hour, daylight, worked out from the sun's position where you live), with each session marked on it by score. Tap a marker, or any session in the list below, to see it in the detail panel: photo, score, leave time, why it scored that way (a bar for every factor, plus confidence and your style), what could change it, and *Plan this shoot*.
- **Scrub the light band.** Drag along the band (or focus it and use the arrow keys) to see any hour's light phase, cloud layers, rain, wind and temperature, plus the selected session's score at that hour where an hourly score makes sense (colour, forest, waterfall, storms).
- **Swipe.** Swipe the detail panel left or right to step through the day's sessions in time order (or use the arrows under it); swipe the day's headline to change day.
- **Full briefing.** A session's whole story on one sheet: the verdict in a sentence, then *The plan* (leave home, start the hike, blue hour, the sun event, golden hour, tide access) running top to bottom beside a strip coloured by the real light at each step. Below that: the written briefing (one point per line, or rewritten by the AI coach), why it scored that way (the leading hunt's factor bars, other hunts folded away), conditions as a plain list, and what to bring. *Plan this shoot* and *Open field mode* stay pinned at the bottom.
- **Plans: Upcoming, Crew, History.** *Upcoming* leads with the next session: its leave time, a live "in 9 h 12 min", the gear list open for packing, field mode and the briefing; later plans fold to a line each, and sessions waiting for a rating sit at the top. *Crew* holds your crews and who's going where. *History* has the hit rate, rated sessions and a place to log shoots you didn't plan.
- **Field mode.** *Field mode* on any session opens a full-screen view for when you arrive: a big countdown to the next light moment, every moment of the session in order (first light, blue hour, sunrise or sunset, golden hour, full darkness, tide access closing, low or high tide), the sky now and for the next two hours from the saved forecast (works without reception), the tide right now, and shortcuts to the compass and radar. It keeps the screen awake where the device allows, and *Night vision* turns everything red to protect your dark adaptation.
- **Scout a spot.** *Scout this spot* (Spots tab) creates a spot where you stand: GPS location with a suggested name, the direction of your composition from the phone's compass (or typed), an optional photo, hunts and notes. It shows when the sun lines up with that view, as does every spot with a facing direction.
- **Field compass.** *Compass* on any session shows a dial with where the sun rises or sets, the Milky Way core, aurora, a rainbow, and your composition's facing direction. *Point with my phone* uses the phone's compass (corrected from magnetic to true north for Australia and New Zealand) and says which way to turn.
- **Light dial detail and the moon.** Below the dial, *The day's light* lists every phase in order (dark, twilight, blue hour, sunrise, golden hour, daylight, and back again) with start and end times and how long each lasts; the phase under the handle is highlighted and tapping a row moves the dial there. *The moon* shows a picture of the current phase (drawn the right way round for the southern hemisphere), its name, how much is lit, its day in the cycle, where it is at the dial's time, and moonrise and moonset.
- **Slide arrows.** The session panel on the home page has arrows on its photo's bottom corners and dots between them showing which of the day's sessions you're on. Tap the arrows or swipe the panel; they nudge once when the page opens.
- **Dials and sliders.** The score on the home page is a gauge that sweeps to its value; tap it for *What if?*, where sliders for cloud, horizon, rain, wind and tide (or cloud, recent rain and wind for forests; rain and cloud for waterfalls) move the gauge live and explain the change. *Tools → Light dial* is a 24-hour ring coloured by the day's light: drag the handle to any time for the light phase and the sun's and moon's bearing and height (also opens from a briefing, set to that spot and time). Coastal briefings include a tide curve to drag along, showing height and whether access is open. The alert threshold, arrive-early time and drive speed are sliders with live examples. The first time the home page opens, the band's readout sweeps briefly to show it can be dragged.
- **Cloud and rain you can read at a glance.** The band's sky draws proper cumulus clouds (two drifting layers, shaded from bright tops to grey bases, thicker where it's overcast and dimmer after dark), and in hours rain is likely a dark rain cloud along the top with raindrops falling from it (a denser layer for heavy rain). *Cloud* and *Rain likely* icons join the legend on days that have them.
- **Motion.** The light band carries a living sky for the selected spot, drawn from its hourly forecast: cloud drifts through the hours that have cloud (denser where it's overcast), rain falls in the hours rain is likely, and stars twinkle in clear dark hours. The Now line moves in real time, and the selected session shows a live "Leave in…" line. On opening, the band sweeps in and the score markers drop into place; picking a session counts its score up and grows its factor bars in turn; pages ease in on tab changes, lists cascade, pop-ups rise and the week grid fills in. *You → Display → Motion* switches it all to Reduced, and the phone's own Reduce Motion setting is always respected.
- **Polish.** While forecasts load, pages show placeholder shapes in their own layout. On screens 1000px and wider, navigation becomes a rail down the left, the home page puts the day beside the selected session, spots sit in two columns and pop-ups become centred dialogs. *You → Text size* offers Standard, Large and Larger (this device only). The header's radar button is labelled *Now*.
- **First-run welcome.** Someone opening Tidelight with no spots gets a one-minute setup: an install prompt first if they're in iPhone Safari rather than the Home Screen app (the two keep separate storage), then home location (current position or a town search), a first spot (place search or current position, with hunts), and an optional account with a crew invite code. *I already have an account* signs in, pulls their data and skips the rest. Every step can be skipped, and *Show the welcome again* at the bottom of You replays it.
- **Five tabs: Forecast, Spots, Plans, Tools, You.** *Tools* gathers what you use in the field: field mode for your next plan, Right now, a compass that works anywhere (today's sunrise and sunset, plus the sun, moon and Milky Way now), the lightning distance timer and Scout this spot. *You* replaces Coach and Settings with one grouped list: Light profile and keepers, Recreate a shot, Account and sync, Alerts, Home and travel, My kit, AI coach and Your data. Each row shows its current status and opens its own page. The app version is at the bottom of You.
- **Spot detail: the week at a glance.** Opening a spot shows its best session this week in a sentence, then a grid of the next 7 days against sunrise, daytime, sunset and night, shaded by score (a red dot marks sessions the tide blocks). Tap any score for its briefing. Sun alignment, notes, hourly forecast and directions sit below.
- **Spot form in sections.** Name, photos, sessions and hunts up front; *Getting there*, *Coast and tide*, *Composition and notes* and *Location* fold away, each showing its current value. Fog and tide-access options appear only when they apply.
- **Spots tab: a card per spot.** Each card shows the spot's best session in the next 3 days, why, and tags (hunt, hike, tide window, models agree or disagree, crewmates going). Filter by session type; the map and search are still there for adding spots.
- **Previously: The Call + spot matrix.** The page opens on the single best session in the next 3 days: your spot photo, a plain verdict ("Go for *fog.*"), the score, leave time and the main reason, with *Read the briefing* and *Plan it*. Below that are three runners-up, preferring different spots. *All 3 days* opens a grid of every spot against every session (sunrise, sunset, night), shaded in four score bands, with tide-blocked sessions marked. Tap a square for its summary and briefing.
- **Hunts per spot: Colour, Fog, Storm, Lightning, Rainbow.** Choose what you shoot at each spot. Each hunt gets its own 0–100 score, and the session shows the best one:
  - *Fog* (sunrise) uses the dew point gap, humidity, overnight wind and cloud, forecast visibility and recent rain. Mark a spot "above the fog" for lookouts; it then also checks the spot's elevation.
  - *Storm* uses storm energy (CAPE), lifted index, convective inhibition, gusts and thunderstorm forecasts in the hours around the session.
  - *Lightning* looks for storm potential in the dark hours after sunset or before sunrise, when lightning is easiest to shoot.
  - *Rainbow* needs showers, breaks in the cloud and the sun below 42°, and tells you which way to look.
- **Daytime sessions: Forest and Waterfall.** Tick these hunts on a spot and each day gets a *Daytime* session, timed to the best hour between an hour after sunrise and an hour before sunset, with the window of good light either side.
  - *Forest* wants soft overcast light (85%+ cloud is ideal, under 40% means harsh dappled light), wet foliage from rain in the previous 24–48 hours, light wind so leaves stay sharp on long exposures, and gets a bonus for mist. Heavy rain during the session counts against it.
  - *Waterfall* wants flow from rain over the past 3 days and the past week (from 14 days of daily rain history), plus soft light. Very heavy recent rain triggers a flood warning (brown water, dangerous access) and lowers the score.
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
- **Hike details per spot.** Hike time, distance and difficulty (easy, moderate, hard, very hard). Leave times include the walk, the timeline shows when to start walking, and briefings warn when you'll be walking in or out in the dark. With no time entered, it's estimated one way from distance and difficulty (about 4, 3.3, 2.6 and 2 km/h).
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
5. **Create your account and sign in.** In the app, You → Account and sync → enter your email and a password (at least 8 characters) → **Create account**. Your existing data uploads straight away. On your other devices, use the same details and tap **Sign in**.

Password reset needs email, so keep your password in your password manager until custom SMTP is set up. The emailed-code sign-in is still in `js/sync.js`, ready to switch back to once custom SMTP unlocks the email templates.

How it works: the app always runs from the device's own copy (so it works offline), then merges with your Supabase copy record by record. The newest change to each spot, plan or keeper wins, and deletions are remembered for 120 days so they don't come back. Before launch, set up custom SMTP: Supabase's built-in email sender only allows a couple of emails an hour, and new free projects can't edit email templates without it.

Free-plan note: Supabase pauses free projects after a week without use. Opening the app syncs and counts as use; if it does pause, restore it from the Supabase dashboard.

## Custom email (password resets and tester sign-ups)

Supabase's built-in sender only allows a couple of emails an hour, and new free projects can't edit email templates without your own sender. Setting one up enables password resets and branded emails.

1. **Pick an email provider with a free tier** that supports SMTP, such as Resend or Brevo, and create an account.
2. **Verify your domain** (e.g. tysonwaldron.com) with the provider. It gives you a few DNS records; add them in Shopify admin → Settings → Domains → your domain → DNS settings (or wherever your domain's DNS is managed). Verification can take from minutes to a few hours.
3. **Connect it to Supabase:** Authentication → Emails → SMTP Settings → enable Custom SMTP, then enter the provider's host, port, username and password (often an API key), a sender address such as `hello@tysonwaldron.com`, and the sender name `Tidelight`.
4. **Raise the email rate limit** (Authentication → Rate Limits) to something like 30 an hour.
5. **Brand the emails:** Authentication → Emails → Templates. Paste `supabase/email-templates/reset-password.html` into *Reset Password* (subject: "Reset your Tidelight password") and `confirm-signup.html` into *Confirm signup* (subject: "Welcome to Tidelight").
6. **Optional:** switch *Confirm email* back on (Authentication → Sign In / Providers → Email) so new testers verify their address.

Password resets in the app: You → Account and sync → type your email → *Forgot your password?* The email link opens Tidelight in the browser, where you choose a new password; then sign in with it everywhere, including the home-screen app. Make sure your GitHub Pages address is listed under Authentication → URL Configuration → Redirect URLs.

## Crews

**Automatic sharing and spot copies.** With *Share my plans automatically* on (Plans → Crew; on by default), every shoot you plan is shared with your crews and each crewmate gets a notification, once per plan. Shared plans carry the spot's settings (hunts, tide, facing, hike, notes) and a small cover photo. Crewmates tap the notification, or *View spot* under Who's going where, to see that spot's week of forecasts scored for them (their drive, their personal score), the session's briefing, and the sharer's notes. *Save to my spots* copies it to their device, photo included; afterwards it shows *Open my copy*. Anyone can mute crew notifications under You → Alerts.

Crews let photographers who shoot together share plans. Plans → Crew → *Create a crew* gives a 6-character invite code; friends join with *Join a crew*. Share any plan (with an optional note) from Upcoming or a session's details: crewmates get a notification, see who's going where under *Who's going where*, and can tap *I'm in* to add it to their own Plans with their own leave time. Sessions show "Sam is going" when a crewmate has planned the same place and time. Crew data lives in the `crews`, `crew_members` and `crew_plans` tables with row-level security: only members of a crew can see it. See `supabase/crews.sql`.

## Gear checklists

Every session lists what to bring, with a reason for each item: kit for the hunts in play (ND and polariser for waterfalls, red headtorch for astro, rain cover for forests), plus items the conditions call for (headtorch for walks in the dark, water and first aid for long or hard hikes, warm layers when it's cold, gumboots for low-tide rock shelves) and your own *always bring* list (You → My kit). Planned sessions keep the list so you can tick items off as you pack.

## Alerts (push notifications)

Every hour, a Supabase Edge Function scores your spots with the app's own engine (including your personal score) and sends:
- **Go alerts:** sessions in the next 36 hours at or above your threshold (default 80), while there's still time to leave. Three or more are grouped into one notification.
- **Called off:** a session you were alerted about has dropped 20+ points and below your threshold.
- **Weekly digest:** the best 3 sessions in the next 3 days, on your chosen day and hour (default Thursday 7pm).
- Nothing during your quiet hours (default 9pm–6am), and nothing is sent twice.

Set up once:
1. **Make your keys.** Upload this version, then open `https://YOUR-SITE/tools/vapid-keys.html` and tap **Generate keys**. Keys are created in your browser and never sent anywhere. Save them in your password manager.
2. **Public key into the app.** Paste `VAPID_PUBLIC_KEY` into `js/config.js` in place of `PASTE_YOUR_VAPID_PUBLIC_KEY_HERE`, and upload that file again.
3. **Turn on scheduling.** Supabase → Database → Extensions: enable **pg_cron** and **pg_net**.
4. **Add secrets.** Supabase → Edge Functions → Secrets: add `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `CRON_SECRET` (from step 1) and `VAPID_SUBJECT` (your email as `mailto:you@example.com`).
5. **Deploy the function.** Supabase → Edge Functions → Deploy a new function → Via editor. Name it exactly `check-alerts`, replace the sample code with all of `supabase/functions/check-alerts/index.ts`, and deploy. Then open the function's settings and switch off **Verify JWT** (the function checks the cron secret and your sign-in itself).
6. **Schedule it.** Supabase → SQL Editor → New query: paste `supabase/alerts.sql`, replace `PASTE_YOUR_PUBLISHABLE_KEY` with your Publishable key (Project Settings → API Keys, starts `sb_publishable_`) and `PASTE_YOUR_CRON_SECRET` with your `CRON_SECRET`, and run it. It creates the device and alert-log tables and runs the check at 5 past every hour.
7. **Turn alerts on.** On iPhone, open Tidelight **from the home screen** (alerts only work in the home-screen app), then You → Alerts → **Turn on alerts on this device** → allow notifications → **Send a test**.

Checking it works: visiting the function's address in a browser shows a `MISSING_CREDENTIALS` message; that's expected and means it's live. Supabase → Edge Functions → check-alerts → Logs shows each hourly run, and the query at the end of `alerts.sql` shows the last scheduled calls. Alert settings sync with your account; each device turns notifications on separately.

If you change the scoring code: run `node tools/build-alerts.mjs` (or ask for a rebuild) and redeploy the function, so alerts keep scoring like the app.

## Updating without stale caches

Phones, and especially home-screen web apps, cache files aggressively. Every file is loaded with a version tag (`?v=5.4`), so a new version always loads fresh. When you change the code yourself, bump the number in `index.html` (two places) and in the `import` lines at the top of each file in `js/`. The current version is shown at the bottom of **Settings**.

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

**Horizon check (colour):** the app also samples cloud 60 and 120 km out along the sunrise and sunset directions. Low or mid cloud there blocks the light from getting under the clouds, so it lowers the colour score and says so.

**Confidence (colour):** each session is also scored with three weather models (ECMWF, GFS and the Bureau of Meteorology's ACCESS). If they agree, it's high confidence; if they disagree by more than 30 points, it's low confidence, the score is pulled towards the middle, and alerts skip it unless you turn that option off.

The **personal score** compares the conditions of each upcoming session with your keepers and duds. It uses a nearest-neighbour similarity across low, mid and high cloud, rain, wind, tide position and wave height. Its weight grows with the number of keepers, up to 60% at 10. So-so sessions count too: when today looks like a past so-so session, the personal score is pulled towards the middle.

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
supabase/alerts.sql   Alert tables and the hourly schedule
supabase/crews.sql    Crew tables, security rules and functions (already applied to your project)
supabase/email-templates/   Branded reset-password and confirm-signup emails
js/gear.js            Gear checklists
supabase/functions/check-alerts/index.ts   The hourly alerts function (generated)
tools/vapid-keys.html Generates your alert keys in the browser
tools/build-alerts.mjs, tools/alerts-main.js   Builds the alerts function from the app's scoring code
sw.js                 Offline support and alert notifications (service worker)
js/util.js            Formatting and small helpers
icons/                App icons
```
