# Make the agent key and connect the MCP server

For `[agent]` step 7 of `founderdata-setup`. The key is a secret: it is made and stored inside one shell command, and you
never see it. Sources: `docs/API.md` ("API keys", `POST /api/v1/keys`) and `docs/MCP.md` ("Connect").

## Pick the scopes

| Edition | Scopes | Why |
| --- | --- | --- |
| Core | `read`, `read:revenue`, `notes:write` | read every tool, see money, log changes with `add_note` |
| Pro, plan agent | `read`, `read:revenue`, `notes:write`, `research:write` | adds the plan, research log and keyword tracking |

Add `spend:seo` or `spend:ai` only when the human has said yes to that spend, because those scopes let the agent buy
DataForSEO calls or run AI checks on their accounts. One key for all sites unlocks `get_portfolio`. A key per agent, named
after the agent (`claude-code`, `codex`), shows up as its own row in Settings, Agents.

## Make it, store it, register it  [agent]

`POST /api/v1/keys` needs the dashboard login, so sign in with the saved password and send the request in one command.
The secret goes to a file with mode 600 and to the MCP registration, never to your output.

```bash
ORIGIN=https://founderdata.example.com
umask 077; mkdir -p ~/.config/founderdata
JAR=$(mktemp)
curl -s -c "$JAR" -X POST "$ORIGIN/api/auth/login" -H 'content-type: application/json' \
  -d "{\"password\":\"$(cat ~/.config/founderdata/admin-password)\"}" >/dev/null
curl -s -b "$JAR" -X POST "$ORIGIN/api/v1/keys" -H 'content-type: application/json' \
  -d '{"name":"claude-code","scopes":["read","read:revenue","notes:write"],"sites":["*"]}' \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const k=JSON.parse(s).key;if(!k){console.error("no key in the answer");process.exit(1)}require("fs").writeFileSync(process.env.HOME+"/.config/founderdata/agent-key",k)})'
rm -f "$JAR"
test -s ~/.config/founderdata/agent-key && echo "key saved"
```

`sites` takes a list of ids, or `["*"]` for every site, including ones added later. Run it once: each call makes another
key (a deployment holds 50). To replace a lost key, the human revokes the old row in Settings, Agents.

Register the server by name with the header read from the file at registration:

```bash
# Claude Code
claude mcp add --scope user --transport http founderdata "$ORIGIN/mcp" --header "Authorization: Bearer $(cat ~/.config/founderdata/agent-key)"
# Codex (reads the token from an environment variable named in the config)
codex mcp add founderdata --url "$ORIGIN/mcp" --bearer-token-env-var FOUNDERDATA_KEY
```

`--scope user` makes the server available in every folder. The default scope, local, ties it to the folder you ran the command in. Claude Code stores the header in its own config file, so the key exists there too. That is the cost of a header-based MCP
server. Cursor and VS Code take the same URL and header in `.cursor/mcp.json` or `.vscode/mcp.json`
(`docs/MCP.md`, "Connect"): write the file with the key read from `agent-key` by a shell command, and keep the file out of git.
For Codex, the schedule needs `FOUNDERDATA_KEY` in its environment: `founderdata-schedule` covers it. A client that only
runs local commands can use `npx mcp-remote` as in `docs/MCP.md`.

Log it: `fd_log "agent-key" "made the claude-code key, scopes read read:revenue notes:write" true`.

## Restart

A running session does not pick up a server added after it started. Tell the human:

> I added FounderData to your agent's MCP servers. Quit this session and start a new one in the same folder, then say
> "continue the FounderData setup". I will not remember this chat, but the setup state lives in FounderData.

The new session runs `whoami`, then `get_setup`, and carries on at the step in `next`. Verify: `get_setup` shows `agent-key`
`done`, and `agent-used` `done` after that first call. If the tools are missing after the restart, run
`claude mcp list` (or the client's equivalent) and check the server is listed and not `failed`. A 401 means the key file
and the registered header differ: ask the human to revoke the key in Settings, Agents, and make it again.

## Check from a terminal

```bash
curl -s "$ORIGIN/mcp" -H "Authorization: Bearer $(cat ~/.config/founderdata/agent-key)" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"whoami","arguments":{}}}'
```

Expect the key's scopes and sites, with no secret in the answer.
