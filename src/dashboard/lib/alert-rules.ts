// The alert rules' plain words (the Settings card here, and Pro's Alert rules page): where a rule sends, and its state. No
// React, no fetch, so test/alert-rule-words.test.ts tests them.
import type { AlertChannel, ChannelKind } from './api';

const KIND: Record<ChannelKind, string> = { slack: 'Slack', discord: 'Discord', telegram: 'Telegram', webhook: 'Webhook', email: 'Email' };

/** A notification channel as a destination: "Slack #growth", or the kind alone when the name is empty or says it. */
export function channelLabel(ch: Pick<AlertChannel, 'kind' | 'name'>): string {
  const kind = KIND[ch.kind] ?? ch.kind;
  const name = (ch.name ?? '').trim();
  if (!name) return kind;
  return name.toLowerCase().startsWith(kind.toLowerCase()) ? name : `${kind} ${name}`;
}

/**
 * Where a rule sends, as one line: "Slack #growth, Email founders, iPhone push, webhook hooks.example.com". With channels
 * on, every channel that covers the rule's site (all of them for a rule for all sites); "no channel covers this site"
 * when none does. Null while the channels are not loaded.
 */
export function ruleDestinations(
  r: { channels: boolean; push: boolean; webhook_url: string | null; site_id: string; all_sites?: boolean },
  channels: Pick<AlertChannel, 'kind' | 'name' | 'sites'>[] | null,
): string | null {
  const out: string[] = [];
  if (r.channels) {
    if (!channels) return null;
    const covering = channels.filter((ch) => r.all_sites || !ch.sites || ch.sites.includes(r.site_id));
    if (covering.length) out.push(...covering.map(channelLabel));
    else out.push('no notification channel covers this site');
  }
  if (r.push) out.push('iPhone push');
  if (r.webhook_url) {
    let host = r.webhook_url;
    try {
      host = new URL(r.webhook_url).host;
    } catch {
      // shown as it is
    }
    out.push(`webhook ${host}`);
  }
  return out.length ? out.join(', ') : 'nowhere';
}

/** A rule's state chip: Paused, Firing now (on N pages or sites), N new errors sent, or Not firing. */
export function ruleState(r: { enabled: boolean; metric: string; crossed: string[]; all_sites?: boolean }): { tone: 'neutral' | 'error' | 'ok'; text: string } {
  if (!r.enabled) return { tone: 'neutral', text: 'Paused' };
  // A verdict rule's state is the changes it judged, not a line it crossed.
  if (r.crossed.length && r.metric !== 'note_verdict') {
    // A rule for all sites keys its state "<site id>|<page or *>".
    const keys = r.crossed.map((k) => (r.all_sites ? k.slice(k.indexOf('|') + 1) : k));
    if (r.metric === 'new_error') return { tone: 'error', text: `${keys.length} new ${keys.length === 1 ? 'error' : 'errors'} sent` };
    const pages = keys.filter((k) => k !== '*').length;
    const sites = r.all_sites ? new Set(r.crossed.map((k) => k.split('|')[0])).size : 0;
    const text = pages ? `Firing on ${pages} ${pages === 1 ? 'page' : 'pages'}` : sites ? `Firing on ${sites} ${sites === 1 ? 'site' : 'sites'}` : 'Firing now';
    return { tone: 'error', text };
  }
  return { tone: 'ok', text: 'Not firing' };
}
