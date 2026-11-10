// Last-line claim filter. Every item must pass before it is rendered or published.
// It catches the common ways a post goes wrong (stats, prices, testimonials, overpromises, contact details);
// it cannot prove a sentence is true, which is why generation is limited to content/facts.md.
import { SCENE_TYPES } from './render.mjs';

const BANNED = [
  [/%|\bper ?cent\b/i, 'percentage'],
  [/\$\s?\d|\bAUD\b|\bper (month|week)\b|\/mo\b|\bfree trial\b|\bdiscount|\bpromo/i, 'price or offer'],
  [/\b(testimonial|review|rated|stars?|trusted by|clients?|our (customers|users)|customers? (say|love)|thousands|hundreds|millions?)\b/i, 'social proof'],
  [/\b(studies|study|research|survey|statistic|on average|average tradie|most tradies|\d+ in \d+)\b/i, 'statistic'],
  [/#1\b|\bnumber one\b|\bbest\b(?! time)|\bguarantee/i, 'superlative or guarantee'],
  [/\bnever miss (a|another|any)\b|\bmore jobs\b|\bdouble\b|\btriple\b/i, 'overpromise'],
  [/\bAI\b|artificial intelligence|chatgpt|\bgpt\b|machine learning/i, 'AI claim (product is rule-based)'],
  [/(?<!never )\bbooks? (a |the |your )?(job|appointment)s?\b|(?<!never )\bquotes (a |the )?(price|job)/i, 'claims it books or quotes'],
  [/\bwe hear\b|\btradies tell us\b|\bour (data|results)\b/i, 'implied customer evidence'],
  [/\+61|\b0[2-478](\s?\d){8}\b|\b13\d{4}\b|\b1[38]00(\s?\d){6}\b/, 'phone number'],
  [/[\w.+-]+@[\w-]+\.\w+/, 'email address'],
  [/\b(?:https?:\/\/|www\.)(?!tradereach\.net)\S+|\b(?!tradereach\.net)[a-z0-9-]+\.(?:com|net|org|io|co|au)\b/i, 'outside link'],
  [/(^|\s)@\w/, '@mention'],
];

// Numbers that are fine: clock times, temperatures, slide numbers, "000", "6 min ago", hashtags.
const ALLOWED_NUMBERS = /\b\d{1,2}:\d{2}\b|\d+°|\b0\d\b|\b000\b|\b\d+ min ago\b|#\w+/g;

export function textOf(item) {
  const scenes = (item.scenes || []).flatMap((s) => [s.kicker, s.text, s.body, s.small, ...(s.calls || []).flat()]);
  return [item.caption, ...scenes].filter(Boolean).join('\n');
}

export function check(item) {
  const problems = [];
  if (!['reel', 'carousel', 'story'].includes(item.type)) problems.push(`bad type ${item.type}`);
  if (!/^[a-z0-9-]{3,80}$/.test(item.id || '')) problems.push('bad id');
  const n = (item.scenes || []).length;
  const [min, max] = { reel: [3, 8], carousel: [3, 10], story: [1, 3] }[item.type] || [1, 1];
  if (n < min || n > max) problems.push(`${item.type} needs ${min}-${max} scenes, has ${n}`);
  for (const s of item.scenes || []) if (!SCENE_TYPES.includes(s.t)) problems.push(`unknown scene ${s.t}`);
  if (item.type !== 'story') {
    if (!item.caption) problems.push('missing caption');
    if ((item.caption || '').length > 2200) problems.push('caption over 2200 chars');
    if (((item.caption || '').match(/#\w+/g) || []).length > 5) problems.push('more than 5 hashtags');
  }
  const text = textOf(item);
  for (const [re, why] of BANNED) if (re.test(text)) problems.push(`${why}: "${text.match(re)[0]}"`);
  const leftover = text.replace(ALLOWED_NUMBERS, '').match(/\d{2,}/);
  if (leftover) problems.push(`unexplained number: "${leftover[0]}"`);
  return problems;
}

// Rejects near-repeats of past hooks (word overlap), so the feed doesn't say the same thing twice.
const words = (s) => new Set(String(s).toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2));
export function isRepeat(hook, pastHooks, threshold = 0.6) {
  const a = words(hook);
  return pastHooks.some((p) => {
    const b = words(p);
    const inter = [...a].filter((w) => b.has(w)).length;
    return inter / Math.max(1, Math.min(a.size, b.size)) >= threshold;
  });
}
export const hookOf = (item) => item.scenes?.[0]?.text || '';
