// The alert rules' words (src/dashboard/lib/alert-rules.ts), used by Settings and Pro's Alert rules page: where a rule
// sends, and "Firing now" instead of "Over the line" (round 7 critique 1, errors-15).
import { describe, expect, it } from 'vitest';
import { channelLabel, ruleDestinations, ruleState } from '../src/dashboard/lib/alert-rules';

describe('alert rules: where a rule sends and its state', () => {
  it('names the destinations and says Firing now instead of Over the line', () => {
    const channels = [
      { kind: 'slack' as const, name: '#growth', sites: null },
      { kind: 'email' as const, name: 'Founders', sites: ['other'] },
      { kind: 'discord' as const, name: '', sites: ['demo0001'] },
    ];
    const r = { channels: true, push: true, webhook_url: 'https://hooks.example.com/x', site_id: 'demo0001' };
    expect(ruleDestinations(r, channels)).toBe('Slack #growth, Discord, iPhone push, webhook hooks.example.com');
    expect(ruleDestinations({ ...r, all_sites: true, push: false, webhook_url: null }, channels)).toBe('Slack #growth, Email Founders, Discord');
    expect(ruleDestinations({ ...r, push: false, webhook_url: null }, [])).toBe('notification channels (none covers this site yet)');
    expect(ruleDestinations({ ...r, channels: false, push: false, webhook_url: 'agent.example.com/••••data' }, [])).toBe('webhook agent.example.com');
    expect(ruleDestinations(r, null)).toBeNull();
    expect(channelLabel({ kind: 'slack', name: 'Slack alerts' })).toBe('Slack alerts');
    expect(ruleState({ enabled: true, metric: 'visitors', crossed: ['*'] })).toEqual({ tone: 'error', text: 'Firing now' });
    expect(ruleState({ enabled: true, metric: 'page_google_clicks', crossed: ['/a', '/b'] }).text).toBe('Firing on 2 pages');
    expect(ruleState({ enabled: true, metric: 'new_error', crossed: ['9c48328265cd'] }).text).toBe('1 new error sent');
    expect(ruleState({ enabled: true, metric: 'visitors', crossed: [] })).toEqual({ tone: 'ok', text: 'Not firing' });
    expect(ruleState({ enabled: false, metric: 'visitors', crossed: ['*'] }).text).toBe('Paused');
  });
});
