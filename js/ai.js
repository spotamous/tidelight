// Optional AI coach using your own Claude API key, called directly from your browser.
// The key is stored only in this browser (localStorage) and never in your GitHub repo.
import { clamp, fmtTime, compass } from './util.js?v=3.2';

export const hasAI = settings => !!(settings.claudeKey && settings.claudeKey.trim());

async function callClaude(settings, content, maxTokens = 500) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': settings.claudeKey.trim(),
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: settings.claudeModel || 'claude-sonnet-5-5',
      max_tokens: maxTokens,
      messages: [{ role: 'user', content }],
    }),
  });
  if (!r.ok) {
    let msg = `Claude API error ${r.status}`;
    try { const e = await r.json(); if (e.error?.message) msg += `: ${e.error.message}`; } catch {}
    throw new Error(msg);
  }
  const d = await r.json();
  return (d.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
}

export const testKey = settings => callClaude(settings, 'Reply with the single word: ready', 10);

export function briefingContext(e, styleSummary) {
  const h = e.hour, s = e.spot, o = e.offset;
  return {
    spot: { name: s.name, coastal: !!s.coastal, tidePreference: s.tide, facingDeg: s.facing || null, notes: s.notes || '' },
    event: {
      type: e.type, localTime: fmtTime(e.t, o), leaveAt: fmtTime(e.leave, o), driveMinutes: e.drive,
      hike: e.hike ? { minutesOneWay: e.hike, km: s.hikeKm || null, difficulty: s.difficulty || null, startWalking: fmtTime(e.walkStart, o) } : null,
      sunAzimuth: e.sunAz != null ? `${Math.round(e.sunAz)}° ${compass(e.sunAz)}` : null,
      goldenHour: e.light.goldenStart ? `${fmtTime(e.light.goldenStart, o)}–${fmtTime(e.light.goldenEnd, o)}` : null,
      blueHour: e.light.blueStart ? `${fmtTime(e.light.blueStart, o)}–${fmtTime(e.light.blueEnd, o)}` : null,
    },
    conditions: {
      cloudLowPct: h.low, cloudMidPct: h.mid, cloudHighPct: h.high, rainChancePct: h.pp,
      visibilityKm: h.vis != null ? +(h.vis / 1000).toFixed(1) : null, windKmh: h.wind, tempC: h.temp,
      waveM: h.wave, swellM: h.swell,
      dewPointC: h.dew, humidityPct: h.rh, stormEnergyCapeJkg: h.cape, liftedIndex: h.li, gustKmh: h.gust, weatherCode: h.code,
      tide: e.tide ? {
        positionPct: Math.round(e.tide.pos * 100), rising: e.tide.rising,
        nearestLow: e.tide.low ? fmtTime(e.tide.low.t, o) : null,
        nearestHigh: e.tide.high ? fmtTime(e.tide.high.t, o) : null,
      } : null,
    },
    scores: { overall: e.score, rulesBased: e.base, personal: e.personal?.score ?? null },
    hunts: Object.fromEntries(Object.entries(e.hunts || {}).map(([k, v]) => [k, { score: v.score, notes: v.factors.map(f => f.t) }])),
    bestHunt: e.topHunt,
    scoreFactors: e.factors.map(f => f.t),
    photographerStyle: styleSummary ? `Their keeper photos tend to have ${styleSummary.text}` : 'Unknown yet',
  };
}

export async function aiBriefing(settings, ctx) {
  const prompt = `You are an experienced seascape and landscape photography guide giving a photographer a pre-dawn briefing.
Using ONLY the data below, write a go/no-go briefing in under 110 words.
Start with one verdict line: GO, MAYBE, or SKIP.
Then explain why in plain language. Cover each hunt this spot is set up for (colour, fog, storms, lightning, rainbows) that scores 40 or more, plus tide and sea where relevant. Then give one or two concrete shooting suggestions: composition, shutter-speed range, and whether to stay after the sun for afterglow.
If storms or lightning score 45 or more, add one short lightning-safety line. Do not invent data you weren't given. Plain text only, no markdown.

DATA:
${JSON.stringify(ctx, null, 1)}`;
  return callClaude(settings, prompt, 400);
}

export async function aiAnalyzeReference(settings, base64Jpeg) {
  const content = [
    { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64Jpeg } },
    { type: 'text', text: `Analyse this landscape or seascape photo and estimate the conditions it was taken in.
Respond ONLY with a JSON object, no prose and no code fences:
{"timeOfDay":"sunrise|sunset|blue hour|night|day","cloudLow":0-100,"cloudMid":0-100,"cloudHigh":0-100,"rain":0-100,"wind":"calm|light|strong","tide":"low|mid|high|unknown","sea":"glassy|moderate|rough|none","fog":true|false,"storm":true|false,"lightning":true|false,"summary":"one sentence on the light and sky","recipe":"one sentence on which conditions to wait for to recreate it"}` },
  ];
  const txt = await callClaude(settings, content, 500);
  const clean = txt.replace(/```json|```/g, '').trim();
  const json = clean.slice(clean.indexOf('{'), clean.lastIndexOf('}') + 1);
  return JSON.parse(json);
}

export function aiResultToFeatures(r) {
  const wind = { calm: 0.1, light: 0.35, strong: 0.8 }[r.wind] ?? null;
  const tide = { low: 0.15, mid: 0.5, high: 0.85 }[r.tide] ?? null;
  const sea = { glassy: 0.1, moderate: 0.35, rough: 0.75 }[r.sea] ?? null;
  const n = v => (typeof v === 'number' ? clamp(v / 100) : 0);
  const yes = v => v === true || v === 'true';
  return [
    n(r.cloudLow), n(r.cloudMid), n(r.cloudHigh), n(r.rain) * 0.5, wind, tide, sea,
    yes(r.fog) ? 0.02 : null,                     // dew point gap: tiny when foggy
    yes(r.storm) || yes(r.lightning) ? 0.6 : null, // storm energy
    yes(r.lightning) ? 1 : (yes(r.storm) ? 0.5 : null),
  ];
}

/* ---------- photos ---------- */

export async function readExif(file) {
  try {
    const m = await window.exifr.parse(file, { gps: true, tiff: true, exif: true });
    let date = m?.DateTimeOriginal || m?.CreateDate || null;
    if (!(date instanceof Date) || isNaN(date)) date = null;
    return { lat: m?.latitude ?? null, lon: m?.longitude ?? null, date };
  } catch {
    return { lat: null, lon: null, date: null };
  }
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve({ img, url });
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('This browser could not open that image format')); };
    img.src = url;
  });
}

export async function resizeImage(file, maxSide, quality = 0.8) {
  const { img, url } = await loadImage(file);
  const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement('canvas');
  c.width = Math.round(img.naturalWidth * scale);
  c.height = Math.round(img.naturalHeight * scale);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  URL.revokeObjectURL(url);
  return c.toDataURL('image/jpeg', quality);
}
