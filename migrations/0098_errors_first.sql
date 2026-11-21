-- Round 7, lane errors, second migration (docs/API.md "Errors"): what keeps issue reads and the new_error alert cheap.
--
-- errors.datacenter: copied from the visit, like events.datacenter, so issues leave out hosting networks and bots the
-- way every other report does (src/worker/datacenter.ts countedSql).
ALTER TABLE errors ADD COLUMN datacenter INTEGER NOT NULL DEFAULT 0;

-- When each issue was first seen. The ping writes it with INSERT OR IGNORE beside the errors row: 1 row the first time
-- an issue appears, none after. Reads look an issue's first sighting up here instead of scanning 90 days of errors.
-- Visits from hosting networks do not set it. The nightly job deletes a row once its issue has no errors row left.
CREATE TABLE error_first (
  site_id TEXT NOT NULL,
  fp TEXT NOT NULL,
  first_seen INTEGER NOT NULL,  -- ms, the ts of the first errors row
  PRIMARY KEY (site_id, fp)
) WITHOUT ROWID;
