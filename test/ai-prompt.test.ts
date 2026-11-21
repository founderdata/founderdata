import { describe, expect, it } from 'vitest';
import { buildAiPrompt } from '../src/dashboard/lib/aiPrompt';
import type { Site } from '../src/dashboard/lib/api';

const site: Site = {
  id: 'site123',
  name: 'ShipKit',
  domain: 'shipkit.example.com',
  timezone: 'America/New_York',
  currency: 'USD',
  api_key: 'rt_secret_key_never_in_prompt',
  dodo_webhook_secret: 'whsec_dodo_never_in_prompt',
  created_at: 0,
  app_bundle_id: null,
  accept_sandbox: 0,
  stripe_webhook_secret: 'whsec_stripe_never_in_prompt',
  revenuecat_auth: 'rc_never_in_prompt',
};
const ORIGIN = 'https://founderdata.example.com';

describe('the AI setup prompt', () => {
  const prompt = buildAiPrompt(site, ORIGIN);

  it('covers every payment provider with this site webhook URLs', () => {
    for (const provider of ['stripe', 'dodo', 'apple', 'revenuecat']) {
      expect(prompt).toContain(`${ORIGIN}/api/webhooks/${provider}/site123`);
    }
    expect(prompt).toContain('subscription_data');
    expect(prompt).toContain('client_reference_id=rtv_');
    expect(prompt).toContain('founderDataVisitorId');
    expect(prompt).toContain(`POST ${ORIGIN}/api/v1/payments`);
    expect(prompt).toContain('"currency": "USD"');
  });

  it('never contains a secret, and asks for the API key through an environment variable', () => {
    for (const secret of [site.api_key, site.dodo_webhook_secret, site.stripe_webhook_secret, site.revenuecat_auth]) {
      expect(prompt).not.toContain(secret!);
    }
    expect(prompt).toContain('FOUNDERDATA_API_KEY');
  });

  it('names the two attributes that keep text out of visit recordings', () => {
    expect(prompt).toMatch(/data-fd-mask on elements whose text must never show in a visit recording/);
    expect(prompt).toContain('data-fd-block');
  });

  it('names the bundle id when the site has one, and asks for it when not', () => {
    expect(prompt).toContain('not set yet');
    expect(buildAiPrompt({ ...site, app_bundle_id: 'com.example.shipkit' }, ORIGIN)).toContain('(currently com.example.shipkit)');
  });
});
