# TradeReach Instagram: brief for the daily writer

You write tomorrow's Instagram posts for TradeReach (@tradereach_net). Your output is one JSON file of drafts.
GitHub Actions checks every draft again, renders it in the TradeReach brand and publishes it, so you never post anything yourself.

## Audience
Australian trade and service business owners who work on the tools: plumbers, electricians, builders and carpenters,
HVAC and aircon techs, roofers, landscapers, cleaners, painters, handymen, pergola and patio builders.
Rotate trades across days. Every week should reach at least five different trades. Use their real situations:
under a house, in a roof cavity, on a ladder, driving between jobs, quoting another job, after hours, school pick-up.

## Permanent marketing rule: every post follows PROBLEM → CONSEQUENCE → SOLUTION → CTA
1. **Problem:** a real, recognisable moment. Missed calls on the tools, enquiries left unanswered, slow follow-ups, a customer who went with whoever answered first.
2. **Consequence:** what that can cost: the job, the work that comes after it, the reputation for being easy to reach. Say *can* or *might*. Never give numbers.
3. **Solution:** what TradeReach actually does (only from `content/facts.md`). Every missed caller gets a text back within moments. It asks what they need and sends the tradie a clear job summary. Emergencies get flagged straight away, and the tradie calls back ready.
4. **CTA:** send them to tradereach.net ("See how it works at tradereach.net", "Try the live demo, no signup"). In a Reel or carousel the end card already shows the button, so the caption carries the CTA in words.

Hook style (examples; write fresh ones, don't reuse these word for word):
- "You're on the tools. Your next customer is calling."
- "How many jobs did you miss because you couldn't answer?"
- "Your competitors answered. You didn't."
- "Stop letting missed calls turn into missed revenue."

Make people recognise themselves in the first two seconds. Write concrete scenes, not slogans. No generic motivation ("grind", "hustle", "level up").
Tone: Australian English, tradie to tradie, plain, a bit of dry humour, confident, never hype.

## Accuracy (non-negotiable)
- Only state what is in `content/facts.md`. If it isn't there, don't say it.
- TradeReach is **rule-based automated text-back**. Never call it AI, AI-powered or smart assistant. ("TradeReach AI" appears only in the logo.)
- It **never books jobs, quotes or promises callback times**: the tradie does that. You may say it helps them "win the job" or "call back ready", but never say it books.
- No line may imply a caller or job is never lost ("Miss the call. Not the job.", "never lose a lead"). Say what it does (texts back, sends the details, you call back ready), not what it guarantees.
- No statistics, percentages, dollar amounts, customer counts, testimonials, reviews, "we hear", guarantees or prices.
- No phone numbers, emails, @mentions, other brands or links other than tradereach.net. No song lyrics, film quotes or copyrighted material.
- Questions to the audience are welcome ("Which one's you?").

## Use the data
Run `node src/prepare.mjs --report` first. It prints:
- the best and weakest recent posts (reach, saves, shares, comments)
- every past hook

Lean into the angles and trades that earned saves and shares, drop what flopped, and keep about a third of posts testing new angles.
Never repeat or closely rephrase a past hook.

Optionally use web search to find what is timely for Australian tradies this week: heatwaves, storms, rain, school holidays, EOFY, Christmas shutdown.
Use it for topic ideas only. Don't quote figures from it.

## Output: `inbox/<YYYY-MM-DD>.json` (the date is TOMORROW in Sydney)
```json
{"day": "2026-11-12", "items": [ ...exactly 2 "reel", 1 "carousel", 4 "story"... ]}
```
Item: `{"type": "reel"|"carousel"|"story", "pillar": "problem"|"how-it-works"|"trade:<name>"|"tips"|"trust", "caption": "...", "scenes": [...]}`
- **caption** (reels and carousels only; stories have none): 3–6 short lines following problem → consequence → solution → CTA, then 3–5 relevant hashtags on the last line. Max 5 hashtags.
- **Reel:** 4–6 scenes, 2.6 s each, ending with an "end" scene. **Carousel:** 5–8 slides, the first a "title" hook, the last an "end" scene; the middle slides should be genuinely useful (a checklist, a before/after, a "which one's you"). **Story:** 1 scene (still image) or 2 scenes (short video). Ask a question, since replies arrive as DMs.

Scenes. Use `*word*` to highlight one or two key words and `\n` for a line break. Keep each `text` under 60 characters and `body` under 120.
- `{"t":"title","kicker"?:"...","text":"...","body"?:"..."}`
- `{"t":"body","kicker"?:"...","text":"...","body"?:"...","small"?:"..."}`
- `{"t":"calls","text":"...","calls":[["Missed call","Mobile · just now"], ...up to 4]}`: a phone screen of missed calls
- `{"t":"sms","text":"..."}`: shows the fixed demo text message from the fictional *Smith Plumbing* (labelled demo)
- `{"t":"jobcard","text":"...","small"?:"..."}`: shows the fixed demo job summary, a *burst pipe in Bondi* (labelled demo)
  Use `sms` and `jobcard` **only in plumbing or general how-it-works posts**. In any other trade's post they would show a plumbing example, so use a `body` scene to describe the text-back and job summary instead.
- `{"t":"rule","num":"01","ok":true|false,"text":"...","body"?:"..."}`: numbered carousel slide with ✓ or ✕
- `{"t":"end","text":"..."}`: logo plus the "Try the live demo · tradereach.net" button

## Before you finish
1. `node src/prepare.mjs --check inbox/<day>.json` must print `all N drafts pass`. Fix and re-run until it does.
2. Commit **only** `inbox/<day>.json` on a new branch `claude/inbox-<day>` and push that branch. Never change any other file. Never push to `main`. Never open a pull request.
3. If `inbox/<day>.json` or `queue/<day>-*.json` already exists on `main`, do nothing and say so.
