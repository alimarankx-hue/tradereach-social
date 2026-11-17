// node --test test/   (no network: the Graph API is faked)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { check, isRepeat } from '../src/guard.mjs';
import { run, makeGraph } from '../src/publish.mjs';

const samples = readdirSync('content/samples').map((f) => JSON.parse(readFileSync(`content/samples/${f}`, 'utf8')));

test('approved samples pass the guard', () => {
  for (const s of samples) assert.deepEqual(check(s), [], s.id);
});

test('guard blocks invented claims and sensitive details', () => {
  const base = samples.find((s) => s.type === 'reel');
  const bad = [
    'Tradies using TradeReach win 40% more jobs.', 'Trusted by hundreds of plumbers.', 'Only $49 per month!',
    '"Best thing I ever bought" - Dave, Penrith', 'Our AI answers every call.', 'It books the job for you.',
    'Call us on 0412 345 678', 'Email hello@tradereach.net', 'Never miss a job again.', 'See example.com.au',
    'Studies show 62 in 100 callers hang up.', 'Most tradies lose 5 calls a week.',
  ];
  for (const caption of bad) assert.notDeepEqual(check({ ...base, caption }), [], caption);
  assert.deepEqual(check({ ...base, caption: 'It never books a job and never quotes a price. tradereach.net' }), []);
});

test('repeat detection', () => {
  assert.ok(isRepeat("You're under a house.", ['You are under a *house*']));
  assert.ok(!isRepeat('First heatwave of summer', ["You're under a house."]));
});

// Fake Graph API: records calls, lets a test make publish "fail after succeeding".
function fakeGraph({ publishThrows = false } = {}) {
  const calls = [];
  const status = {};
  let n = 0;
  const g = {
    dry: false,
    calls,
    async call(method, path, params) {
      calls.push(`${method} ${path.replace(/^ig\//, '')}`);
      if (path.endsWith('content_publishing_limit')) return { data: [{ quota_usage: 0, config: { quota_total: 50 } }] };
      if (method === 'GET' && path === 'ig/media') return { data: [] };
      if (method === 'GET' && params.fields === 'status_code') return { status_code: status[path] || 'FINISHED' };
      if (method === 'GET') return { permalink: 'https://instagram.com/p/x' };
      if (path === 'ig/media') { const id = `c${++n}`; status[id] = 'FINISHED'; return { id, uri: 'u' }; }
      if (path === 'ig/media_publish') {
        status[params.creation_id] = 'PUBLISHED';
        if (publishThrows) throw Object.assign(new Error('timeout'), { transient: true });
        return { id: `m${n}` };
      }
      throw new Error(`unexpected ${method} ${path}`);
    },
    async upload() {},
  };
  return g;
}

const due = (s, iso) => ({ ...s, publish_at: iso });
const NOW = new Date('2026-11-20T01:00:00Z'); // 12 pm Sydney

test('publishes due items once; a re-run does nothing', async () => {
  const g = fakeGraph();
  const ledger = {};
  const queue = samples.filter((s) => s.type !== 'story').map((s) => due(s, '2026-11-20T00:30:00Z'));
  const args = { g, ig: 'ig', queue, ledger, save() {}, render: async () => ['a.mp4'], mediaUrl: (f) => f, now: NOW, log() {} };
  const r1 = await run(args);
  const reels = queue.filter((q) => q.type === 'reel').length, carousels = queue.filter((q) => q.type === 'carousel').length;
  assert.equal(r1.published.length, 3); // 3 reels (daily cap)
  assert.equal(r1.skipped.length, reels - 3 + carousels); // extra reels wait for the cap; carousels are paused (cap 0)
  const publishes = g.calls.filter((c) => c.includes('media_publish')).length;
  await run(args);
  assert.equal(g.calls.filter((c) => c.includes('media_publish')).length, publishes);
});

test('a publish that errors after going live is not published again', async () => {
  const g = fakeGraph({ publishThrows: true });
  const ledger = {};
  const queue = [due(samples.find((s) => s.type === 'reel'), '2026-11-20T00:30:00Z')];
  const args = { g, ig: 'ig', queue, ledger, save() {}, render: async () => ['a.mp4'], mediaUrl: (f) => f, now: NOW, log() {} };
  await run(args); // throws after Meta marked it PUBLISHED
  assert.equal(Object.values(ledger)[0].status, 'pending');
  await run(args); // retry sees PUBLISHED and records it
  assert.equal(Object.values(ledger)[0].status, 'published');
  assert.equal(g.calls.filter((c) => c.includes('media_publish')).length, 1);
});

test('blocked, stale and future items are not published', async () => {
  const g = fakeGraph();
  const ledger = {};
  const reel = samples.find((s) => s.type === 'reel');
  const queue = [
    due({ ...reel, id: 'bad-claim', caption: 'Trusted by hundreds of tradies' }, '2026-11-20T00:30:00Z'),
    due({ ...reel, id: 'old-one' }, '2026-11-19T10:00:00Z'),
    due({ ...reel, id: 'tomorrow' }, '2026-11-21T00:30:00Z'),
  ];
  await run({ g, ig: 'ig', queue, ledger, save() {}, render: async () => ['a.mp4'], mediaUrl: (f) => f, now: NOW, log() {} });
  assert.equal(ledger['bad-claim'].status, 'blocked');
  assert.equal(ledger['old-one'].status, 'stale');
  assert.equal(ledger.tomorrow.status, 'pending');
  assert.equal(g.calls.filter((c) => c.includes('media_publish')).length, 0);
});

test('dry-run graph makes no write requests', async () => {
  let hits = 0;
  const g = makeGraph({ token: 't', dry: true, fetchImpl: async () => { hits++; return { ok: true, json: async () => ({}) }; }, log() {} });
  await g.call('POST', 'ig/media', { caption: 'x' });
  assert.equal(hits, 0);
});

import { prepare, sydneyToUtc } from '../src/prepare.mjs';

test('Sydney times convert across daylight saving', () => {
  assert.equal(sydneyToUtc('2026-11-20', '10:00'), '2026-11-19T23:00:00.000Z'); // AEDT +11
  assert.equal(sydneyToUtc('2026-06-20', '10:00'), '2026-06-20T00:00:00.000Z'); // AEST +10
});

test('prepare keeps good items, drops bad and repeated ones, caps per type', async () => {
  const reel = samples.find((s) => s.id.includes('reel-02'));
  const items = [
    { ...reel, scenes: reel.scenes.slice(0, -1) }, // missing end card: added automatically
    { ...reel, caption: 'Trusted by hundreds of sparkies' }, // claim: dropped
    { ...samples.find((s) => s.id.includes('reel-01')) }, // repeat of past hook: dropped
    { ...samples.find((s) => s.id.includes('reel-03')) },
    { ...samples.find((s) => s.id.includes('reel-03')), scenes: [{ t: 'title', text: 'A third reel about ladders' }, { t: 'title', text: 'x' }, { t: 'title', text: 'y' }] },
    { ...samples.find((s) => s.id.includes('reel-03')), scenes: [{ t: 'title', text: 'A fourth reel about utes' }, { t: 'title', text: 'z' }] }, // over cap
    { ...samples.find((s) => s.type === 'carousel') }, // carousels paused: dropped
    { type: 'story', scenes: [{ t: 'body', text: 'Ever answered a call *mid-climb?*' }] },
  ];
  const kept = await prepare({ day: '2026-11-21', items, pastHooks: ["You're under a *house.*"], render: async () => ['x'], log() {} });
  assert.deepEqual(kept.map((k) => k.id), ['2026-11-21-reel-1', '2026-11-21-reel-2', '2026-11-21-reel-3', '2026-11-21-story-1']);
  assert.equal(kept[0].scenes.at(-1).t, 'end');
  assert.equal(kept[3].caption, undefined);
  assert.equal(kept[0].publish_at, '2026-11-20T20:00:00.000Z'); // 7 am Sydney (AEDT)
});

import { sceneSecs, REEL_MAX_SECS, tradeOf, footageFor } from '../src/render.mjs';

test('reels stay short: about 8 s whatever the scene count; stories keep their timing', () => {
  for (const n of [3, 4, 6]) {
    const item = { type: 'reel', secs: 2.6, scenes: Array(n).fill({ t: 'title', text: 'x' }) };
    const total = sceneSecs(item) * n - 0.35 * (n - 1);
    assert.ok(total <= REEL_MAX_SECS + 0.01 && total >= 3.2, `${n} scenes -> ${total}s`);
  }
  assert.equal(sceneSecs({ type: 'story', secs: 2.6, scenes: [{}, {}] }), 2.6);
});

test('footage trade comes from pillar, kicker or hashtags, never loose caption words', () => {
  assert.equal(tradeOf({ pillar: 'trade:electrician', caption: 'repair a pipe' }), 'electric');
  assert.equal(tradeOf({ pillar: 'problem', scenes: [{ kicker: 'ROOFERS' }], caption: '' }), 'roof');
  assert.equal(tradeOf({ pillar: 'problem', caption: 'Repair calls while you clean up.\n#plumbersofaustralia' }), 'plumb');
  assert.equal(tradeOf({ pillar: 'problem', caption: 'Repair calls while you clean up.' }), null);
});

test('footage: none without a key or clips; a Pexels failure never blocks a post', async () => {
  const item = { id: 'x-reel-1', type: 'reel', pillar: 'trade:plumber', scenes: [] };
  assert.equal(await footageFor(item, { env: {} }), null);
  assert.equal(await footageFor({ ...item, type: 'story' }, { env: { PEXELS_API_KEY: 'k' } }), null);
  const broken = async () => { throw new Error('network down'); };
  assert.equal(await footageFor(item, { env: { PEXELS_API_KEY: 'k' }, fetchImpl: broken }), null);
  const empty = async () => ({ json: async () => ({ videos: [] }) });
  assert.equal(await footageFor(item, { env: { PEXELS_API_KEY: 'k' }, fetchImpl: empty }), null);
});

import { mascotFor, moodOf } from '../src/render.mjs';

test('swearing must be masked; slurs are always blocked', () => {
  const base = samples.find((s) => s.id.includes('angry-koala'));
  assert.deepEqual(check(base), []);
  for (const bad of ["Oh you're fucking joking", 'What a cunt of a day', 'Absolute shitshow']) {
    assert.notDeepEqual(check({ ...base, caption: bad }), [], bad);
  }
  for (const ok of ["Oh you're f#@!ing joking", 'What a c*nt of a day', 'Absolute sh*tshow, mate']) {
    assert.deepEqual(check({ ...base, caption: ok }), [], ok);
  }
  assert.notDeepEqual(check({ ...base, caption: 'Stop being a little b*tch' }), []);
});

test('mascot: chosen per reel, never on stories, off with footage unless asked; rants look angry', () => {
  const reel = { id: 'r1', type: 'reel', scenes: [{ t: 'title', text: 'x' }] };
  assert.ok(['koala', 'roo'].includes(mascotFor(reel)));
  assert.equal(mascotFor({ ...reel, type: 'story' }), null);
  assert.equal(mascotFor({ ...reel, mascot: 'none' }), null);
  assert.equal(mascotFor(reel, '/clip.mp4'), null);
  assert.equal(mascotFor({ ...reel, mascot: 'roo' }, '/clip.mp4'), 'roo');
  assert.equal(moodOf({ scenes: [{ t: 'say' }] }), 'angry');
  assert.equal(moodOf({ scenes: [{ t: 'title' }] }), 'happy');
});

import { speechParts, isMasked, shapes, engineFor } from '../src/talk.mjs';
import { isDialogue } from '../src/render.mjs';

test('talk: masked swear words are bleeped, normal punctuation is not', () => {
  assert.deepEqual(speechParts("Oh you're *f#@!ing* joking. Flamin' hell!"),
    [{ text: "Oh you're " }, { bleep: true }, { text: " joking. Flamin' hell!" }]);
  for (const w of ['f#@!ing', 'sh#t', 'c*nt', 'f***', 'c#@t.']) assert.ok(isMasked(w), w);
  for (const w of ['hell!', 'wow!!', 'mate,', "'em", 'ya']) assert.ok(!isMasked(w), w);
});

test('talk: mouth follows loudness, no single-frame flicker; voice engine picked from the env', () => {
  assert.deepEqual(shapes([0, 0, 500, 900, 1000, 300, 0, 0, 800, 0]), [0, 0, 2, 2, 2, 2, 0, 0, 0, 0]);
  assert.deepEqual(shapes([0, 0, 0]), [0, 0, 0]);
  assert.equal(engineFor({ AZURE_SPEECH_KEY: 'k' }), 'azure');
  assert.equal(engineFor({ TALK_ENGINE: 'none' }), process.platform === 'darwin' ? 'none' : 'none');
});

test('dialogue sample passes the guard and is detected as a talking sketch', () => {
  const chat = samples.find((s) => s.id.includes('koala-roo-chat'));
  assert.deepEqual(check(chat), []);
  assert.ok(isDialogue(chat));
  assert.ok(!isDialogue(samples.find((s) => s.id.includes('reel-01'))));
});
