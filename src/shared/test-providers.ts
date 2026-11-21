/**
 * Payment providers whose rows are test purchases: stored so an owner can check the setup, never counted as revenue.
 * App Store sandbox (docs/APP-API.md section 2) and Google Play test purchases (section 9).
 */
export const SANDBOX_PROVIDER = 'app_store_sandbox';
export const PLAY_TEST_PROVIDER = 'google_play_test';
export const TEST_PROVIDERS: readonly string[] = [SANDBOX_PROVIDER, PLAY_TEST_PROVIDER];
export const isTestProvider = (provider: string | null | undefined): boolean => !!provider && TEST_PROVIDERS.includes(provider);
/** SQL list for `provider NOT IN ...`. */
export const TEST_PROVIDERS_SQL = `(${TEST_PROVIDERS.map((p) => `'${p}'`).join(', ')})`;
