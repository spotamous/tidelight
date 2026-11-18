// Tidelight: A session's briefing: the full detail sheet for one sunrise, sunset or night.
import { cap, esc, fmtTime, toast } from './util.js?v=7.0';
import { gearFor } from './gear.js?v=7.0';
import { coverUrl } from './photos.js?v=7.0';
import { HUNT_LABEL } from './hunts.js?v=7.0';
import { currentUser } from './sync.js?v=7.0';
import { MIN_KEEPERS, personalModelSummary } from './scoring.js?v=7.0';
import { openSkyAR } from './skyar.js?v=7.0';
import { hasAI, aiBriefing, briefingContext } from './ai.js?v=7.0';
import { $, S, briefing, closeSheet, eventIndex, huntList, openSheet, sessionName } from './core.js?v=7.0';
import { avatarStack, cloudChips, commitPanel, horizonScene, huntPhrase, labModel, partBar, phaseColor, runCounts, sessionWhen, skyClass, skyOf, toneDot, toneOf, whySentence } from './forecast.js?v=7.0';
import { crewGoing, crewState, goingText, openShareSheet } from './crews.js?v=7.0';
import { tideChart, wireTide } from './tools.js?v=7.0';
import { drawHere, saveHere } from './here.js?v=7.0';
import { openShareCard } from './planners.js?v=7.0';
import { addPlan } from './plans.js?v=7.0';

/* ================= event detail ================= */

export function openEvent(key) {
  const e = eventIndex.get(key);
  if (!e) return;
  const o = e.offset, h = e.hour, L = e.light;

  const tl = [{ t: e.leave, label: e.drive != null ? `Leave home (${e.drive} min drive)` : e.hike ? 'Start walking' : 'Be on location', cls: 'leave' }];
  if (e.hike && e.drive != null) tl.push({ t: e.walkStart, label: `Start the hike (${[e.spot.hikeKm ? `${Number(e.spot.hikeKm)} km` : '', e.spot.difficulty || '', `${e.hike} min`].filter(Boolean).join(', ')})`, cls: 'leave' });
  if (L.blueStart) tl.push({ t: L.blueStart, label: 'Blue hour starts' });
  if (L.blueEnd) tl.push({ t: L.blueEnd, label: 'Blue hour ends' });
  if (L.goldenStart && e.type === 'sunset') tl.push({ t: L.goldenStart, label: 'Golden hour starts' });
  if (e.timeline) tl.push(...e.timeline); else tl.push({ t: e.t, label: cap(e.type), cls: 'key' });
  if (e.access && !e.access.none) {
    if (!e.access.openStart) tl.push({ t: e.access.start, label: 'Tide access opens' });
    tl.push({ t: e.access.backBy, label: 'Be back off the rocks', cls: 'warn' });
  }
  if (L.goldenEnd && e.type === 'sunrise') tl.push({ t: L.goldenEnd, label: 'Golden hour ends' });
  if (e.tide?.low && Math.abs(e.tide.low.t - e.t) < 4 * 3600) tl.push({ t: e.tide.low.t, label: 'Low tide' });
  if (e.tide?.high && Math.abs(e.tide.high.t - e.t) < 4 * 3600) tl.push({ t: e.tide.high.t, label: 'High tide' });
  tl.sort((a, b) => a.t - b.t);

  const planned = S().plans.some(p => p.key === e.key);
  const cond = [
    ['Low cloud', `${Math.round(h.low ?? 0)}%`], ['Mid cloud', `${Math.round(h.mid ?? 0)}%`], ['High cloud', `${Math.round(h.high ?? 0)}%`],
    ['Rain chance', h.pp != null ? `${Math.round(h.pp)}%` : '–'], ['Wind', h.wind != null ? `${Math.round(h.wind)} km/h` : '–'],
    ['Visibility', h.vis != null ? `${(h.vis / 1000).toFixed(0)} km` : '–'],
    ['Waves', h.wave != null ? `${h.wave.toFixed(1)} m` : '–'], ['Tide', e.tide ? `${Math.round(e.tide.pos * 100)}%` : '–'],
    ['Temp', h.temp != null ? `${Math.round(h.temp)}°C` : '–'],
    ['Dew point', h.dew != null ? `${Math.round(h.dew)}°C` : '–'], ['Humidity', h.rh != null ? `${Math.round(h.rh)}%` : '–'],
    ['Storm energy', h.cape != null ? `${Math.round(h.cape)} J/kg` : '–'],
  ];

  // The plan as a strip of light: each step takes the colour of the sky at that moment.
  const stripStops = tl.map((x, i) => `${phaseColor(e.spot, x.t, o)} ${(((i + 0.5) / tl.length) * 100).toFixed(1)}%`).join(', ');
  const huntBlock = ([k, v]) => `
      <div class="part-list">${(v.parts || []).map(p => partBar(p)).join('')}</div>
      <ul class="factors">${v.factors.map(f => `<li class="${f.k}">${esc(f.t)}</li>`).join('') || '<li>Nothing stands out either way.</li>'}</ul>
      ${k === 'lightning' ? '<button class="link-btn" data-lightning>Open the lightning distance timer</button>' : ''}`;
  const hunts = huntList(e);
  const topHunt = hunts.find(([k]) => k === e.topHunt) || hunts[0];
  const otherHunts = hunts.filter(h => h !== topHunt);
  const going = crewGoing(e);
  const gear = gearFor(e, S().settings);

  openSheet(`
    <div class="bf-sky ${skyClass(e)} ${coverUrl(e.spot) ? 'has-photo' : 'has-scene'}" style="--sky:${skyOf(e)}${coverUrl(e.spot) ? `; --photo:url('${coverUrl(e.spot)}')` : ''}">${coverUrl(e.spot) ? '' : horizonScene(e)}${cloudChips(e)}</div>
    <header class="bf-head">
      <div>
        <h2 class="bf-name">${esc(e.spot.name)}</h2>
        <p class="bf-when">${esc(cap(sessionName(e)))}, ${sessionWhen(e)}${(() => { const pk = e.hunts?.[e.topHunt]?.peak; return pk && Math.abs(pk - e.t) > 45 * 60 ? `. ${HUNT_LABEL[e.topHunt]} peaks around ${fmtTime(pk, o)}` : ''; })()}</p>
      </div>
      <p class="bf-score num tone-${toneOf(e.score)}-score" aria-label="Score ${e.score} out of 100, ${e.score >= 75 ? 'go' : e.score >= 50 ? 'maybe' : 'skip'}"><span data-count="${e.score}">${e.score}</span><small>${e.score >= 75 ? 'Go' : e.score >= 50 ? 'Maybe' : 'Skip'}${toneDot(e.score)}</small></p>
    </header>
    <p class="bf-verdict">${esc(huntPhrase(e))}. ${esc(whySentence(e))}</p>
    ${e.topHunt === 'colour' && e.confidence ? `<p class="bf-note conf-${e.confidence.level}">${{ high: 'The weather models agree.', medium: 'The weather models roughly agree.', low: 'The weather models disagree, so treat this as a maybe.' }[e.confidence.level]}</p>` : ''}
    ${e.access && !e.access.inside ? `<p class="bf-note conf-low">${e.access.none ? 'The tide stays above your access level around this session.' : `Tide access runs ${fmtTime(e.access.start, o)} to ${fmtTime(e.access.backBy, o)}, which doesn't cover this session.`}</p>` : ''}
    ${going.length ? `<p class="bf-note crew">${avatarStack(going, 22)}${esc(goingText(going))}.</p>` : ''}
    <div class="bf-tools" role="group" aria-label="Tools for this session">
      <button class="tool-chip" data-compass="${esc(e.key)}">Compass</button>
      <button class="tool-chip" data-dial="${esc(e.key)}">Light dial</button>
      ${labModel(e) ? `<button class="tool-chip" data-lab="${esc(e.key)}">What if?</button>` : ''}
      <button class="tool-chip" id="skyBtn">Sky view</button>
      <button class="tool-chip" id="cardBtn">Share card</button>
      ${currentUser() && crewState.crews.length && !e.spot.here ? '<button class="tool-chip" id="shareBtn">Share with crew</button>' : ''}
    </div>
    ${e.spot.here ? `<p class="bf-note">${e.spot.hereMode === 'place' ? 'Not a saved spot. Leave times are from home.' : 'Right here, not a saved spot. Times assume you\'re already here.'}</p>` : ''}

    <h3 class="sec">The plan</h3>
    <ol class="tline" style="--strip: linear-gradient(to bottom, ${stripStops})">
      ${tl.map(x => `<li class="${x.cls || ''}"><time class="num">${fmtTime(x.t, o)}</time><span>${esc(x.label)}</span></li>`).join('')}
    </ol>

    ${tideChart(e)}

    <h3 class="sec">Briefing</h3>
    <p class="bf-brief" id="briefText">${esc(briefing(e))}</p>
    <button class="link-btn" id="aiBriefBtn">Rewrite with the AI coach</button>

    <h3 class="sec">Why this score</h3>
    ${topHunt ? `<div class="bf-hunt"><div class="bf-hunt-head"><span>${HUNT_LABEL[topHunt[0]]}</span><b class="num">${topHunt[1].score}</b></div>${huntBlock(topHunt)}</div>` : ''}
    ${otherHunts.map(h => `<details class="bf-hunt more"><summary><span>${HUNT_LABEL[h[0]]}</span><b class="num">${h[1].score}</b></summary>${huntBlock(h)}</details>`).join('')}
    <p class="small muted bf-personal">${e.personal
      ? `The ${e.score} blends ${e.base} from conditions with ${e.personal.score} from your ${e.personal.n} keepers (${Math.round(e.personal.weight * 100)}% weight).`
      : `Add ${MIN_KEEPERS} or more keeper photos under You, in Light profile, and this score will start reflecting your taste.`}</p>

    <h3 class="sec">Conditions at ${e.type === 'night' || e.type === 'day' ? fmtTime(e.t, o) : e.type}</h3>
    <dl class="bf-cond">${cond.filter(([, val]) => val !== '–').map(([k, val]) => `<div><dt>${k}</dt><dd class="num">${val}</dd></div>`).join('')}</dl>

    <h3 class="sec">What to bring</h3>
    <ul class="gear-preview">${gear.map(g => `<li><strong>${esc(g.label)}</strong><span>${esc(g.why)}</span></li>`).join('')}</ul>
    <p class="small muted">${e.spot.here ? 'Your always-bring items live under You, in My kit.' : 'Plan the shoot to tick these off as you pack. Your always-bring items live under You, in My kit.'}</p>

    <div class="sheet-actions">${e.spot.here ? '<div class="row"><button class="btn primary" id="hereSave">Save as a spot</button><button class="btn" id="hereBack">Back</button></div>'
      : planned ? commitPanel(e) : `<button class="btn primary" data-plan="${esc(e.key)}">Plan this shoot</button>`}</div>
  `);
  runCounts($('#sheetBody'));
  wireTide(e);
  if (e.spot.here) { $('#hereBack').onclick = () => drawHere(); $('#hereSave').onclick = () => saveHere(); }
  $('#cardBtn').onclick = () => openShareCard(e);
  $('#skyBtn').onclick = () => { closeSheet(); openSkyAR({ time: e.t, focus: e.type === 'night' || e.topHunt === 'astro' ? 'core' : 'sun' }); };
  const sb = $('#shareBtn');
  if (sb) sb.onclick = () => {
    if (!S().plans.some(p => p.key === e.key)) addPlan(e);
    openShareSheet(S().plans.find(p => p.key === e.key).id);
  };

  $('#aiBriefBtn').onclick = async () => {
    const st = S();
    if (!hasAI(st.settings)) { toast('Add your Claude key under You, in AI coach, to use this.', 5000); return; }
    const btn = $('#aiBriefBtn'), box = $('#briefText');
    btn.disabled = true; btn.textContent = 'Thinking…';
    try {
      const text = await aiBriefing(st.settings, briefingContext(e, personalModelSummary(st.keepers)));
      box.textContent = text;
      btn.textContent = 'Rewritten by the AI coach';
    } catch (err) {
      toast(err.message, 5000);
      btn.disabled = false; btn.textContent = 'Rewrite with the AI coach';
    }
  };
}
