// What to bring for a session: built from the hunts it's about, the conditions, the walk in,
// and your own "always bring" list (Settings → My kit). Each item says why it's on the list.

const BY_HUNT = {
  colour: [
    ['grad-nd', 'Graduated ND filter', 'Holds back a bright sky against a darker foreground'],
    ['remote', 'Remote or self-timer', 'Sharp long exposures at low light'],
  ],
  fog: [
    ['tele', 'Telephoto lens', 'Picks out layers and ridgelines in the fog'],
    ['cloth', 'Microfibre cloth', 'Fog beads on the front element'],
  ],
  storm: [
    ['rain-cover', 'Camera rain cover', 'Storm showers arrive fast'],
    ['jacket', 'Rain jacket', 'Storm showers arrive fast'],
    ['wide', 'Wide lens', 'Shelf clouds fill the sky'],
  ],
  lightning: [
    ['trigger', 'Lightning trigger or intervalometer', 'Catches strikes you can\'t react to'],
    ['tripod-weight', 'Tripod weight or bag hook', 'Gusty outflow ahead of storms'],
  ],
  rainbow: [
    ['polariser', 'Polariser', 'Rotate it to strengthen the rainbow (or it can erase it)'],
  ],
  forest: [
    ['polariser', 'Polariser', 'Cuts glare off wet leaves so the greens glow'],
    ['cloth', 'Microfibre cloths', 'Drips and humidity on the lens'],
    ['rain-cover', 'Camera rain cover', 'Wet canopy drips long after the rain stops'],
    ['boots', 'Waterproof boots', 'Muddy, wet tracks'],
  ],
  waterfall: [
    ['nd', 'ND filter (3–6 stop)', 'Slows the water to 0.5–2 s in daylight'],
    ['polariser', 'Polariser', 'Cuts glare off wet rock and water'],
    ['cloth', 'Microfibre cloths', 'Spray on the lens'],
    ['grip', 'Shoes with good grip', 'Wet rock near falls is slippery'],
  ],
  aurora: [
    ['fast-wide', 'Fast wide lens (f/2.8 or faster)', 'Aurora needs short, bright exposures'],
    ['red-torch', 'Red headtorch', 'Keeps your night vision'],
    ['warm', 'Warm layers', 'Long, still nights get cold'],
  ],
  astro: [
    ['fast-wide', 'Fast wide lens (f/2.8 or faster)', 'More stars, shorter exposures'],
    ['red-torch', 'Red headtorch', 'Keeps your night vision'],
    ['dew', 'Lens heater or hand warmers', 'Dew forms on the lens on clear nights'],
    ['warm', 'Warm layers', 'Clear nights get cold'],
  ],
};

export function gearFor(e, settings = {}) {
  const items = new Map();
  const add = (id, label, why) => { if (!items.has(id)) items.set(id, { id, label, why }); };
  const h = e.hour || {};
  const s = e.spot || {};

  for (const k of Object.keys(e.hunts || {})) {
    const hs = e.hunts[k];
    if (k !== e.topHunt && (hs?.score ?? 0) < 45) continue;   // only hunts that are in play
    for (const [id, label, why] of BY_HUNT[k] || []) add(id, label, why);
  }

  // The walk in and out.
  if (e.hike) {
    const dawn = e.light?.blueStart, dusk = e.light?.blueEnd;
    const darkWalk = e.type === 'night'
      || (e.type === 'sunrise' && dawn && e.walkStart < dawn)
      || (e.type === 'sunset' && dusk && e.t + (20 + e.hike) * 60 > dusk);
    if (darkWalk) add('headtorch', 'Headtorch and spare batteries', `You'll walk the ${e.hike} min track in the dark`);
    if (e.hike >= 60 || s.difficulty === 'hard' || s.difficulty === 'very hard') {
      add('water', 'Water and snacks', `${e.hike} min ${s.difficulty || ''} walk each way`.replace('  ', ' '));
      add('first-aid', 'First-aid kit', 'Longer or harder track');
    }
  } else if (e.type === 'night' || (e.type === 'sunrise')) {
    add('headtorch', 'Headtorch', 'Setting up before first light');
  }

  // Weather.
  if ((h.pp ?? 0) >= 40 || (h.precip ?? 0) >= 0.2) add('jacket', 'Rain jacket', `${Math.round(h.pp ?? 0)}% chance of rain`);
  if ((h.pp ?? 0) >= 40) add('rain-cover', 'Camera rain cover', 'Rain likely');
  if (h.temp != null && h.temp <= 8) add('warm', 'Warm layers, gloves and beanie', `Around ${Math.round(h.temp)}°C`);
  if ((h.wind ?? 0) >= 30 || (h.gust ?? 0) >= 45) add('tripod-weight', 'Tripod weight or bag hook', `Wind ${Math.round(h.wind ?? 0)} km/h${h.gust ? `, gusts ${Math.round(h.gust)}` : ''}`);

  // The coast.
  if (s.coastal) {
    if (s.tideAccess || s.tide === 'low') add('boots-wet', 'Gumboots or wading shoes', 'Low tide and wet rock shelves');
    if (s.tideAccess && e.access && !e.access.none) add('tide-times', 'Tide access times noted', 'Know when the way back closes');
    if ((h.wave ?? 0) >= 1.5) add('spray', 'Lens cloths for spray', `${h.wave.toFixed(1)} m sea`);
  }

  // Your own kit, always.
  for (const raw of settings.gearAlways || []) {
    const label = String(raw).trim();
    if (label) add(`mine:${label.toLowerCase()}`, label, 'On your always-bring list');
  }
  return [...items.values()];
}
