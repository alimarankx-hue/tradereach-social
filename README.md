# TradeReach Instagram autopilot

Kept separate from every other project: it shares no servers, keys or code with them.

Every 30 minutes, GitHub Actions:
1. **Takes tomorrow's drafts.** A daily Claude scheduled task (1:30 pm Sydney) follows `content/WRITER.md` and `content/facts.md`. It pushes `inbox/<day>.json` to a `claude/inbox-<day>` branch. Actions copies only that file, then deletes the branch. Each draft must pass the claim guard (`src/guard.mjs`), a repeat check and a test render, or it's dropped.
2. **Publishes due posts** through Meta's Graph API (`src/publish.mjs`). Daily caps: 2 Reels, 1 carousel and 5 Stories. Retries never create duplicates.
3. **Collects insights** into `state/insights.json`. Tomorrow's plan leans towards what performed best.

## Emergency stop (any one of these works)
- GitHub → repo → Settings → Secrets and variables → Actions → Variables → set `PUBLISHING_ENABLED` to `false`.
- Add a file named `STOP` to the repo root (works from the GitHub mobile app).
- Actions tab → "TradeReach Instagram" → ⋯ → Disable workflow.

## Alerts
A run fails, and GitHub emails you, when:
- a post is blocked or fails 3 times
- the Meta token stops working
- fewer than 3 items pass the checks for tomorrow

Details are in the Actions log and `state/ledger.json`.

## Secrets (repo → Settings → Secrets → Actions)
- `META_ACCESS_TOKEN`: the Meta system-user token (no expiry). The run fails and emails you if it stops working.
- `IG_USER_ID`: the Instagram account ID linked to the TradeReach Page.

## Local
- `node --test test/*.test.mjs`: runs the tests (no network).
- `KEEP_FRAMES=1 node src/render.mjs content/samples/*.json`: renders the samples to `out/`.

## Limits
- Topic research uses web search for timely ideas only; figures are never quoted.
- The guard catches common bad claims, but it can't prove a sentence is true. Keep `content/facts.md` accurate.
- Reels are animated text with no voiceover or music. Instagram's API only supports original audio.
- Website visits and leads are tracked only as profile link taps. TradeReach production is deliberately not touched.
