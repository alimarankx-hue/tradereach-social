// Renders one content item (JSON spec) to Instagram-ready files: HTML scenes -> PNG (headless Chrome) -> JPEG / MP4 (FFmpeg).
// CLI: node src/render.mjs <spec.json ...>   -> out/<id>/...
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, existsSync, statSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { voiceLine, mouthFrames } from './talk.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const FFMPEG = process.env.FFMPEG_PATH || join(ROOT, 'bin/ffmpeg');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PROFILE = join(tmpdir(), 'tr-render-profile'); // throwaway profile so the user's own Chrome is untouched

// Brand tokens from the approved logo pack (brand/README.txt) and the TradeReach design guide.
const CSS = `
@font-face{font-family:Archivo;src:url(${ROOT}/fonts/Archivo.ttf);font-weight:100 900;font-stretch:62% 125%}
*{box-sizing:border-box;margin:0}
body{width:var(--w);height:var(--h);background:#0B1E3A;color:#fff;font-family:Archivo;overflow:hidden;
  display:flex;flex-direction:column;justify-content:center;gap:48px;padding:var(--pad)}
body.light{background:#fff;color:#0B1E3A}
.h{font-weight:800;font-stretch:112%;letter-spacing:-.03em;line-height:1.02;font-size:var(--hs);text-wrap:balance}
.h.m{--hs:84px}
.gold{color:#FFC629}.light .gold{color:#c62a1d}
.k{font-weight:600;font-size:38px;letter-spacing:.14em;text-transform:uppercase;color:#94A3B8}.light .k{color:#4a5675}
.p{font-size:46px;line-height:1.35;color:#c9d3ec;text-wrap:pretty}.light .p{color:#4a5675}
.tag{position:absolute;top:var(--tagtop);left:var(--padx)}.tag img{height:72px}
.demo{position:absolute;top:var(--tagtop);right:var(--padx);font-size:28px;font-weight:600;letter-spacing:.06em;
  text-transform:uppercase;color:#FFC629;border:2px solid rgba(255,198,41,.55);border-radius:999px;padding:10px 22px}
.bubble{max-width:88%;border-radius:40px;padding:34px 40px;font-size:42px;line-height:1.35;background:#1f5eff;color:#fff;border-bottom-left-radius:10px}
.note{display:flex;gap:28px;align-items:center;background:rgba(255,255,255,.08);border:2px solid rgba(255,255,255,.12);
  border-radius:32px;padding:30px 36px;font-size:40px}
.note b{font-weight:700}.note small{display:block;color:#94A3B8;font-size:32px;margin-top:6px}
.dot{width:72px;height:72px;border-radius:50%;background:#c62a1d;flex:none;display:grid;place-items:center}
.card{background:#fff;color:#0B1E3A;border-radius:32px;padding:44px;font-size:40px;line-height:1.5;box-shadow:0 30px 60px -30px rgba(0,0,0,.6)}
.card .badge{display:inline-block;background:#c62a1d;color:#fff;border-radius:999px;padding:6px 22px;font-weight:700;font-size:30px}
.card dl{display:grid;grid-template-columns:auto 1fr;gap:8px 28px;margin-top:22px}.card dt{color:#4a5675}
.num{font-weight:800;font-stretch:112%;font-size:200px;line-height:.9;color:#FFC629}.light .num{color:#0B1E3A}
.rule{display:flex;gap:30px;align-items:flex-start}
.x{flex:none;width:96px;height:96px;border-radius:50%;display:grid;place-items:center;font-size:56px;font-weight:800;background:#c62a1d;color:#fff}
.x.ok{background:#1b7f4b}
.end{position:absolute;inset:0;background:#0B1E3A;color:#fff;display:flex;flex-direction:column;justify-content:center;
  align-items:center;text-align:center;gap:48px;padding:var(--pad)}
.end img{width:860px;mix-blend-mode:lighten}.end .gold{color:#FFC629}
.hook{justify-content:flex-start;padding-top:330px}.hook .h{font-size:150px}.hook .h.m{font-size:120px}
.top{justify-content:flex-start;padding-top:300px}.hook.mk .h{font-size:112px}
.say{position:relative;align-self:flex-start;max-width:96%;background:#fff;color:#0B1E3A;border-radius:56px;padding:46px 54px;
  font-weight:800;font-stretch:108%;font-size:88px;line-height:1.04;letter-spacing:-.02em;box-shadow:0 30px 70px -30px rgba(0,0,0,.7)}
.say .gold{color:#c62a1d}.say.right{align-self:flex-end}
.say.right:after{left:auto;right:110px;border-width:62px 46px 0 18px}
.say:after{content:"";position:absolute;left:110px;bottom:-62px;border-style:solid;border-width:62px 18px 0 46px;border-color:#fff transparent transparent transparent}
.over{background:transparent}.over .h,.over .p,.over .k{text-shadow:0 4px 28px rgba(0,0,0,.65)}.over .p{color:#eef2fb}.over .k{color:#d7deea}
.pill{background:#FFC629;color:#3b2a00;font-weight:700;font-size:46px;border-radius:999px;padding:26px 56px}
.small{font-size:32px;color:#94A3B8}
`;

const FMT = { // Reel/Story 9:16, carousel 4:5. Text stays out of the areas Instagram's UI covers.
  reel: { w: 1080, h: 1920, vars: '--pad:300px 90px 520px;--padx:90px;--tagtop:150px;--hs:116px' },
  story: { w: 1080, h: 1920, vars: '--pad:260px 90px 360px;--padx:90px;--tagtop:130px;--hs:116px' },
  carousel: { w: 1080, h: 1350, vars: '--pad:150px 96px 120px;--padx:96px;--tagtop:70px;--hs:96px' },
};

// Fixed wording from the public demo on tradereach.net (fictional Smith Plumbing). Never generated.
const SMS = `Hi, Smith Plumbing here. Sorry we missed your call. If it's about a job, reply with what you need. (Automated reply. Reply STOP to opt out.)`;
const JOBCARD = `<div class="card"><span class="badge">Emergency</span> &nbsp;Job summary · 2:15 pm
  <dl><dt>Name</dt><dd>Sarah</dd><dt>Suburb</dt><dd>Bondi</dd><dt>Problem</dt><dd>Burst pipe under the sink, water everywhere</dd><dt>Call back</dt><dd>As soon as possible</dd></dl></div>`;
const PHONE = `<svg width="40" height="40" viewBox="0 0 24 24" fill="#fff"><path d="M6.6 10.8a15.5 15.5 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25 11.4 11.4 0 0 0 3.6.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.25 1z"/></svg>`;

const esc = (s = '') => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const fmt = (s) => esc(s).replace(/\*([^*]+)\*/g, '<span class="gold">$1</span>').replace(/\n/g, '<br>'); // *word* = accent
const opt = (cls, s) => (s ? `<div class="${cls}">${fmt(s)}</div>` : '');
const h = (s) => `<div class="h${String(s).length > 34 ? ' m' : ''}">${fmt(s)}</div>`;

const SCENES = {
  title: (s) => opt('k', s.kicker) + h(s.text) + opt('p', s.body),
  body: (s) => opt('k', s.kicker) + h(s.text) + opt('p', s.body) + opt('small', s.small),
  calls: (s) => h(s.text) + (s.calls || []).map(([t, sub]) =>
    `<div class="note"><div class="dot">${PHONE}</div><div><b>${esc(t)}</b><small>${esc(sub)}</small></div></div>`).join(''),
  sms: (s) => `<div class="demo">Demo · fictional business</div>` + h(s.text) + `<div class="bubble">${esc(SMS)}</div>`,
  jobcard: (s) => `<div class="demo">Demo · fictional business</div>` + h(s.text) + JOBCARD + opt('small', s.small),
  rule: (s) => `<div class="num">${esc(s.num)}</div><div class="rule"><div class="x${s.ok ? ' ok' : ''}">${s.ok ? '✓' : '✕'}</div>${h(s.text)}</div>` + opt('p', s.body),
  say: (s) => opt('k', s.kicker) + `<div class="say">${fmt(s.text)}</div>` + opt('p', s.body),
  talk: (s) => opt('k', s.kicker) + `<div class="say${s.who === 'roo' ? ' right' : ''}">${fmt(s.text)}</div>`,
  end: (s) => `<div class="end"><img src="${ROOT}/brand/horizontal_dark.png">${h(s.text)}
    <div class="pill">Try the live demo · tradereach.net</div><div class="small">No signup. Runs in your browser.</div></div>`,
};
export const SCENE_TYPES = Object.keys(SCENES);

async function shot(dir, name, scene, item, { hook = false, over = false, top = false } = {}) {
  const f = FMT[item.type];
  const html = join(dir, `${name}.html`), png = join(dir, `${name}.png`);
  const tag = item.type === 'carousel' ? '' : `<div class="tag"><img src="${ROOT}/brand/icon_gold.png"></div>`;
  writeFileSync(html, `<!doctype html><meta charset="utf-8"><style>${CSS}</style>
<body class="${[item.type === 'carousel' && 'light', hook && 'hook', top && !hook && 'top', top && 'mk', over && 'over'].filter(Boolean).join(' ')}" style="--w:${f.w}px;--h:${f.h}px;${f.vars}">${tag}${SCENES[scene.t](scene)}</body>`);
  return snap(html, png, f.w, f.h, over, item.id);
}

async function snap(html, png, w, h, transparent, id) {
  rmSync(png, { force: true });
  // Headless Chrome writes the screenshot but doesn't always exit, so wait for the file and then kill it.
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--allow-file-access-from-files',
    '--no-first-run', '--no-sandbox', `--user-data-dir=${PROFILE}`, '--force-device-scale-factor=1',
    `--window-size=${w},${h}`, '--virtual-time-budget=3000', ...(transparent ? ['--default-background-color=00000000'] : []),
    `--screenshot=${png}`, `file://${html}`], { stdio: 'ignore' });
  for (let t = 0; t < 300 && !(existsSync(png) && statSync(png).size > 0); t++) await sleep(100);
  await sleep(300);
  chrome.kill('SIGKILL');
  if (!existsSync(png)) throw new Error(`screenshot failed: ${id}/${basename(png)}`);
  return png;
}

const ff = (args) => execFileSync(FFMPEG, ['-v', 'error', '-y', ...args], { stdio: 'inherit' });

// Stills -> MP4 meeting Meta's Reel/Story spec: H.264 yuv420p, 30 fps, closed GOP, moov at front, AAC 48 kHz.
// Our own synthesized loops (src/music.mjs). Picked from the post ID so posts vary but re-renders match.
const MUSIC = existsSync(join(ROOT, 'assets/music')) ? readdirSync(join(ROOT, 'assets/music')).filter((f) => f.endsWith('.m4a')).sort() : [];
const trackFor = (id) => MUSIC.length ? join(ROOT, 'assets/music', MUSIC[[...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % MUSIC.length]) : null;

// Mascots: original koala and kangaroo tradies (brand/mascot-*.svg). Angry brows and a frown for rants.
const MASCOTS = { koala: join(ROOT, 'brand/mascot-koala.svg'), roo: join(ROOT, 'brand/mascot-roo.svg') };
const MW = 460, MH = 570, MX = 50, MY = 940; // bottom-left, above Instagram's caption area
export function mascotFor(item, footage = null) {
  if (item.type !== 'reel' || item.mascot === 'none') return null;
  // Owner, 2026-11-17: the code-drawn mascots don't look good enough, so they only appear when a post asks for one.
  return MASCOTS[item.mascot] || null;
}
export const moodOf = (item) => item.mood || (item.scenes.some((s) => s.t === 'say') ? 'angry' : 'happy');
async function mascotPng(dir, kind, mood, id, mouth = 0) {
  const name = `mascot-${kind}-${mood}-${mouth}`;
  const html = join(dir, `${name}.html`), png = join(dir, `${name}.png`);
  const hide = '#mouth-open,#mouth-wide{display:none}' + (mood === 'angry' ? '#smile{display:none}' : '#brows,#frown{display:none}')
    + (mouth ? `#smile,#frown{display:none}#mouth-${mouth === 1 ? 'open' : 'wide'}{display:inline!important}` : '');
  writeFileSync(html, `<!doctype html><meta charset="utf-8"><style>*{margin:0}body{background:transparent}svg{display:block;width:${MW}px;height:${MH}px}${hide}</style>
<body>${readFileSync(MASCOTS[kind], 'utf8')}</body>`);
  return snap(html, png, MW, MH, true, id);
}

const FADE = 0.35;
const TRANSITIONS = ['slideup', 'smoothleft', 'fade'];
// The first 0.5 s decides whether people keep watching, so the hook scene punches in fast, then drifts slowly.
const PUNCH = "if(lte(on,15),1.14-0.00933*on,1+0.0006*(on-15))";

function video(pngs, secs, out, music, footage = null, mascot = null) {
  const fps = 30, frames = Math.round(secs * fps), n = pngs.length;
  const total = Math.max(3.2, secs * n - FADE * (n - 1)); // Meta minimum is 3 s
  const start = (i) => i * (secs - FADE);
  let inputs, graph, last;
  if (footage) { // real footage, darkened for contrast, with each transparent scene faded in on top
    inputs = [...pngs.flatMap((p) => ['-loop', '1', '-t', total.toFixed(2), '-i', p]), '-stream_loop', '-1', '-i', footage];
    graph = [`[${n}:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=${fps},trim=0:${total.toFixed(2)},setpts=PTS-STARTPTS,eq=saturation=0.9,drawbox=c=black@0.5:t=fill,format=yuv420p[bg]`];
    last = 'bg';
    pngs.forEach((_, i) => {
      const fx = [i > 0 && `fade=t=in:st=${start(i).toFixed(2)}:d=${FADE}:alpha=1`,
        i < n - 1 && `fade=t=out:st=${(start(i) + secs - FADE).toFixed(2)}:d=${FADE}:alpha=1`].filter(Boolean);
      graph.push(`[${i}]format=rgba${fx.length ? ',' + fx.join(',') : ''}[o${i}]`, `[${last}][o${i}]overlay=0:0:format=auto[b${i}]`);
      last = `b${i}`;
    });
  } else {
    inputs = pngs.flatMap((p) => ['-loop', '1', '-t', String(secs), '-i', p]);
    graph = pngs.map((_, i) =>
      `[${i}]scale=2160:3840,zoompan=z='${i === 0 ? PUNCH : 'min(zoom+0.0007,1.05)'}':x='iw/2-iw/zoom/2':y='ih/2-ih/zoom/2':d=${frames}:s=1080x1920:fps=${fps},format=yuv420p[v${i}]`);
    last = 'v0';
    for (let i = 1; i < n; i++) {
      graph.push(`[${last}][v${i}]xfade=transition=${TRANSITIONS[(i - 1) % TRANSITIONS.length]}:duration=${FADE}:offset=${start(i).toFixed(2)}[x${i}]`);
      last = `x${i}`;
    }
  }
  if (mascot) {
    const m = n + (footage ? 1 : 0);
    inputs.push('-loop', '1', '-t', total.toFixed(2), '-i', mascot.png);
    graph.push(`[${m}:v]format=rgba[mz]`,
      `[${last}][mz]overlay=x='${MX}+if(lt(t,0.7),9*sin(70*t),0)':y='${MY}+12*sin(2*PI*1.5*t)':enable='lt(t,${mascot.until.toFixed(2)})'[mo]`);
    last = 'mo';
  }
  const a = n + (footage ? 1 : 0) + (mascot ? 1 : 0); // audio input index
  const audioIn = music ? ['-stream_loop', '-1', '-i', music] : ['-f', 'lavfi', '-t', String(total), '-i', 'anullsrc=r=48000:cl=stereo'];
  graph.push(`[${a}:a]atrim=0:${total},afade=t=in:d=0.3,afade=t=out:st=${Math.max(0, total - 1).toFixed(2)}:d=1,volume=0.85[aud]`);
  ff([...inputs, ...audioIn,
    '-filter_complex', graph.join(';'), '-map', `[${last}]`, '-map', '[aud]',
    '-c:v', 'libx264', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-r', String(fps), '-g', '60', '-crf', '20',
    '-maxrate', '8M', '-bufsize', '16M', '-c:a', 'aac', '-b:a', '128k', '-ar', '48000',
    '-movflags', '+faststart', '-t', String(total), out]);
}

// Short Reels get watched to the end (and replayed), which is what Instagram rewards: about 8 s at most.
export const REEL_MAX_SECS = 8;
export function sceneSecs(item) {
  const n = item.scenes.length, want = item.secs || 2.6;
  return item.type === 'reel' ? Math.max(1.4, Math.min(want, (REEL_MAX_SECS + FADE * (n - 1)) / n)) : want;
}

// Background footage for a Reel, best first: the owner's own clips (assets/footage/<trade>/ or assets/footage/),
// then free Pexels stock when PEXELS_API_KEY is set. None found: the plain brand background is used.
const TRADE_QUERIES = { plumb: 'plumber working', electric: 'electrician working', sparky: 'electrician working', roof: 'roofer working',
  hvac: 'air conditioner technician', aircon: 'air conditioner technician', 'air con': 'air conditioner technician', landscap: 'landscaping gardener', garden: 'landscaping gardener',
  build: 'carpenter construction', carpent: 'carpenter construction', deck: 'carpenter construction', pest: 'pest control technician',
  paint: 'house painter', clean: 'cleaner working' };
const hashOf = (id) => [...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
// The trade comes from the pillar ("trade:plumber"), then the first scene's kicker, then hashtags: never free caption
// text, where words like "repair" or "clean" would pick the wrong footage.
export function tradeOf(item) {
  const tags = ((item.caption || '').match(/#\w+/g) || []).join(' ');
  for (const text of [item.pillar, item.scenes?.[0]?.kicker, tags]) {
    const t = String(text || '').toLowerCase();
    const key = t && Object.keys(TRADE_QUERIES).find((k) => t.includes(k));
    if (key) return key;
  }
  return null;
}
const clips = (dir) => existsSync(dir) ? readdirSync(dir).filter((f) => /\.(mp4|mov)$/i.test(f)).sort().map((f) => join(dir, f)) : [];

export async function footageFor(item, { env = process.env, fetchImpl = fetch } = {}) {
  if (item.type !== 'reel' || env.FOOTAGE === '0') return null;
  const trade = tradeOf(item);
  const own = [...(trade ? clips(join(ROOT, 'assets/footage', trade)) : []), ...clips(join(ROOT, 'assets/footage'))];
  if (own.length) return own[hashOf(item.id) % own.length];
  if (!env.PEXELS_API_KEY) return null;
  try {
    const q = encodeURIComponent(TRADE_QUERIES[trade] || 'tradesman working');
    const res = await fetchImpl(`https://api.pexels.com/videos/search?query=${q}&orientation=portrait&per_page=20`,
      { headers: { Authorization: env.PEXELS_API_KEY }, signal: AbortSignal.timeout(20000) });
    const videos = (await res.json()).videos || [];
    const files = videos.map((v) => (v.video_files || []).filter((f) => f.height >= 1280 && f.width < f.height && f.file_type === 'video/mp4')
      .sort((a, b) => a.height - b.height)[0]).filter(Boolean);
    if (!files.length) return null;
    const pick = files[hashOf(item.id) % files.length];
    const dir = join(ROOT, 'out/footage-cache'), file = join(dir, `${pick.id}.mp4`);
    if (!existsSync(file)) {
      mkdirSync(dir, { recursive: true });
      const v = await fetchImpl(pick.link, { signal: AbortSignal.timeout(60000) });
      writeFileSync(file, Buffer.from(await v.arrayBuffer()));
    }
    return file;
  } catch { return null; } // stock footage is a nice-to-have: never block a post over it
}

// Dialogue Reels: the koala (left) and the kangaroo (right, facing him) talk in turns. Each "talk" line is spoken in that
// character's voice, his mouth follows the voice frame by frame and he bounces while talking; the other one listens.
const CAST = { koala: 40, roo: 580 }; // x positions
export const isDialogue = (item) => item.type === 'reel' && item.scenes.some((s) => s.t === 'talk');
const ENC = ['-c:v', 'libx264', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-r', '30', '-g', '60', '-crf', '20',
  '-maxrate', '8M', '-bufsize', '16M', '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2'];

async function dialogueVideo(item, frames, out, music) {
  const FPS = 30, sprites = {}, segs = [];
  // Each character keeps his mood between lines (a fuming koala stays fuming while he listens), starting with his first line's.
  const mood = Object.fromEntries(Object.keys(CAST).map((k) => [k, item.scenes.find((s) => s.t === 'talk' && (s.who === 'roo' ? 'roo' : 'koala') === k)?.mood || 'happy']));
  const sprite = async (kind, mood, mouth) => (sprites[`${kind}-${mood}-${mouth}`] ||= await mascotPng(frames, kind, mood, item.id, mouth));
  for (const [i, s] of item.scenes.entries()) {
    const seg = join(frames, `seg${i}.mp4`);
    const bg = await shot(frames, `${i + 1}`, s, item, { hook: i === 0 && s.t !== 'talk', top: s.t !== 'end' });
    if (s.t === 'end') { // clean end card, no cast
      ff(['-loop', '1', '-t', '2.2', '-i', bg, '-f', 'lavfi', '-t', '2.2', '-i', 'anullsrc=r=48000:cl=stereo',
        '-vf', `fps=${FPS},format=yuv420p`, ...ENC, '-t', '2.2', seg]);
      segs.push(seg); continue;
    }
    const speaker = s.t === 'talk' ? (s.who === 'roo' ? 'roo' : 'koala') : null;
    let secs = 1.8, wav = null, mouths = null;
    if (speaker) {
      wav = join(frames, `line${i}.wav`);
      const v = await voiceLine({ who: speaker, text: s.text, mood: s.mood }, wav);
      secs = v.secs + 0.35;
      mouths = mouthFrames(wav, Math.round(secs * FPS), v.voiced);
    }
    const n = Math.round(secs * FPS);
    const inputs = ['-loop', '1', '-t', secs.toFixed(2), '-i', bg];
    const graph = [`[0:v]fps=${FPS},format=yuv420p[bg]`];
    let last = 'bg';
    for (const [k, kind] of Object.keys(CAST).entries()) {
      const talking = kind === speaker;
      if (talking && s.mood) mood[kind] = s.mood;
      const seq = talking ? mouths : Array(n).fill(0);
      const lines = [];
      for (let f = 0; f < n;) { // run-length: one concat entry per mouth shape held
        let g = f; while (g < n && seq[g] === seq[f]) g++;
        lines.push(`file '${await sprite(kind, mood[kind], seq[f])}'`, `duration ${((g - f) / FPS).toFixed(4)}`);
        f = g;
      }
      lines.push(lines.at(-2)); // the concat demuxer needs the last file repeated to honour its duration
      const list = join(frames, `seq${i}-${kind}.txt`);
      writeFileSync(list, lines.join('\n'));
      inputs.push('-f', 'concat', '-safe', '0', '-i', list);
      const [amp, hz] = talking ? [14, 3] : [5, 1];
      graph.push(`[${k + 1}:v]fps=${FPS},format=rgba${kind === 'roo' ? ',hflip' : ''}[m${k}]`,
        `[${last}][m${k}]overlay=x=${CAST[kind]}:y='${MY}+${amp}*sin(2*PI*${hz}*t)':eof_action=repeat[o${k}]`);
      last = `o${k}`;
    }
    const a = Object.keys(CAST).length + 1;
    inputs.push(...(wav ? ['-i', wav] : ['-f', 'lavfi', '-t', secs.toFixed(2), '-i', 'anullsrc=r=48000:cl=stereo']));
    ff([...inputs, '-filter_complex', graph.join(';'), '-map', `[${last}]`, '-map', `${a}:a`, ...ENC, '-t', secs.toFixed(2), seg]);
    segs.push(seg);
  }
  const list = join(frames, 'segs.txt'), joined = join(frames, 'joined.mp4');
  writeFileSync(list, segs.map((f) => `file '${f}'`).join('\n'));
  ff(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', joined]);
  if (!music) { ff(['-i', joined, '-c', 'copy', '-movflags', '+faststart', out]); return; }
  ff(['-i', joined, '-stream_loop', '-1', '-i', music, '-filter_complex',
    '[1:a]volume=0.16[m];[0:a][m]amix=inputs=2:duration=first:normalize=0[aud]', '-map', '0:v', '-map', '[aud]',
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-movflags', '+faststart', out]); // music bed under the voices
}

// Returns the list of output files, in posting order.
export async function renderItem(item, outRoot = join(ROOT, 'out')) {
  if (!FMT[item.type]) throw new Error(`unknown type ${item.type}`);
  for (const s of item.scenes) if (!SCENES[s.t]) throw new Error(`unknown scene ${s.t} in ${item.id}`);
  const dir = join(resolve(outRoot), item.id), frames = join(dir, 'frames');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(frames, { recursive: true });
  if (isDialogue(item)) {
    const files = [join(dir, `${item.id}.mp4`)];
    await dialogueVideo(item, frames, files[0], item.music === false ? null : trackFor(item.id));
    if (!process.env.KEEP_FRAMES) rmSync(frames, { recursive: true, force: true });
    return files;
  }
  const footage = await footageFor(item);
  const mascot = mascotFor(item, footage);
  const pngs = [];
  for (const [i, s] of item.scenes.entries())
    pngs.push(await shot(frames, `${i + 1}`, s, item, { hook: item.type === 'reel' && i === 0, over: Boolean(footage) && s.t !== 'end', top: Boolean(mascot) }));
  let files;
  if (isVideo(item)) {
    files = [join(dir, `${item.id}.mp4`)];
    const secs = sceneSecs(item), n = item.scenes.length;
    const until = item.scenes.at(-1).t === 'end' ? (n - 1) * (secs - FADE) : 999; // the end card stays clean
    const m = mascot ? { png: await mascotPng(frames, mascot, moodOf(item), item.id), until } : null;
    video(pngs, secs, files[0], item.music === false ? null : trackFor(item.id), footage, m);
  } else {
    files = pngs.map((p, i) => join(dir, `${item.id}-${i + 1}.jpg`));
    pngs.forEach((p, i) => ff(['-i', p, '-q:v', '2', files[i]]));
  }
  if (!process.env.KEEP_FRAMES) rmSync(frames, { recursive: true, force: true });
  return files;
}
export const isVideo = (item) => item.type === 'reel' || (item.type === 'story' && item.scenes.length > 1);

if (process.argv[1] && basename(process.argv[1]) === 'render.mjs') {
  for (const f of process.argv.slice(2)) {
    const item = JSON.parse(readFileSync(f, 'utf8'));
    console.log('rendered', (await renderItem(item)).map((p) => p.replace(ROOT + '/', '')).join(', '));
  }
}
