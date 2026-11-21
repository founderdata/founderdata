-- Round 7, lane survey: answers of the two surveys (src/worker/surveys.ts, docs/API.md "Survey answers",
-- docs/PRIVACY.md "Surveys"). heard_about asks where a visitor heard about the site; cancel_reason why a customer
-- cancels. Answers come from the tracker's answer call, the survey widget (FounderData Pro) and the cancellation
-- reasons of Stripe and Polar webhooks.
--
-- One row per answer. The answer is also a trait on the visitor row (visitors.traits, keys heard_about and
-- cancel_reason), which is how the widget knows not to ask again. Rows go with the visitor (erase.ts) and after
-- RETENTION_MONTHS like visits (retention.ts).
--
-- WITHOUT ROWID with no other index: an answer writes 1 row. Reads go by site, survey and time, the key's order.
CREATE TABLE survey_answers (
  site_id TEXT NOT NULL,
  survey TEXT NOT NULL,         -- heard_about | cancel_reason
  ts INTEGER NOT NULL,          -- ms
  id TEXT NOT NULL,             -- random, or <provider>:<subscription id>:<cancel time> (a retried webhook writes nothing)
  visitor_id TEXT,
  session_id TEXT,
  subscription_id TEXT,         -- cancel_reason from a webhook
  answer TEXT NOT NULL,         -- an answer key (src/shared/surveys.ts), 'other' or 'skipped'
  text TEXT,                    -- free text, 200 characters; emails, phone numbers and runs of 6 or more digits removed
  via TEXT NOT NULL,            -- widget | js | stripe | polar
  PRIMARY KEY (site_id, survey, ts, id)
) WITHOUT ROWID;
