// Publishes due queue items to Instagram through Meta's official Graph API (Facebook Login path).
// Safe to re-run: the ledger records each container before publishing, and a container whose
// status is already PUBLISHED is recorded, never published twice.
// Env: IG_USER_ID, META_TOKEN, PUBLISHING_ENABLED=true, MEDIA_BASE_URL, [GRAPH_VERSION], [DRY_RUN=1]
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { check } from './guard.mjs';

const ROOT = resolve(import.meta.dirname, '..');
export const CAPS = { reel: 2, carousel: 1, story: 5 }; // per Sydney calendar day
const STALE_HOURS = 6; // a due item older than this is skipped, so an outage never dumps a backlog
const MAX_ATTEMPTS = 3;

export const sydneyDay = (d) => new Date(d).toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });

export function makeGraph({ token, version = 'v23.0', fetchImpl = fetch, dry = false, log = console.log }) {
  const base = `https://graph.facebook.com/${version}`;
  async function call(method, path, params = {}) {
    if (dry && method !== 'GET') { log(`[dry-run] ${method} ${path} ${JSON.stringify(Object.keys(params))}`); return { id: `dry-${Math.random().toString(36).slice(2, 8)}`, uri: 'dry' }; }
    const body = new URLSearchParams({ ...params, access_token: token });
    const url = method === 'GET' ? `${base}/${path}?${body}` : `${base}/${path}`;
    const res = await fetchImpl(url, method === 'GET' ? {} : { method, body });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.error) {
      const e = new Error(json.error?.message || `HTTP ${res.status}`);
      e.transient = res.status >= 500 || [1, 2, 4, 17, 32, 613, 9004, 2207001].includes(json.error?.code) || json.error?.is_transient;
      e.auth = json.error?.code === 190 || json.error?.code === 10 || json.error?.code === 200; // token or permission problem
      throw e;
    }
    return json;
  }
  async function upload(containerUri, file) { // resumable upload of a local video
    if (dry) { log(`[dry-run] upload ${relative(ROOT, file)}`); return; }
    const res = await fetchImpl(containerUri, { method: 'POST', body: readFileSync(file),
      headers: { Authorization: `OAuth ${token}`, offset: '0', file_size: String(statSync(file).size) } });
    if (!res.ok) { const e = new Error(`upload HTTP ${res.status}`); e.transient = res.status >= 500; throw e; }
  }
  return { call, upload, dry };
}

export async function waitReady(g, id, { tries = 30, delayMs = 10000 } = {}) {
  if (g.dry) return 'FINISHED';
  for (let i = 0; i < tries; i++) {
    const { status_code: s } = await g.call('GET', id, { fields: 'status_code' });
    if (s === 'FINISHED' || s === 'PUBLISHED') return s;
    if (s === 'ERROR' || s === 'EXPIRED') return s;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  const e = new Error(`container ${id} still processing`); e.transient = true; throw e;
}

// Creates the container(s) for an item. `files` are rendered outputs; images are served from MEDIA_BASE_URL.
async function createContainer(g, ig, item, files, mediaUrl) {
  const isVideo = (f) => f.endsWith('.mp4');
  if (item.type === 'carousel') {
    const children = [];
    for (const f of files) children.push((await g.call('POST', `${ig}/media`, { image_url: mediaUrl(f), is_carousel_item: 'true' })).id);
    for (const c of children) if ((await waitReady(g, c)) !== 'FINISHED') throw new Error(`carousel child ${c} failed`);
    return (await g.call('POST', `${ig}/media`, { media_type: 'CAROUSEL', children: children.join(','), caption: item.caption })).id;
  }
  const f = files[0];
  const params = item.type === 'reel'
    ? { media_type: 'REELS', upload_type: 'resumable', caption: item.caption, share_to_feed: 'true' }
    : isVideo(f) ? { media_type: 'STORIES', upload_type: 'resumable' } : { media_type: 'STORIES', image_url: mediaUrl(f) };
  const c = await g.call('POST', `${ig}/media`, params);
  if (params.upload_type) await g.upload(c.uri, f);
  return c.id;
}

export function loadQueue(dir = join(ROOT, 'queue')) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')))
    .sort((a, b) => a.publish_at.localeCompare(b.publish_at));
}

// One pass over the queue. Returns {published, failed, skipped}; mutates and saves the ledger after every step.
export async function run({ g, ig, queue, ledger, save, render, mediaUrl, now = new Date(), log = console.log }) {
  const out = { published: [], failed: [], skipped: [] };
  const today = sydneyDay(now);
  const usedToday = (type) => Object.values(ledger).filter((e) => e.status === 'published' && e.type === type && sydneyDay(e.at) === today).length;

  const limit = await g.call('GET', `${ig}/content_publishing_limit`, { fields: 'quota_usage,config' }).catch(() => null);
  let quotaLeft = limit?.data?.[0] ? limit.data[0].config.quota_total - limit.data[0].quota_usage : 25;

  let recentCaptions = null; // fetched lazily, only when a new feed container is about to be created
  for (const item of queue) {
    const e = ledger[item.id] ||= { type: item.type, status: 'pending', attempts: 0 };
    if (['published', 'failed', 'stale', 'blocked'].includes(e.status)) continue;
    const due = new Date(item.publish_at);
    if (due > now) continue;
    if (now - due > STALE_HOURS * 3600e3 && !e.container) { e.status = 'stale'; save(); out.skipped.push(item.id); log(`stale, skipped: ${item.id}`); continue; }
    const problems = check(item);
    if (problems.length) { Object.assign(e, { status: 'blocked', error: problems.join('; ') }); save(); out.failed.push(item.id); log(`BLOCKED ${item.id}: ${e.error}`); continue; }
    if (usedToday(item.type) >= CAPS[item.type]) { log(`daily cap reached for ${item.type}, leaving ${item.id} for review`); out.skipped.push(item.id); continue; }
    if (quotaLeft <= 1) { log('Meta publishing quota nearly used, stopping this run'); break; }

    try {
      e.attempts++;
      if (e.container) { // a previous run got this far: never publish the same thing twice
        const s = await waitReady(g, e.container);
        if (s === 'PUBLISHED') { Object.assign(e, { status: 'published', at: now.toISOString() }); save(); out.published.push(item.id); continue; }
        if (s !== 'FINISHED') delete e.container; // expired or errored before publishing: safe to rebuild
      }
      if (!e.container && item.caption && !g.dry) {
        recentCaptions ||= (await g.call('GET', `${ig}/media`, { fields: 'caption,permalink', limit: '30' })).data || [];
        const hit = recentCaptions.find((m) => m.caption === item.caption);
        if (hit) { Object.assign(e, { status: 'published', permalink: hit.permalink, at: now.toISOString(), note: 'found already live' }); save(); out.published.push(item.id); continue; }
      }
      if (!e.container) {
        const files = await render(item);
        e.container = await createContainer(g, ig, item, files, mediaUrl);
        save(); // recorded before publishing, so a crash after this point can't cause a duplicate
        const s = await waitReady(g, e.container);
        if (s !== 'FINISHED') throw Object.assign(new Error(`container ${s}`), { transient: s === 'EXPIRED' });
      }
      const { id } = await g.call('POST', `${ig}/media_publish`, { creation_id: e.container });
      const info = g.dry ? {} : await g.call('GET', id, { fields: 'permalink' }).catch(() => ({}));
      Object.assign(e, { status: 'published', media_id: id, permalink: info.permalink, at: now.toISOString() });
      delete e.error;
      quotaLeft--;
      save();
      out.published.push(item.id);
      log(`published ${item.id} ${info.permalink || ''}`);
    } catch (err) {
      e.error = err.message;
      if (err.auth) { e.attempts--; save(); throw err; } // stop the whole run and alert; the item stays pending
      if (!err.transient || e.attempts >= MAX_ATTEMPTS) { e.status = 'failed'; out.failed.push(item.id); }
      save();
      log(`${e.status === 'failed' ? 'FAILED' : 'will retry'} ${item.id}: ${err.message}`);
    }
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const env = process.env;
  const dry = env.DRY_RUN === '1';
  if (env.PUBLISHING_ENABLED !== 'true' && !dry) { console.log('Publishing is switched off (PUBLISHING_ENABLED is not "true"). Nothing to do.'); process.exit(0); }
  if (existsSync(join(ROOT, 'STOP'))) { console.log('STOP file present. Nothing published.'); process.exit(0); }
  for (const k of ['IG_USER_ID', 'META_TOKEN', 'MEDIA_BASE_URL']) if (!env[k] && !dry) { console.error(`missing ${k}`); process.exit(1); }
  const { renderItem } = await import('./render.mjs');
  const ledgerFile = join(ROOT, 'state/ledger.json');
  const ledger = existsSync(ledgerFile) ? JSON.parse(readFileSync(ledgerFile, 'utf8')) : {};
  const save = () => { if (!dry) writeFileSync(ledgerFile, JSON.stringify(ledger, null, 1) + '\n'); };
  const media = join(ROOT, 'media');
  const out = await run({
    g: makeGraph({ token: env.META_TOKEN, version: env.GRAPH_VERSION, dry }),
    ig: env.IG_USER_ID || 'dry-ig', queue: loadQueue(), ledger, save,
    // Images were rendered and committed by the prepare step, so Meta can fetch them from MEDIA_BASE_URL.
    // Videos are rendered here (deterministic from the spec) and uploaded directly.
    render: async (item) => {
      const dir = join(media, item.id);
      if (existsSync(dir)) return readdirSync(dir).filter((f) => f.endsWith('.jpg')).sort((a, b) => a.localeCompare(b, 'en', { numeric: true })).map((f) => join(dir, f));
      const files = await renderItem(item, join(ROOT, 'out'));
      if (!files[0].endsWith('.mp4')) throw new Error(`images for ${item.id} were not prepared in media/`);
      return files;
    },
    mediaUrl: (f) => `${env.MEDIA_BASE_URL || 'https://example.invalid'}/${relative(ROOT, f)}`,
  });
  console.log(JSON.stringify(out));
  if (out.failed.length) process.exit(1); // failed run -> GitHub emails the repo owner
}
