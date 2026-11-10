// Plans and builds tomorrow's posts once a day: writes queue/<id>.json and pre-renders images into media/<id>/.
// Copy comes from GitHub Models (free tier, uses the workflow's GITHUB_TOKEN), limited to content/facts.md.
// Every item must pass the claim guard, the repeat check and a test render, or it is dropped (fewer posts, never bad ones).
// Env: GITHUB_TOKEN, [MODEL], [FORCE_DATE=YYYY-MM-DD], [DRY_RUN=1]
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { check, isRepeat, hookOf } from './guard.mjs';
import { renderItem, isVideo, SCENE_TYPES } from './render.mjs';
import { sydneyDay, loadQueue } from './publish.mjs';

const ROOT = resolve(import.meta.dirname, '..');
// Sydney posting slots. Feed times follow Metricool's best-time data (10 am peak, 5–6 pm second peak).
const SLOTS = { reel: ['10:00', '18:00'], carousel: ['12:00'], story: ['08:00', '11:30', '15:00', '19:30'] };

// 'YYYY-MM-DD', 'HH:MM' in Sydney -> UTC ISO string (handles daylight saving).
export function sydneyToUtc(day, hm) {
  const guess = new Date(`${day}T${hm}:00Z`);
  const shown = new Date(guess.toLocaleString('en-US', { timeZone: 'Australia/Sydney' }));
  const utcShown = new Date(guess.toLocaleString('en-US', { timeZone: 'UTC' }));
  return new Date(guess - (shown - utcShown)).toISOString();
}

function performanceNotes() {
  const f = join(ROOT, 'state/insights.json');
  if (!existsSync(f)) return 'No performance data yet.';
  const { media = {} } = JSON.parse(readFileSync(f, 'utf8'));
  const queue = Object.fromEntries(loadQueue().map((q) => [q.id, q]));
  const rows = Object.entries(media).filter(([id]) => queue[id]).map(([id, m]) => {
    const x = m.metrics || {};
    return { hook: hookOf(queue[id]), type: queue[id].type, score: (x.reach || 0) + 5 * ((x.saved || 0) + (x.shares || 0)) + 2 * (x.comments || 0) };
  }).sort((a, b) => b.score - a.score);
  if (rows.length < 6) return 'Too little performance data yet; keep testing different pillars.';
  const fmt = (r) => `- [${r.type}] "${r.hook}" (score ${r.score})`;
  return `Best performing:\n${rows.slice(0, 3).map(fmt).join('\n')}\nWeakest:\n${rows.slice(-3).map(fmt).join('\n')}`;
}

const prompt = (day, pastHooks) => `You write Instagram content for TradeReach, aimed at Australian tradies (plumbers, electricians, builders, HVAC, roofers).
Date of posting: ${day} (Australia). Use the season and time of year where it helps (e.g. summer heat, storms, Christmas shutdown, EOFY).
Australian English, plain and practical, a little dry humour, no hype. Speak tradie to tradie.

FACTS: you may only state facts from this list. If it isn't here, don't claim it.
${readFileSync(join(ROOT, 'content/facts.md'), 'utf8')}

HARD RULES: no statistics, numbers of customers, percentages, prices, testimonials, reviews, "AI", guarantees, phone numbers, emails, @mentions or links except tradereach.net. Don't claim it books jobs or quotes. Don't say "we hear" or imply customer feedback. Questions to the audience are fine.
Mix the pillars across the day: the missed-call problem, how it works, a specific trade, practical tips that help even without TradeReach, trust (what it never does).
Don't repeat these previous hooks or close variants:
${pastHooks.slice(-80).map((h) => `- ${h}`).join('\n') || '- (none yet)'}

PERFORMANCE (lean towards what worked, keep testing new angles):
${performanceNotes()}

OUTPUT: JSON object {"items":[...]} with exactly: 2 "reel", 1 "carousel", 4 "story".
Item: {"type": "reel"|"carousel"|"story", "pillar": string, "caption": string (reel/carousel only: 2-5 short lines, ends with a call to action like "Try the live demo, link in bio.", then 3-5 hashtags), "scenes": [...]}
Scenes (text uses *word* to highlight one or two key words; \\n for a line break; keep each "text" under 60 characters):
- {"t":"title","kicker"?:string,"text":string,"body"?:string}
- {"t":"body","kicker"?:string,"text":string,"body"?:string,"small"?:string}
- {"t":"calls","text":string,"calls":[["Missed call","Mobile · just now"], ...up to 4]}
- {"t":"sms","text":string}   (shows the fixed demo text message; labelled as a demo)
- {"t":"jobcard","text":string,"small"?:string}   (shows the fixed demo job summary)
- {"t":"rule","num":"01","ok":boolean,"text":string,"body"?:string}   (carousel list slides)
- {"t":"end","text":string}   (logo + "Try the live demo" button; last scene of every reel and carousel)
Reels: 4-6 scenes. Carousels: 5-8 scenes, first is a "title" hook. Stories: 1 scene (image) or 2 scenes (short video); story replies come in as DMs, so ask questions.`;

async function generate(day, pastHooks) {
  const res = await fetch('https://models.github.ai/inference/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, 'Content-Type': 'application/json', Accept: 'application/vnd.github+json' },
    body: JSON.stringify({ model: process.env.MODEL || 'openai/gpt-4.1', temperature: 0.8,
      response_format: { type: 'json_object' }, messages: [{ role: 'user', content: prompt(day, pastHooks) }] }),
  });
  if (!res.ok) throw new Error(`GitHub Models HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = await res.json();
  return JSON.parse(json.choices[0].message.content).items || [];
}

export async function prepare({ day, items, pastHooks, log = console.log, render = renderItem }) {
  const kept = [];
  const n = { reel: 0, carousel: 0, story: 0 };
  for (const raw of items) {
    const type = raw.type;
    if (!SLOTS[type] || n[type] >= SLOTS[type].length) continue;
    const scenes = (raw.scenes || []).filter((s) => SCENE_TYPES.includes(s?.t));
    if (type !== 'story' && scenes.at(-1)?.t !== 'end') scenes.push({ t: 'end', text: 'Missed the call? It still gets *answered.*' });
    const item = { id: `${day}-${type}-${n[type] + 1}`, type, pillar: raw.pillar, publish_at: sydneyToUtc(day, SLOTS[type][n[type]]),
      caption: type === 'story' ? undefined : raw.caption, scenes };
    const problems = check(item);
    if (problems.length) { log(`dropped ${type}: ${problems.join('; ')}`); continue; }
    if (isRepeat(hookOf(item), [...pastHooks, ...kept.map(hookOf)])) { log(`dropped ${type}: repeats an earlier hook`); continue; }
    try {
      const files = await render(item, isVideo(item) ? join(ROOT, 'out') : join(ROOT, 'media'));
      if (isVideo(item) && process.env.DRY_RUN !== '1') rmSync(join(ROOT, 'out', item.id), { recursive: true, force: true }); // videos are re-rendered at publish time
      log(`ready ${item.id} (${files.length} file${files.length > 1 ? 's' : ''})`);
    } catch (err) { log(`dropped ${type}: render failed: ${err.message}`); continue; }
    kept.push(item);
    n[type]++;
  }
  return kept;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const tomorrow = process.env.FORCE_DATE || sydneyDay(Date.now() + 24 * 3600e3);
  const queue = loadQueue();
  const hourSydney = Number(new Date().toLocaleString('en-US', { timeZone: 'Australia/Sydney', hour: 'numeric', hourCycle: 'h23' }));
  if (queue.some((q) => q.id.startsWith(tomorrow))) { console.log(`${tomorrow} already planned`); process.exit(0); }
  if (!process.env.FORCE_DATE && process.env.DRY_RUN !== '1' && hourSydney < 14) { console.log('plans are made after 2 pm Sydney'); process.exit(0); }
  const pastHooks = queue.map(hookOf);
  const kept = await prepare({ day: tomorrow, items: await generate(tomorrow, pastHooks), pastHooks });
  if (process.env.DRY_RUN === '1') { console.log(JSON.stringify(kept, null, 1)); process.exit(0); }
  mkdirSync(join(ROOT, 'queue'), { recursive: true });
  for (const item of kept) writeFileSync(join(ROOT, 'queue', `${item.id}.json`), JSON.stringify(item, null, 1) + '\n');
  console.log(`planned ${kept.length} items for ${tomorrow}`);
  if (kept.length < 3) { console.error('fewer than 3 items passed the checks'); process.exit(1); } // alert
}
