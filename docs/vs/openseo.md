# FounderData vs OpenSEO

OpenSEO is an open-source (MIT) SEO research tool, also hosted, built around DataForSEO. It is strong at keyword research
that costs cents, rank tracking with schedules, backlinks, its own site crawler and an MCP server with OAuth and agent
skills. It runs on the same stack as FounderData, Cloudflare Workers and D1, or in Docker.

FounderData is analytics and revenue. Its SEO tab, in FounderData Pro, €99.99 or $99.99 once, tracks Google ranks and Search Console too, and its edge is that
search ties to visits, customers and revenue. Many people run both.

Checked in November 2026. OpenSEO figures come from its README, release notes and pricing page, read on 6 November. They
may have changed.

## Side by side

| | OpenSEO | FounderData |
| --- | --- | --- |
| Hosting and license | MIT. Hosted, Docker, or Cloudflare | Core is MIT. The SEO tab, rank tracking and AI visibility are in FounderData Pro, €99.99 or $99.99 once. Cloudflare Workers and D1 only |
| Hosted price | $10, $30 and $100 a month, including $10, $36 and $120 of usage. The hosted plan adds 28% to DataForSEO calls | No hosted plan |
| Data provider | Your DataForSEO key. Self-hosters pay DataForSEO directly | Your DataForSEO login, for ranks and research. Your own keys for AI engines |
| Keyword research | About $0.05 a search on the hosted plan. Intent badges, wildcards, city volume | Suggestions with volume and difficulty, and the keywords a domain ranks for. Each costs DataForSEO's price per call and is cached 30 days in the research log |
| Rank tracking | Scheduled by day and time, up to 1.5 cents per keyword per check | Up to 200 keywords a site, one check a day on DataForSEO. An estimated $3.60 to $7.20 a month at 10 or 20 results, and $15.60 to $19.20 with the AI Overview flag on. DataForSEO prices in our docs are unverified estimates |
| Rank history | Per tracker | 400 days |
| Search Console | Your Google OAuth client. GA4 also | Your Google OAuth client. 16 months of queries. The top 40 queries and 40 pages by clicks and by impressions are kept per day, not your whole long tail |
| Cannibalization | Not found in our research | A view of queries that two of your pages share, over 28 days |
| Site audit | Its own crawler, with JavaScript rendering. On the Cloudflare free plan audits stop at about 40 pages | No crawler. A Page audit reads a file your crawler pushes, up to about 5,000 URLs |
| Backlinks | Referring domains, new and lost, about $0.08 a domain overview | Stores a `backlinks` part you push. It collects nothing |
| AI visibility | ChatGPT, Claude, Gemini, Perplexity and AI Overviews, about $0.002 a check, labelled beta | OpenAI, Anthropic, Gemini, Perplexity and Google AI Overviews, with optional sentiment, share of voice and cited pages. A check costs about $0.008 to $0.033 by our estimate |
| Analytics tie-in | GA4 only. Open requests for Plausible, PostHog and Umami | Its own visits, customers and revenue, for every page and AI referral |
| Agents | About 40 MCP tools, OAuth sign-in, skills for audits, clustering and reports, plugins for Claude, Codex and Cursor | In Pro, 39 MCP tools behind a pasted `fdk_` key, twelve workflows served as MCP prompts and a research log. Chart notes that agents review |
| Reports | Saved agent reports, PDF, public share links | A weekly report, a research log, a share link. No PDF |
| Local SEO, IndexNow, Lighthouse | Yes | No. Core Web Vitals come from your real visitors |

## What FounderData does not do

- **No crawler.** Pushing your own crawler's output is the only audit path. OpenSEO crawls for you.
- **No backlink collection** and no competitor domain overview beyond the keywords a domain ranks for.
- **No SERP features, no IndexNow, no local rank grids, no Lighthouse runs.**
- **No keyword history import.** Keywords come in as a CSV list, and ranks start at zero on the day you add them.
- **Search Console keeps the top of the tail.** If your site has thousands of queries a day, the rest are missing from the
  decay and opportunities views.
- **Setup takes an afternoon.** Connect Google needs your own Google Cloud project, an exact redirect URI and two secrets.
  A project left in Testing mode logs you out every 7 days. The backfill takes about two days. The setup checklist tests
  the DataForSEO login and shows any country DataForSEO refuses. A new keyword gets its first rank within about 15 minutes,
  because the cron runs every 5 minutes. 200 keywords take about 170 minutes to come back on the free plan.
- **No MCP OAuth.** Your agent holds a key.
- **A large MCP tool set,** and it loads before an agent reads a number.
- **Costs are estimates.** DataForSEO's prices are not verified in our docs. The monthly cap is soft, and the default of
  $10 a site stops about day 15 with 200 keywords and the AI Overview flag on.

## Moving over

1. Deploy FounderData and add the site. See the [README](../../README.md#install).
2. **Connect Search Console** in the SEO tab. See [Connect Google](../SEO.md#connect-google). Or run `scripts/gsc-sync.mjs`
   from your machine, which needs no OAuth client and pushes 90 days. See [Sync Search Console](../SEO.md#sync-search-console).
3. **Add your keywords** with a CSV import, one `keyword` column, in the Google ranks view. See
   [Keyword research and rank tracking](../SEO.md#keyword-research-and-rank-tracking). Export them from OpenSEO's Saved
   Keywords as CSV first.
4. Add DataForSEO as two Worker secrets. Use the same account OpenSEO used if you like.
5. Keep OpenSEO for its crawler and research, or run both MCP servers, OpenSEO for research and FounderData for traffic,
   revenue and verdicts.
