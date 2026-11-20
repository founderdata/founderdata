-- Questions on owner tasks (FounderData Pro: pro/worker/questions.ts, docs/MCP.md "update_tasks", docs/API.md "Plan (Pro)",
-- docs/MOBILE-API.md "Questions"). An agent asks the owner on a task with owner human; the owner answers in the phone
-- app's Growth tab or on the Plan tab, and the answer closes the task, so the next run reads it in due.done_by_you.
-- Number 0081: 0080 is taken by another branch.
--
-- Rows written per write path (pinned in pro/test/cost.test.ts, listed in the README cost table):
--   a task with a question, new or changed   1, as any task
--   the owner answers, or undoes an answer    1
--   the question push for a site               1 (plans.questions_pushed_at), whatever the number of questions and phones
--
-- plan_tasks.question  JSON { type, options, recommended, allow_text }, or NULL. type single, multi or text; options a list
--                      of 2 to 8 { id, label } (single and multi only), labels at most 80 characters; recommended a list of
--                      option ids; allow_text true adds a text field to single or multi. A human task without a question
--                      that is kind approval reads as single choice Yes (id yes) and No (id no). Fixed once set on an open task
-- plan_tasks.answer    JSON { choices, text, via, answered_at }: the owner's answer. choices is a list of option ids, text
--                      the typed or dictated words or null, via app, voice or web, answered_at ISO 8601. NULL until answered;
--                      undo clears it
-- plans.questions_pushed_at  ms: the newest question push for the site. Open questions (owner tasks with a question, and
--                      approvals) created after it wait for a push. Set to now for every plan here, so nothing asked before
--                      this migration pushes
ALTER TABLE plan_tasks ADD COLUMN question TEXT;
ALTER TABLE plan_tasks ADD COLUMN answer TEXT;
ALTER TABLE plans ADD COLUMN questions_pushed_at INTEGER;
UPDATE plans SET questions_pushed_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000;

-- The open owner tasks of every site, oldest first: the Growth tab's list and the five-minute push check read this
-- instead of every task.
CREATE INDEX plan_tasks_open_owner ON plan_tasks (created_at) WHERE owner = 'human' AND status IN ('todo', 'doing');
