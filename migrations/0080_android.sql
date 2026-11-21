-- Android apps (docs/APP-API.md section 9).
-- android_package: the app's Google Play package name (application id). App batches with ctx.platform "android" must
-- name it, as iOS batches name app_bundle_id. google_push_email: the service account the Pub/Sub push subscription for
-- Google Play notifications signs its OIDC token with.
ALTER TABLE sites ADD COLUMN android_package TEXT;
ALTER TABLE sites ADD COLUMN google_push_email TEXT;
