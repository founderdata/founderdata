import { useEffect, useState } from 'react';
import { navigate } from '../../App';
import { api, type AlertChannel, type Site } from '../../lib/api';
import { ruleDestinations, ruleState } from '../../lib/alert-rules';
import { SetupRow, SkeletonRows, StatusChip } from '../ui';
import { SetupIcons } from './icons';
import { InlineError, SettingsCard } from './kit';
import { useCardStatus } from './status';

/** The part of a rule from GET /api/alerts/rules that this card reads (the full shape is in AlertRules.tsx). */
interface AlertRule {
  id: string;
  site_id: string;
  all_sites: boolean;
  name: string;
  summary: string;
  enabled: boolean;
  metric: string;
  crossed: string[];
  channels: boolean;
  push: boolean;
  webhook_url: string | null;
}

/**
 * Settings, Alerts: the rules that watch this site, read from GET /api/alerts/rules. Rules and channels are edited on
 * the Alerts page, which covers every site, so this card shows them and links there.
 */
export function AlertsCard({ site }: { site: Site }) {
  const [rules, setRules] = useState<AlertRule[] | null>(null);
  const [error, setError] = useState('');
  const [n, setN] = useState(0);
  const [channels, setChannels] = useState<AlertChannel[] | null>(null);
  const status = useCardStatus('alert-rules', site);
  useEffect(() => {
    api<{ rules: AlertRule[] }>('/api/alerts/rules').then(
      (r) => (setRules(r.rules.filter((x) => x.site_id === site.id || x.all_sites || x.site_id === '*')), setError('')),
      (e) => setError((e as Error).message),
    );
    // The notification channels, so each rule can say where it posts. Empty when they cannot be read.
    api<{ channels: AlertChannel[] }>('/api/alerts').then((a) => setChannels(a.channels ?? []), () => setChannels([]));
  }, [site.id, n]);
  const open = (
    <button className="btn-dark" onClick={() => navigate('/notifications')}>
      Open alerts
    </button>
  );
  return (
    <SettingsCard
      id="alert-rules"
      title="Alert rules"
      status={status}
      actions={rules?.length ? open : undefined}
      desc="A rule checks a number every hour or day and posts when it crosses its line. An agent's webhook also gets the numbers and the chart notes from those days."
    >
      {error && <InlineError message={error} onRetry={() => setN((x) => x + 1)} />}
      {!rules && !error && <SkeletonRows rows={2} />}
      {rules && !rules.length && (
        <SetupRow icon={SetupIcons.alerts} title="No rule watches this site" action={open}>
          A good first one: revenue per visitor falls 15% in 7 days.
        </SetupRow>
      )}
      {!!rules?.length && (
        <ul className="divide-y divide-stone-200/60">
          {rules.map((r) => {
            const state = ruleState(r);
            const to = ruleDestinations(r, channels);
            return (
              <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5 text-sm">
                <span className="min-w-0 flex-1 basis-56">
                  <span className="block truncate font-medium text-ink">{r.name || r.summary}</span>
                  {r.name && r.name !== r.summary && <span className="block truncate text-[13px] text-stone-500">{r.summary}</span>}
                  {to && <span className="block truncate text-[13px] text-stone-500">Sends to {to}</span>}
                </span>
                {r.all_sites || r.site_id === '*' ? <StatusChip tone="neutral" dot={false}>All sites</StatusChip> : null}
                <StatusChip tone={state.tone === 'error' ? 'warn' : state.tone}>{state.text}</StatusChip>
              </li>
            );
          })}
        </ul>
      )}
    </SettingsCard>
  );
}
