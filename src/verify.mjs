// Read-only check of the Meta token: validity, expiry, permissions and access to @tradereach_net.
// Never prints the token. Run with the token taken straight from the macOS Keychain:
//   META_ACCESS_TOKEN="$(security find-generic-password -s tradereach-social-meta -w)" node src/verify.mjs
const token = process.env.META_ACCESS_TOKEN;
const V = process.env.GRAPH_VERSION || 'v23.0';
const USERNAME = 'tradereach_net';
const REQUIRED = ['instagram_basic', 'instagram_content_publish', 'pages_show_list', 'pages_read_engagement'];
const WANTED = ['instagram_manage_insights']; // for results tracking; publishing works without it

if (!token) { console.error('No token found in the Keychain item "tradereach-social-meta".'); process.exit(1); }

async function get(path, params = {}) {
  const res = await fetch(`https://graph.facebook.com/${V}/${path}?${new URLSearchParams({ ...params, access_token: token })}`);
  const json = await res.json().catch(() => ({}));
  if (json.error) throw new Error(`${json.error.type || 'error'} ${json.error.code}: ${json.error.message}`); // Meta errors never echo the token
  return json;
}

let ok = true;
const line = (pass, msg) => { console.log(`${pass ? 'PASS' : 'FAIL'}  ${msg}`); if (!pass) ok = false; };
const note = (msg) => console.log(`NOTE  ${msg}`);

try {
  const { data: d } = await get('debug_token', { input_token: token });
  line(d.is_valid, `token is valid (type ${d.type}, app ${d.application || d.app_id})`);
  note(d.expires_at === 0 ? 'token does not expire' : `token expires ${new Date(d.expires_at * 1000).toISOString()}`);
  const scopes = d.scopes || [];
  for (const s of REQUIRED) line(scopes.includes(s), `permission ${s}`);
  for (const s of WANTED) if (!scopes.includes(s)) note(`permission ${s} missing: results tracking will be limited`);
  const extra = scopes.filter((s) => /ads_management|business_management|pages_manage|publish_video|ads_read/.test(s));
  if (extra.length) note(`token also has broader permissions it doesn't need: ${extra.join(', ')}`);

  const { data: pages = [] } = await get('me/accounts', { fields: 'name,instagram_business_account{id,username}' });
  note(`Pages this token can see: ${pages.map((p) => p.name).join(', ') || 'none'}`);
  const page = pages.find((p) => p.instagram_business_account?.username === USERNAME);
  line(!!page, `@${USERNAME} is linked to a Page${page ? ` (${page.name})` : ' (Page shows no instagram_business_account)'}`);
  let ig = page?.instagram_business_account.id;
  if (!ig) { // fall back to the business portfolio that owns the Page
    for (const p of pages) {
      const { business } = await get(p.id, { fields: 'business{id,name}' });
      if (!business) continue;
      const { data = [] } = await get(`${business.id}/owned_instagram_accounts`, { fields: 'id,username' });
      ig = data.find((a) => a.username === USERNAME)?.id;
      if (ig) { note(`@${USERNAME} found via business portfolio "${business.name}"`); break; }
    }
  }
  line(!!ig, `token can reach @${USERNAME}`);
  if (ig) {
    const acct = await get(ig, { fields: 'username,followers_count,media_count' });
    note(`Instagram user ID ${ig} (not secret; goes in IG_USER_ID): @${acct.username}, ${acct.followers_count} followers, ${acct.media_count} posts`);
    const { data: [lim] = [] } = await get(`${ig}/content_publishing_limit`, { fields: 'quota_usage,config' });
    line(!!lim, `publishing quota readable${lim ? `: ${lim.quota_usage} used of ${lim.config?.quota_total} per 24 h` : ''}`);
  }
} catch (err) {
  line(false, err.message);
}
console.log(ok ? '\nAll checks passed. Nothing was posted.' : '\nSome checks failed. Nothing was posted.');
process.exit(ok ? 0 : 1);
