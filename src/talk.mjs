// Voices and lip-sync for the talking mascots.
// voiceLine(): speaks one line with an Australian voice (Azure Speech when AZURE_SPEECH_KEY is set; the Mac's own `say`
// for local tests; otherwise silent with an estimated length) and replaces masked swear words with a TV bleep.
// mouthFrames(): turns the voice's loudness into one mouth shape per video frame (0 closed, 1 open, 2 wide).
import { execFileSync } from 'node:child_process';
import { writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const FFMPEG = process.env.FFMPEG_PATH || join(ROOT, 'bin/ffmpeg');
export const FPS = 30;
const RATE = 24000; // mono 16-bit PCM throughout

// Two different Australian men, so the koala and the kangaroo never sound alike. Override with TALK_VOICE_KOALA/_ROO.
const AZURE_VOICES = { koala: 'en-AU-WilliamNeural', roo: 'en-AU-NeilNeural' };
const MAC_VOICES = { koala: 'Karen', roo: 'Daniel' }; // local testing only

const ff = (args) => execFileSync(FFMPEG, ['-v', 'error', '-y', ...args], { stdio: ['ignore', 'pipe', 'inherit'] });
const xml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);

// Text as it should be heard: highlight markers gone, masked swear words (f#@!ing, c*nt) become bleeps.
// A word is masked when a symbol sits inside it (f#@!ing, sh#t, c*nt) or follows a single letter (f***),
// never for normal end punctuation ("hell!").
export const isMasked = (word) => {
  const w = String(word).replace(/^[("'‘“]+|[.,?;:"')’”]+$/g, '');
  return /[#@!*][a-z]/i.test(w) || /^[a-z][#@!*]{2,}$/i.test(w);
};
export function speechParts(text) {
  const clean = String(text).replace(/\*([^*\s][^*]*)\*/g, '$1').replace(/\n/g, ' ');
  const parts = [];
  for (const word of clean.split(/(\s+)/)) {
    if (word.trim() && isMasked(word)) parts.push({ bleep: true });
    else if (parts.length && !parts.at(-1).bleep) parts.at(-1).text += word;
    else parts.push({ text: word });
  }
  return parts.filter((p) => p.bleep || p.text.trim());
}

async function azure(text, who, mood, out, env, fetchImpl) {
  const voice = env[`TALK_VOICE_${who.toUpperCase()}`] || AZURE_VOICES[who] || AZURE_VOICES.koala;
  const prosody = mood === 'angry' ? "rate='+12%' pitch='+4%'" : "rate='+6%'";
  const ssml = `<speak version='1.0' xml:lang='en-AU'><voice name='${voice}'><prosody ${prosody}>${xml(text)}</prosody></voice></speak>`;
  const res = await fetchImpl(`https://${env.AZURE_SPEECH_REGION || 'australiaeast'}.tts.speech.microsoft.com/cognitiveservices/v1`, {
    method: 'POST', body: ssml, signal: AbortSignal.timeout(30000),
    headers: { 'Ocp-Apim-Subscription-Key': env.AZURE_SPEECH_KEY, 'Content-Type': 'application/ssml+xml',
      'X-Microsoft-OutputFormat': 'riff-24khz-16bit-mono-pcm', 'User-Agent': 'tradereach-social' } });
  if (!res.ok) throw new Error(`Azure Speech HTTP ${res.status}`);
  writeFileSync(out, Buffer.from(await res.arrayBuffer()));
}

function mac(text, who, out) {
  const aiff = out.replace(/\.wav$/, '.aiff');
  execFileSync('say', ['-v', MAC_VOICES[who] || 'Karen', '-r', '190', '-o', aiff, text]);
  ff(['-i', aiff, '-ac', '1', '-ar', String(RATE), out]);
  rmSync(aiff, { force: true });
}

const silence = (secs, out) => ff(['-f', 'lavfi', '-t', secs.toFixed(2), '-i', `anullsrc=r=${RATE}:cl=mono`, out]);
const bleep = (out) => ff(['-f', 'lavfi', '-t', '0.38', '-i', `sine=frequency=1000:sample_rate=${RATE}`, '-af', 'volume=0.35', out]);

export function engineFor(env = process.env) {
  if (env.AZURE_SPEECH_KEY) return 'azure';
  if (process.platform === 'darwin' && env.TALK_ENGINE !== 'none') return 'mac';
  return 'none';
}

/** Speaks one line into `out` (wav). Returns { secs, voiced }. Never throws for a voice outage: falls back to silence. */
export async function voiceLine({ who = 'koala', text, mood = 'happy' }, out, { env = process.env, fetchImpl = fetch } = {}) {
  const engine = engineFor(env);
  const parts = speechParts(text);
  const words = String(text).split(/\s+/).filter(Boolean).length;
  if (engine === 'none' || !parts.length) { const secs = Math.max(1.2, words * 0.36); silence(secs, out); return { secs, voiced: false }; }
  const pieces = [];
  try {
    for (const [i, p] of parts.entries()) {
      const f = out.replace(/\.wav$/, `-${i}.wav`);
      if (p.bleep) bleep(f);
      else if (engine === 'azure') await azure(p.text.trim(), who, mood, f, env, fetchImpl);
      else mac(p.text.trim(), who, f);
      pieces.push(f);
    }
    const list = out.replace(/\.wav$/, '.txt');
    writeFileSync(list, pieces.map((f) => `file '${f}'`).join('\n'));
    // Same format for every piece, then trim the voice's leading/trailing silence so lines snap together.
    ff(['-f', 'concat', '-safe', '0', '-i', list, '-ac', '1', '-ar', String(RATE),
      '-af', 'silenceremove=start_periods=1:start_threshold=-45dB,areverse,silenceremove=start_periods=1:start_threshold=-45dB,areverse', out]);
    rmSync(list, { force: true });
    return { secs: pcm(out).length / RATE, voiced: true };
  } catch (err) {
    console.error(`voice failed (${err.message}); using a silent line`);
    const secs = Math.max(1.2, words * 0.36); silence(secs, out); return { secs, voiced: false };
  } finally { for (const f of pieces) rmSync(f, { force: true }); }
}

// 16-bit samples of a wav, as Int16Array (decoded through FFmpeg so any wav layout works).
function pcm(wav) {
  const buf = execFileSync(FFMPEG, ['-v', 'error', '-i', wav, '-f', 's16le', '-ac', '1', '-ar', String(RATE), '-'], { maxBuffer: 64 << 20 });
  return new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 2));
}

/** One mouth shape per frame from the voice's loudness; silent lines flap at a talking pace instead. */
export function mouthFrames(wav, frames, voiced = true) {
  if (!voiced) return Array.from({ length: frames }, (_, i) => [0, 1, 2, 1][Math.floor(i / 3) % 4]);
  const s = pcm(wav), per = RATE / FPS, rms = [];
  for (let f = 0; f < frames; f++) {
    let sum = 0, n = 0;
    for (let i = Math.floor(f * per); i < Math.min(s.length, Math.floor((f + 1) * per)); i++) { sum += s[i] * s[i]; n++; }
    rms.push(n ? Math.sqrt(sum / n) : 0);
  }
  return shapes(rms);
}

// Pure: loudness per frame -> 0/1/2, relative to the line's loudest moment, each shape held at least 2 frames.
export function shapes(rms) {
  const peak = Math.max(1, ...rms);
  const raw = rms.map((v) => (v / peak < 0.12 ? 0 : v / peak < 0.5 ? 1 : 2));
  for (let i = 1; i < raw.length - 1; i++) if (raw[i] !== raw[i - 1] && raw[i] !== raw[i + 1]) raw[i] = raw[i - 1];
  return raw;
}
