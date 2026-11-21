-- Round 7, lane errors: JavaScript errors without recording (docs/API.md "Errors", docs/PRIVACY.md "Errors").
-- One errors row per distinct error of a page view, written by the ping when the site catches errors (sites.errors_on,
-- migration 0090) or records visits. Kept 90 days, erased with the person. No index beyond the key: a page view's
-- errors cost 1 row each, and every read is a range of one site's days.
CREATE TABLE errors (
  site_id TEXT NOT NULL,
  ts INTEGER NOT NULL,          -- when the error happened, ms (the page's start plus the tracker's offset)
  id INTEGER NOT NULL,          -- random
  fp TEXT NOT NULL,             -- fingerprint, 12 hex characters (src/worker/errors.ts fingerprint)
  session_id TEXT, visitor_id TEXT, path TEXT,
  message TEXT NOT NULL,        -- 200 characters, emails, phone numbers and runs of 6 or more digits replaced
  source TEXT,                  -- file:line, without the query
  stack TEXT,                   -- at most 3 frames "file:line:col fn", one per line, 300 characters
  n INTEGER NOT NULL DEFAULT 1, -- times on this page view
  device TEXT, browser TEXT,
  PRIMARY KEY (site_id, ts, id)
) WITHOUT ROWID;

-- The owner's decision about an issue. No row: open. A resolved issue that happens again reads as regressed.
CREATE TABLE error_issues (
  site_id TEXT NOT NULL, fp TEXT NOT NULL,
  status TEXT NOT NULL,         -- resolved | ignored
  changed_at INTEGER NOT NULL,
  PRIMARY KEY (site_id, fp)
) WITHOUT ROWID;
