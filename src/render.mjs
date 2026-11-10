// Renders one content item (JSON spec) to Instagram-ready files: HTML scenes -> PNG (headless Chrome) -> JPEG / MP4 (FFmpeg).
// CLI: node src/render.mjs <spec.json ...>   -> out/<id>/...
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, existsSync, statSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';

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
  end: (s) => `<div class="end"><img src="${ROOT}/brand/horizontal_dark.png">${h(s.text)}
    <div class="pill">Try the live demo · tradereach.net</div><div class="small">No signup. Runs in your browser.</div></div>`,
};
export const SCENE_TYPES = Object.keys(SCENES);

async function shot(dir, name, scene, item) {
  const f = FMT[item.type];
  const html = join(dir, `${name}.html`), png = join(dir, `${name}.png`);
  const tag = item.type === 'carousel' ? '' : `<div class="tag"><img src="${ROOT}/brand/icon_gold.png"></div>`;
  writeFileSync(html, `<!doctype html><meta charset="utf-8"><style>${CSS}</style>
<body class="${item.type === 'carousel' ? 'light' : ''}" style="--w:${f.w}px;--h:${f.h}px;${f.vars}">${tag}${SCENES[scene.t](scene)}</body>`);
  rmSync(png, { force: true });
  // Headless Chrome writes the screenshot but doesn't always exit, so wait for the file and then kill it.
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--allow-file-access-from-files',
    '--no-first-run', '--no-sandbox', `--user-data-dir=${PROFILE}`, '--force-device-scale-factor=1',
    `--window-size=${f.w},${f.h}`, '--virtual-time-budget=3000', `--screenshot=${png}`, `file://${html}`], { stdio: 'ignore' });
  for (let t = 0; t < 300 && !(existsSync(png) && statSync(png).size > 0); t++) await sleep(100);
  await sleep(300);
  chrome.kill('SIGKILL');
  if (!existsSync(png)) throw new Error(`screenshot failed: ${item.id}/${name}`);
  return png;
}

const ff = (args) => execFileSync(FFMPEG, ['-v', 'error', '-y', ...args], { stdio: 'inherit' });

// Stills -> MP4 meeting Meta's Reel/Story spec: H.264 yuv420p, 30 fps, closed GOP, moov at front, AAC 48 kHz.
// Our own synthesized loops (src/music.mjs). Picked from the post ID so posts vary but re-renders match.
const MUSIC = existsSync(join(ROOT, 'assets/music')) ? readdirSync(join(ROOT, 'assets/music')).filter((f) => f.endsWith('.m4a')).sort() : [];
const trackFor = (id) => MUSIC.length ? join(ROOT, 'assets/music', MUSIC[[...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % MUSIC.length]) : null;

function video(pngs, secs, out, music) {
  const fps = 30, fade = 0.35, frames = Math.round(secs * fps);
  const inputs = pngs.flatMap((p) => ['-loop', '1', '-t', String(secs), '-i', p]);
  const parts = pngs.map((_, i) =>
    `[${i}]scale=2160:3840,zoompan=z='min(zoom+0.0007,1.05)':x='iw/2-iw/zoom/2':y='ih/2-ih/zoom/2':d=${frames}:s=1080x1920:fps=${fps},format=yuv420p[v${i}]`);
  let last = 'v0';
  const chain = [];
  for (let i = 1; i < pngs.length; i++) {
    chain.push(`[${last}][v${i}]xfade=transition=fade:duration=${fade}:offset=${((secs - fade) * i).toFixed(2)}[x${i}]`);
    last = `x${i}`;
  }
  const total = Math.max(3.2, secs * pngs.length - fade * (pngs.length - 1)); // Meta minimum is 3 s
  const audioIn = music ? ['-stream_loop', '-1', '-i', music] : ['-f', 'lavfi', '-t', String(total), '-i', 'anullsrc=r=48000:cl=stereo'];
  const audio = `[${pngs.length}:a]atrim=0:${total},afade=t=in:d=0.4,afade=t=out:st=${Math.max(0, total - 1.2).toFixed(2)}:d=1.2,volume=0.85[aud]`;
  ff([...inputs, ...audioIn,
    '-filter_complex', [...parts, ...chain, audio].join(';'), '-map', `[${last}]`, '-map', '[aud]',
    '-c:v', 'libx264', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-r', String(fps), '-g', '60', '-crf', '20',
    '-maxrate', '8M', '-bufsize', '16M', '-c:a', 'aac', '-b:a', '128k', '-ar', '48000',
    '-movflags', '+faststart', '-t', String(total), out]);
}

// Returns the list of output files, in posting order.
export async function renderItem(item, outRoot = join(ROOT, 'out')) {
  if (!FMT[item.type]) throw new Error(`unknown type ${item.type}`);
  for (const s of item.scenes) if (!SCENES[s.t]) throw new Error(`unknown scene ${s.t} in ${item.id}`);
  const dir = join(resolve(outRoot), item.id), frames = join(dir, 'frames');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(frames, { recursive: true });
  const pngs = [];
  for (const [i, s] of item.scenes.entries()) pngs.push(await shot(frames, `${i + 1}`, s, item));
  let files;
  if (isVideo(item)) {
    files = [join(dir, `${item.id}.mp4`)];
    video(pngs, item.secs || 2.6, files[0], item.music === false ? null : trackFor(item.id));
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
