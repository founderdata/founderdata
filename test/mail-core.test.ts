// What core gives FounderData Pro's mail (migration 0070, pro/docs/mail-plan.md): the email() and queue() exports and
// their Pro hooks, the erase hook, the owner-only /api/mail-admin/* rule, the account-wide key check with the mail
// scopes, Standard Webhooks signing, and the in-memory bindings tests use.
import { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { denied } from '../src/worker/auth';
import type { AppEnv } from '../src/worker/env';
import { NO_MAIL_HANDLER } from '../src/worker/mail-reject';
import { accountKeyOf, resetKeysForTests, SCOPES, SCOPE_TEXT, type AccountScope } from '../src/worker/keys';
import { newWebhookSecret, signStandardWebhook, verifyStandardWebhook } from '../src/worker/lib/crypto';
import { installPro, proHooks, type Pro } from '../src/worker/pro-hooks';
import { itCore } from './helpers/edition';
import { FakeQueue, FakeR2, FakeSendEmail, rawMail } from './helpers/mail';
import { startWorker, type TestWorker } from './helpers/worker';

describe('mail in core', () => {
  let w: TestWorker;
  let bucket: FakeR2;
  let queue: FakeQueue;
  let email: FakeSendEmail;
  const installed = proHooks();
  /** Run with Pro's hooks plus `extra`, then put the edition back. */
  const withHooks = (extra: Partial<Pro>) => installPro({ ...(installed ?? {}), ...extra });

  beforeAll(async () => {
    bucket = new FakeR2();
    queue = new FakeQueue();
    email = new FakeSendEmail();
    w = await startWorker({ VIEWER_PASSWORD: 'viewer-password', MAIL_BUCKET: bucket.asBinding(), MAIL_QUEUE: queue.asBinding(), EMAIL: email.asBinding() });
  });
  afterAll(() => w.dispose());
  afterEach(() => installPro(installed));

  it('has the mail tables, with mail_domains.site_id the only link to a site', async () => {
    const tables = (await w.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'mail_%' ORDER BY name").all<{ name: string }>()).results.map((r) => r.name);
    expect(tables).toEqual([
      'mail_addresses', 'mail_attachments', 'mail_domains', 'mail_events', 'mail_idempotency', 'mail_key_domains', 'mail_key_settings',
      'mail_message_ids', 'mail_messages', 'mail_parties', 'mail_suppressions', 'mail_template_versions', 'mail_templates', 'mail_threads', 'mail_webhook_deliveries', 'mail_webhooks',
    ]);
    for (const t of tables) {
      const cols = (await w.db.prepare(`PRAGMA table_info(${t})`).all<{ name: string }>()).results.map((c) => c.name);
      expect(cols.includes('site_id'), t).toBe(t === 'mail_domains');
    }
  });

  itCore('rejects inbound mail when no mail handler is installed', async () => {
    const m = await w.email(rawMail({ from: 'Ann <ann@sender.example>', to: 'hello@acme.example' }), { from: 'bounce@sender.example', to: 'hello@acme.example' });
    expect(m.rejected).toBe(NO_MAIL_HANDLER);
  });

  it('hands inbound mail to the Pro hook with the env and context', async () => {
    const seen: { to: string; subject: string | null; hasBucket: boolean }[] = [];
    withHooks({
      email: async (message, env) => {
        seen.push({ to: message.to, subject: message.headers.get('subject'), hasBucket: !!env.MAIL_BUCKET });
      },
    });
    const m = await w.email(rawMail({ from: 'ann@sender.example', to: 'hello@acme.example', subject: 'Hi there' }), { from: 'b@sender.example', to: 'hello@acme.example' });
    expect(m.rejected).toBeNull();
    expect(seen).toEqual([{ to: 'hello@acme.example', subject: 'Hi there', hasBucket: true }]);
  });

  itCore('acks queue messages when no queue handler is installed', async () => {
    queue.push({ type: 'cf.email.sending.message.delivered' }, { kind: 'parse' });
    expect(await queue.drain(w.queue)).toMatchObject({ acked: 2, retried: 0, left: 0 });
  });

  it('hands queue batches to the Pro hook, which acks and retries', async () => {
    withHooks({
      queue: async (batch) => {
        for (const m of batch.messages) ((m.body as { ok: boolean }).ok ? m.ack() : m.retry());
      },
    });
    queue.push({ ok: true }, { ok: false });
    const r = await queue.drain(w.queue, { maxRounds: 3 });
    expect(r).toMatchObject({ acked: 1, retried: 3, left: 1 });
    queue.pending = [];
  });

  it('adds the Pro erase counts to the erase answer and the erase log, for an erase by email only', async () => {
    const site = await w.createSite();
    const calls: string[] = [];
    withHooks({
      erasePerson: async ({ email: who, env }) => {
        calls.push(who);
        expect(env.DB).toBeTruthy();
        return { mail_messages: 3, mail_objects: 5 };
      },
    });
    const byEmail = await w.admin(`/api/sites/${site.id}/erase`, { method: 'POST', json: { email: ' Ann@Sender.example ' } });
    expect(byEmail.status).toBe(200);
    expect(byEmail.body).toMatchObject({ ok: true, visitors: 0, mail_messages: 3, mail_objects: 5 });
    expect(calls).toEqual(['ann@sender.example']);
    const byUser = await w.admin(`/api/sites/${site.id}/erase`, { method: 'POST', json: { user_id: 'u1' } });
    expect(byUser.body.mail_messages).toBeUndefined();
    expect(calls).toHaveLength(1);
    const log = JSON.parse((await w.db.prepare("SELECT counts FROM erasures WHERE site_id = ? AND method = 'email'").bind(site.id).first<string>('counts'))!);
    expect(log).toMatchObject({ mail_messages: 3, mail_objects: 5 });
  });

  it('erases mail only for the owner or a key that also holds mail:write, and stops on a refusal before anything is erased', async () => {
    const site = await w.createSite();
    resetKeysForTests();
    const newKey = async (name: string, scopes: string[]) => (await w.admin('/api/v1/keys', { method: 'POST', json: { name, scopes, sites: [site.id] } })).body.key as string;
    const payments = await newKey('payments only', ['payments:write']);
    const both = await newKey('payments and mail', ['payments:write', 'mail:write']);
    const calls: string[] = [];
    let refusal: { error: string; status: 400 | 503 } | null = null;
    withHooks({
      erasePerson: async ({ email: who }) => {
        calls.push(who);
        return { mail_messages: 1 };
      },
      eraseRefusal: async () => refusal,
    });
    const erase = async (secret: string, who: string) => {
      const res = await w.fetch('/api/v1/erase', { method: 'POST', json: { email: who }, headers: { cookie: '', authorization: `Bearer ${secret}` } });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };
    // A key for one site's payments, and the site's own key, never reach the deployment's mail.
    const skipped = await erase(payments, 'ann@sender.example');
    expect(skipped).toMatchObject({ status: 200, body: { ok: true, mail_skipped: true } });
    expect(skipped.body.mail_messages).toBeUndefined();
    expect(await erase(site.api_key, 'ann@sender.example')).toMatchObject({ status: 200, body: { mail_skipped: true } });
    expect(calls).toEqual([]);
    // With mail:write as well, the key erases mail like the owner.
    const done = await erase(both, 'ann@sender.example');
    expect(done).toMatchObject({ status: 200, body: { ok: true, mail_messages: 1 } });
    expect(done.body.mail_skipped).toBeUndefined();
    expect(calls).toEqual(['ann@sender.example']);

    // A refusal answers its status and erases nothing, not even the site's own rows.
    await w.db.prepare("INSERT INTO visitors (id, site_id, first_seen, email) VALUES ('v-refused', ?, 1, 'support@acme.example')").bind(site.id).run();
    refusal = { error: 'support@acme.example is one of this deployment\'s own addresses.', status: 400 };
    const before = (await w.db.prepare('SELECT COUNT(*) AS n FROM erasures').first<number>('n'))!;
    expect(await erase(both, 'support@acme.example')).toMatchObject({ status: 400, body: { error: expect.stringMatching(/own addresses/) } });
    expect((await w.admin(`/api/sites/${site.id}/erase`, { method: 'POST', json: { email: 'support@acme.example' } })).status).toBe(400);
    expect(calls).toHaveLength(1);
    expect(await w.db.prepare("SELECT email FROM visitors WHERE id = 'v-refused'").first('email')).toBe('support@acme.example');
    expect(await w.db.prepare('SELECT COUNT(*) AS n FROM erasures').first('n')).toBe(before);
    // The refusal is about mail. A key that cannot touch mail is not asked, and erases the site's rows as before.
    expect(await erase(payments, 'support@acme.example')).toMatchObject({ status: 200, body: { visitors: 1, mail_skipped: true } });
  });

  it('removes a revoked key\'s mail settings and domains', async () => {
    const made = (await w.admin('/api/v1/keys', { method: 'POST', json: { name: 'gone', scopes: ['mail:write'] } })).body as { id: string };
    await w.db.batch([
      w.db.prepare("INSERT INTO mail_key_domains (key_id, domain_id) VALUES (?, 'dom_1')").bind(made.id),
      w.db.prepare('INSERT INTO mail_key_settings (key_id, restricted, reply_only, daily_cap) VALUES (?, 1, 1, 50)').bind(made.id),
    ]);
    expect((await w.admin(`/api/v1/keys/${made.id}`, { method: 'DELETE' })).status).toBe(200);
    expect(await w.db.prepare('SELECT COUNT(*) AS n FROM mail_key_domains WHERE key_id = ?').bind(made.id).first('n')).toBe(0);
    expect(await w.db.prepare('SELECT COUNT(*) AS n FROM mail_key_settings WHERE key_id = ?').bind(made.id).first('n')).toBe(0);
  });

  it('keeps viewers, viewer teammates and phones off /api/mail-admin/*, whatever the method', async () => {
    const env = w.env;
    for (const role of ['viewer', 'device'] as const) {
      for (const method of ['GET', 'POST', 'DELETE']) {
        expect(denied(role, method, '/api/mail-admin/status', env), `${role} ${method}`).toMatch(/Mail/);
        expect(denied(role, method, '/api/mail-admin', env), `${role} ${method}`).toMatch(/Mail/);
      }
    }
    // A phone is pointed at its own mail routes. Its mail actions there (read state, archive, reply) are writes a phone
    // may make, next to chart notes (FounderData Pro, docs/MOBILE-API.md section 10).
    expect(denied('device', 'GET', '/api/mail-admin/threads', env)).toBe('Mail on a phone goes through /api/mobile/mail, not the dashboard routes.');
    for (const path of ['/api/mobile/mail/threads/t1/read', '/api/mobile/mail/threads/t1/archive', '/api/mobile/mail/threads/t1/reply']) {
      expect(denied('device', 'POST', path, env), path).toBeNull();
      expect(denied('viewer', 'POST', path, env), path).not.toBeNull();
    }
    // Only the mail-admin prefix: a similar path is not caught.
    expect(denied('viewer', 'GET', '/api/mail-administrator', env)).toBeNull();

    const login = await w.fetch('/api/auth/login', { method: 'POST', headers: { cookie: '' }, json: { password: 'viewer-password' } });
    const viewer = (login.headers.get('set-cookie') ?? '').split(';')[0];
    const res = await w.fetch('/api/mail-admin/status', { headers: { cookie: viewer } });
    expect(res.status).toBe(403);
    expect((await res.json<any>()).error).toBe('Mail is for owners. Ask an owner.');
    // Without a login at all: 401 before anything else.
    expect((await w.fetch('/api/mail-admin/status', { headers: { cookie: '' } })).status).toBe(401);
  });

  it('refuses a mail-admin write from another origin, even for the owner', async () => {
    const res = await w.fetch('/api/mail-admin/domains', { method: 'POST', headers: { origin: 'https://evil.example' }, json: {} });
    expect(res.status).toBe(403);
    expect((await res.json<any>()).error).toMatch(/dashboard/);
  });

  itCore('answers 404 on mail-admin routes for the owner in core', async () => {
    expect((await w.admin('/api/mail-admin/status')).status).toBe(404);
  });

  describe('account-wide key check (keys.ts accountKeyOf)', () => {
    const probe = new Hono<AppEnv>();
    probe.get('/probe/:scope', async (c) => {
      const auth = await accountKeyOf(c, c.req.param('scope') as AccountScope);
      return 'error' in auth ? c.json({ error: auth.error }, auth.status) : c.json({ id: auth.key.id });
    });
    const call = (scope: string, key?: string) =>
      probe.fetch(new Request(`http://localhost/probe/${scope}`, { headers: key ? { authorization: `Bearer ${key}` } : {} }), w.env, { waitUntil() {}, passThroughOnException() {} } as any);
    const make = async (scopes: string[], sites?: string[]) => {
      const r = await w.admin('/api/v1/keys', { method: 'POST', json: { name: `k-${scopes.join('-')}`, scopes, ...(sites ? { sites } : {}) } });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      return r.body.key as string;
    };

    it('lists the mail scopes with their texts', () => {
      expect(SCOPES).toContain('mail:read');
      expect(SCOPES).toContain('mail:write');
      expect(SCOPES).toContain('mail:templates');
      expect(SCOPE_TEXT['mail:write']).toMatch(/does not include mail:read/);
      expect(SCOPE_TEXT['mail:templates']).toMatch(/sends nothing/);
    });

    it('needs the exact mail scope: read, mail:read and mail:write do not stand in for each other', async () => {
      resetKeysForTests();
      const read = await make(['read', 'read:revenue', 'read:rows', 'notes:write', 'payments:write']);
      const mailRead = await make(['mail:read']);
      const mailWrite = await make(['mail:write']);
      const site = await w.createSite();
      const oneSite = await make(['mail:write'], [site.id]);

      expect((await call('mail:read')).status).toBe(401);
      expect((await call('mail:read', 'fdk_unknownunknownunknown1')).status).toBe(401);
      const r = await call('mail:read', read);
      expect(r.status).toBe(403);
      expect((await r.json<any>()).error).toMatch(/needs the mail:read scope/);
      expect((await call('mail:write', read)).status).toBe(403);
      expect((await call('mail:read', mailRead)).status).toBe(200);
      expect((await call('mail:write', mailRead)).status).toBe(403);
      expect((await call('mail:write', mailWrite)).status).toBe(200);
      expect((await call('mail:read', mailWrite)).status).toBe(403);
      // mail:templates changes templates and neither sends nor reads, and the other mail scopes do not include it.
      const templates = await make(['mail:templates']);
      expect((await call('mail:templates', templates)).status).toBe(200);
      expect((await call('mail:write', templates)).status).toBe(403);
      expect((await call('mail:read', templates)).status).toBe(403);
      expect((await call('mail:templates', mailWrite)).status).toBe(403);
      // Mail belongs to the deployment: a key for one site still reaches it with the scope.
      expect((await call('mail:write', oneSite)).status).toBe(200);
      // The site API key (rt_...) belongs to one site and never reaches mail.
      expect((await call('mail:write', site.api_key)).status).toBe(401);
    });
  });

  it('signs a Standard Webhooks delivery that verifyStandardWebhook accepts', async () => {
    const secret = newWebhookSecret();
    expect(secret).toMatch(/^whsec_[A-Za-z0-9+/]{32}$/);
    const now = Date.UTC(2026, 10, 18, 9, 0, 0);
    const ts = Math.floor(now / 1000);
    const body = JSON.stringify({ type: 'email.delivered', data: { email_id: 'e1' } });
    const signature = await signStandardWebhook(secret, 'msg_1', ts, body);
    expect(signature).toMatch(/^v1,[A-Za-z0-9+/]+=*$/);
    expect(await verifyStandardWebhook(secret, { id: 'msg_1', timestamp: String(ts), signature }, body, now)).toBe(true);
    expect(await verifyStandardWebhook(secret, { id: 'msg_1', timestamp: String(ts), signature }, `${body} `, now)).toBe(false);
    expect(await verifyStandardWebhook(secret, { id: 'msg_2', timestamp: String(ts), signature }, body, now)).toBe(false);
    expect(await verifyStandardWebhook(newWebhookSecret(), { id: 'msg_1', timestamp: String(ts), signature }, body, now)).toBe(false);
    // Svix's documented example: secret, id, timestamp and body give this signature.
    const svix = await signStandardWebhook('whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw', 'msg_p5jXN8AQM9LWM0D4loKWxJek', 1614265330, '{"test": 2432232314}');
    expect(svix).toBe('v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=');
  });

  it('has bindings tests can use: R2, queue and send_email fakes', async () => {
    await bucket.put('msg/a/body.json', JSON.stringify({ text: 'hi' }), { httpMetadata: { contentType: 'application/json' } });
    await bucket.put('msg/a/att/0', new Uint8Array([1, 2, 3]));
    await bucket.put('msg/b/raw.eml', new Response('raw').body);
    expect(await (await bucket.get('msg/a/body.json'))!.json()).toEqual({ text: 'hi' });
    expect((await bucket.head('msg/a/att/0'))!.size).toBe(3);
    const page = await bucket.list({ prefix: 'msg/a/', limit: 1 });
    expect(page.objects.map((o) => o.key)).toEqual(['msg/a/att/0']);
    expect(page.truncated).toBe(true);
    expect((await bucket.list({ prefix: 'msg/a/', cursor: page.cursor })).objects.map((o) => o.key)).toEqual(['msg/a/body.json']);
    await bucket.delete(['msg/a/att/0', 'msg/a/body.json']);
    expect(bucket.text('msg/b/raw.eml')).toBe('raw');
    expect(await bucket.get('msg/a/att/0')).toBeNull();

    const sent = await email.send({ from: { email: 'hello@mail-test.example', name: 'Team' }, to: 'ann@sender.example', subject: 'Hi', text: 'x' });
    expect(sent.messageId).toMatch(/^<[A-Za-z0-9]{36}@mail-test\.example>$/);
    email.failNext('E_RECIPIENT_SUPPRESSED', 'suppressed');
    await expect(email.send({ from: 'hello@mail-test.example', to: 'x@sender.example', subject: 'Hi' })).rejects.toMatchObject({ code: 'E_RECIPIENT_SUPPRESSED' });
    email.failNext(undefined, 'internal error');
    const err = await email.send({ from: 'hello@mail-test.example', to: 'x@sender.example', subject: 'Hi' }).catch((e) => e);
    expect(err.code).toBeUndefined();
    expect(email.sent).toHaveLength(1);

    await queue.send({ a: 1 }, { delaySeconds: 30 });
    expect(queue.sent.at(-1)).toMatchObject({ body: { a: 1 }, delaySeconds: 30 });
    queue.pending = [];
  });
});
