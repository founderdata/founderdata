// The two surveys (plan round 7, S6; docs/API.md "Survey answers"): their keys, answer keys and default wording. The
// Worker validates answers against these lists, the dashboard and the survey widget (pro/js/survey.ts) show the labels.
// The owner may change the question and the labels (sites.surveys), never the keys.

export const SURVEYS = ['heard_about', 'cancel_reason'] as const;
export type SurveyKey = (typeof SURVEYS)[number];

/** Answer keys per survey, in the order the widget lists them. `other` is last and takes a text. */
export const ANSWERS: Record<SurveyKey, readonly string[]> = {
  heard_about: ['google', 'ai', 'x', 'reddit', 'youtube', 'linkedin', 'friend', 'podcast', 'newsletter', 'other'],
  // Stripe's cancellation_details.feedback values; Polar's customer_cancellation_reason uses the same ones.
  cancel_reason: ['too_expensive', 'missing_features', 'switched_service', 'unused', 'too_complex', 'low_quality', 'customer_service', 'other'],
};

/**
 * Cancel reasons from the App Store and Google Play, as RevenueCat's webhook reports them (cancel_reason or
 * expiration_reason; src/worker/revenuecat.ts). They are the store's fixed categories, never the customer's words, so
 * they are stored under keys of their own beside the answers above, with `via` app_store or play_store.
 */
export const STORE_REASONS = ['unsubscribed', 'billing_error', 'price_increase', 'developer', 'refunded', 'unknown'] as const;
export type StoreReason = (typeof STORE_REASONS)[number];
/** Where a store's cancel reason came from (`survey_answers.via`). */
export const STORE_VIAS = ['app_store', 'play_store'] as const;
export const isStoreVia = (v: unknown) => typeof v === 'string' && (STORE_VIAS as readonly string[]).includes(v);

export const STORE_REASON_LABELS: Record<StoreReason, string> = {
  unsubscribed: 'Turned off renewal, no reason given',
  billing_error: 'Payment failed',
  price_increase: 'Did not accept a price increase',
  developer: 'Canceled by you',
  refunded: 'Refunded',
  unknown: 'No reason from the store',
};

/** A dismissed widget. Stored like an answer so the same visitor is not asked again; never counted as one. */
export const SKIPPED = 'skipped';

export const DEFAULT_QUESTIONS: Record<SurveyKey, string> = {
  heard_about: 'How did you hear about us?',
  cancel_reason: 'Why are you canceling?',
};

export const DEFAULT_LABELS: Record<SurveyKey, Record<string, string>> = {
  heard_about: {
    google: 'Google or another search engine',
    ai: 'ChatGPT, Claude or another AI',
    x: 'X (Twitter)',
    reddit: 'Reddit',
    youtube: 'YouTube',
    linkedin: 'LinkedIn',
    friend: 'A friend or colleague',
    podcast: 'A podcast',
    newsletter: 'A newsletter',
    other: 'Somewhere else',
  },
  cancel_reason: {
    too_expensive: 'It costs too much',
    missing_features: 'It is missing something I need',
    switched_service: 'I switched to another product',
    unused: "I don't use it enough",
    too_complex: 'It is too hard to use',
    low_quality: 'It did not work well enough',
    customer_service: 'Support did not help',
    other: 'Another reason',
  },
};

/** Limits of the owner's wording (PATCH /api/sites/:id `surveys`). */
export const QUESTION_CHARS = 120;
export const LABEL_CHARS = 40;
/** Characters of free text kept ("Other", Stripe's comment). */
export const TEXT_CHARS = 200;

/** One survey's settings as sites.surveys stores them (migration 0090). */
export interface SurveySettings {
  /** 1 = the widget may show. */
  on: 0 | 1;
  /** Path prefixes the widget shows on; absent = only where the site calls founderdata('survey', key). */
  paths?: string[];
  /** The question, when the owner changed it. */
  q?: string;
  /** Labels the owner changed, by answer key. */
  l?: Record<string, string>;
}
export type SurveysConfig = Partial<Record<SurveyKey, SurveySettings>>;

export const isSurvey = (s: unknown): s is SurveyKey => typeof s === 'string' && (SURVEYS as readonly string[]).includes(s);

/** sites.surveys as an object; {} for null or text that is not JSON. */
export function parseSurveys(text: string | null | undefined): SurveysConfig {
  if (!text) return {};
  try {
    const v = JSON.parse(text);
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    const out: SurveysConfig = {};
    for (const k of SURVEYS) if (v[k] && typeof v[k] === 'object') out[k] = v[k];
    return out;
  } catch {
    return {};
  }
}

/** The question and labels to show for a survey: the owner's wording over the defaults. */
export function wording(cfg: SurveysConfig, key: SurveyKey): { q: string; labels: Record<string, string> } {
  const s = cfg[key];
  return { q: s?.q || DEFAULT_QUESTIONS[key], labels: { ...DEFAULT_LABELS[key], ...(s?.l ?? {}) } };
}
