// Collects Instagram insights for published posts and a daily account snapshot into state/insights.json.
// Needs the instagram_manage_insights permission. Metric names change between Graph versions, so each
// metric is requested on its own and unknown ones are skipped instead of failing the run.
// Env: IG_USER_ID, META_TOKEN, [GRAPH_VERSION]
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { makeGraph, sydneyDay } from './publish.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const METRICS = { reel: ['reach', 'views', 'likes', 'comments', 'saved', 'shares', 'total_interactions'],
  carousel: ['reach', 'views', 'likes', 'comments', 'saved', 'shares', 'total_interactions'],
  story: ['reach', 'views', 'replies', 'shares', 'navigation'] };

async function metricsFor(g, mediaId, names) {
  const out = {};
  for (const m of names) {
    const r = await g.call('GET', `${mediaId}/insights`, { metric: m }).catch(() => null);
    const v = r?.data?.[0]?.values?.[0]?.value ?? r?.data?.[0]?.total_value?.value;
    if (typeof v === 'number') out[m] = v;
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { IG_USER_ID: ig, META_TOKEN: token, GRAPH_VERSION: version } = process.env;
  if (!ig || !token) { console.log('no Meta credentials yet, skipping insights'); process.exit(0); }
  const g = makeGraph({ token, version });
  const file = join(ROOT, 'state/insights.json');
  const data = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { media: {}, account: {} };
  const ledgerFile = join(ROOT, 'state/ledger.json');
  const ledger = existsSync(ledgerFile) ? JSON.parse(readFileSync(ledgerFile, 'utf8')) : {};
  const now = Date.now();
  for (const [id, e] of Object.entries(ledger)) {
    if (e.status !== 'published' || !e.media_id) continue;
    const age = (now - new Date(e.at)) / 3600e3, last = data.media[id]?.at ? (now - new Date(data.media[id].at)) / 3600e3 : Infinity;
    // Stories vanish after 24 h, so read them at ~20 h; feed posts daily for 30 days.
    const due = e.type === 'story' ? age > 18 && age < 24 && last > 6 : age > 2 && age < 24 * 30 && last > 20;
    if (due) data.media[id] = { at: new Date(now).toISOString(), metrics: await metricsFor(g, e.media_id, METRICS[e.type]) };
  }
  const today = sydneyDay(now);
  if (!data.account[today]) {
    const acct = await g.call('GET', ig, { fields: 'followers_count,media_count' });
    const taps = await g.call('GET', `${ig}/insights`, { metric: 'profile_links_taps', period: 'day', metric_type: 'total_value' }).catch(() => null);
    data.account[today] = { followers: acct.followers_count, posts: acct.media_count, link_taps: taps?.data?.[0]?.total_value?.value };
  }
  writeFileSync(file, JSON.stringify(data, null, 1) + '\n');
  console.log(`insights: ${Object.keys(data.media).length} posts tracked; today ${JSON.stringify(data.account[today])}`);
}
