# FounderData vs Peec and Profound

Peec and Profound are AI visibility tools. They track whether ChatGPT, Gemini, Google AI Overviews and other engines name
your brand, and which sources they cite. Peec is the plain, affordable one. It reads the logged-out web interface of each
engine with browser automation, because API answers differ in the number and type of sources. Profound covers the most
engines and adds prompt volumes, a fact check of what engines say about you and bot analytics. Its trial is free, and its
paid plans are Enterprise only.

FounderData asks the engines' APIs with your own keys, so a check is a model with a search tool and not a replay of what a
buyer sees. In exchange it ties AI referrals to customers and revenue. AI visibility is part of FounderData Pro, €99.99 or $99.99 once,
and after that it costs your API bills.

Checked in November 2026. Prices and engine lists come from each vendor's pricing and docs pages, read on 6 November, and
may have changed. FounderData's token and search prices come from providers' pages as of November 2026.

## Side by side

| | Peec | Profound | FounderData |
| --- | --- | --- | --- |
| Price | From $95 a month for 50 prompts on 3 models, daily, which is 4,500 answers a month | Free 7-day trial with 50 prompts on 3 engines, then Enterprise only | Core is free under MIT. AI visibility is in FounderData Pro, €99.99 or $99.99 once. Then about $45 a month in API bills for 50 prompts a day on the three cheapest engines, with a default cap of $20 a site you raise first |
| Engines | ChatGPT, AI Mode, AI Overviews, Copilot, Gemini and Naver. Claude, Grok and others on Enterprise through the API | ChatGPT, Perplexity, Claude, Gemini, Copilot, DeepSeek, AI Overviews, AI Mode and more | OpenAI, Anthropic and Gemini on your keys, plus Google AI Overviews and Perplexity through DataForSEO. Perplexity also runs on its own key, a path that has only run against mocks. The DataForSEO path is the main one. No Copilot, AI Mode, Grok or DeepSeek |
| How answers are collected | Browser automation as a logged-out user | Not disclosed | Each engine's API with web search on. Not a replay of the consumer app |
| Metrics | Visibility, position, sentiment, cited domains and sources, competitors, recommendations | Visibility score, citations, sentiment, fact check, prompt volumes, shopping | Mention rate per engine and prompt, cited domains and URLs, whether your pages are cited, share of voice against competitors, position, positive, neutral and negative counts per engine, this week against last |
| Sentiment | Yes | Yes | Off by default. The AI tab has a Turn on, 20 a day button. Then one model rating per answer that names you, at most 20 a site and day, a fraction of a cent each. We have not measured its accuracy against hand labels |
| Cost when it runs | Flat plan | Enterprise contract | Estimated per check, shown against a monthly cap. AI Overview and DataForSEO Perplexity checks also need room under the DataForSEO cap that rank tracking uses. Your provider's invoice is the truth. Gemini 3.8 Flash doubles its token price on 1 January 2027 |
| History | Not checked | Not checked | Answers are kept 200 days |
| Bots | Not a Peec feature in our research | Agent Analytics. Verifies bots against published IP ranges, per a search summary we could not open | Your server forwards hits from GPTBot, ClaudeBot, PerplexityBot and other AI crawlers. Counts per bot, page and status |
| Revenue | No | No | Visits that arrive from an AI assistant carry customers and revenue, like any source |
| Agents | Not found in our research | Not found in our research | In Pro, MCP `get_ai_answers` with views for visibility and sentiment. Agents can add prompts with a key that has the `spend:ai` scope |

## What FounderData does not do

- **No replay of the consumer apps.** Answers come from APIs, which differ by account, location and day. Treat one day as
  noise and read the trend. Peec scrapes the logged-out interface for this reason.
- **No verified bot IPs.** FounderData never receives an IP address. Your server can check the IP and send `verified:
  false` on hits that fail. A user agent alone is only a claim.
- **No table of crawler hits by citation by revenue.** Crawler hits, cited pages and AI-referred revenue are separate
  views. You join them yourself.
- **No prompt volume data, no recommendations and no fact check.** A check lists factual errors an agent pushed, and the
  runner does not hunt for them.
- **No confidence range.** The docs warn that one day is noise. Nothing puts an interval on 50 prompts.
- **200 days of history.** A year-on-year share of voice for a board deck is out of reach.
- **Five engines, not ten.** Copilot, AI Mode, Grok and DeepSeek are missing.
- **Costs are not flat.** Turning on all three cheap engines passes the default $20 cap. The cap is soft, and prices
  change. AI Overview and DataForSEO Perplexity checks stop when either the AI cap or the DataForSEO cap is full, so a
  busy month of AI checks can pause rank tracking unless you raise the DataForSEO cap too.
- **A large MCP tool set,** with a pasted key.

## Moving over

There is no import from Peec or Profound. Their history stays with them. Start the runs, and run both for 14 days on your
own prompts before you cancel.

1. Add your prompts, brands and competitors in the AI visibility tab, with your own engine keys as Worker secrets. See
   [Set it up](../AI-VISIBILITY.md#set-it-up).
2. Turn on Google AI Overviews and Perplexity with your DataForSEO login. Settings, Setup checklist has a Test button for
   the login. See
   [Google AI Overviews](../AI-VISIBILITY.md#google-ai-overviews) and [Perplexity](../AI-VISIBILITY.md#perplexity).
3. Raise the monthly cap, and the DataForSEO cap, before you turn on every engine. See [Cost](../AI-VISIBILITY.md#cost).
4. If you want sentiment, press Turn on, 20 a day in the AI tab.
5. Forward crawler hits from your server if you want bot counts. See
   [AI crawler hits](../AI-VISIBILITY.md#ai-crawler-hits).
6. Connect Stripe and add the tracker. Visits from ChatGPT and other assistants then appear as sources, with their customers and revenue.
7. If your prompts live in a spreadsheet, push them with `add_ai_prompts` or
   [`POST /api/v1/ai-prompts`](../API.md#ai-visibility-pro).
