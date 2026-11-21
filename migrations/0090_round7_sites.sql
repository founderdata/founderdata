-- Round 7: the site switches of errors, click maps, surveys and experiments, and scroll depth on the page speed row.
-- 0080 to 0083 are taken on other branches. 0091 to 0094 hold the new tables (experiments, survey_answers, page_maps,
-- errors), 0095 to 0099 are kept free.

-- Catch JavaScript errors without recording the visit: 1 = on. Off by default (docs/PRIVACY.md, "Errors").
ALTER TABLE sites ADD COLUMN errors_on INTEGER NOT NULL DEFAULT 0;

-- Click maps: 1 = on. Off by default (docs/PRIVACY.md, "Click maps and scroll").
ALTER TABLE sites ADD COLUMN maps_on INTEGER NOT NULL DEFAULT 0;

-- Percent of page views that send a click map, 1 to 100.
ALTER TABLE sites ADD COLUMN map_sample INTEGER NOT NULL DEFAULT 100;

-- The two surveys as JSON: {"heard_about":{"on":1,"paths":["/welcome"],"q":"...","l":{"podcast":"A podcast"}},
-- "cancel_reason":{...}}. NULL: both off.
ALTER TABLE sites ADD COLUMN surveys TEXT;

-- The running experiments as compact JSON, so the cached site row assigns them without a read:
-- [{"k":"pricing_headline","v":[["control",50],["b",50]],"p":["/pricing"]}], at most 10. NULL: none.
ALTER TABLE sites ADD COLUMN exp_live TEXT;

-- The deepest scroll of the page load, percent of the document height. NULL: not measured.
ALTER TABLE vitals ADD COLUMN scroll INTEGER;
