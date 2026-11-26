---
name: founderdata-schedule
description: Use when the human wants their agent to work on FounderData every night or every week without being asked, or when a scheduled FounderData run stopped. Sets up Claude Code scheduled tasks, launchd with claude -p, Codex or GitHub Actions, each with a pre-flight that calls get_setup and stops on a broken step.
---

# Make the agent work every night

An unattended run needs a prompt, a key and a scheduler. It also needs a pre-flight that stops the run when the setup is
broken, because an agent working against a broken setup writes wrong notes.

The scheduling paths, their costs and their failure modes are in `docs/GUIDE.md`, "Run an agent on a schedule (Pro)". That
section wins where this file and it differ. This file adds the pre-flight, a launchd recipe and the setup around them.
Read `skills/founderdata-browser/SKILL.md` for the safety contract.

## 1. The prompt  [agent]

Pro, with a plan on the site (`get_plan` answers):

```text
Work on the growth plan for site SITE_ID in FounderData. Call get_plan and do what its guide says. End with log_session.
```

Several sites: one task per site with that site's prompt, so one failure does not stop the others.

Core, or Pro without a plan: a review run.

```text
Call get_setup first. If any step is broken, stop. Otherwise call list_notes with due set to true. For each change that is
due, read the numbers before and after with get_overview and add_note what you found. Change nothing else.
```

That review prompt is not from the guide and was not run: run it once by hand and read the result before you schedule it.

Every prompt also states the pre-flight in words, for schedulers that cannot run a script first: "Call `get_setup` first. If
any step has status `broken`, stop, append one line to `~/.config/founderdata/agent-log.jsonl` naming the step and its
`next`, and end the run."

## 2. A key for the scheduler  [agent]

Make a separate key named `nightly` with the scopes the prompt needs: `read`, `read:revenue`, `notes:write` (core), plus
`research:write` for the plan (Pro). Reuse the snippet in `skills/founderdata-setup/references/agent-connect.md` with that
name and write the result to `~/.config/founderdata/nightly-key` (mode 600). Leave out `spend:seo` and `spend:ai` unless the
human said yes to unattended spend, because those scopes let a scheduled run buy DataForSEO calls or AI checks. Settings,
Agents shows the key's last use, and the human revokes it alone.

## 3. The pre-flight  [agent]

`GET /api/v1/setup` accepts a key with `read` and answers every step with its status. Save this as
`~/.config/founderdata/preflight.sh` (mode 700). It exits 0 when the run may start, 1 on a broken step and 2 when
FounderData is unreachable or refuses the key, and it logs each outcome:

```bash
#!/bin/bash
# FounderData pre-flight: stop a scheduled run when a step is broken.
ORIGIN="https://founderdata.example.com"
KEY_FILE="$HOME/.config/founderdata/nightly-key"
LOG="$HOME/.config/founderdata/agent-log.jsonl"
log() { printf '{"at":"%s","cmd":"preflight","action":"%s","ok":%s}\n' "$(date -u +%FT%TZ)" "$1" "$2" >> "$LOG"; }

state=$(curl -sf -m 20 "$ORIGIN/api/v1/setup" -H "Authorization: Bearer $(cat "$KEY_FILE")") || { log "unreachable or key refused" false; exit 2; }
broken=$(printf '%s' "$state" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log((j.steps||[]).filter(x=>x.status==="broken").map(x=>x.id).join(","))})')
if [ -n "$broken" ]; then log "broken: $broken" false; exit 1; fi
log "ok" true
```

Set `ORIGIN` to the deployment. A non-zero exit means the agent does not start and the human hears about it (the log line and
the scheduler's own failure notice).

## 4. Pick the scheduler  [you choose, agent sets up]

Ask where it should run, using the table in `docs/GUIDE.md`. The Claude app's cloud tasks run while the Mac sleeps. Claude
Code's scheduled tasks run only while the app is open and the Mac awake. GitHub Actions can open pull requests. A launchd
job needs a Mac that is on or wakes.

### Claude Code desktop scheduled tasks

Source: <https://code.claude.com/docs/en/desktop-scheduled-tasks>. In the Claude desktop app, open the **Code** tab, click
**Scheduled**, **New task**, paste the prompt from section 1, pick the project folder and choose **Daily**. It sees the MCP
server you added with `claude mcp add`. **STOP**: the human clicks **Run now**, watches the first run and allows the
FounderData tools (`mcp__founderdata__*`) and nothing broader. The task cannot run a script first, so the prompt's own
first step (section 1) is the pre-flight here.

### launchd with `claude -p`

For a Mac that is mostly on. launchd starts the job at the next wake after a missed time and merges the missed runs into
one (`man launchd.plist`, StartCalendarInterval), where cron skips them. The wrapper
`~/.config/founderdata/nightly.sh` (mode 700):

```bash
#!/bin/bash
# Pre-flight, then one non-interactive Claude Code session. Replace the placeholders.
"$HOME/.config/founderdata/preflight.sh" || exit $?
cd /path/to/your/product-repo || exit 4
export PATH="/path/to/claude/bin:$PATH"
exec claude -p "Work on the growth plan for site SITE_ID in FounderData. Call get_plan and do what its guide says. End with log_session." \
  --allowedTools "mcp__founderdata__*" \
  --permission-prompts none \
  --max-budget-usd 3 \
  --output-format json >> "$HOME/.config/founderdata/nightly-run.log" 2>&1
```

Flags (<https://code.claude.com/docs/en/headless>, `claude --help`): `-p` runs once without a screen, `--allowedTools`
pre-approves the named tools (`mcp__founderdata__*` matches every tool of that server,
<https://code.claude.com/docs/en/permissions>), `--permission-prompts none` denies anything that would wait for a person,
`--max-budget-usd` caps the run and `--output-format json` records `total_cost_usd`. To let the agent edit the repo, add
`Edit` and the narrow `Bash(...)` rules the task needs, never a switch that approves everything. The MCP server must be
visible from the repo folder, so register it with `--scope user` (`agent-connect.md` does).

`~/Library/LaunchAgents/com.example.founderdata-nightly.plist`, the same shape as `scripts/aso-collect.plist.example`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.example.founderdata-nightly</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>/path/to/your-home/.config/founderdata/nightly.sh</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>3</integer>
    <key>Minute</key>
    <integer>17</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>/tmp/founderdata-nightly.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/founderdata-nightly.log</string>
</dict>
</plist>
```

`/path/to/your-home` is the human's home directory, because launchd does not expand `~`. **STOP** before loading: the human
confirms the time and the budget cap. Then:

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.example.founderdata-nightly.plist
launchctl kickstart gui/$(id -u)/com.example.founderdata-nightly      # one test run now
```

The job runs under the human's login: a locked screen is fine, a logged-out Mac is not.

### Codex

Source: `codex mcp add --help` and `codex exec --help` of the Codex CLI. Register the server with the key in the
environment, not on a command line:

```bash
codex mcp add founderdata --url https://founderdata.example.com/mcp --bearer-token-env-var FOUNDERDATA_KEY
```

The scheduled command is a wrapper like the one above: `preflight.sh`, then
`FOUNDERDATA_KEY=$(cat ~/.config/founderdata/nightly-key) codex exec "<the prompt>"` from the repo folder.
`docs/GUIDE.md` notes that scheduled tasks in the ChatGPT desktop app also run Codex while the computer is on. The sandbox
and approval flags for an unattended `codex exec` were not checked: read `codex exec --help` and keep the default sandbox.

### GitHub Actions

The Plan tab's **Copy run-plan.yml** button copies the workflow with the URL and site id filled in (the Pro repository has
it at `pro/examples/agents/run-plan.yml`). Setup, secrets and the two-job design are in `docs/GUIDE.md`. Add the
pre-flight as the first step of the `plan` job, with the key from the `FOUNDERDATA_KEY` secret:

```yaml
- name: FounderData pre-flight
  env:
    FOUNDERDATA_KEY: ${{ secrets.FOUNDERDATA_KEY }}
  run: |
    state=$(curl -sf -m 20 "https://founderdata.example.com/api/v1/setup" -H "Authorization: Bearer $FOUNDERDATA_KEY")
    broken=$(printf '%s' "$state" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{console.log(JSON.parse(s).steps.filter(x=>x.status==="broken").map(x=>x.id).join(","))})')
    if [ -n "$broken" ]; then echo "::error::FounderData setup is broken: $broken"; exit 1; fi
```

The failed step is the log line: the run turns red and GitHub notifies the human. The human adds the secrets
`ANTHROPIC_API_KEY` and `FOUNDERDATA_KEY` themselves (STOP: you never see them).

## 5. Verify  [agent]

- Start one run by hand through the scheduler (Run now, `launchctl kickstart`, or `workflow_dispatch`).
- Pro: the Plan tab shows a session and `get_plan` lists it. Core: `list_notes` shows the run's note.
- `get_setup`: step `schedule` is `done` after the first run that reaches FounderData.
- Settings, Agents shows the `nightly` key's last use.
- Set the plan's `cadence_hours` to the interval you scheduled (`docs/GUIDE.md`). After twice that gap without a session
  FounderData sends the "No plan session" alert, which is the human's reminder.

## What wrong looks like

- Pre-flight exits 1: read the broken step with `get_setup`, fix it with `founderdata-setup` or `founderdata-connect`, then
  rerun. Do not edit the script to skip it.
- Pre-flight exits 2: the Worker is down, or the key was revoked or expired. Check `curl -s ORIGIN/api/auth/me`, then the key
  row in Settings, Agents.
- 401 or 403 from the tools: a wrong or revoked key, or a missing scope (the message names it).
- Nothing runs: a sleeping Mac with the desktop app, a logged-out user for launchd, or a dropped GitHub schedule.
- A tool call waited for approval with no one there: it is not in `--allowedTools`, and `--permission-prompts none` denied it.
