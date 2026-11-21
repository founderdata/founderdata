-- Mail folders on the iPhone app (FounderData Pro, docs/MOBILE-API.md section 11): the trash, and two counters that let
-- the thread list filter by sent mail and by attachments without reading the messages of every thread. Core holds the
-- columns, as for every Pro feature. Core never writes them.
--
--   trashed_at        when the thread went to the trash, ms. NULL when it is not in the trash. A thread in the trash
--                     is in no other list or count. The retention job deletes it for good 30 days after this time. A
--                     new inbound message takes it out of the trash, as it takes a thread out of the archive.
--   sent_count        messages of the thread that went out (direction out), whatever their status
--   attachment_count  messages of the thread with at least one attachment (mail_messages.has_attachments), inline
--                     images included
--
-- Both counters move in the statement that adds a message to its thread (pro/worker/mail/store.ts
-- upsertThreadStatement) and are counted again when messages leave (threads.ts recountThreadsStatements). Neither has
-- an index, so they add no rows to a write.
--
-- Rows each path writes (pro/test/cost.test.ts pins them):
--   move a thread to the trash      3: the row and its two trash index entries
--   take it out of the trash        1
--   delete messages for good        as purgeMessages (pro/worker/mail/erase.ts) always did
ALTER TABLE mail_threads ADD COLUMN trashed_at INTEGER;
ALTER TABLE mail_threads ADD COLUMN sent_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE mail_threads ADD COLUMN attachment_count INTEGER NOT NULL DEFAULT 0;

-- The counters for threads that exist already. Threads with nothing to count keep the default 0 and are not written.
UPDATE mail_threads SET
  sent_count = (SELECT COUNT(*) FROM mail_messages m WHERE m.thread_id = mail_threads.id AND m.direction = 'out'),
  attachment_count = (SELECT COUNT(*) FROM mail_messages m WHERE m.thread_id = mail_threads.id AND m.has_attachments = 1)
WHERE EXISTS (SELECT 1 FROM mail_messages m WHERE m.thread_id = mail_threads.id AND (m.direction = 'out' OR m.has_attachments = 1));

-- The retention job's oldest trash first, and the trash folder newest first. Both hold only threads in the trash, so a
-- thread outside it costs nothing here.
CREATE INDEX mail_threads_trash ON mail_threads (trashed_at) WHERE trashed_at IS NOT NULL;
CREATE INDEX mail_threads_trash_by_last ON mail_threads (last_at) WHERE trashed_at IS NOT NULL;
