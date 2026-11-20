import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { dataLocation } from '../src/worker/location';

// Plain .mjs script; a non-literal path keeps TypeScript from looking for its types.
const SCRIPT = '../scripts/setup.mjs';
const ID = '3f2b9c1e-8d4a-4f6b-9e2d-1a7c5b8e0f42';

describe('scripts/setup.mjs', () => {
  it('reads --record and ends --replay with each site\'s Record visits link', async () => {
    const { readRecord, replayNextStep } = await import(/* @vite-ignore */ SCRIPT);
    expect(readRecord(['--replay'])).toBeNull();
    expect(readRecord(['--replay', '--record', 'all'])).toBe('all');
    expect(readRecord(['--record=site1'])).toBe('site1');
    expect(() => readRecord(['--record', '--replay'])).toThrow(/needs a site id or all/);
    const url = 'https://founderdata.example.com';
    const sites = [{ id: 'a1', name: 'Acme' }, { id: 'b2', domain: 'acme.example' }];
    expect(replayNextStep(url, sites)).toEqual([
      '  Next: turn on Record visits for each site you want to record:',
      `    Acme: ${url}/site/a1/settings#record-visits`,
      `    acme.example: ${url}/site/b2/settings#record-visits`,
    ]);
    expect(replayNextStep(url, sites, ['a1'])[1]).toBe(`    Acme (on): ${url}/site/a1/settings#record-visits`);
    expect(replayNextStep(url, [])).toEqual([`  Next: add a site in ${url}, then turn on Record visits in its settings.`]);
  });

  it('finds a database by name in `wrangler d1 list --json` output', async () => {
    const { findDatabase } = await import(/* @vite-ignore */ SCRIPT);
    const list = `\n ⛅️ wrangler 4\n[{ "uuid": "${ID}", "name": "founderdata" }, { "uuid": "other", "name": "blog" }]`;
    expect(findDatabase(list, 'founderdata')).toBe(ID);
    expect(findDatabase(list, 'missing')).toBeNull();
    expect(findDatabase('Not logged in', 'founderdata')).toBeNull();
  });

  it('tells a deployment on the hourly cron about the 5-minute one, and says nothing to the shipped config', async () => {
    const { staleCronNotice } = await import(/* @vite-ignore */ SCRIPT);
    const shipped = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
    expect(shipped).toContain('"*/5 * * * *"');
    expect(staleCronNotice(shipped)).toBeNull();
    const old = shipped.replace('"*/5 * * * *"', '"0 * * * *"');
    expect(staleCronNotice(old)).toMatch(/\*\/5 \* \* \* \*/);
    expect(staleCronNotice('{ "triggers": { "crons": ["0 7 * * *"] } }')).toBeNull();
  });

  it('warns about a config that lists both the hourly cron and the 5-minute one', async () => {
    const { staleCronNotice } = await import(/* @vite-ignore */ SCRIPT);
    const shipped = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
    const both = shipped.replace('"*/5 * * * *"', '"0 * * * *", "*/5 * * * *"');
    const note = staleCronNotice(both);
    expect(note).toMatch(/both the hourly cron/);
    expect(note).toMatch(/run twice/);
  });

  it('renames the database in a config and keeps the comments', async () => {
    const { readDatabaseName, writeDatabaseName } = await import(/* @vite-ignore */ SCRIPT);
    const config = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
    expect(readDatabaseName(config)).toBe('founderdata');
    const updated = writeDatabaseName(config, 'my-analytics');
    expect(readDatabaseName(updated)).toBe('my-analytics');
    const comments = (text: string) => text.split('\n').filter((l) => l.trim().startsWith('//'));
    expect(comments(updated)).toEqual(comments(config));
  });

  it('writes the jurisdiction as a var the Worker reads', async () => {
    const { writeVar, databaseJurisdiction } = await import(/* @vite-ignore */ SCRIPT);
    const config = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
    const strip = (t: string) => JSON.parse(t.replace(/^\s*\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1'));
    const once = writeVar(config, 'DATA_JURISDICTION', 'eu');
    expect(strip(once).vars).toEqual({ DATA_JURISDICTION: 'eu' });
    expect(strip(once).d1_databases).toEqual(strip(config).d1_databases);
    expect(writeVar(once, 'DATA_JURISDICTION', 'eu')).toBe(once);
    expect(strip(writeVar(once, 'DATA_JURISDICTION', 'fedramp')).vars).toEqual({ DATA_JURISDICTION: 'fedramp' });
    expect(strip(writeVar('{ "name": "x", "vars": { "A": "1" } }', 'DATA_JURISDICTION', 'eu')).vars).toEqual({ DATA_JURISDICTION: 'eu', A: '1' });
    expect(strip(writeVar('{ "name": "x", "vars": {} }', 'DATA_JURISDICTION', 'eu')).vars).toEqual({ DATA_JURISDICTION: 'eu' });
    const list = `[{ "uuid": "${ID}", "name": "founderdata", "jurisdiction": "EU" }, { "uuid": "other", "name": "blog" }]`;
    expect(databaseJurisdiction(list, 'founderdata')).toBe('eu');
    expect(databaseJurisdiction(list, 'blog')).toBeNull();
  });

  describe('--mail', () => {
    const strip = (t: string) => JSON.parse(t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1'));
    const opts = { bucket: 'founderdata-mail', queue: 'founderdata-mail' };
    const consumer = { queue: 'founderdata-mail', max_batch_size: 3, max_batch_timeout: 2, max_retries: 8 };

    it('keeps the committed config free of mail bindings, so a deploy works on an account without R2 or Queues', () => {
      const shipped = strip(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
      expect(shipped.r2_buckets).toBeUndefined();
      expect(shipped.queues).toBeUndefined();
      expect(shipped.send_email).toBeUndefined();
    });

    it('adds the three bindings to the shipped config, with the EU jurisdiction, and keeps every comment', async () => {
      const { writeMailBindings } = await import(/* @vite-ignore */ SCRIPT);
      const config = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
      const { text, notes } = writeMailBindings(config, { ...opts, jurisdiction: 'eu' });
      const j = strip(text);
      expect(j.send_email).toEqual([{ name: 'EMAIL' }]);
      expect(j.r2_buckets).toEqual([{ binding: 'MAIL_BUCKET', bucket_name: 'founderdata-mail', jurisdiction: 'eu' }]);
      expect(j.queues).toEqual({ producers: [{ binding: 'MAIL_QUEUE', queue: 'founderdata-mail' }], consumers: [consumer] });
      expect(j.d1_databases).toEqual(strip(config).d1_databases);
      expect(notes).toEqual([]);
      const comments = (t: string) => t.split('\n').filter((l) => l.trim().startsWith('//'));
      expect(comments(text).slice(0, comments(config).length)).toEqual(comments(config));
      // Idempotent: a second run changes nothing.
      expect(writeMailBindings(text, { ...opts, jurisdiction: 'eu' }).text).toBe(text);
      expect(strip(writeMailBindings(config, opts).text).r2_buckets).toEqual([{ binding: 'MAIL_BUCKET', bucket_name: 'founderdata-mail' }]);
    });

    it('patches a local config that already has other bindings, and leaves what is there', async () => {
      const { writeMailBindings } = await import(/* @vite-ignore */ SCRIPT);
      const local = `{
  "name": "founderdata",
  // a comment with brackets [ { that must not count
  "send_email": [ { "name": "ALERTS" } ],
  "r2_buckets": [],
  "queues": { "producers": [ { "binding": "OTHER", "queue": "other" } ], },
  "vars": { "DATA_JURISDICTION": "eu" }
}`;
      const { text } = writeMailBindings(local, opts);
      const j = strip(text);
      expect(j.send_email).toEqual([{ name: 'EMAIL' }, { name: 'ALERTS' }]);
      expect(j.r2_buckets).toEqual([{ binding: 'MAIL_BUCKET', bucket_name: 'founderdata-mail' }]);
      expect(j.queues.producers).toEqual([{ binding: 'MAIL_QUEUE', queue: 'founderdata-mail' }, { binding: 'OTHER', queue: 'other' }]);
      expect(j.queues.consumers).toEqual([consumer]);
      expect(j.vars).toEqual({ DATA_JURISDICTION: 'eu' });
      expect(text).toContain('// a comment with brackets [ { that must not count');
      expect(writeMailBindings(text, opts).text).toBe(text);
    });

    it('leaves an existing EMAIL binding as it is, and says when it only sends to fixed addresses', async () => {
      const { writeMailBindings } = await import(/* @vite-ignore */ SCRIPT);
      const local = '{ "name": "x", "send_email": [{ "name": "EMAIL", "destination_address": "me@acme.example" }] }';
      const { text, notes } = writeMailBindings(local, opts);
      expect(strip(text).send_email).toEqual([{ name: 'EMAIL', destination_address: 'me@acme.example' }]);
      expect(notes[0]).toMatch(/destination_address/);
    });

    it('names the bucket and queue after the database, and reads Wrangler list output', async () => {
      const { mailResourceName, listsBucket, listsQueue } = await import(/* @vite-ignore */ SCRIPT);
      expect(mailResourceName('founderdata')).toBe('founderdata-mail');
      expect(mailResourceName('My_Analytics')).toBe('my-analytics-mail');
      expect(listsBucket('name:           founderdata-mail\ncreation_date:  2026-11-18T08:00:00.000Z\n', 'founderdata-mail')).toBe(true);
      expect(listsBucket('name:           founderdata-mail-old\n', 'founderdata-mail')).toBe(false);
      const table = '┌──────┬──────────────────┐\n│ id   │ name             │\n│ abc  │ founderdata-mail │\n└──────┴──────────────────┘';
      expect(listsQueue(table, 'founderdata-mail')).toBe(true);
      expect(listsQueue(table, 'founderdata')).toBe(false);
    });
  });
});

describe('scripts/setup.mjs --replay', () => {
  const strip = (t: string) => JSON.parse(t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1'));
  const shipped = () => readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');

  it('names the bucket after the database', async () => {
    const { replayBucketName } = await import(/* @vite-ignore */ SCRIPT);
    expect(replayBucketName('founderdata')).toBe('founderdata-replay');
    expect(replayBucketName('My_Analytics')).toBe('my-analytics-replay');
    expect(replayBucketName('---')).toBe('founderdata-replay');
    expect(replayBucketName('x'.repeat(80))).toHaveLength(63);
  });

  it('adds REPLAY_BUCKET to the shipped config, with the jurisdiction, keeps every comment, and changes nothing the second time', async () => {
    const { writeReplayBinding } = await import(/* @vite-ignore */ SCRIPT);
    const config = shipped();
    const text = writeReplayBinding(config, { bucket: 'founderdata-replay', jurisdiction: 'eu' });
    expect(strip(text).r2_buckets).toEqual([{ binding: 'REPLAY_BUCKET', bucket_name: 'founderdata-replay', jurisdiction: 'eu' }]);
    expect(strip(text).d1_databases).toEqual(strip(config).d1_databases);
    const comments = (t: string) => t.split('\n').filter((l) => l.trim().startsWith('//'));
    expect(comments(text).slice(0, comments(config).length)).toEqual(comments(config));
    expect(writeReplayBinding(text, { bucket: 'founderdata-replay', jurisdiction: 'eu' })).toBe(text);
    expect(strip(writeReplayBinding(config, { bucket: 'founderdata-replay' })).r2_buckets).toEqual([{ binding: 'REPLAY_BUCKET', bucket_name: 'founderdata-replay' }]);
  });

  it('sits next to the mail bucket in a local config, in either order', async () => {
    const { writeReplayBinding, writeMailBindings } = await import(/* @vite-ignore */ SCRIPT);
    const mail = writeMailBindings(shipped(), { bucket: 'founderdata-mail', queue: 'founderdata-mail' }).text;
    const both = writeReplayBinding(mail, { bucket: 'founderdata-replay' });
    expect(strip(both).r2_buckets).toEqual([
      { binding: 'REPLAY_BUCKET', bucket_name: 'founderdata-replay' },
      { binding: 'MAIL_BUCKET', bucket_name: 'founderdata-mail' },
    ]);
    const other = writeMailBindings(writeReplayBinding(shipped(), { bucket: 'founderdata-replay' }), { bucket: 'founderdata-mail', queue: 'founderdata-mail' }).text;
    expect(strip(other).r2_buckets.map((b: any) => b.binding).sort()).toEqual(['MAIL_BUCKET', 'REPLAY_BUCKET']);
    // A REPLAY_BUCKET someone set by hand stays as it is.
    const own = '{ "name": "x", "r2_buckets": [{ "binding": "REPLAY_BUCKET", "bucket_name": "my-own" }] }';
    expect(writeReplayBinding(own, { bucket: 'founderdata-replay' })).toBe(own);
  });

  it('adds a 90-day lifecycle rule without a prompt, in the jurisdiction, once', async () => {
    const { replayLifecycleArgs, listsLifecycleRule, REPLAY_RULE } = await import(/* @vite-ignore */ SCRIPT);
    expect(replayLifecycleArgs('founderdata-replay', 'eu')).toEqual(['r2', 'bucket', 'lifecycle', 'add', 'founderdata-replay', REPLAY_RULE, '--expire-days', '90', '--force', '--jurisdiction', 'eu']);
    expect(replayLifecycleArgs('founderdata-replay')).not.toContain('--jurisdiction');
    const table = `Listing lifecycle rules for bucket 'founderdata-replay'...\nname:        ${REPLAY_RULE}\nenabled:     Yes\nprefix:      (all prefixes)\naction:      Expire objects after 90 days\n`;
    expect(listsLifecycleRule(table)).toBe(true);
    expect(listsLifecycleRule("There are no lifecycle rules for bucket 'founderdata-replay'.")).toBe(false);
    expect(listsLifecycleRule(`name: ${REPLAY_RULE}-old`)).toBe(false);
  });
});

describe('data location', () => {
  it('says EU only when the var says so', () => {
    expect(dataLocation({ DATA_JURISDICTION: 'eu' })).toMatchObject({ jurisdiction: 'eu', stored: 'EU (D1 jurisdiction eu)' });
    expect(dataLocation({ DATA_JURISDICTION: ' EU ' }).jurisdiction).toBe('eu');
    expect(dataLocation({})).toMatchObject({ jurisdiction: null, stored: 'Not pinned to a region' });
    expect(dataLocation({ DATA_JURISDICTION: 'mars' }).jurisdiction).toBeNull();
    expect(dataLocation({}).processed).toMatch(/hashes the IP address and user agent in memory/);
    // The retention the DPA paragraph quotes, in the days pruneOldData cuts at.
    expect(dataLocation({})).toMatchObject({ retention_days: 730, pii_retention_days: null });
    expect(dataLocation({ RETENTION_MONTHS: '12', PII_RETENTION_MONTHS: '6' })).toMatchObject({ retention_days: 365, pii_retention_days: 183 });
  });
});
