// The local paste page of `npm run connect`: one screen on 127.0.0.1 where the person pastes a key, so the value goes
// from the browser straight to Wrangler or the dashboard API and the coding agent never sees it.
//
// Security: the server listens on 127.0.0.1 only, on a random port, under a random one-time path. It answers 404 to any
// other path and 421 to any other Host header (a DNS rebinding page can't reach it), accepts JSON only from its own
// origin, saves once, and closes after the save or after 10 minutes. The page has a strict CSP with a per-page nonce,
// sends no referrer (the path is the token), and is never cached. Nothing here logs a value.
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Instrument Serif italic (OFL, scripts/lib/fonts) and Inter from the installed @fontsource-variable/inter, as base64. */
function fontData(cwd) {
  const read = (path) => {
    try {
      return readFileSync(path).toString('base64');
    } catch {
      return null;
    }
  };
  return {
    serif: read(join(HERE, 'fonts', 'instrument-serif-latin-400-italic.woff2')),
    inter: read(join(cwd, 'node_modules', '@fontsource-variable', 'inter', 'files', 'inter-latin-wght-normal.woff2')),
  };
}

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const CSS = `
:root{--canvas:#fff;--card:#f5f5f2;--input:#fff;--line:rgb(0 0 0/.08);--line-strong:rgb(0 0 0/.16);--ink:#1a1a1c;--ink-2:#38383b;
--muted:#66666b;--faint:#7a7a80;--btn-bg:#1a1a1c;--btn-hover:#000;--btn-fg:#fff;--soft:rgb(0 0 0/.05);--soft-hover:rgb(0 0 0/.09);
--good:#16884f;--good-soft:rgb(46 230 166/.2);--bad:#c4302b;--mint:#2ee6a6;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--canvas:#07080b;--card:#101116;--input:#0a0b0f;--line:rgb(255 255 255/.08);
--line-strong:rgb(255 255 255/.16);--ink:#f2f2f0;--ink-2:#c9cacd;--muted:#a0a1a6;--faint:#8a8b91;--btn-bg:#2ee6a6;--btn-hover:#5cf0bd;
--btn-fg:#04130d;--soft:rgb(255 255 255/.06);--soft-hover:rgb(255 255 255/.1);--good:#48c484;--good-soft:rgb(46 230 166/.14);--bad:#f5706a;color-scheme:dark}}
*,*::before,*::after{box-sizing:border-box}
[hidden]{display:none!important}
html{background:var(--canvas);-webkit-text-size-adjust:100%}
body{margin:0;min-height:100vh;background:var(--canvas);color:var(--ink);font:400 16px/1.6 'Inter Variable',ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif;
letter-spacing:-.011em;font-feature-settings:'cv11' 1,'ss03' 1;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale}
main{max-width:36rem;margin:0 auto;padding:clamp(2.5rem,9vh,6.5rem) 16px 3rem}
.eyebrow{display:inline-flex;align-items:center;gap:.5rem;margin:0;font-size:.8125rem;font-weight:500;color:var(--muted)}
.dot{width:7px;height:7px;border-radius:999px;background:var(--mint)}
h1{margin:1.25rem 0 0;font-size:clamp(2.375rem,1.5rem + 3.6vw,3.5rem);line-height:1.04;letter-spacing:-.05em;font-weight:450;text-wrap:balance}
h1:focus{outline:none}
.serif{font-family:'Instrument Serif','Iowan Old Style',Georgia,serif;font-style:italic;font-weight:400;letter-spacing:-.02em}
.lede{margin:1rem 0 0;max-width:32rem;font-size:1.0625rem;line-height:1.55;letter-spacing:-.015em;color:var(--muted);text-wrap:pretty}
.panel{margin-top:2.25rem;padding:1.5rem;border-radius:28px;background:var(--card)}
@media (min-width:560px){.panel{padding:2rem}}
.field+.field{margin-top:1.5rem}
.row{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:.25rem 1rem}
label,.label{font-size:.9375rem;font-weight:560;letter-spacing:-.015em}
.name{margin-left:.5rem;font:500 .75rem/1 ui-monospace,'SF Mono',Menlo,Consolas,monospace;color:var(--faint);letter-spacing:0}
.opt{margin-left:.375rem;font-size:.8125rem;font-weight:400;color:var(--faint)}
a.find{font-size:.875rem;font-weight:500;color:var(--ink-2);text-decoration:underline;text-decoration-color:var(--line-strong);text-underline-offset:3px;border-radius:6px}
a.find:hover{color:var(--ink);text-decoration-color:currentColor}
.row p{margin:0}
.hint{margin:.25rem 0 .75rem;font-size:.875rem;line-height:1.5;color:var(--muted)}
.wrap{position:relative}
input[type=text],input[type=password]{width:100%;height:3.25rem;padding:0 4.5rem 0 1rem;border:1px solid var(--line-strong);border-radius:14px;background:var(--input);
color:var(--ink);font:400 1rem/1 ui-monospace,'SF Mono',Menlo,Consolas,monospace;letter-spacing:0}
input[type=text].plain{padding-right:1rem}
input::placeholder{color:var(--faint)}
input[aria-invalid=true]{border-color:var(--bad)}
.toggle{position:absolute;top:50%;right:.5rem;transform:translateY(-50%);height:2.25rem;padding:0 .875rem;border:0;border-radius:999px;background:var(--soft);
color:var(--ink-2);font-family:inherit;font-size:.8125rem;font-weight:500;line-height:1;cursor:pointer}
.toggle:hover{background:var(--soft-hover)}
.drop{display:flex;align-items:center;gap:.75rem;min-height:3.25rem;padding:.625rem 1rem;border:1px dashed var(--line-strong);border-radius:14px;background:var(--input);cursor:pointer}
.drop:hover{border-color:var(--ink-2)}
.drop input{position:absolute;width:1px;height:1px;opacity:0}
.drop:focus-within{outline:2px solid var(--ink);outline-offset:3px}
.drop .pick{flex:none;height:2.25rem;padding:0 .875rem;display:inline-flex;align-items:center;border-radius:999px;background:var(--soft);font-size:.8125rem;font-weight:500}
.drop .file{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:.875rem;color:var(--muted)}
.have{display:flex;align-items:center;gap:.5rem;min-height:3.25rem;padding:0 1rem;border-radius:14px;background:var(--good-soft);font-size:.875rem;font-weight:500}
.err{margin:.5rem 0 0;font-size:.875rem;color:var(--bad)}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:.5rem;height:3.25rem;padding:0 1.75rem;border:0;border-radius:999px;background:var(--btn-bg);
color:var(--btn-fg);font-family:inherit;font-size:1rem;font-weight:500;line-height:1;letter-spacing:-.015em;cursor:pointer;
box-shadow:0 1px 2px rgb(0 0 0/.2),0 10px 24px -12px rgb(0 0 0/.45);transition:background-color .16s,transform .12s}
.btn:hover{background:var(--btn-hover)}
.btn:active{transform:scale(.98)}
.btn[disabled]{opacity:.55;cursor:progress}
.btn.secondary{background:var(--soft);color:var(--ink);box-shadow:none}
.btn.secondary:hover{background:var(--soft-hover)}
.actions{display:flex;flex-wrap:wrap;gap:.75rem;margin-top:1.75rem}
@media (max-width:479px){.actions .btn{flex:1 1 100%}}
.status{margin:.75rem 0 0;font-size:.875rem;color:var(--muted)}
.status.bad{color:var(--bad)}
.value{margin:0;padding:1rem;border-radius:14px;background:var(--input);border:1px solid var(--line-strong);font:400 .9375rem/1.5 ui-monospace,'SF Mono',Menlo,Consolas,monospace;
letter-spacing:0;word-break:break-all;user-select:all}
.foot{margin:1.5rem 0 0;font-size:.8125rem;color:var(--faint)}
.check{display:grid;place-items:center;width:3.5rem;height:3.5rem;margin-top:1.75rem;border-radius:999px;background:var(--good-soft);color:var(--good)}
:focus-visible{outline:2px solid var(--ink);outline-offset:3px}
input:focus-visible{outline:2px solid var(--ink);outline-offset:2px;border-color:transparent}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
`;

const CHECK = '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

function fieldHtml(f, i, prefilled) {
  const id = `f${i}`;
  const desc = `${id}-hint ${id}-err`;
  const optional = f.optional ? '<span class="opt">Optional</span>' : '';
  const head = `<div class="row"><label for="${id}">${esc(f.label)}${optional}<span class="name">${esc(f.name)}</span></label><a class="find" href="${esc(f.url)}" target="_blank" rel="noreferrer noopener">Find it here<span aria-hidden="true"> ↗</span></a></div>
<p class="hint" id="${id}-hint">${esc(f.where)}${f.kind === 'file' ? '' : ` It ${esc(f.check.says)}.`}</p>`;
  const err = `<p class="err" id="${id}-err" hidden></p>`;
  if (prefilled[f.name] !== undefined) {
    return `<div class="field">${head}<p class="have" id="${id}">${CHECK.replace('26', '18').replace('26', '18')}${esc(prefilled[f.name].from)}</p></div>`;
  }
  if (f.kind === 'file') {
    return `<div class="field" data-field="${esc(f.name)}" data-kind="file">${head}<label class="drop" for="${id}"><span class="pick">Choose file</span><span class="file" id="${id}-file">No file chosen. You can also drop it here.</span><input id="${id}" type="file" accept="${esc(f.accept ?? '')}" aria-describedby="${desc}"${f.optional ? '' : ' required'}></label>${err}</div>`;
  }
  const secret = f.kind === 'secret';
  const input = `<input id="${id}" class="${secret ? '' : 'plain'}" type="${secret ? 'password' : 'text'}" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" aria-describedby="${desc}"${f.optional ? '' : ' required'}>`;
  const toggle = secret ? `<button type="button" class="toggle" data-for="${id}" aria-pressed="false" aria-label="Show ${esc(f.label)}">Show</button>` : '';
  return `<div class="field" data-field="${esc(f.name)}" data-kind="${f.kind}">${head}<div class="wrap">${input}${toggle}</div>${err}</div>`;
}

const SCRIPT = `
const $=(s,r=document)=>r.querySelector(s);
const files={};
for(const b of document.querySelectorAll('.toggle'))b.addEventListener('click',()=>{const i=document.getElementById(b.dataset.for);const show=i.type==='password';i.type=show?'text':'password';b.textContent=show?'Hide':'Show';b.setAttribute('aria-pressed',String(show));i.focus()});
async function readFile(field,file){if(!file)return;if(file.size>65536){showErr(field,'That file is too big for a key.');return}files[field.dataset.field]=await file.text();$('.file',field).textContent=file.name;showErr(field,'')}
for(const field of document.querySelectorAll('[data-kind=file]')){const input=$('input',field);input.addEventListener('change',()=>readFile(field,input.files[0]));const drop=$('.drop',field);
drop.addEventListener('dragover',e=>{e.preventDefault()});drop.addEventListener('drop',e=>{e.preventDefault();readFile(field,e.dataTransfer.files[0])})}
function showErr(field,msg){const p=$('.err',field);const i=$('input',field);p.textContent=msg;p.hidden=!msg;if(i)i.setAttribute('aria-invalid',msg?'true':'false')}
function show(id){for(const s of document.querySelectorAll('main>section'))s.hidden=s.id!==id;const h=$('#'+id+' h1');if(h){h.tabIndex=-1;h.focus()}}
async function copy(btn,text){try{await navigator.clipboard.writeText(text);btn.textContent='Copied'}catch{btn.textContent='Select and copy it'}}
function reveal(r){const box=$('#reveal');if(!r||!box)return;$('#reveal-label').textContent=r.label;$('#reveal-value').textContent=r.value;$('#reveal-hint').textContent=r.hint||'';box.hidden=false;$('#reveal-copy').addEventListener('click',e=>copy(e.currentTarget,r.value))}
async function post(body){try{const r=await fetch(location.pathname,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});return{status:r.status,json:await r.json().catch(()=>({}))}}catch{return null}}
const form=$('#form');
if(form)form.addEventListener('submit',async e=>{e.preventDefault();const btn=$('button[type=submit]',form);const status=$('#status');const values={};
for(const field of form.querySelectorAll('[data-field]')){showErr(field,'');values[field.dataset.field]=field.dataset.kind==='file'?(files[field.dataset.field]??''):$('input',field).value}
btn.disabled=true;status.className='status';status.textContent='Saving...';const res=await post({values});btn.disabled=false;
if(!res){status.className='status bad';status.textContent='The connect command stopped. Run it again for a new page.';return}
if(res.status===200&&res.json.ok){form.reset();for(const k in files)delete files[k];$('#done-note').textContent=res.json.note||'';show('done');reveal(res.json.reveal);return}
let first=null;for(const [name,msg] of Object.entries(res.json.errors||{})){const field=form.querySelector('[data-field="'+name+'"]');if(field){showErr(field,msg);first=first||$('input',field)}}
status.className='status bad';status.textContent=res.json.message||(first?'Check the field marked in red.':'That did not work. Run the connect command again.');
if(res.json.final){btn.disabled=true}if(first)first.focus()});
const done=$('#done-btn');if(done)done.addEventListener('click',async()=>{await post({done:true});show('done')});
const cp=$('#copy-btn');if(cp)cp.addEventListener('click',()=>copy(cp,$('#shown-value').textContent));
`;

/**
 * The page. `mode` 'paste' shows the form; 'show' shows a value FounderData made (once) with a copy button; 'gone' says
 * the link was used. `prefilled` maps field names that need no input (read from a file) to `{ from }`.
 */
export function renderPage({ nonce, provider, fields = [], prefilled = {}, mode = 'paste', shown = null, site = null, cwd = process.cwd(), fonts = fontData(cwd) }) {
  const faces = [
    fonts.serif ? `@font-face{font-family:'Instrument Serif';font-style:italic;font-weight:400;font-display:swap;src:url(data:font/woff2;base64,${fonts.serif}) format('woff2')}` : '',
    fonts.inter ? `@font-face{font-family:'Inter Variable';font-style:normal;font-weight:100 900;font-display:swap;src:url(data:font/woff2;base64,${fonts.inter}) format('woff2-variations')}` : '',
  ].join('');
  const where = site ? ` for ${esc(site.name || site.id)}` : '';
  const done = `<section id="done"${mode === 'gone' ? '' : ' hidden'}><div class="check">${CHECK}</div><h1><span class="serif">Saved.</span></h1><p class="lede">You can close this tab.</p><p class="foot" id="done-note"></p>
<div class="panel" id="reveal" hidden><p class="label" id="reveal-label"></p><p class="hint" id="reveal-hint"></p><p class="value" id="reveal-value"></p><div class="actions"><button class="btn" type="button" id="reveal-copy">Copy</button></div></div></section>`;
  let body;
  if (mode === 'gone') {
    body = `<section id="gone"><h1>This link is <span class="serif">used</span></h1><p class="lede">Each page saves once. Run the connect command again for a new one.</p></section>`;
  } else if (mode === 'show') {
    const f = fields[0];
    body = `<section id="form-view"><h1>Your ${esc(provider.label)} <span class="serif">header</span></h1>
<p class="lede">FounderData made this value and saved it${where}. Paste it into ${esc(provider.label)} now. This page shows it once.</p>
<div class="panel"><div class="row"><p class="label">${esc(f.label)}</p><a class="find" href="${esc(f.url)}" target="_blank" rel="noreferrer noopener">Open ${esc(provider.label)}<span aria-hidden="true"> ↗</span></a></div>
<p class="hint">${esc(f.where)}</p><p class="value" id="shown-value">${esc(shown)}</p>
<div class="actions"><button class="btn" type="button" id="copy-btn">Copy</button><button class="btn secondary" type="button" id="done-btn">Done</button></div></div>
<p class="foot">Lost it? Run the generate command again. It makes a new value and the old one stops working.</p></section>${done.replace('<h1><span class="serif">Saved.</span></h1><p class="lede">You can close this tab.</p>', '<h1><span class="serif">Done.</span></h1><p class="lede">You can close this tab.</p>')}`;
  } else {
    body = `<section id="form-view"><h1>Connect <span class="serif">${esc(provider.label)}</span></h1>
<p class="lede">What you paste goes straight to your FounderData${where}. Your coding agent only hears that it was saved.</p>
<form class="panel" id="form" novalidate autocomplete="off">${fields.map((f, i) => fieldHtml(f, i, prefilled)).join('\n').replace(/<input id="(f\d+)"/, '<input autofocus id="$1"')}
<div class="actions"><button class="btn" type="submit">Save</button></div><p class="status" id="status" role="status" aria-live="polite"></p></form>
<p class="foot">This page runs on your computer only. It saves once and closes after 10 minutes.</p></section>${done}`;
  }
  const title = mode === 'show' ? `${provider.label} header` : `Connect ${provider?.label ?? ''}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><meta name="robots" content="noindex">
<title>${esc(title)} · FounderData</title><style nonce="${nonce}">${faces}${CSS}</style></head>
<body><main><p class="eyebrow"><span class="dot"></span>FounderData</p>${body}</main><script nonce="${nonce}">${SCRIPT}</script></body></html>`;
}

/** Headers of every answer: no cache, no referrer, no framing, and a CSP that allows only this page's own nonce. */
function headers(nonce, type) {
  return {
    'content-type': type,
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
    'content-security-policy': `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; font-src data:; img-src data:; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'`,
  };
}

/**
 * Serves the page until one save works, the person presses Done (show mode), or `timeoutMs` passes.
 * `submit(values)` stores the values and answers `{ ok: true, note?, reveal? }` or `{ ok: false, errors?, message?, final? }`.
 * Resolves `{ status: 'saved' | 'done' | 'timeout' | 'failed', result }`. `onUrl(url)` gets the page address.
 */
export function servePastePage({ provider, fields, prefilled = {}, mode = 'paste', shown = null, site = null, submit, timeoutMs = 600_000, onUrl, cwd = process.cwd(), maxTries = 8 }) {
  const token = randomBytes(24).toString('base64url');
  const path = `/${token}`;
  const fonts = fontData(cwd);
  let used = false;
  let viewed = false;
  let busy = false;
  let tries = 0;
  return new Promise((resolve, reject) => {
    let finished = false;
    const server = createServer();
    const finish = (status, result = null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      server.close();
      server.closeAllConnections?.();
      resolve({ status, result });
    };
    const timer = setTimeout(() => finish('timeout'), timeoutMs);
    server.on('request', (req, res) => {
      const port = server.address().port;
      const remote = req.socket.remoteAddress ?? '';
      const nonce = randomBytes(16).toString('base64');
      const send = (code, body, type = 'application/json; charset=utf-8') => {
        res.writeHead(code, headers(nonce, type));
        res.end(typeof body === 'string' ? body : JSON.stringify(body));
      };
      if (!['127.0.0.1', '::ffff:127.0.0.1'].includes(remote)) return send(403, { ok: false });
      if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host ?? '')) return send(421, { ok: false });
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
      if (url.pathname !== path) return send(404, { ok: false });
      if (req.method === 'GET') {
        // A value FounderData made shows once: a reload gets the "used" page.
        const gone = used || (mode === 'show' && viewed);
        viewed = true;
        return send(gone ? 410 : 200, renderPage({ nonce, provider, fields, prefilled, mode: gone ? 'gone' : mode, shown, site, cwd, fonts }), 'text/html; charset=utf-8');
      }
      if (req.method !== 'POST') return send(405, { ok: false });
      const origin = req.headers.origin;
      if (origin && origin !== `http://${req.headers.host}`) return send(403, { ok: false });
      if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) return send(415, { ok: false });
      if (used) return send(410, { ok: false, final: true, message: 'This page already saved. Run the connect command again for a new one.' });
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > 128 * 1024) req.destroy();
        else chunks.push(c);
      });
      req.on('end', async () => {
        let body;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          return send(400, { ok: false, message: 'The page sent something unreadable. Reload it.' });
        }
        if (mode === 'show') {
          if (body?.done !== true) return send(400, { ok: false });
          used = true;
          send(200, { ok: true });
          return finish('done');
        }
        if (busy) return send(409, { ok: false, message: 'Still saving.' });
        busy = true;
        tries++;
        let out;
        try {
          out = await submit(body?.values && typeof body.values === 'object' ? body.values : {});
        } catch (e) {
          out = { ok: false, final: true, message: e?.message || 'Saving failed.' };
        }
        busy = false;
        if (out.ok) {
          used = true;
          send(200, { ok: true, note: out.note ?? null, reveal: out.reveal ?? null });
          return finish('saved', out);
        }
        const final = out.final || tries >= maxTries;
        send(out.final ? 502 : 400, { ok: false, errors: out.errors ?? null, message: out.message ?? null, final });
        if (final) {
          used = true;
          finish('failed', out);
        }
      });
    });
    server.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    server.listen(0, '127.0.0.1', () => onUrl?.(`http://127.0.0.1:${server.address().port}${path}`));
  });
}
