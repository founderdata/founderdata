# Set up FounderData with your agent

Your coding agent (Claude Code, Codex, Cursor) can set FounderData up for you. It deploys to your Cloudflare account,
adds your sites, installs the tracker in your code, connects your payment provider and connects itself. You sign in where
a provider needs you, paste secrets into a page the agent never sees, and say yes before anything costs money.

Paste this into your agent, in an empty folder:

```text
Set up FounderData for me. Clone https://github.com/founderdata/founderdata and follow skills/founderdata-setup/SKILL.md.
```

The agent reads the skills in this repository's `skills/` folder. If you already cloned it, say "follow
`skills/founderdata-setup/SKILL.md`" instead.

## What the agent asks first

One message, answered once:

- Which websites and apps, and where their code is on your machine.
- **EU only, or anywhere.** This is yours to choose and cannot change after the database exists
  ([PRIVACY.md](PRIVACY.md)).
- Which payment provider each product uses.
- Whether you have FounderData Pro or want it later.

Then it shows a plan: every step, who does it, how long it takes and what it costs. Nothing changes until you say yes.

## Who does what

| Step | The agent | You | Takes |
| --- | --- | --- | --- |
| Deploy to Cloudflare | creates the database, deploys the Worker, checks it | log in to Cloudflare once (`npx wrangler login`) | 5 min |
| Add your sites | creates them and keeps their ids | nothing | 3 min |
| Install the tracker | edits your code on a branch, runs your tests | deploy your site, or tell the agent to | 10 min a product |
| Install the iOS SDK | links the package in Xcode, wires the code | run the app once on a device or simulator | 10 min |
| Connect payments | creates the webhook where it can, drives the provider's console | sign in, paste the signing secret into the paste page | 10 min a provider |
| Check revenue attribution | watches for the first linked payment | make one cheap purchase and refund it (your money, your yes) | 5 min |
| Connect the agent | makes a scoped key, adds the MCP server | restart the agent session once | 2 min |
| Pro growth steps | connects Search Console, keyword ranks, AI answers and more, one by one | sign in, paste, agree each cost | 5 to 15 min each |
| A nightly run | writes the schedule and a pre-flight | confirm the time and the budget cap | 10 min |

The times are budgets the skills hold the agent to, not measurements. Core should take well under an hour, most of it
waiting for a deploy and your first visit. Setup is not "done" when a
secret is saved. A step reads done only after a real signal: a first visit, a first payment linked to a visit, a first
Apple notification. Until then it reads waiting, and the agent says what ends the wait. The dashboard's setup checklist and
`get_setup` show the same state.

## How secrets work

A secret never goes through the agent. When a provider needs a signing secret or key, the agent runs
`npm run connect -- <provider>`. That opens a page on your own machine (127.0.0.1, one-time link, closes after one paste or
10 minutes) that names the provider, links the page where the value lives and has one field. You paste, it stores the
value, and the agent learns only that the secret is set. Apple's `.p8` key goes through `--watch-downloads` or `--file`.
You can also type a value in the terminal with `--stdin`.

## The safety contract

Every skill holds the agent to these rules (`skills/founderdata-browser/SKILL.md`):

1. It shows the plan, every command and click in order, before it changes an account.
2. It never reads, prints, types or logs a secret.
3. It never deletes anything, changes billing, DNS or the permissions of an existing key, or does what is not in the plan.
4. Spend and production data need your yes: a paid API call, a live test payment, a cost cap.
5. It writes each action to `~/.config/founderdata/agent-log.jsonl`, without secret values. Read it any time.
6. It tells you which steps are safe to run again. Most are: `npm run setup`, `scripts/setup-sites.mjs` and
   `npm run connect` keep your data and change only what you name. A webhook created in a provider is the exception, so
   the agent checks the provider's list before it makes another.

## Commands

You rarely type these. The agent runs them, and you can too.

| Command | What it does |
| --- | --- |
| `npm run doctor` | Read-only check of Node, Wrangler login, config, the deployed Worker and every setup step. `-- --json` for a machine answer |
| `npm run setup -- --dry-run --region <eu\|auto>` | Prints every action setup would take and changes nothing |
| `npm run setup -- --region <eu\|auto>` | Deploys. A new database needs the region decision |
| `node scripts/setup-sites.mjs <url>` | Creates or updates the sites in `sites.json` |
| `npm run connect -- <provider> --site <id>` | The paste page for one provider's secret |
| `get_setup` (MCP tool) or `GET /api/v1/setup` | The setup steps with their status and the one next step |

Exit codes of `doctor`, `setup` and `connect`: 0 done, 1 something to do, 2 needs a decision, 3 needs you (a login), 4 error.

## What the skills cover

| Skill | For |
| --- | --- |
| `founderdata-setup` | The whole run, from deploy to a connected agent |
| `founderdata-connect` | One file per provider: Stripe, Dodo, Lemon Squeezy, Polar, Paddle, Gumroad, RevenueCat, the App Store, Resend, Cloudflare, Search Console, DataForSEO, AI engines, Meta ads, X, Apple Search Ads and App Store Connect sales |
| `founderdata-browser` | The safety contract, and how the agent drives web consoles (agent-browser) and Mac apps such as Xcode (agent-desktop) |
| `founderdata-schedule` | Make the agent work every night, with a pre-flight that stops on a broken setup |

The Pro providers (Search Console, DataForSEO and the rest) need FounderData Pro ([PRO.md](PRO.md)). In core they show as
locked, with what they would give you.

## If something goes wrong

- The agent stops at a sign-in or a code: that is a step for you. It says what to do and waits.
- `npm run doctor` says what is wrong and gives the next command.
- A step says `broken`: the agent reads its skill's "what wrong looks like" and fixes it, or hands you the one click.
- Google's Testing status expires your Search Console login after 7 days. The skill sets the app to In production first
  ([SEO.md](SEO.md#connect-google)).
- Start over safely: run the same prompt again. The agent reads the state and continues at the next step.
