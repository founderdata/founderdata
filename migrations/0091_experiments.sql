-- Round 7, lane exp: web experiments and flags (docs/API.md "Experiments (Pro)", docs/PRIVACY.md "Experiments").
-- A flag is an experiment of kind flag with the variants off and on and a rollout weight. The running ones are also
-- kept as compact JSON in sites.exp_live (migration 0090), so a pageview assigns them from the cached site row. A
-- visit's variant is the session property exp_<key> (sessions.props, migration 0006): no table of exposures.
CREATE TABLE experiments (
  site_id TEXT NOT NULL,
  key TEXT NOT NULL,            -- [a-z0-9_]{1,40}, not "new"; the session property is exp_<key>
  kind TEXT NOT NULL,           -- experiment | flag
  name TEXT NOT NULL,
  variants TEXT NOT NULL,       -- JSON [{"key":"control","weight":50},{"key":"b","weight":50}], 2 to 4, the first is the control
  paths TEXT,                   -- path prefixes, one per line (recording.ts parseSkipList rules); NULL = every page
  goal TEXT,                    -- goal judged beside revenue; NULL = the site's primary goal
  status TEXT NOT NULL,         -- draft | running | stopped
  started_at INTEGER, stopped_at INTEGER, winner TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (site_id, key)
) WITHOUT ROWID;
