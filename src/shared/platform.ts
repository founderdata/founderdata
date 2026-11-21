/**
 * Which platform a session belongs to, from its hostname (docs/APP-API.md, sections 1 and 9). App sessions have the
 * hostname `ios:<bundle id>` or `android:<package>`; anything else, including null, is the website.
 */

export type Platform = 'ios' | 'android' | 'web';

export const IOS_PREFIX = 'ios:';
export const ANDROID_PREFIX = 'android:';

/** True for a session of the iOS or the Android app. */
export function isAppHost(host: string | null | undefined): boolean {
  return typeof host === 'string' && (host.startsWith(IOS_PREFIX) || host.startsWith(ANDROID_PREFIX));
}

export function platformOf(host: string | null | undefined): Platform {
  if (typeof host !== 'string') return 'web';
  if (host.startsWith(IOS_PREFIX)) return 'ios';
  if (host.startsWith(ANDROID_PREFIX)) return 'android';
  return 'web';
}

/** The platform's name as the dashboard shows it and the `platform` filter takes it: iOS, Android or Web. */
export const PLATFORM_LABEL: Record<Platform, string> = { ios: 'iOS', android: 'Android', web: 'Web' };

/** SQL: the session `col` (a hostname column) is an app session. */
export const appHostSql = (col = 'hostname') => `(${col} LIKE '${IOS_PREFIX}%' OR ${col} LIKE '${ANDROID_PREFIX}%')`;
/** SQL: the session `col` is a website session (null hostnames included). */
export const webHostSql = (col = 'hostname') => `(${col} IS NULL OR NOT ${appHostSql(col)})`;
/** SQL: 'ios', 'android' or 'web' for the hostname column `col`. */
export const platformSql = (col = 'hostname') =>
  `(CASE WHEN ${col} LIKE '${IOS_PREFIX}%' THEN 'ios' WHEN ${col} LIKE '${ANDROID_PREFIX}%' THEN 'android' ELSE 'web' END)`;
/** SQL: 'iOS', 'Android' or 'Web', the values of the `platform` filter and breakdown. */
export const platformLabelSql = (col = 'hostname') =>
  `(CASE WHEN ${col} LIKE '${IOS_PREFIX}%' THEN 'iOS' WHEN ${col} LIKE '${ANDROID_PREFIX}%' THEN 'Android' ELSE 'Web' END)`;

export const APP_HOST_SQL = appHostSql();
export const WEB_HOST_SQL = webHostSql();

/** The site has an app on either store: an App Store bundle id or a Play package name. */
export function hasApp(site: { app_bundle_id?: string | null; android_package?: string | null }): boolean {
  return !!(site.app_bundle_id || site.android_package);
}

/** The `platform` filter keeps app sessions only: iOS, Android, or App for both. */
export const isAppFilter = (p: string | null | undefined) => p === 'iOS' || p === 'Android' || p === 'App';
