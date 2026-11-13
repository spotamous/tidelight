# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

(Installable PWA, used mainly as an iPhone Home Screen app; desktop layout from 1000px with a left rail.)

## Users

Landscape and seascape photographers, heading toward a public product under the Tyson Waldron Photography brand. Today the circle is Tyson, photographer friends in crews, and testers. Users know light (blue hour, golden hour, tide, cloud layers) and don't need it explained, but a new user should still understand a score in seconds.

Main jobs, in order of how often they happen:
1. **Evening decision:** "Is tomorrow's light worth the alarm, and where?"
2. **Week-ahead planning:** "Which day and spot this week is the real chance?" (to pick a trip or a day off).
3. Commit to a session, pack, leave on time, work the light in the field, then rate it.

## Product Purpose

Tidelight scores every sunrise, sunset, daytime and night session at the user's own spots over the coming days, from sky, tide and sea, and turns that into a go/no-go call, a leave time and a plain-language reason. Success: the photographer makes the right call quickly, shows up at the right place at the right time, and wastes fewer 4am alarms.

## Positioning

A light planner, not a weather app: it draws each day as its actual light (3am to 3am, from the sun's position), scores per "hunt" (colour, fog, storm, lightning, rainbow, forest, waterfall, aurora, Milky Way), includes tide access and hike time in the leave time, and learns from the photographer's own ratings and keeper photos which conditions produce *their* best shots.

## Operating Context

- Mostly used on a phone in the evening (couch) and when planning the week ahead; also in the field pre-dawn (field mode, night vision, offline forecast).
- Static site on GitHub Pages; no build step. Vanilla JS modules (`js/app.js` renders every view), one stylesheet (`css/styles.css`).
- Data in localStorage, optionally synced to Supabase (account, crews, push alerts, feedback).
- External data: Open-Meteo style forecasts, tides/waves, NOAA Kp, rain radar, OpenStreetMap search; optional Claude API key for the AI coach.

## Capabilities and Constraints

- **Scoring is fixed for design work:** `js/scoring.js` and `js/hunts.js` logic must not change during design passes. The highest score leads; design must not re-rank sessions by type.
- Features to keep (may be regrouped): forecast light band with scrubbing, session briefing, What if?, plans (upcoming, crew, history, ratings 0–10), field mode with night vision, scout a spot, compass, light dial and moon, exposure tools (ND, NPF, hyperfocal), lightning timer, Right now (radar, hourly), spot form and spot week grid, score tuning, keepers / recreate a shot, alerts, account and sync, AI coach, first-run welcome, feedback.
- Works offline from the last saved forecast; must stay fast on slow connections.
- Terminology in use: session, hunt, spot, keeper, plan, briefing, field mode, crew, leave time, tide access.

## Brand Commitments

- Name: Tidelight. Made by Tyson Waldron Photography; the header logo links home, and *Visit tysonwaldron.com* and *Send feedback* sit at the bottom of You.
- Voice: plain, honest, spoken like a photographer friend ("The weather models disagree, so treat this as a maybe."). No hype, no jargon for its own sake.

## Evidence on Hand

- Real app and copy in this folder; README.md documents every feature.
- Promo video: `Desktop/TideLight/tidelightV6.0-promo.mp4`.
- No testimonials, user counts or accuracy statistics exist yet; don't invent them. The in-app hit-rate tracker is per-user only.

## Product Principles

1. **Answer the next decision first.** Every screen leads with the call that matters now (tomorrow's light, this week's best chance), with the detail one step deeper.
2. **One path from decide to go.** Decide (forecast) → commit (plan) → go (field). Each capability has one natural home, not many doors.
3. **Light is the interface.** The real light of a session (its phases, sky and tide) is the primary visual and information language.
4. **Honest confidence.** Show how sure the call is and when it has changed; one wrong line costs trust in every score.
5. **Respect the field.** Usable one-handed, half-awake, offline, and dark-adapted.

## Accessibility & Inclusion

Target WCAG 2.2 AA: 44px touch targets, visible focus, proper dialog focus handling, no constantly-updating live regions, honours Reduce Motion and the in-app text size setting (Standard, Large, Larger).
