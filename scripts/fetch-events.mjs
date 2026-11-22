// Runs on GitHub Actions every 6 hours.
// 1) Reads LeekDuck event data via the ScrapedDuck feed
// 2) Checks the official Pokémon GO news page to confirm events
// 3) Writes data/events.json + data/main.ics + data/all.ics
import { writeFile, mkdir, readFile } from 'node:fs/promises';

const FEED = 'https://raw.githubusercontent.com/bigfoott/ScrapedDuck/data/';
const OFFICIAL_NEWS = 'https://pokemongolive.com/news';
const HEADERS = { 'User-Agent': 'pogo-event-radar/1.0 (personal GitHub Pages tracker)' };
const H = 36e5, D = 24 * H;

// Routine events hidden under "Main" (new types count as main by default)
const MINOR = new Set(['raid-battles', 'raid-hour', 'pokemon-spotlight-hour', 'go-battle-league',
  'research-breakthrough', 'season', 'max-mondays', 'go-pass']);
// Event types that happen at a physical location
const IN_PERSON = new Set(['city-safari', 'safari-zone', 'pokemon-go-fest', 'pokemon-go-tour', 'live-event', 'wild-area']);
// City keywords → time zone, for in-person events (add more when new cities appear)
const VENUES = [
  [/san francisco|pier 39|los angeles|las vegas|seattle|san diego/i, 'America/Los_Angeles'],
  [/new york|jersey city|toronto|boston|philadelphia|miami/i, 'America/New_York'],
  [/chicago|indianapolis|dallas|houston/i, 'America/Chicago'],
  [/mexico city|ciudad de m[eé]xico|monterrey|guadalajara/i, 'America/Mexico_City'],
  [/s[aã]o paulo|rio de janeiro/i, 'America/Sao_Paulo'],
  [/buenos aires/i, 'America/Argentina/Buenos_Aires'],
  [/santiago/i, 'America/Santiago'],
  [/london|liverpool|manchester|edinburgh/i, 'Europe/London'],
  [/paris|madrid|barcelona|valencia|berlin|amsterdam|copenhagen|stockholm|milan|rome|vienna|prague|brussels/i, 'Europe/Paris'],
  [/tokyo|osaka|yokohama|fukuoka|sendai|sapporo|nagasaki|kyoto|japan/i, 'Asia/Tokyo'],
  [/seoul|busan|korea/i, 'Asia/Seoul'],
  [/taipei|taichung|tainan|taiwan/i, 'Asia/Taipei'],
  [/hong kong/i, 'Asia/Hong_Kong'],
  [/singapore/i, 'Asia/Singapore'],
  [/jakarta|indonesia/i, 'Asia/Jakarta'],
  [/bangkok|thailand/i, 'Asia/Bangkok'],
  [/manila|philippines/i, 'Asia/Manila'],
  [/mumbai|delhi|bengaluru|bangalore|kolkata|chennai|hyderabad|india/i, 'Asia/Kolkata'],
  [/sydney|melbourne/i, 'Australia/Sydney'],
  [/auckland/i, 'Pacific/Auckland']
];
// Live raids/eggs/research are attached to these event types while they're running
const LIVE_EXTRAS = new Set(['event', 'season', 'raid-battles']);

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

const parts = (t, z) => Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: z, hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
  .formatToParts(t).filter(p => p.type !== 'literal').map(p => [p.type, +p.value]));
const offset = (t, z) => { const p = parts(t, z); return Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second) - Math.floor(t / 1e3) * 1e3; };
const wall = (y, mo, d, h, mi, z) => { const g = Date.UTC(y, mo - 1, d, h, mi); return g - offset(g - offset(g, z), z); };
const wallStr = (s, z) => { const m = s.match(/(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/); return wall(+m[1], +m[2], +m[3], +m[4], +m[5], z); };

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

const mon = (p, tier) => p && p.name ? { name: p.name, image: p.image || '', shiny: !!p.canBeShiny, ...(tier ? { tier } : {}) } : null;
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
const events = raw
  .filter(e => e?.eventID && e.start && e.end && Date.parse(e.end) > now - 2 * D)
  .map(e => {
    const x = e.extraData || {}, type = e.eventType || 'event';
    const isGlobal = /Z$|[+-]\d{2}:?\d{2}$/.test(e.start);
    let scope = isGlobal ? 'global' : 'local', tz = null;
    if (!isGlobal && IN_PERSON.has(type) && !/global/i.test(e.name)) {
      const hit = VENUES.find(([re]) => re.test(`${e.name} ${e.heading || ''}`));
      if (hit) { scope = 'venue'; tz = hit[1]; }
    }
    const live = Date.parse(e.start) - 14 * H <= now && now <= Date.parse(e.end) + 14 * H;

    const groups = [
      group('featured', 'Featured', 'star', [
        ...(x.communityday?.spawns || []),
        ...(x.spotlight ? (x.spotlight.list?.length ? x.spotlight.list : [x.spotlight]) : [])
      ]),
      group('raids', 'Raid bosses', 'shield', x.raidbattles?.bosses),
      group('breakthrough', 'Research breakthrough', 'map-search', x.breakthrough ? (x.breakthrough.list?.length ? x.breakthrough.list : [x.breakthrough]) : [])
    ];
    if (live && LIVE_EXTRAS.has(type)) {
      if (!x.raidbattles?.bosses?.length) groups.push(group('raids-now', 'Raids right now', 'shield', raids, p => p.tier));
      groups.push(group('eggs-now', 'Eggs right now', 'egg', eggs, p => p.eggType ? p.eggType + (p.isAdventureSync ? ' · Adventure Sync' : '') : ''));
      groups.push(group('research-now', 'Field research right now', 'map-search', research.flatMap(r => r.rewards || [])));
    }

    const bonuses = [
      ...(x.communityday?.bonuses || []).map(b => ({ text: b.text, image: b.image || '' })),
      ...(x.spotlight?.bonus ? [{ text: x.spotlight.bonus, image: '' }] : [])
    ];
    const rewards = [];
    for (const step of x.communityday?.specialresearch || []) {
      for (const r of step.rewards || []) rewards.push({ text: r.text, image: r.image || '' });
      for (const t of step.tasks || []) if (t.reward?.text) rewards.push({ text: t.reward.text, image: t.reward.image || '' });
    }

    let official = findOfficial(e.name, posts);
    if (!official && officialStatus !== 'ok') official = previous.get(e.eventID)?.official || null; // keep old match if check failed

    return {
      id: e.eventID, name: e.name, type, heading: e.heading || '', link: e.link, image: e.image || '',
      start: e.start, end: e.end, main: !MINOR.has(type), scope, tz, official,
      groups: groups.filter(Boolean), bonuses,
      disclaimers: x.communityday?.bonusDisclaimers || [],
      rewards: rewards.filter((r, i, a) => r.text && a.findIndex(o => o.text === r.text) === i)
    };
  })
  .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));

await mkdir('data', { recursive: true });
await writeFile('data/events.json', JSON.stringify({
  updatedAt: new Date().toISOString(),
  sources: { feed: 'LeekDuck via ScrapedDuck', official: officialStatus },
  events
}));

/* ---------- calendars ---------- */
const icsFloat = s => s.replace(/[-:]/g, '').slice(0, 15);
const icsUTC = t => new Date(t).toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
const esc = s => String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const fold = l => (l.match(/.{1,73}/gu) || ['']).join('\r\n ');
function icsTimes(e) {
  if (e.scope === 'local') return [icsFloat(e.start), icsFloat(e.end)];       // same clock time everywhere
  if (e.scope === 'global') return [icsUTC(Date.parse(e.start)), icsUTC(Date.parse(e.end))];
  return [icsUTC(wallStr(e.start, e.tz)), icsUTC(wallStr(e.end, e.tz))];     // venue time → exact moment
}
function describe(e) {
  const out = [e.heading];
  for (const g of e.groups) out.push(`${g.label}: ${g.items.map(p => p.name + (p.shiny ? ' ✨' : '')).join(', ')}`);
  if (e.bonuses.length) out.push('Bonuses: ' + e.bonuses.map(b => b.text).join('; '));
  if (e.official) out.push('Official post: ' + e.official);
  out.push('Details: ' + e.link);
  return out.join('\n');
}
function ics(list, calName) {
  const stamp = icsUTC(Date.now());
  const L = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//pogo-event-radar//EN', 'CALSCALE:GREGORIAN',
    `X-WR-CALNAME:${calName}`, 'REFRESH-INTERVAL;VALUE=DURATION:PT6H', 'X-PUBLISHED-TTL:PT6H'];
  for (const e of list) {
    const [s, en] = icsTimes(e);
    L.push('BEGIN:VEVENT', `UID:${e.id}@pogo-event-radar`, `DTSTAMP:${stamp}`, `DTSTART:${s}`, `DTEND:${en}`,
      `SUMMARY:${esc(e.name)}`, `DESCRIPTION:${esc(describe(e))}`, `URL:${e.link}`,
      'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT1H', `DESCRIPTION:${esc(e.name)} in 1 hour`, 'END:VALARM');
    if (e.main) L.push('BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-P1D', `DESCRIPTION:${esc(e.name)} tomorrow`, 'END:VALARM');
    L.push('END:VEVENT');
  }
  L.push('END:VCALENDAR');
  return L.map(fold).join('\r\n') + '\r\n';
}
await writeFile('data/main.ics', ics(events.filter(e => e.main), 'Pokémon GO – Main events'));
await writeFile('data/all.ics', ics(events, 'Pokémon GO – All events'));

console.log(`Saved ${events.length} events (${events.filter(e => e.main).length} main, ${events.filter(e => e.official).length} confirmed by official news)`);
