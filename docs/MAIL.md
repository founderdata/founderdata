# Mail (Pro)

FounderData Pro sends and receives email on your own domains through Cloudflare. Cloudflare Email Service sends, and
Email Routing receives. Three kinds of callers use it:

- Your apps send through an API that answers like Resend's, so they keep the `resend` package and change the base URL
  and the key. That includes Resend's templates: the HTML lives in FounderData, and an app sends it by name.
- You read and answer mail on the dashboard's **Mail** page.
- Agents read and answer it through `/api/v1/mail` or the MCP tool `mail`.

Mail belongs to the deployment, not to a site. One inbox and one sent log cover every domain you add.

## What it needs

- FounderData Pro ([PRO.md](PRO.md)).
- Cloudflare's Workers Paid plan, $5 a month. It includes 3,000 sent messages a month and charges $0.35 per 1,000
  after that. On the free plan Cloudflare sends only to addresses you verified by hand.
- A domain whose DNS is on the same Cloudflare account.
- An R2 bucket and a queue. Setup creates both.

## Set it up

1. Run setup with the mail flag. It creates the R2 bucket and the queue, both named `<database name>-mail`, writes
   their bindings into `wrangler.local.jsonc` and deploys. A database in the EU gets an EU bucket.

   ```bash
   npm run setup -- --mail
   ```

2. Give the Worker a Cloudflare API token and your account id. Mail sends and receives without them. With them the
   Domains tab can set a domain up for you, show each DNS record's state, keep the suppression list in step with
   Cloudflare's and find the status of a message whose delivery event never arrived.

   ```bash
   node scripts/wrangler.mjs secret put CLOUDFLARE_API_TOKEN
   node scripts/wrangler.mjs secret put CLOUDFLARE_ACCOUNT_ID
   ```

   The token reads the zone and the account's analytics, and edits Email Sending, Email Routing and Queues. When a
   step on the Domains tab fails, its message quotes Cloudflare's error, which names the missing permission.

3. Open **Mail**, **Domains**, and add the domain. Pick sending, receiving or both. With the token set, FounderData
   finds the domain's zone, turns on Email Sending and Email Routing, points the catch-all rule at the Worker and
   subscribes the domain's delivery events to the queue. Without the token the tab lists the commands to run instead.

4. Wait for the DNS records to read **verified**. Cloudflare adds them to a zone it hosts. **Check again** reads
   their state.

5. A new domain starts with the catch-all address `*`, so all its mail lands in the inbox. Add the addresses you send
   from or want to sort, such as `support`. See [Receive mail](#receive-mail).

6. Send a test with **New message** on the Inbox tab to a mailbox you own, and answer it. The answer shows up in the
   same thread.

Until step 1 is done, the Mail page and every mail route say which piece is missing.

## DNS records

Cloudflare creates these when sending is on for `acme.example`:

| Record | Name | Value |
| --- | --- | --- |
| MX, 3 of them | `cf-bounce.acme.example` | `route1.mx.cloudflare.net` to `route3.mx.cloudflare.net` |
| TXT (SPF) | `cf-bounce.acme.example` | `v=spf1 include:_spf.mx.cloudflare.net ~all` |
| TXT (DKIM) | `cf-bounce._domainkey.acme.example` | the public key |
| TXT (DMARC) | `_dmarc.acme.example` | `v=DMARC1; p=reject;`, only when the domain has no DMARC record |

Receiving adds three MX records on the domain itself, an SPF record and a DKIM record at `cf2024-1._domainkey`.

Two things to check before you turn a domain on:

- **Another service sends from the domain.** A new `p=reject` DMARC record makes receivers refuse that service's mail
  unless it signs with DKIM for your domain. Keep your own DMARC record if you have one.
- **Another mailbox provider receives for the domain.** Email Routing refuses a domain that has other MX records,
  such as Google Workspace. Receive on a subdomain instead, such as `reply.acme.example`.

## Receive mail

Each address on a domain has one action:

| Action | What happens to a message |
| --- | --- |
| `inbox` | Stored, threaded and shown in the inbox. Posts `email.received` to your webhooks. |
| `forward` | Forwarded to one address and not stored. Cloudflare forwards only to destination addresses you verified in Email Routing. When it refuses, the message goes to the inbox. |
| `webhook` | Stored for 30 days outside the inbox, and posted as `email.received`. For mail an app reads. |
| `drop` | Accepted and thrown away. |

The address `*` takes mail for every address without its own entry. Each new domain gets one with the action
`inbox`. An exact address wins over `*`. Mail to an address with no entry and no `*` is rejected, and the sender gets
a bounce.

**On a subdomain, add a routing rule per address.** Cloudflare's catch-all rule works on the zone's own name only.
For `reply.acme.example` in the zone `acme.example`, open Email Routing in the Cloudflare dashboard, then **Routing
rules**, and create a custom address for each address you added here, with the action **Send to a Worker** and your
FounderData Worker as the destination. FounderData does not create these rules. The Domains tab says so for a
subdomain, and `*` receives nothing there.

A message can be 25 MB. A larger one is rejected. A message stores up to 50 of the To and Cc addresses it names.

Replies join a thread through their `In-Reply-To` and `References` headers, matched against mail of the same domain.
Without those headers a message joins a thread by subject and sender, but only when Cloudflare's DMARC check passed
and the same address received both. Anyone can write a From line, so mail that fails the check starts its own thread.
When a message names a Reply-To address that is not its sender, the inbox shows where a reply would go.

A received message waits on a queue to be stored. When storing fails, the queue tries again after 30 seconds, then
with longer waits, 8 times over about 16 hours. After that an hourly job puts the message on the queue again. A
message that could not be stored for 7 days is deleted and the Worker's log says so.

## The Mail page

Only the owner sees it. Viewers and viewer teammates get no mail. The iPhone app has its own view of the inbox, see
[On the iPhone app](#on-the-iphone-app).

- **Inbox** lists threads with their unread count. Open one to read it, reply, archive it or delete it. HTML mail
  renders in a sandboxed frame, and remote images stay blocked until you allow them for that message.
- **Sent** lists every sent message with its status and delivery events, from apps, the dashboard and agents. Open
  one to see it as it was sent, while its body is stored. Filter by domain or by template.
- **Templates** groups by domain the templates you keep here and the kinds of mail your apps send without one. See
  [Templates](#templates).
- **Domains** holds the domains, their DNS records and their addresses.
- **API** shows the base URL, your endpoints for webhooks and which domains each key may send from. **Copy AI
  prompt** gives a coding agent the steps to move one app off Resend.
- **Suppressions** lists the addresses mail is not sent to.

## On the iPhone app

The owner's iPhone app shows five folders: Inbox, Sent (threads you wrote in), Archive, Trash and All (everything
outside the trash). It filters by unread or read and by attachments, marks threads read or unread, archives them,
moves them to the trash and back, deletes them for good from the trash, opens attachments, and replies inside a
thread in plain text with up to 10 files of 15 MB in all. It cannot write to a new address or send HTML. A reply from
the phone goes only to people already in the thread, so a Reply-To that names a stranger is not followed. Each phone
may send 50 replies in 24 hours, or the number in the Worker variable `PHONE_MAIL_DAILY_REPLIES` (1 to 1,000). The
Sent tab shows these replies with the source iPhone app.

A thread in the trash is in no other folder and no count: not in the inbox's unread count, the app badge, the
dashboard's thread list or an agent's. It keeps whether it was archived and goes back there when you take it out. A
new message from outside takes it out of the trash and puts it in the inbox, as it does for an archived thread, and
pushes like any new message. A reply you send into a thread in the trash leaves it there. After 30 days in the trash
the hourly retention job deletes the thread for good with its messages and files.

The phone can also push each received message. Pushes start off on every phone. In the app's alert settings you turn
them on and choose domains, addresses, first messages of a thread only, and whether to skip likely spam (on by
default). Only mail that lands in the inbox of an `inbox` address pushes, and mail from your own domains never does.
With `PHONE_PII=0` on the Worker the phone gets no mail and no mail push. The routes, the push and the spam rule are in
[MOBILE-API.md](MOBILE-API.md#10-mail).

## Move an app off Resend

Change two values in the app and keep its code:

| | Resend | FounderData |
| --- | --- | --- |
| Base URL | `https://api.resend.com` | `https://founderdata.example.com/api/mail` |
| API key | `re_...` | a key with the `mail:write` scope, `fdk_...` (Settings, Agents) |

The Node package reads the base URL from the environment:

```bash
RESEND_BASE_URL=https://founderdata.example.com/api/mail
RESEND_API_KEY=fdk_...
```

A `mail:write` key sends, and reads back the mail it sent itself. It cannot read the inbox, and it cannot read what
another key, the dashboard or an agent sent: those answer 404. On the API tab each key has three limits:

- **Domains.** Keep a key to some domains, and it sends from those only. When its last domain is removed the key
  sends from none until you pick domains again or lift the limit.
- **Recipients in 24 hours.** 1,000 by default, counted across `to`, `cc` and `bcc`, over the last 24 hours. Set
  another number for a key, up to 1,000,000. Past the cap a send answers `429` with the name `daily_quota_exceeded`,
  as Resend does. Sends that ended `failed` or `suppressed` do not count. The cap limits what a leaked key can send.
- **Replies only.** The key answers in a thread, to the people already in it, and cannot write to a new address.

These routes answer as Resend's do:

| Route | Notes |
| --- | --- |
| `POST /emails` | `from`, `to`, `cc`, `bcc`, `subject`, `text`, `html`, `reply_to`, `headers`, `tags`, `attachments` with base64 `content` or an https `path`. Answers `{ "id": "..." }`. |
| `POST /emails/batch` | Up to 100 messages. One invalid message fails the batch before anything is sent. `data` has one id per message, in the order of the request. |
| `GET /emails`, `GET /emails/:id` | The messages this key sent. `text` and `html` are `null` once the body was deleted after 30 days. |
| `GET /emails/:id/attachments`, `GET /emails/:id/attachments/:attachment_id` | Names and sizes. `download_url` returns the bytes. |
| `GET /domains`, `GET /domains/:id` | Read only. |

The `Idempotency-Key` header works as on Resend. The same key and body within 24 hours answer the first `id` and send
nothing. The same key with another body answers 409.

A message Cloudflare took is never sent twice. If the Worker cannot store the result, the answer is still the `id`,
and a job marks the message `sent` within 10 minutes. If the request ended before Cloudflare confirmed the message,
it ends as `failed` with the code `E_SEND_UNCONFIRMED`: it may or may not have gone out. Its `Idempotency-Key` then
answers that `id` and does not send again.

What differs from Resend:

- `download_url` is a route of this API. Fetch it with the same `Authorization` header. It does not expire while the
  body is stored.
- Sending uses the first `reply_to` address. The message's record keeps all of them.
- Received mail is not on this API. The package's `emails.receiving` calls answer 404. An app gets inbound mail from
  the `email.received` webhook, and an agent reads the inbox with a `mail:read` key.
- Open and click tracking, `scheduled_at`, broadcasts, contacts and audiences answer 422 in Resend's error shape. So
  do creating or changing domains, webhooks and API keys through the API.
- Templates work, with the differences listed under [Templates](#templates).
- A message can have 50 recipients across `to`, `cc` and `bcc`, 32 attachments and 18 MB in all. A request larger
  than 25 MB answers `413`.
- In a batch, a message the mail service refused keeps its id and its place in `data`, with the status `failed` or
  `suppressed`. A message that could not be stored at all is missing from `data` and listed in
  `errors: [{ "index": 2, "message": "..." }]`, the shape Resend answers in permissive mode.
- An attachment's `filename`, `content_type` and `content_id` may hold no line break, and `content_type` is a plain
  media type such as `application/pdf`. A `path` is an https URL on a public host name. Redirects are followed 3
  times at most, each to an address that passes the same check.
- Cloudflare refuses the headers it writes itself, such as `Message-ID` and `Date`. A send with one of them fails with
  a 422 that names the header.

## Webhooks

Add an endpoint under **Mail**, **API**, and pick its event types. Each post is signed the way Resend signs, with the
`svix-id`, `svix-timestamp` and `svix-signature` headers and a secret that starts with `whsec_`, so Resend's
verification code works unchanged.

```json
{
  "type": "email.delivered",
  "created_at": "2026-11-18T08:25:31.000+00:00",
  "data": {
    "email_id": "6f1c2a9e-0b7d-4c7e-9f0a-3d5b8e1c2a47",
    "from": "Acme <hello@acme.example>",
    "to": ["ann@example.net"],
    "subject": "Your invoice",
    "created_at": "2026-11-18T08:25:30.123+00:00",
    "tags": { "category": "invoice" }
  }
}
```

The types are `email.sent`, `email.delivered`, `email.delivery_delayed`, `email.bounced`, `email.complained`,
`email.failed`, `email.suppressed` and `email.received`. `email.received` also carries `text`, `html`, `headers` and
`message_id`.

An endpoint has 10 seconds to answer with a 2xx status. A failed post is tried again after 30 seconds, 2 minutes, 10
minutes, 1 hour, 3 hours, 6 hours and 12 hours, 8 attempts over about 22 hours. An endpoint is switched off once
every attempt failed for 24 hours and there were at least 20, and the API tab says so. An outage of a few minutes does
not switch it off, however many events it misses in that time.

## Delivery status and suppressions

A sent message moves from `queued` to `sent` when Cloudflare takes it, then to `delivered`, `delivery_delayed`,
`bounced`, `complained` or `failed`. Cloudflare reports these as events on the queue, usually within seconds. Events
can go missing, so every 5 minutes the Worker asks Cloudflare's analytics about each message that is still `sent`
after 10 minutes, up to 31 days back. That check needs the API token.

A message to several addresses has one status, the highest any recipient reached, so one bounce among them makes it
`bounced` and posts `email.bounced`, also when another recipient was delivered first. The Worker keeps checking such a
message until every recipient has a final status. Cloudflare's analytics do not say which recipient bounced. An event
does, and suppresses that address at once. Without the event the address reaches the suppression list from
Cloudflare's own list, which the Worker copies once an hour.

A hard bounce or a spam complaint puts the address on the suppression list at once. The next send to it fails with a
422, is stored as `suppressed` and posts `email.suppressed`. Remove an address on the Suppressions tab to send to it
again. With the API token, entries are copied to and from Cloudflare's own list. Removing a domain moves its entries
to "every domain", so an address that bounced stays suppressed when you add the domain again.

Link a domain to a site on the Domains tab, and that site's [Email panel](GUIDE.md#email-resend-pro) counts the mail
sent from it.

## Health alerts

Once an hour, at minute 20, the Worker looks for broken mail and posts what it finds to your alert channels as **Mail
problems** ([GUIDE.md](GUIDE.md#alerts-and-weekly-report)). Every channel has it on, older ones included. A deployment
without mail never sends it. Each alert also goes to the [alert inbox](GUIDE.md#alert-inbox-pro).

**A domain breaks.** Each domain with sending or receiving on gets the same check as **Check again** once a day, at
most 2 domains an hour. The check needs the API token, and a domain added before the token existed needs one **Check
again** first. An alert goes out when the status leaves `verified`, when Email Routing is not `ready`, when the
catch-all rule stops sending mail to the Worker, or when the check finds a problem the last one did not. Its title
names the first new problem, such as "Mail for acme.example: DKIM record missing", and its lines list every problem
with its fix. It goes out once per change, not every day. When the domain passes again, a short note says so. If
Cloudflare or a DNS lookup does not answer, the check counts for nothing and runs again the next hour.

**Sends fail.** A message that ends `failed` counts: Cloudflare refused it, the request ended before Cloudflare
confirmed it, or Cloudflare reported that delivery failed. A bounce comes from the recipient's server and does not
count. Each domain alerts at most once a day, with the number of failed messages since its last alert, 24 hours at
most, and the latest error.

**Received mail is lost.** The Worker counts three things. A message it could not parse is kept with its headers and
the raw file. A message still not stored after 16 hours of retries goes back on the queue. A message not stored after
7 days is deleted. One alert a day at most gives the counts since the last one.

The JSON webhook gets `event` and these fields:

| `event` | Fields |
| --- | --- |
| `domain_problem` | `domain` (`id`, `name`), `site` (`id`, `name`, `domain`, or null), `status`, `problems`, `new_problems` |
| `domain_ok` | `domain`, `site` |
| `send_failed` | `domain`, `site`, `failed` (the count), `since`, `last_error`, `last_failed_at` |
| `inbound_failed` | `unreadable`, `requeued`, `lost` |

A channel that covers only some sites gets a domain's alerts when the domain is linked to one of them, or to no site.
Every channel that takes Mail problems gets the received-mail alert.

One run makes 1 D1 read when there is nothing to do. A domain's check makes about 6 calls to Cloudflare and one DNS
lookup per record name, 15 subrequests or so. The run reads every message sent in the last 2 days once, to count the
failed ones.

## Templates

A template is HTML you keep in FounderData and send by its id or alias, with values for its variables. Change the
template and the next send uses the new version. The app does not need a deploy.

```js
await resend.emails.send({
  to: 'ann@example.net',
  template: { id: 'welcome', variables: { NAME: 'Ann', SEATS: 3 } },
});
```

Each template belongs to one of your mail domains. That is the domain of its from address, or the one you pick when
it has none.

### Write one

Use the dashboard (Mail, Templates, **New template**), Resend's calls (`resend.templates.create`, `update`,
`publish`, `duplicate`, `remove`, `get`, `list`), or the agent API and the MCP tool `mail`. A template has:

| Field | |
| --- | --- |
| `name` | Required, up to 100 characters. |
| `alias` | Optional. A second name a send can use, such as `welcome`. Letters, digits, dots, dashes and underscores. Unique across the deployment. |
| `from`, `subject`, `reply_to` | Optional defaults. A send that names its own wins. |
| `html` | Required, up to 512 KB. |
| `text` | Optional. Leave it out and the text part is made from the HTML at send. An empty string sends no text part. |
| `variables` | Up to 50, each `{ key, type, fallback_value }`. |

A placeholder is `{{{KEY}}}` in `html`, `subject` or `text`. Each one needs a variable, or the save answers 422. A key
has up to 50 ASCII letters, digits and underscores, and case matters. `FIRST_NAME`, `LAST_NAME`, `EMAIL`,
`UNSUBSCRIBE_URL`, `RESEND_UNSUBSCRIBE_URL`, `contact` and `this` are reserved, as on Resend.

A new template is a draft. Sends use the published version only, so publish it first. Editing a published template
changes its draft, and sends keep the published version until you publish again. FounderData keeps the 10 newest
published versions. The dashboard shows them, and **Restore** puts one back in the draft.

### Send one

`template: { id, variables }` takes the place of `html` and `text`. A send with both answers 422. The send's `from`,
`subject` and `reply_to` win over the template's. Without them the template's are used, and when it has none either,
the send answers 422. The from address has to be on the template's domain.

Each value fills its placeholders:

- In `html` it is HTML-escaped, so a name such as `<b>Ann</b>` shows as written and adds no markup.
- In `subject` and `text` it goes in as written. A line break in a subject value becomes a space.
- A missing value takes the variable's `fallback_value`. A variable with neither answers 422 and nothing is sent.
- A `number` variable takes a JSON number. A `string` variable takes a string or a number.
- A string can have 2,000 characters.
- A value for a key the template does not declare answers 422. This catches a typo that would otherwise send the
  fallback.

A sent message records the template, the version and the language it was made from. The Sent tab filters by template,
and the Templates tab counts each template's sends over 30 days.

### Languages

A template has one default language and can have spin-offs: the same email in other languages. Each language has its
own subject, HTML and text. The name, alias, from address, reply-to and variables are shared, so a send passes the same
values whatever the language. Publishing puts out every language at once as one version.

A send asks for a language in the template id, which works through the `resend` package:

```js
await resend.emails.send({ to: 'ann@example.net', template: { id: 'welcome:de', variables: { NAME: 'Ann' } } });
```

Over plain HTTP, `template: { id: 'welcome', language: 'de' }` works too. The package drops any field of `template`
other than `id` and `variables`, which is why the id carries it. FounderData picks the first of these the template has:

1. The language asked for, such as `de-at`.
2. Its base language, `de`.
3. The template's default language.

The sent message records which language went out. A template without a language set is English.

In the dashboard, the editor's **Languages** bar adds a language as a copy of the default to translate, removes one, and
makes another one the default. Through the API, create takes `language` (the default, `en` when left out) and
`languages`, an object of language tags and `{ subject, html, text }`. An update changes the default language's
subject, html and text, or another language's when the body names it in `language`; a language the template lacks
starts as a copy of the default. `languages` sets several at once, and `null` removes one. `default_language` makes a
spin-off the default. A template holds 20 languages and 1.5 MB of html and text across them.

### Who can change them

`mail:templates` is a scope of its own. It creates, changes, publishes and deletes templates, and it sends nothing. A
`mail:write` key sends with templates and reads them, and a call that changes one answers `403`. A leaked app key
therefore cannot rewrite the password-reset mail your app sends. Give a build or an agent that uploads templates a
`mail:templates` key. A key kept to some domains on the API tab sees and changes their templates only.

### What your apps send without templates

The Templates tab also lists, per domain, the kinds of mail your apps sent over the last 30 days through the API. It
groups each message by the first of these it has:

1. The template it was made from.
2. A tag named `category`, such as `tags: [{ name: 'category', value: 'receipt' }]`.
3. The shape of its subject. Addresses, links, amounts, dates, numbers, ids and a greeted name come out, so "Your
   receipt #4821 for $12.00" and "Your receipt #4822 for $9.50" are one kind.

Each kind shows its sends and delivery counts and the newest message. The preview needs that message's body, which is
kept for 30 days. Mail from the dashboard and from agents is left out, unless it used a template. The tab reads the
newest 20,000 sent messages and says so when there were more.

### Where it differs from Resend

Resend's docs leave these open. FounderData does the following, and an app that relies on another behavior may need a
change.

- Values are HTML-escaped in `html`. Placeholders also work in `subject` and `text`, and `{{{ KEY }}}` with spaces
  works. `{{KEY}}` with two braces is plain text.
- Variable types are `string` and `number`. Any other type answers 422.
- A send with a value for an undeclared variable answers 422.
- `GET /templates/:id` answers the draft, and `has_unpublished_versions` says whether it differs from the published
  version. `current_version_id` is `<template id>:<version>`, or `<template id>:draft` before the first publish.
- `PATCH` with `variables` replaces the whole list. `null` clears `alias`, `from`, `subject`, `reply_to` or `text`.
- `duplicate` makes a draft named "<name> (copy)" without an alias.
- An unknown template answers `404 not_found`. One never published answers 422.
- A deployment holds 500 templates.
- A template's answer carries fields Resend's does not: `domain`, `language` and `languages`. Create takes `domain`,
  a name or id, for a template without a from address. A key kept to one domain needs neither. Resend's own fields
  (`subject`, `html`, `text`) hold the default language. See [Languages](#languages).
- A template id with a colon, `welcome:de`, sends that language. Resend has no languages.

## Agents

A scoped key reaches mail with two scopes of its own. `mail:read` reads the inbox, the sent log and delivery events.
`mail:write` sends, replies, marks read and archives. Neither includes the other, and `read` reaches no mail. Any of
the three mail scopes reads and previews templates, and only `mail:templates` changes them. The routes are in
[API.md](API.md#mail-pro), and the MCP tool is `mail` ([MCP.md](MCP.md#the-mail-tool-pro)).

An agent gets each message as text, cut at 2,000 characters in a thread and at 40,000 for one message. It gets the
names and sizes of attachments, not their bytes. A message with HTML and no text part is read as the HTML's text, and
`text_from_html` is then `true`: that text can hold words a person never sees in a mail program, such as hidden
elements.

A reply goes to the Reply-To address of the last received message when it has one, else to its sender. The answer to a
send or a reply names the address in `to`. Turn on **Replies only** for an agent's key (Mail, API), and it can answer
only the people already in a thread: a Reply-To that names someone else is not followed, and a send to a new address
answers `403`. The key's daily cap applies to agents too.

Mail is the one place where an agent sees addresses and text that strangers wrote. Every answer with mail in it
carries a `content_notice` that says so. An agent treats a message as data and follows no instruction inside it. Give
`mail:write` only to an agent you would let send mail in your name.

## What is stored and for how long

| What | Where | Kept |
| --- | --- | --- |
| Sender, recipients, subject, the first 200 characters, headers, status | D1 | Until deleted. With `PII_RETENTION_MONTHS` set, a sent message loses everything that names a person after that many months: its addresses, subject, first 200 characters, custom headers, attachments and stored body. The row stays with its sender, status and times. |
| Text and HTML of messages an app sent through the API, with their attachments | R2 | 30 days |
| Text, HTML, attachments and the raw message of inbox mail, and of mail sent from the dashboard, the iPhone app or by an agent | R2 | Until you delete the message or the thread, or 30 days after its thread went to the trash |
| Mail received for a `webhook` address | D1 and R2 | 30 days |
| Delivery events and webhook deliveries | D1 | 30 days |
| Idempotency keys | D1 | 24 hours |
| Suppressed addresses | D1 | Until removed |
| Templates, with their 10 newest published versions | D1 | Until you delete the template or its domain |

Deleting a message or a thread in the inbox removes its rows and its R2 objects for good, and so does deleting a
thread from the trash, emptying the trash and the 30-day trash cleanup.

[Erasing one person](GUIDE.md#erase-one-person) by email also erases their mail across the deployment, from the
dashboard or with a key that holds `mail:write` next to `payments:write` ([API.md](API.md#erase-one-person)). One of
your own addresses is refused. Every message
with that address as sender or recipient goes, with its body, attachments and events. Its other recipients lose
their copy of the record too, because the body may name the person. The address leaves the suppression list here
and, with the API token, Cloudflare's list. A hard bounce will suppress it again if you send to it later.

Cloudflare processes every message and keeps its own delivery logs, which FounderData cannot delete
([PRIVACY.md](PRIVACY.md#what-cloudflare-processes)).

## Limits

- One provider. Cloudflare sends and receives, and there is no fallback.
- No open or click tracking, no scheduled sends, no broadcasts, no contact lists.
- Cloudflare publishes no sending rate limit. New accounts start with a low daily quota that Cloudflare raises by
  itself.
- A subdomain needs a routing rule per address, added by hand ([Receive mail](#receive-mail)).
- The inbox has no labels, drafts or search inside message text. Search covers subjects and addresses. The folders
  are fixed: inbox, sent, archive, trash and all.
- The iPhone app replies inside a thread only, in plain text with at most 10 files of 15 MB in all, and cannot
  compose a new message.
- Deleting from the trash and emptying it handle 15 messages per request, so a long thread or a full trash takes
  several calls. The app repeats them. The rule keeps a request inside the 50 subrequests of the Workers free plan.

## What it costs in D1 rows

| Path | Rows written |
| --- | --- |
| An app sends to one address | 18, plus 2 for each further address and 1 for each attachment |
| The same with an `Idempotency-Key` | 21. A repeat writes 0 |
| The same with a template | 1 more, for the template's index |
| Create a template / change its draft / publish it | 3 / 1 / 3. Publishing an unchanged draft writes 0 |
| The dashboard sends / an agent sends | 23 / 24, because the message starts a thread |
| A reply in a thread, from the dashboard / by an agent / from the iPhone app | 21 / 22 / 22, plus 1 for each attachment |
| Move a thread to the trash / take it out | 3 / 1. A thread already there writes 0 |
| Delete a thread for good from the trash, or by emptying it | What D1 counts for the deleted rows: 10 for a thread with one received message |
| The iPhone app's mail push switches: on or off / a domain or address switched | 1 / 1 each. A switch already in that state writes 0 |
| A received message that pushes to phones | Nothing more than receiving it, plus 1 when APNs calls a phone's token dead |
| A status event, such as delivered | 5. The same event again writes 0 |
| A received message that starts a thread / one that joins a thread | 15 / 14 |
| A webhook delivery | 4 when queued, plus 1 or 2 for each attempt |
| Mark a thread read / archive it | 1 for each unread message, plus 1 / 1 |
| A new message in a thread in the trash, which takes it out | The same as in any thread |
| Reading the inbox, the sent log, a message, the templates or the catalog | 0 |
| Health alerts: an hour with nothing to check or report / a domain's daily check / an alert | 0 / 1, plus 1 when its problems change / 2, its alert inbox row and the row that keeps it to once a day or once per change |
| A received message that could not be parsed, or that the hourly sweep queues again or deletes | 1 more, for the count the health alert reads |

At 100 sent and 20 received messages a day, mail writes about 2,600 rows. Workers Paid includes 50 million a month.
