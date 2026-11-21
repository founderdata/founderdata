-- Today (FounderData Pro: pro/worker/today/, docs/MOBILE-API.md "Today", docs/MCP.md "mail"): one list across all sites
-- of what needs the owner. Reply cards come from mail an agent flagged, or a buyer's mail nobody answered in 24 hours.
-- Decide cards are the open questions on owner tasks (migration 0081). Fix cards are states that are broken now, read
-- from tables that exist already, so they need no table here. Core holds the tables, as for every Pro feature. Core
-- never writes them. Times are ms since the epoch.
--
-- Rows each path writes (pro/test/cost.test.ts pins them, the README cost table lists them). No table has an index
-- besides its key, so an insert or an update is 1 row.
--   an agent flags a thread (or decides it needs no answer)   2: the flag and its log row
--   an agent saves a draft                                    2: the draft and its log row
--   the owner sends a Reply card                              the reply's own rows (pro/worker/mail/send.ts) + 2: the
--                                                             log row, written before the send so a second send of
--                                                             the same card is refused, and its result after
--   the owner taps Not needed                                 1
--   the owner mutes a Fix card for 24 hours                   1
--   the owner changes the Today settings                      1
--   the 08:00 Today push                                      1 (its day in scheduled_pushes), whatever the phones
--   the push for a critical Fix as it starts                  1 per tick that finds new ones (cron_state
--                                                             'today:fix-push'), 0 when none started
--   the nightly cleanup                                       1 per log row past 90 days and per mute past its end

-- An agent's decision about the newest received message of a thread, and the owner's Not needed. One row per thread:
-- a later decision replaces it.
--   message_id    the received message the decision is about, message_at its created_at. A later received message
--                 waits for a new decision.
--   important     1: the owner must answer, the thread is a Reply card. 0: the agent decided it needs no answer from
--                 the owner, or the owner tapped Not needed on a card no agent flagged.
--   reason        one line: why the owner must answer. Plain text, at most 300 characters.
--   checked       JSON [{ "label": "Orders", "value": "#1042 and #1043, $29 each" }]: what the agent looked up, at most
--                 8 pairs, labels of at most 40 characters, values of at most 200.
--   promises      one line naming every promise the draft makes, such as "Promises a refund of $29", or NULL.
--   flagged_by    the name of the API key that wrote the decision, NULL for the owner's Not needed.
--   dismissed_at  the owner's Not needed. It covers the received messages up to that time. A newer one opens the card
--                 again.
CREATE TABLE mail_flags (
  thread_id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  message_at INTEGER NOT NULL,
  important INTEGER NOT NULL,
  reason TEXT,
  checked TEXT,
  promises TEXT,
  flagged_by TEXT,
  flagged_at INTEGER NOT NULL,
  dismissed_at INTEGER
) WITHOUT ROWID;

-- One plain-text draft per thread, written by an agent while the owner has Agent drafts on. The draft answers one
-- received message: it is shown only while that message is the thread's newest received one, and its reply goes to
-- that message's sender and nobody else.
--   message_id   the received message the draft answers
--   to_addr      that message's From address, lowercased
--   text         the draft, plain text, at most 10,000 characters, control characters removed
--   new_links    JSON list of the links in the draft that appear in no message of the thread (the 20 newest), worked
--                out when the draft is saved
--   written_by   the name of the API key that saved it
CREATE TABLE mail_drafts (
  thread_id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  to_addr TEXT NOT NULL,
  text TEXT NOT NULL,
  new_links TEXT NOT NULL DEFAULT '[]',
  written_by TEXT NOT NULL,
  written_at INTEGER NOT NULL
) WITHOUT ROWID;

-- Fix cards the owner muted. A mute ends at `until` (24 hours after it was set), or earlier when the state recovers:
-- it holds only while the card's `since` is still `since` here, so a state that recovers and breaks again shows.
--   key    the Fix card's key, such as webhook_refused:SITE_ID:stripe
CREATE TABLE today_mutes (
  key TEXT PRIMARY KEY,
  since INTEGER NOT NULL,
  until INTEGER NOT NULL,
  muted_at INTEGER NOT NULL
) WITHOUT ROWID;

-- The owner's Today settings, one row (id 1). No row reads as the defaults: every card kind on, Agent drafts off, the
-- 08:00 push on.
--   reply, decide, fix   1 shows that card kind in the list, the counts and the pushes
--   agent_drafts         1 lets agents save drafts. Off, the save is refused.
--   push                 1 sends the 08:00 push "N things need you" when a Reply or critical Fix card waits
CREATE TABLE today_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  reply INTEGER NOT NULL DEFAULT 1,
  decide INTEGER NOT NULL DEFAULT 1,
  fix INTEGER NOT NULL DEFAULT 1,
  agent_drafts INTEGER NOT NULL DEFAULT 0,
  push INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);

-- What agents wrote and what the owner sent from a card, for the owner to read (GET /api/today/log). Kept 90 days, and
-- deleted with its thread.
--   kind      flag, draft or send
--   actor     the API key's name for flag and draft, phone or dashboard for send
--   detail    JSON. flag: { important, reason, checked, promises }. draft: { text, new_links }. send: { from_draft,
--             edited, sent_id, status, error }.
CREATE TABLE today_log (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  message_id TEXT,
  actor TEXT,
  detail TEXT NOT NULL DEFAULT '{}'
) WITHOUT ROWID;
