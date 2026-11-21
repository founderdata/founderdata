-- Round 7, owner item 8: App Store and Google Play cancel reasons in "Why they cancel" (docs/API.md "Survey answers").
-- From this release on, a RevenueCat CANCELLATION or EXPIRATION stores the store's reason as a cancel_reason answer
-- (src/worker/revenuecat.ts storeReason) with via app_store or play_store, under the keys of src/shared/surveys.ts
-- STORE_REASONS. No schema change: survey_answers.via and answer take the new values.
--
-- This migration adds the reasons RevenueCat sent before, once. They are in subscription_signals (reason), which names
-- the visitor but not the subscription, so a reason is added only when its visitor has a canceled or ended
-- subscription that started before it: the newest such one. One answer per subscription, its earliest signal. Signals
-- without a visitor, sandbox ones and paused Google Play subscriptions are left out. It writes 1 row per subscription
-- found, once; answers older than RETENTION_MONTHS go with the nightly retention job like every answer.
INSERT OR IGNORE INTO survey_answers (site_id, survey, ts, id, visitor_id, session_id, subscription_id, answer, text, via)
SELECT site_id, 'cancel_reason', MIN(ts), 'backfill:' || sub, visitor_id, NULL, sub,
       CASE UPPER(reason)
         WHEN 'UNSUBSCRIBE' THEN 'unsubscribed'
         WHEN 'BILLING_ERROR' THEN 'billing_error'
         WHEN 'PRICE_INCREASE' THEN 'price_increase'
         WHEN 'DEVELOPER_INITIATED' THEN 'developer'
         WHEN 'CUSTOMER_SUPPORT' THEN 'refunded'
         ELSE 'unknown'
       END,
       NULL,
       CASE WHEN UPPER(store) = 'PLAY_STORE' THEN 'play_store' ELSE 'app_store' END
FROM (
  SELECT g.site_id, g.ts, g.visitor_id, g.reason, g.store,
         (SELECT s.id FROM subscriptions s
          WHERE s.site_id = g.site_id AND s.visitor_id = g.visitor_id AND s.sandbox = 0 AND s.started_at <= g.ts
            AND (s.canceled_at IS NOT NULL OR s.ended_at IS NOT NULL)
          ORDER BY s.started_at DESC LIMIT 1) AS sub
  FROM subscription_signals g
  WHERE g.provider = 'revenuecat' AND g.type IN ('cancellation', 'expiration') AND g.sandbox = 0
    AND g.visitor_id IS NOT NULL AND g.reason IS NOT NULL AND UPPER(g.reason) != 'SUBSCRIPTION_PAUSED'
    AND UPPER(COALESCE(g.store, '')) IN ('APP_STORE', 'MAC_APP_STORE', 'PLAY_STORE')
)
WHERE sub IS NOT NULL
GROUP BY site_id, sub;
