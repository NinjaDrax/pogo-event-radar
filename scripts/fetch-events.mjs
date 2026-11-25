// Runs on GitHub Actions every 6 hours.
// 1) Reads LeekDuck event data via the ScrapedDuck feed
// 2) Reads each upcoming event's own LeekDuck page (Pokémon, bonuses, description, sub-event times)
// 3) Checks the official Pokémon GO news page to confirm events
// 4) Works out WHERE each event happens: everywhere, at a city venue, or only in some countries
// 5) Writes data/events.json + data/main.ics + data/all.ics
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import * as cheerio from 'cheerio';

const FEED = 'https://raw.githubusercontent.com/bigfoott/ScrapedDuck/data/';
const OFFICIAL_NEWS = 'https://pokemongolive.com/news';
const HEADERS = { 'User-Agent': 'pogo-event-radar/1.1 (personal GitHub Pages tracker)' };
const H = 36e5, D = 24 * H;

// Routine events hidden under "Main" (new types count as main by default)
const MINOR = new Set(['raid-battles', 'raid-hour', 'pokemon-spotlight-hour', 'go-battle-league',
  'research-breakthrough', 'season', 'max-mondays', 'go-pass']);
// Event types that happen at a physical location
const IN_PERSON = new Set(['city-safari', 'safari-zone', 'pokemon-go-fest', 'pokemon-go-tour', 'live-event', 'wild-area']);
// Words in an event name that mean "you have to be there"
const IN_PERSON_WORDS = /\b(?:safari zone|city safari|go fest|go tour|wild area|live event|meet-?up|in-person|ticketed)\b/i;

// City → time zone + country, for in-person events.
// If the Action log says "No city found for in-person event", add the city here.
const CITIES = [
  [/\b(?:san francisco|pier 39|los angeles|las vegas|seattle|san diego|portland|sacramento|san jose)\b/i, 'America/Los_Angeles', 'United States'],
  [/\bhonolulu\b/i, 'Pacific/Honolulu', 'United States'],
  [/\b(?:new york|jersey city|boston|philadelphia|miami|atlanta|orlando|washington,? d\.?c)\b/i, 'America/New_York', 'United States'],
  [/\b(?:chicago|indianapolis|dallas|houston|austin|st\.? louis|minneapolis|nashville)\b/i, 'America/Chicago', 'United States'],
  [/\b(?:denver|salt lake city)\b/i, 'America/Denver', 'United States'],
  [/\bphoenix\b/i, 'America/Phoenix', 'United States'],
  [/\b(?:toronto|montr[eé]al|ottawa)\b/i, 'America/Toronto', 'Canada'],
  [/\bvancouver\b/i, 'America/Vancouver', 'Canada'],
  [/\b(?:mexico city|ciudad de m[eé]xico|monterrey|guadalajara)\b/i, 'America/Mexico_City', 'Mexico'],
  [/\b(?:s[aã]o paulo|rio de janeiro)\b/i, 'America/Sao_Paulo', 'Brazil'],
  [/\bbuenos aires\b/i, 'America/Argentina/Buenos_Aires', 'Argentina'],
  [/\bsantiago\b/i, 'America/Santiago', 'Chile'],
  [/\bbogot[aá]\b/i, 'America/Bogota', 'Colombia'],
  [/\blima\b/i, 'America/Lima', 'Peru'],
  [/\b(?:london|liverpool|manchester|edinburgh|birmingham)\b/i, 'Europe/London', 'United Kingdom'],
  [/\bdublin\b/i, 'Europe/Dublin', 'Ireland'],
  [/\b(?:paris|lyon|marseille)\b/i, 'Europe/Paris', 'France'],
  [/\b(?:madrid|barcelona|valencia|sevilla|seville)\b/i, 'Europe/Madrid', 'Spain'],
  [/\b(?:berlin|hamburg|munich|m[uü]nchen|dortmund|cologne|k[oö]ln)\b/i, 'Europe/Berlin', 'Germany'],
  [/\b(?:amsterdam|rotterdam)\b/i, 'Europe/Amsterdam', 'Netherlands'],
  [/\bcopenhagen\b/i, 'Europe/Copenhagen', 'Denmark'],
  [/\bstockholm\b/i, 'Europe/Stockholm', 'Sweden'],
  [/\b(?:milan|rome|turin)\b/i, 'Europe/Rome', 'Italy'],
  [/\bvienna\b/i, 'Europe/Vienna', 'Austria'],
  [/\bprague\b/i, 'Europe/Prague', 'Czechia'],
  [/\bbrussels\b/i, 'Europe/Brussels', 'Belgium'],
  [/\blisbon\b/i, 'Europe/Lisbon', 'Portugal'],
  [/\bwarsaw\b/i, 'Europe/Warsaw', 'Poland'],
  [/\b(?:tokyo|osaka|yokohama|fukuoka|sendai|sapporo|nagasaki|kyoto|nagoya|kobe|hiroshima|tottori|iwate)\b/i, 'Asia/Tokyo', 'Japan'],
  [/\b(?:seoul|busan|incheon)\b/i, 'Asia/Seoul', 'South Korea'],
  [/\b(?:new taipei|taipei|taichung|tainan|kaohsiung)\b/i, 'Asia/Taipei', 'Taiwan'],
  [/\bhong kong\b/i, 'Asia/Hong_Kong', 'Hong Kong'],
  [/\bsingapore\b/i, 'Asia/Singapore', 'Singapore'],
  [/\b(?:jakarta|surabaya|bali)\b/i, 'Asia/Jakarta', 'Indonesia'],
  [/\bbangkok\b/i, 'Asia/Bangkok', 'Thailand'],
  [/\b(?:manila|cebu)\b/i, 'Asia/Manila', 'Philippines'],
  [/\bkuala lumpur\b/i, 'Asia/Kuala_Lumpur', 'Malaysia'],
  [/\b(?:mumbai|new delhi|delhi|bengaluru|bangalore|kolkata|chennai|hyderabad|pune)\b/i, 'Asia/Kolkata', 'India'],
  [/\b(?:sydney|melbourne)\b/i, 'Australia/Sydney', 'Australia'],
  [/\bbrisbane\b/i, 'Australia/Brisbane', 'Australia'],
  [/\bperth\b/i, 'Australia/Perth', 'Australia'],
  [/\bauckland\b/i, 'Pacific/Auckland', 'New Zealand'],
  [/\b(?:dubai|abu dhabi)\b/i, 'Asia/Dubai', 'United Arab Emirates']
];
// Country names, for events only playable in certain countries (names must match the app's list)
const COUNTRIES = [
  ['india', 'India'], ['japan', 'Japan'], ['(?:south )?korea', 'South Korea'], ['taiwan', 'Taiwan'],
  ['hong kong', 'Hong Kong'], ['singapore', 'Singapore'], ['indonesia', 'Indonesia'], ['thailand', 'Thailand'],
  ['(?:the )?philippines', 'Philippines'], ['malaysia', 'Malaysia'], ['viet ?nam', 'Vietnam'], ['australia', 'Australia'],
  ['new zealand', 'New Zealand'], ['united states(?: of america)?|usa|u\\.s\\.(?:a\\.)?', 'United States'], ['canada', 'Canada'],
  ['mexico(?! city)', 'Mexico'], ['brazil|brasil', 'Brazil'], ['argentina', 'Argentina'], ['chile', 'Chile'],
  ['colombia', 'Colombia'], ['peru', 'Peru'], ['united kingdom|uk|great britain', 'United Kingdom'], ['ireland', 'Ireland'],
  ['france', 'France'], ['germany', 'Germany'], ['spain', 'Spain'], ['italy', 'Italy'], ['(?:the )?netherlands', 'Netherlands'],
  ['belgium', 'Belgium'], ['denmark', 'Denmark'], ['sweden', 'Sweden'], ['norway', 'Norway'], ['finland', 'Finland'],
  ['poland', 'Poland'], ['austria', 'Austria'], ['switzerland', 'Switzerland'], ['czechia|czech republic', 'Czechia'],
  ['portugal', 'Portugal'], ['greece', 'Greece'], ['t[uü]rkiye|turkey', 'Turkey'], ['united arab emirates|uae', 'United Arab Emirates'],
  ['saudi arabia', 'Saudi Arabia'], ['israel', 'Israel'], ['egypt', 'Egypt'], ['south africa', 'South Africa']
].map(([src, name]) => ({ name, any: new RegExp(`\\b(?:${src})(?![a-z])`, 'i'), start: new RegExp(`^(?:${src})(?![a-z])`, 'i') }));
// Phrases like "only in India", "trainers in Japan and Taiwan"
const COUNTRY_TRIGGER = /\b(?:only in|exclusive(?:ly)? (?:to|in)|available (?:only )?in|across|throughout|trainers in|players in|held in|taking place in|in)\s+(?:the\s+)?(?=([^.;:!?()]{1,100}))/gi;

// Global raids/eggs/research are only attached to the season itself
const LIVE_EXTRAS = new Set(['season']);
// Event types whose LeekDuck page is NOT read
const SCRAPE_SKIP = new Set(['go-battle-league', 'go-pass', 'season', 'research-breakthrough', 'raid-hour', 'twitch-drops']);
// Page sections to ignore when collecting Pokémon
const SKIP_SECTIONS = /go pass|research|reward|sale|graphic|bonus|related|ticket|sticker|background/i;
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

/* ---------- helpers ---------- */
async function getJSON(name, required = false) {
  try {
    const r = await fetch(FEED + name, { headers: HEADERS });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } catch (err) {
    if (required) throw new Error(`Could not load ${name}: ${err.message}`);
    console.warn(`Skipping ${name}: ${err.message}`);
    return [];
  }
}
const norm = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/&[a-z]+;/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
const STOP = new Set(['the', 'and', 'with', 'for', 'pokemon', 'event', 'events', 'day', 'days', 'hour', 'hours',
  'raid', 'raids', 'featuring', 'part', 'new', 'go', 'from', 'into']);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const pad = n => String(n).padStart(2, '0');
const isZoned = s => /Z$|[+-]\d{2}:?\d{2}$/.test(s || '');
const stripTags = s => String(s || '').replace(/<[^>]+>/g, '').trim();

const parts = (t, z) => Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: z, hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
  .formatToParts(t).filter(p => p.type !== 'literal').map(p => [p.type, +p.value]));
const offset = (t, z) => { const p = parts(t, z); return Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second) - Math.floor(t / 1e3) * 1e3; };
const wall = (y, mo, d, h, mi, z) => { const g = Date.UTC(y, mo - 1, d, h, mi); return g - offset(g - offset(g, z), z); };
const wallStr = (s, z) => { const m = s.match(/(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/); return wall(+m[1], +m[2], +m[3], +m[4], +m[5], z); };

/* ---------- where does an event happen? ---------- */
function countriesIn(text) {
  const found = new Set();
  for (const m of String(text || '').matchAll(COUNTRY_TRIGGER)) {
    let rest = m[1].replace(/^(?:(?:select|certain|some|parts of|participating)\s+)+/i, '');
    for (let c; (c = COUNTRIES.find(k => k.start.test(rest)));) {
      found.add(c.name);
      rest = rest.replace(c.start, '').replace(/^\s*(?:,\s*)?(?:(?:and|or|&)\s+)?(?:the\s+)?/i, '');
    }
  }
  return [...found];
}
function placeOf(e, desc) {
  const name = e.name || '', text = `${name} ${e.heading || ''}`;
  if (/\bglobal\b/i.test(name)) return null;
  const inPerson = IN_PERSON.has(e.eventType) || IN_PERSON_WORDS.test(name);
  if (inPerson) {
    for (const [re, tz, country] of CITIES) {
      const m = text.match(re);
      if (m) return { kind: 'venue', city: m[0], country, tz };
    }
    const c = COUNTRIES.find(k => k.any.test(name));
    if (c) return { kind: 'venue', city: null, country: c.name, tz: null };
    if (IN_PERSON.has(e.eventType)) {
      console.warn(`No city found for in-person event: "${name}" (add it to CITIES)`);
      return { kind: 'venue', city: null, country: null, tz: null };
    }
    return null;
  }
  const countries = new Set(COUNTRIES.filter(k => k.any.test(name)).map(k => k.name));
  for (const c of countriesIn(desc)) countries.add(c);
  return countries.size ? { kind: 'country', countries: [...countries] } : null;
}
const placeLabel = e => {
  const p = e.place;
  if (!p) return '';
  if (p.kind === 'venue') return [...new Set([p.city, p.country].filter(Boolean))].join(', ') || 'In person';
  return `${(p.countries || []).join(', ')} only`;
};

// Max Mondays: "Dynamax X may appear ... through November 29, 2026" → keep it on the radar all week
function throughEnd(e, desc) {
  const m = String(desc || '').match(/\bthrough\s+([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s*(\d{4})?/i);
  if (!m) return null;
  const mo = MONTHS.indexOf(m[1].toLowerCase());
  if (mo < 0) return null;
  let y = m[3] ? +m[3] : +e.start.slice(0, 4);
  if (!m[3] && mo + 1 < +e.start.slice(5, 7)) y++;
  const s = `${y}-${pad(mo + 1)}-${pad(+m[2])}${e.end.slice(10)}`;
  return s > e.end ? s : null;
}

/* ---------- event page reader ---------- */
async function scrapeEventPage(url) {
  const r = await fetch(url, { headers: HEADERS });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const $ = cheerio.load(await r.text());
  const desc = ($('meta[name="description"]').attr('content') || $('meta[property="og:description"]').attr('content') || '').trim();
  const found = new Map(), links = new Map(), bonuses = [];
  let label = '';
  $('h2, h3, li, a[href*="/events/"], img[src*="/events/bonuses/"]').each((_, el) => {
    if (el.name === 'h2' || el.name === 'h3') { label = $(el).text().replace(/\s+/g, ' ').trim(); return; }
    if (!label) return;
    if (el.name === 'img') {
      if (/bonus/i.test(label) && !/go pass/i.test(label)) {
        const text = ($(el).attr('alt') || '').trim();
        if (text && !bonuses.some(b => b.text === text)) bonuses.push({ text, image: new URL($(el).attr('src'), url).href });
      }
      return;
    }
    if (SKIP_SECTIONS.test(label)) return;
    if (el.name === 'a') {
      const m = ($(el).attr('href') || '').match(/\/events\/([^/?#]+)/);
      if (m && !links.has(label)) links.set(label, m[1]);
      return;
    }
    if ($(el).parents('li').length) return;
    const imgs = $(el).find('img');
    const img = imgs.filter((_, i) => /\/pokemon_icons/.test($(i).attr('src') || '')).first();
    if (!img.length) return;
    const name = $(el).text().replace(/\s+/g, ' ').trim()
      .split(/\s*(?:\d+%\s*IV|Max CP|Min CP|POSSIBLE)/i)[0].trim();
    if (!name || name.length > 40) return;
    const src = new URL(img.attr('src'), url).href;
    const shiny = imgs.filter((_, i) => /shiny-icon/.test($(i).attr('src') || '')).length > 0;
    if (!found.has(label)) found.set(label, { dmax: false, items: new Map() });
    const g = found.get(label);
    g.dmax ||= /_dmax|gmax|gigantamax/i.test(src);
    if (!g.items.has(name)) g.items.set(name, { name, image: src, shiny });
  });
  const icon = (l, dmax) => dmax || /max|dynamax/i.test(l) ? 'bolt' : /raid/i.test(l) ? 'shield'
    : /egg|hatch/i.test(l) ? 'egg' : /wild|spawn|encounter/i.test(l) ? 'paw'
    : /spotlight|featured/i.test(l) ? 'star' : /eternatus|legendary/i.test(l) ? 'crown' : 'pokeball';
  const groups = [...found].sort((a, b) => b[1].dmax - a[1].dmax).map(([l, g]) => ({
    key: 'p-' + norm(l).replace(/ /g, '-'), label: l, icon: icon(l, g.dmax),
    items: [...g.items.values()], ...(links.has(l) ? { linked: links.get(l) } : {})
  }));
  return { desc, bonuses, groups };
}

/* ---------- official news check ---------- */
async function getOfficialPosts() {
  const r = await fetch(OFFICIAL_NEWS, { headers: HEADERS });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const html = await r.text();
  const posts = new Map();
  const add = (href, title = '') => {
    const url = new URL(href, 'https://pokemongolive.com').href;
    const slug = url.split('/post/')[1] || '';
    const prev = posts.get(url)?.text || '';
    posts.set(url, { url, text: norm(`${slug.replace(/[-/]/g, ' ')} ${title.replace(/<[^>]+>/g, ' ')} ${prev}`) });
  };
  for (const m of html.matchAll(/<a[^>]+href="([^"]*\/post\/[^"#?]+)"[^>]*>([\s\S]*?)<\/a>/gi)) add(m[1], m[2]);
  for (const m of html.matchAll(/["'](\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?post\/[a-z0-9-]+\/?)["']/gi)) add(m[1]);
  console.log(`Official news page: HTTP ${r.status}, ${html.length} bytes, ${posts.size} post links`);
  return [...posts.values()];
}
function findOfficial(name, posts) {
  const words = [...new Set(norm(name).split(' ').filter(w => w.length > 2 && !STOP.has(w) && !/^\d+$/.test(w)))];
  if (!words.length || !posts.length) return null;
  let best = null, bestScore = 0;
  for (const p of posts) {
    const hay = ` ${p.text} `;
    const score = words.filter(w => hay.includes(` ${w} `)).length / words.length;
    if (score > bestScore) { best = p; bestScore = score; }
  }
  return bestScore >= 0.67 ? best.url : null;
}

/* ---------- build ---------- */
const [raw, raids, eggs, research] = await Promise.all([
  getJSON('events.min.json', true), getJSON('raids.min.json'), getJSON('eggs.min.json'), getJSON('research.min.json')
]);

const previous = new Map();
try { for (const e of JSON.parse(await readFile('data/events.json', 'utf8')).events || []) previous.set(e.id, e); } catch {}

let posts = [], officialStatus = 'ok';
try { posts = await getOfficialPosts(); console.log(`Official news: ${posts.length} posts found`); }
catch (err) { officialStatus = 'unavailable'; console.warn(`Official news check failed: ${err.message}`); }
if (!posts.length) officialStatus = 'unavailable';

const names = l => (l || []).map(x => typeof x === 'string' ? x : x?.name).filter(Boolean);
// Keeps CP (100% IV), weather boost and types when the feed has them
function mon(p, tier) {
  if (!p?.name) return null;
  const c = p.combatPower || {};
  const cp = c.normal?.max ?? c.max ?? null, cpB = c.boosted?.max ?? null;
  const w = names(p.boostedWeather), types = names(p.types);
  return {
    name: p.name, image: p.image || '', shiny: !!p.canBeShiny, ...(tier ? { tier } : {}),
    ...(cp > 0 ? { cp } : {}), ...(cpB > 0 ? { cpB } : {}), ...(w.length ? { w } : {}), ...(types.length ? { types } : {})
  };
}
function group(key, label, icon, list, tierFn) {
  const seen = new Set(), items = [];
  for (const p of list || []) {
    const m = mon(p, tierFn?.(p));
    if (!m) continue;
    const k = m.name + '|' + (m.tier || '');
    if (!seen.has(k)) { seen.add(k); items.push(m); }
  }
  return items.length ? { key, label, icon, items } : null;
}

const now = Date.now();
const rawById = new Map(raw.filter(e => e?.eventID).map(e => [e.eventID, e]));

function timeGroup(g, e) {
  const { linked, ...rest } = g;
  const L = linked && linked !== e.eventID ? rawById.get(linked) : null;
  if (!L?.start || !L?.end) return rest;
  const inside = Date.parse(L.start) >= Date.parse(e.start) - D && Date.parse(L.end) <= Date.parse(e.end) + D;
  return inside ? { ...rest, start: L.start, end: L.end } : rest;
}

// Read event pages for events running now or within the next 14 days
const scraped = new Map();
for (const e of raw) {
  const type = e?.eventType || 'event';
  if (!e?.eventID || !e.link || SCRAPE_SKIP.has(type)) continue;
  if (!(Date.parse(e.end) > now - D && Date.parse(e.start) < now + 14 * D)) continue;
  try {
    const p = await scrapeEventPage(e.link);
    scraped.set(e.eventID, p);
    console.log(`Read ${e.eventID}: ${p.groups.map(g => `${g.label} (${g.items.length})`).join(', ') || 'no Pokémon'} | ${p.bonuses.length} bonuses`);
    await sleep(800); // be polite to LeekDuck
  } catch (err) { console.warn(`Page scrape failed for ${e.eventID}: ${err.message}`); }
}

const events = raw
  .filter(e => e?.eventID && e.start && e.end)
  .map(e => {
    const x = e.extraData || {}, type = e.eventType || 'event';
    const prev = previous.get(e.eventID);
    const page = scraped.get(e.eventID) || (prev ? {
      desc: prev.desc || '', bonuses: prev.pageBonuses || [],
      groups: (prev.groups || []).filter(g => g.key?.startsWith('p-'))
    } : null);
    const desc = page?.desc || '';

    // Where it happens
    const place = placeOf(e, `${desc} ${e.heading || ''}`);
    let scope = isZoned(e.start) ? 'global' : 'local', tz = null;
    if (place?.kind === 'venue' && place.tz) { scope = 'venue'; tz = place.tz; }

    // Max Mondays stay on the radar until the "through" date
    let end = e.end, extendedEnd = false;
    if (type === 'max-mondays') { const t = throughEnd(e, desc); if (t) { end = t; extendedEnd = true; } }

    const live = Date.parse(e.start) - 14 * H <= now && now <= Date.parse(end) + 14 * H;

    const groups = [
      group('featured', 'Featured', 'star', [
        ...(x.communityday?.spawns || []),
        ...(x.spotlight ? (x.spotlight.list?.length ? x.spotlight.list : [x.spotlight]) : [])
      ]),
      group('raids', 'Raid bosses', 'shield', x.raidbattles?.bosses),
      group('breakthrough', 'Research breakthrough', 'map-search', x.breakthrough ? (x.breakthrough.list?.length ? x.breakthrough.list : [x.breakthrough]) : [])
    ].filter(Boolean);

    if (page && !groups.length) groups.push(...page.groups.map(g => timeGroup(g, e)));

    if (live && LIVE_EXTRAS.has(type)) {
      if (!x.raidbattles?.bosses?.length) groups.push(group('raids-now', 'Raids right now', 'shield', raids, p => p.tier));
      groups.push(group('eggs-now', 'Eggs right now', 'egg', eggs, p => p.eggType ? p.eggType + (p.isAdventureSync ? ' · Adventure Sync' : '') : ''));
      // Each research task becomes a heading with its reward Pokémon under it (HTML tags removed)
      const tasks = research.flatMap(r => (r.rewards || []).map(p => ({ ...p, task: stripTags(r.text) })));
      groups.push(group('research-now', 'Field research right now', 'map-search', tasks, p => p.task));
    }

    let bonuses = [
      ...(x.communityday?.bonuses || []).map(b => ({ text: b.text, image: b.image || '' })),
      ...(x.spotlight?.bonus ? [{ text: x.spotlight.bonus, image: '' }] : [])
    ];
    if (!bonuses.length && page?.bonuses?.length) bonuses = page.bonuses;
    const rewards = [];
    for (const step of x.communityday?.specialresearch || []) {
      for (const r of step.rewards || []) rewards.push({ text: r.text, image: r.image || '' });
      for (const t of step.tasks || []) if (t.reward?.text) rewards.push({ text: t.reward.text, image: t.reward.image || '' });
    }

    let official = findOfficial(e.name, posts);
    if (!official && officialStatus !== 'ok') official = prev?.official || null;

    const placeOut = !place ? null : place.kind === 'venue'
      ? { kind: 'venue', city: place.city, country: place.country }
      : { kind: 'country', countries: place.countries };

    return {
      id: e.eventID, name: e.name, type, heading: e.heading || '', link: e.link, image: e.image || '',
      start: e.start, end, ...(extendedEnd ? { extendedEnd: true } : {}),
      main: !MINOR.has(type), scope, tz, place: placeOut, official,
      desc, pageBonuses: page?.bonuses || [],
      groups: groups.filter(Boolean), bonuses,
      disclaimers: x.communityday?.bonusDisclaimers || [],
      rewards: rewards.filter((r, i, a) => r.text && a.findIndex(o => o.text === r.text) === i)
    };
  })
  .filter(e => Date.parse(e.end) > now - 2 * D);

// Keep week-long Max Mondays even if the feed already dropped them
for (const p of previous.values()) {
  if (p.extendedEnd && !rawById.has(p.id) && Date.parse(p.end) > now) events.push(p);
}
events.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));

const placed = events.filter(e => e.place);
if (placed.length) console.log(`Special-place events: ${placed.map(e => `${e.name} → ${placeLabel(e)}`).join(' | ')}`);

await mkdir('data', { recursive: true });
await writeFile('data/events.json', JSON.stringify({
  updatedAt: new Date().toISOString(),
  sources: { feed: 'LeekDuck via ScrapedDuck', pages: scraped.size, official: officialStatus },
  events
}));

/* ---------- calendars ---------- */
const icsFloat = s => s.replace(/[-:]/g, '').slice(0, 15);
const icsUTC = t => new Date(t).toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
const esc = s => String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
// iCalendar lines must be at most 75 BYTES (✨ is 3 bytes), continuation lines start with a space
function fold(line) {
  const out = [];
  let cur = '', bytes = 0, limit = 75;
  for (const ch of line) {
    const b = Buffer.byteLength(ch);
    if (bytes + b > limit) { out.push(cur); cur = ''; bytes = 0; limit = 74; }
    cur += ch; bytes += b;
  }
  out.push(cur);
  return out.join('\r\n ');
}
function icsTimes(e) {
  if (isZoned(e.start)) return [icsUTC(Date.parse(e.start)), icsUTC(Date.parse(e.end))];       // exact moment
  if (e.scope === 'venue' && e.tz) return [icsUTC(wallStr(e.start, e.tz)), icsUTC(wallStr(e.end, e.tz))]; // venue clock
  return [icsFloat(e.start), icsFloat(e.end)];                                                  // same clock time everywhere
}
function describe(e) {
  const out = [e.heading];
  if (e.place) out.push(e.place.kind === 'venue' ? `📍 In person: ${placeLabel(e)}` : `📍 ${placeLabel(e)}`);
  if (e.desc) out.push(e.desc);
  const list = l => l.map(p => p.name + (p.shiny ? ' ✨' : '')).join(', ');
  for (const g of e.groups) {
    const tiers = [...new Set(g.items.map(p => p.tier || ''))];
    if (tiers.length > 1) out.push(`${g.label}:` + tiers.map(t => `\n• ${t ? stripTags(t) + ': ' : ''}${list(g.items.filter(p => (p.tier || '') === t))}`).join(''));
    else out.push(`${g.label}: ${list(g.items)}`);
  }
  if (e.bonuses.length) out.push('Bonuses: ' + e.bonuses.map(b => b.text).join('; '));
  if (e.official) out.push('Official post: ' + e.official);
  out.push('Details: ' + e.link);
  return out.join('\n');
}
function summary(e) {
  const p = placeLabel(e);
  if (!p) return e.name;
  const n = e.name.toLowerCase();
  const already = e.place.kind === 'venue' ? [e.place.city, e.place.country].some(x => x && n.includes(x.toLowerCase())) : false;
  return already ? e.name : `${e.name} (${p})`;
}
function ics(list, calName) {
  const stamp = icsUTC(Date.now());
  const L = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//pogo-event-radar//EN', 'CALSCALE:GREGORIAN',
    `X-WR-CALNAME:${calName}`, 'REFRESH-INTERVAL;VALUE=DURATION:PT6H', 'X-PUBLISHED-TTL:PT6H'];
  for (const e of list) {
    const [s, en] = icsTimes(e);
    L.push('BEGIN:VEVENT', `UID:${e.id}@pogo-event-radar`, `DTSTAMP:${stamp}`, `DTSTART:${s}`, `DTEND:${en}`,
      `SUMMARY:${esc(summary(e))}`, `DESCRIPTION:${esc(describe(e))}`, `URL:${e.link}`);
    if (e.place?.kind === 'venue' && placeLabel(e) !== 'In person') L.push(`LOCATION:${esc(placeLabel(e))}`);
    L.push('BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT1H', `DESCRIPTION:${esc(e.name)} in 1 hour`, 'END:VALARM');
    if (e.main) L.push('BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-P1D', `DESCRIPTION:${esc(e.name)} tomorrow`, 'END:VALARM');
    L.push('END:VEVENT');
  }
  L.push('END:VCALENDAR');
  return L.map(fold).join('\r\n') + '\r\n';
}
await writeFile('data/main.ics', ics(events.filter(e => e.main), 'Pokémon GO – Main events'));
await writeFile('data/all.ics', ics(events, 'Pokémon GO – All events'));

console.log(`Saved ${events.length} events (${events.filter(e => e.main).length} main, ${placed.length} special-place, ${scraped.size} pages read, ${events.filter(e => e.official).length} confirmed by official news)`);
