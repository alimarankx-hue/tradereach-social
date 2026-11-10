// Generates TradeReach's own background music loops with FFmpeg synthesis: no samples, no third-party
// audio, so nothing can be claimed for copyright. Run once; the files are committed in assets/music/.
//   node src/music.mjs
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const FFMPEG = process.env.FFMPEG_PATH || join(ROOT, 'bin/ffmpeg');
const OUT = join(ROOT, 'assets/music');
const SECS = 48;

// Each track: tempo and a 4-chord progression (three notes per chord, Hz).
const TRACKS = [
  { name: 'drive', bpm: 104, chords: [[261.63, 329.63, 392.0], [196.0, 246.94, 293.66], [220.0, 261.63, 329.63], [174.61, 220.0, 261.63]] }, // C G Am F
  { name: 'sunrise', bpm: 96, chords: [[293.66, 369.99, 440.0], [246.94, 293.66, 369.99], [196.0, 246.94, 293.66], [220.0, 277.18, 329.63]] }, // D Bm G A
  { name: 'workshop', bpm: 112, chords: [[220.0, 261.63, 329.63], [174.61, 220.0, 261.63], [261.63, 329.63, 392.0], [196.0, 246.94, 293.66]] }, // Am F C G
  { name: 'steady', bpm: 90, chords: [[174.61, 220.0, 261.63], [261.63, 329.63, 392.0], [196.0, 246.94, 293.66], [233.08, 293.66, 349.23]] }, // F C G Bb
];

const pick = (bar, chords, i) => // chord note i for bar index expression `bar`
  `if(eq(${bar},0),${chords[0][i]},if(eq(${bar},1),${chords[1][i]},if(eq(${bar},2),${chords[2][i]},${chords[3][i]})))`;

function track({ name, bpm, chords }) {
  const beat = 60 / bpm, barLen = beat * 4, step = beat / 2;
  const bar = `mod(floor(t/${barLen}),4)`;
  const n = [0, 1, 2].map((i) => pick(bar, chords, i));
  // Pad: the chord, softened at each change. Arp: chord notes an octave up on eighth notes, plucked.
  const pad = `(${n.map((f) => `sin(2*PI*${f}*t)+0.3*sin(4*PI*${f}*t)`).join('+')})*0.07*(1-exp(-4*mod(t,${barLen})))`;
  const arpNote = `if(eq(mod(floor(t/${step}),4),0),${n[0]},if(eq(mod(floor(t/${step}),4),1),${n[1]},if(eq(mod(floor(t/${step}),4),2),${n[2]},${n[1]})))`;
  const arp = `0.09*sin(4*PI*${arpNote}*t)*exp(-7*mod(t,${step}))`;
  const bass = `0.16*sin(PI*${n[0]}*t)*(0.6+0.4*exp(-3*mod(t,${beat})))`;
  const kick = `0.5*sin(2*PI*(45+90*exp(-25*mod(t,${beat})))*mod(t,${beat}))*exp(-9*mod(t,${beat}))`;
  const hat = `0.05*(2*random(0)-1)*exp(-45*mod(t+${beat / 2},${beat}))`;
  const out = join(OUT, `${name}.m4a`);
  execFileSync(FFMPEG, ['-v', 'error', '-y',
    '-f', 'lavfi', '-i', `aevalsrc='${pad}+${arp}+${bass}':s=48000:d=${SECS}`,
    '-f', 'lavfi', '-i', `aevalsrc='${kick}':s=48000:d=${SECS}`,
    '-f', 'lavfi', '-i', `aevalsrc='${hat}':s=48000:d=${SECS}`,
    '-filter_complex', '[0]lowpass=f=3800[m];[1]lowpass=f=180[k];[2]highpass=f=6000[h];[m][k][h]amix=inputs=3:normalize=0,acompressor=threshold=0.3:ratio=3,aecho=0.6:0.4:220:0.18,loudnorm=I=-18:TP=-2,pan=stereo|c0=c0|c1=c0',
    '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', out]);
  return out;
}

mkdirSync(OUT, { recursive: true });
for (const t of TRACKS) console.log('made', track(t).replace(ROOT + '/', ''));
