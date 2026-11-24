# AI engines (Pro)

## Unlocks

How often ChatGPT, Claude, Gemini and Perplexity name the site when asked the questions a buyer would ask, with
competitors, position and sentiment (AI visibility tab, `get_ai_answers`). Step id `ai-engines`. Needs a `pro/` folder.

## Cost

The owner's own provider accounts bill each check. Estimates from `docs/AI-VISIBILITY.md` (November 2026 prices, unverified):
about $0.011 a check on `gpt-6-luna` or `claude-haiku-5-5`, $0.031 on `claude-sonnet-5-5`, so about $16.58 a month for 50
prompts a day on one cheap engine and about $45 for the three cheapest together. The site's monthly cap defaults to $20, and
0 pauses the runs. **Raise or set the cap only with the human's yes**, and use a key with a spend limit at the provider.

## Needs

One key is enough. Any of `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `PERPLEXITY_API_KEY`. Google AI Overviews
and Perplexity also run through the DataForSEO login (`dataforseo.md`).

## Fastest path  [browser, you]

1. Ask which engines. Say the cap math above. Wait for a yes.
2. For each engine, the human creates a key at the provider (their usual console: OpenAI platform, Anthropic Console,
   Google AI Studio, Perplexity settings) **with a monthly spend limit**. You open the page with
   `agent-browser --headed` and wait. **STOP** at sign-in and at the key, which shows once. Provider page layouts are not in
   this repository: snapshot and follow them.
3. `npm run connect -- ai-engines` opens a paste page with a field per engine. The human fills the ones they chose and
   leaves the rest.
4. In the AI visibility tab the **human** turns the engine on for the site, picks the model and sets the monthly cap. Only
   the dashboard login changes engines, models and the cap.
5. [agent] Prompts: a key with `spend:ai` adds them (`add_ai_prompts` or `POST /api/v1/ai-prompts` with
   `{"prompts":[...],"competitors":[...]}`). Each prompt then costs money on every enabled engine every day. Propose 10 to
   20 buyer questions, show them with the daily cost, wait for a yes. A site keeps 100.
6. Names: the brand and competitors (with aliases and exclusions, up to 20 each) in the tab. Competitors can ride in the
   `add_ai_prompts` call.

## Connect command

```bash
npm run connect -- ai-engines
```

## Verify

`ai-engines`: `waiting` until the first check, `done` after it. The first check runs within the hour. The panel shows each
engine's last error until a later run succeeds. `get_ai_answers` returns rows with `engine` and `cost_usd`.

## What wrong looks like

- The panel shows a rejected key for an engine: that key is wrong, expired or out of quota. Paste it again.
- Runs stop mid-month: the cap was reached (one check can end a little over it).
- The setup checklist row says some of an integration's secrets are missing: a deployment needs one engine key, not all.
