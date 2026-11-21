-- Round 7, click maps (src/worker/page-maps.ts, docs/PRIVACY.md "Click maps and scroll"): one row per page view of a
-- site that turns click maps on (sites.maps_on, sampled by sites.map_sample). No visitor or session id, like vitals.
-- Kept 90 days (retention.ts through core-parts.ts). A row is 1 D1 row written: the table has no other index.
CREATE TABLE page_maps (
  site_id TEXT NOT NULL,
  path TEXT NOT NULL,
  ts INTEGER NOT NULL,
  id INTEGER NOT NULL,          -- random
  device TEXT,                  -- Desktop | Mobile | Tablet, as sessions.device
  width INTEGER, height INTEGER, -- viewport width and document height, px
  scroll INTEGER,               -- deepest scroll, percent of the document
  clicks TEXT,                  -- JSON [[x per mille of width, y px, "hint", "label"], ...], at most 50
  PRIMARY KEY (site_id, path, ts, id)
) WITHOUT ROWID;
