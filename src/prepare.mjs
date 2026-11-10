// Turns drafts into scheduled posts: reads inbox/<day>.json (written by the daily Claude task, see content/WRITER.md),
// assigns times and IDs, and writes queue/<id>.json plus pre-rendered images in media/<id>/.
// Every draft must pass the claim guard, the repeat check and a test render, or it is dropped (fewer posts, never bad ones).
//   node src/prepare.mjs            ingest every inbox file (GitHub Actions)
//   node src/prepare.mjs --check F  validate a draft file without rendering (the writer runs this)
//   node src/prepare.mjs --report   performance summary and past hooks (the writer reads this)
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


export async function prepare({ day, items, pastHooks, log = console.log, render = renderItem }) {
  const kept = [];
  const n = { reel: 0, carousel: 0, story: 0 };
  for (const raw of items) {
    const type = raw.type;
    if (!SLOTS[type]) { log(`dropped: unknown type "${type}"`); continue; }
    if (n[type] >= SLOTS[type].length) { log(`dropped ${type}: only ${SLOTS[type].length} per day`); continue; }
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
  const [mode, file] = process.argv.slice(2);
  const queue = loadQueue();
  const pastHooks = queue.map(hookOf);
  if (mode === '--report') {
    console.log(performanceNotes());
    console.log(`\nPast hooks (${pastHooks.length}):\n${pastHooks.map((h) => `- ${h}`).join('\n') || '- none yet'}`);
    process.exit(0);
  }
  const read = (f) => { const d = JSON.parse(readFileSync(f, 'utf8')); if (!/^\d{4}-\d{2}-\d{2}$/.test(d.day) || !Array.isArray(d.items)) throw new Error(`${f}: needs {"day":"YYYY-MM-DD","items":[...]}`); return d; };
  if (mode === '--check') {
    const { day, items } = read(file);
    const kept = await prepare({ day, items, pastHooks, render: async () => ['ok'] });
    console.log(kept.length === items.length ? `all ${items.length} drafts pass` : `${items.length - kept.length} of ${items.length} drafts fail (see above)`);
    process.exit(kept.length === items.length ? 0 : 1);
  }
  const inbox = join(ROOT, 'inbox');
  let short = false;
  for (const f of existsSync(inbox) ? readdirSync(inbox).filter((x) => x.endsWith('.json')) : []) {
    const path = join(inbox, f);
    let d;
    try { d = read(path); } catch (err) { console.error(`ignored ${f}: ${err.message}`); rmSync(path); short = true; continue; }
    if (queue.some((q) => q.id.startsWith(d.day))) { console.log(`${d.day} already planned, ignoring ${f}`); rmSync(path); continue; }
    if (d.day < sydneyDay(Date.now())) { console.log(`${d.day} is in the past, ignoring ${f}`); rmSync(path); continue; }
    const kept = await prepare({ day: d.day, items: d.items, pastHooks });
    if (process.env.DRY_RUN === '1') { console.log(`[dry-run] would queue ${kept.length} items for ${d.day}`); continue; }
    mkdirSync(join(ROOT, 'queue'), { recursive: true });
    for (const item of kept) writeFileSync(join(ROOT, 'queue', `${item.id}.json`), JSON.stringify(item, null, 1) + '\n');
    rmSync(path);
    console.log(`queued ${kept.length} items for ${d.day}`);
    if (kept.length < 3) short = true;
  }
  if (short) { console.error('a draft file was unusable or fewer than 3 drafts passed'); process.exit(1); } // alert
}
