-- FounderData Pro's Android parts: the owner app's FCM push (pro/worker/fcm.ts) and the Google Play sales import
-- (pro/worker/playsales.ts). Core creates the tables so every edition has the same schema.
-- An Android owner app's push (pro/worker/fcm.ts, docs/MOBILE-API.md "Android"). NULL is APNs, as every row before.
-- 'fcm': apns_token holds the FCM registration token and apns_topic the app's package name (apns_env stays NULL), so
-- every query that looks for a live alert token, revoking a device and apns_disabled_at work unchanged.
ALTER TABLE devices ADD COLUMN push_provider TEXT;

-- Google Play's estimated sales report (sales/salesreport_YYYYMM.zip in the Play bucket), added up per day (Order
-- Charged Date, UTC), status, product, currency and buyer country. Amounts are sums in major units of `currency`;
-- refunds are negative. units: charged orders minus full refunds (a partial refund counts 0).
-- Re-importing a day deletes its rows and writes them again, so row_key only has to be unique within a day.
CREATE TABLE play_sales (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_date TEXT NOT NULL,
  row_key TEXT NOT NULL,
  site_id TEXT,
  package TEXT,
  sku TEXT,
  title TEXT,
  product_type TEXT,
  kind TEXT NOT NULL,   -- subscription, inapp, paid_app or other
  status TEXT NOT NULL, -- charged, refund or partial_refund
  units INTEGER NOT NULL,
  item_price REAL NOT NULL DEFAULT 0,
  taxes REAL NOT NULL DEFAULT 0,
  charged REAL NOT NULL DEFAULT 0, -- item price plus tax, as the buyer paid it
  currency TEXT,
  country TEXT,
  UNIQUE (report_date, row_key)
);
CREATE INDEX play_sales_site_day ON play_sales (site_id, report_date);

-- One row per day of an imported month. status: ok (orders), zero (covered, no orders) or partial (the file was
-- written before the day had ended plus a day, so more orders may come). hash: of the day's sums, so an unchanged day
-- is not written again. revenue.ts can count the report on ok and zero days, as asc_import_days does for Apple.
CREATE TABLE play_import_days (
  report_date TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  rows INTEGER NOT NULL DEFAULT 0,
  hash TEXT,
  imported_at INTEGER NOT NULL
) WITHOUT ROWID;

-- One row per month file. generation: Cloud Storage's, so a file Google did not rewrite is not read again.
-- status: running (a step started; a step that dies leaves it), ok or error. attempts counts steps on this generation.
CREATE TABLE play_import_files (
  name TEXT PRIMARY KEY,
  generation TEXT NOT NULL,
  updated INTEGER NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  imported_at INTEGER NOT NULL
) WITHOUT ROWID;

-- The developer id's bucket is a deployment setting: deployment_settings key 'play_bucket' (migration 0031), no column.
