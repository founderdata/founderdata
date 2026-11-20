-- Mail on the iPhone app (FounderData Pro, docs/MOBILE-API.md section 10): each phone's push switches for received mail,
-- and which phone sent a reply, so a phone's daily reply cap can count its own sends. Core holds the tables, as for every
-- Pro feature. Core never writes them.
--
-- Rows each path writes (pro/test/cost.test.ts pins them):
--   change a phone's mail switches   1 for the device row, + 1 per domain or address switched (device_mail_prefs has no
--                                    index besides its key)
--   a reply sent from a phone        1 more than the same reply from the dashboard, for mail_messages_by_device

-- The phone's mail push switches. mail_push starts off, for phones signed in before and after this migration: a phone
-- asks for mail pushes. mail_new_threads_only pushes the first message of a thread only. mail_skip_spam sends no push
-- for a message the Worker reads as likely spam (pro/worker/mail/phone-push.ts likelySpam).
ALTER TABLE devices ADD COLUMN mail_push INTEGER NOT NULL DEFAULT 0;
ALTER TABLE devices ADD COLUMN mail_new_threads_only INTEGER NOT NULL DEFAULT 0;
ALTER TABLE devices ADD COLUMN mail_skip_spam INTEGER NOT NULL DEFAULT 1;

-- A phone's switch for one mail domain or one address. A domain or address with no row is on, so a domain or address
-- added later pushes. Rows hold only what a person touched. Revoking the device deletes its rows.
--   target_id  a mail_domains.id or a mail_addresses.id
--   kind       domain or address
CREATE TABLE device_mail_prefs (
  device_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  PRIMARY KEY (device_id, target_id)
) WITHOUT ROWID;

-- The phone that sent a message (a reply from the iPhone app), NULL for every other sender. The phone's daily reply cap
-- adds up a day of it.
ALTER TABLE mail_messages ADD COLUMN device_id TEXT;
CREATE INDEX mail_messages_by_device ON mail_messages (device_id, created_at) WHERE device_id IS NOT NULL;
