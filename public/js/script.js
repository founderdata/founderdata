/*! FounderData tracker: <script defer data-website-id="SITE_ID" src="https://founderdata.example.com/js/script.js"></script>
 * Cookieless by default. Add data-cookies="on" (the visitor already consented) or call founderdata('consent', true)
 * to keep a visitor id in first-party cookies; founderdata('consent', false) removes them. Marketing consent, which the
 * Meta Conversions API needs, is separate: data-marketing="on" or founderdata('marketing', true).
 * Based on minilytics by Surendra Pandar (MIT). window.minilytics, data-ml-goal, ?ml_ignore and the ml_* cookies
 * still work for one release. window.revtrail, the name before FounderData, stays as an alias: sites installed under
 * that name call it for goals and checkout attribution. */
(function () {
  'use strict';
  var w = window, d = document, loc = w.location, nav = w.navigator;
  var script = d.currentScript;
  if (!script) return;

  var siteId = script.getAttribute('data-website-id');
  var host = new URL(script.src).origin;
  var endpoint = script.getAttribute('data-api') || host + '/api/event';
  var allowLocal = script.hasAttribute('data-allow-localhost');
  var cookieDomain = script.getAttribute('data-domain');
  var VID = 'rt_vid', SID = 'rt_sid', CONSENT = 'rt_consent', MKT = 'rt_mkt', YEAR = 31536000, SESSION = 1800;
  // Names from minilytics, read once and migrated (remove after one release).
  var OLD_VID = 'ml_vid', OLD_SID = 'ml_sid', OLD_CONSENT = 'ml_consent';

  var queued = [].concat((w.founderdata && w.founderdata.q) || [], (w.revtrail && w.revtrail.q) || [],
    (w.minilytics && w.minilytics.q) || []);
  function noop() {}
  function expose(fn) { w.founderdata = fn; w.revtrail = fn; w.minilytics = fn; }

  // Opt yourself out: visit any page with ?rt_ignore=true (undo with ?rt_ignore=false). ?ml_ignore works too.
  try {
    var qs = new URLSearchParams(loc.search);
    var ig = qs.get('rt_ignore') || qs.get('ml_ignore');
    if (localStorage.getItem('ml_ignore') === '1') { localStorage.setItem('rt_ignore', '1'); localStorage.removeItem('ml_ignore'); }
    if (ig === 'true') localStorage.setItem('rt_ignore', '1');
    if (ig === 'false') localStorage.removeItem('rt_ignore');
  } catch (e) {}
  var ignored = false;
  try { ignored = localStorage.getItem('rt_ignore') === '1'; } catch (e) {}
  var local = /^(localhost|127\.|0\.0\.0\.0|\[::1\]|.*\.local$)/.test(loc.hostname) || loc.protocol === 'file:';
  if (!siteId || ignored || nav.webdriver || (local && !allowLocal)) {
    expose(noop);
    noop.attribution = function () { return {}; };
    return;
  }

  // ---- identity
  // Cookieless (default): no cookies, no storage. The server derives a visitor id from a daily-rotating hash and
  // returns it with the first response; it lives in memory for this page only.
  // Cookies: after consent, rt_vid (1 year) and rt_sid (30 minutes, sliding) on the root domain, so
  // app.site.com and site.com are one visitor. rt_consent=1 remembers the consent for later page loads.
  function readCookie(name) {
    var m = d.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : null;
  }
  var domain; // root domain for cookies, found on first use (finding it writes a test cookie)
  function rootDomain() {
    if (domain !== undefined) return domain;
    domain = null;
    if (cookieDomain) return (domain = cookieDomain);
    var parts = loc.hostname.split('.');
    if (parts.length < 2 || /^\d+$/.test(parts[parts.length - 1])) return domain;
    for (var i = parts.length - 2; i >= 0; i--) {
      var cand = parts.slice(i).join('.');
      d.cookie = 'rt_t=1; path=/; domain=' + cand + '; SameSite=Lax';
      if (readCookie('rt_t')) {
        d.cookie = 'rt_t=; path=/; domain=' + cand + '; max-age=0';
        return (domain = cand);
      }
    }
    return domain;
  }
  function writeCookie(name, value, maxAge) {
    var dom = rootDomain();
    d.cookie = name + '=' + encodeURIComponent(value) + '; path=/; max-age=' + maxAge + '; SameSite=Lax' +
      (dom ? '; domain=' + dom : '') + (loc.protocol === 'https:' ? '; Secure' : '');
  }
  function removeCookies(names) {
    var dom = rootDomain();
    (names || [VID, SID, CONSENT]).forEach(function (n) {
      d.cookie = n + '=; path=/; max-age=0';
      if (dom) d.cookie = n + '=; path=/; max-age=0; domain=' + dom;
    });
  }
  // The site's root domain without touching cookies (for telling outbound links from subdomains).
  function siteRoot() {
    if (domain || cookieDomain) return domain || cookieDomain;
    var p = loc.hostname.replace(/^www\./, '').split('.');
    var n = p.length > 2 && p[p.length - 1].length === 2 && p[p.length - 2].length <= 3 ? 3 : 2; // shop.co.uk
    return p.slice(-n).join('.');
  }
  function uuid() {
    if (w.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 3) | 8).toString(16);
    });
  }
  // Migrate the cookies of the Minilytics-named version once: same visitor, same session, same consent.
  // Without consent they are only removed.
  var dataCookies = script.getAttribute('data-cookies') === 'on';
  var oldVid = readCookie(OLD_VID), oldSid = readCookie(OLD_SID), oldConsent = readCookie(OLD_CONSENT);
  if (oldVid || oldSid || oldConsent) {
    removeCookies([OLD_VID, OLD_SID, OLD_CONSENT]);
    if (oldConsent === '1' && !readCookie(CONSENT)) writeCookie(CONSENT, '1', YEAR);
    if (oldConsent === '1' || dataCookies) {
      if (oldVid && !readCookie(VID)) writeCookie(VID, oldVid, YEAR);
      if (oldSid && !readCookie(SID)) writeCookie(SID, oldSid, SESSION);
    }
  }
  // rt_consent=r: kept because the site turned on Remember visitors, not by the visitor's consent (config below).
  var cookies = dataCookies || /^[1r]$/.test(readCookie(CONSENT));
  // Marketing consent (docs/GUIDE.md, "Meta Conversions API"): 1 granted, 0 withdrawn on this page, null never given.
  var marketing = script.getAttribute('data-marketing') === 'on' || readCookie(MKT) === '1' ? 1 : null;
  // Cookies left by an older version of this script, without consent: remove them.
  if (!cookies && (readCookie(VID) || readCookie(SID))) removeCookies();
  var mem = null, memAt = 0, awaiting = 0;
  function remember(id) {
    if (!id || !id.vid || !id.sid) return;
    mem = { vid: id.vid, sid: id.sid };
    memAt = Date.now();
    // Consent arrived while the server was still working out the ids: keep the same visitor.
    if (cookies && !readCookie(VID)) ids();
    queueTag();
  }
  /** The ids to send, or null to let the server derive them (cookieless, nothing known yet). */
  function ids() {
    if (mem && Date.now() - memAt > SESSION * 1000) mem = null; // idle past the session window
    if (!cookies) return mem;
    var vid = readCookie(VID) || (mem && mem.vid);
    var sid = readCookie(SID) || (mem && mem.sid);
    if (!vid && awaiting) return null;
    vid = vid || uuid();
    sid = sid || uuid();
    writeCookie(VID, vid, YEAR);
    writeCookie(SID, sid, SESSION); // sliding 30 minute session
    mem = null;
    return { vid: vid, sid: sid };
  }
  function setMarketing(granted) {
    marketing = granted ? 1 : 0;
    if (granted) writeCookie(MKT, '1', YEAR);
    else removeCookies([MKT]);
  }
  var refused = false;
  function consent(granted) {
    refused = !granted;
    if (granted) {
      cookies = true;
      writeCookie(CONSENT, '1', YEAR);
      ids(); // keeps the current visitor and session ids, so the visit continues
      if (held) record(held); // a recording that waited for consent starts now
    } else {
      cookies = false;
      mem = null;
      removeCookies();
    }
  }

  // ---- transport
  // Personal data in URLs (e.g. ?email= on a payment return page) never leaves the browser.
  var PRIVATE_PARAM = /^(e-?mail|name|phone|password|pass|token|access_token|id_token|auth|code|secret|key|api_key|license_key|license)$/i;
  function cleanUrl(href) {
    try {
      var u = new URL(href);
      var drop = [];
      u.searchParams.forEach(function (_, k) { if (PRIVATE_PARAM.test(k)) drop.push(k); });
      for (var i = 0; i < drop.length; i++) u.searchParams.delete(drop[i]);
      return u.toString();
    } catch (e) { return href; }
  }
  function send(type, extra, beacon) {
    var id = ids();
    if (id && !cookies) memAt = Date.now();
    var body = { w: siteId, t: type, u: cleanUrl(loc.href), sw: w.screen ? screen.width : 0 };
    if (id) { body.vid = id.vid; body.sid = id.sid; }
    // Marketing consent: the server may pass this visit's purchase to Meta only with it (docs/GUIDE.md, "Meta ads").
    if (marketing !== null) body.m = marketing;
    // With marketing consent, the browser id a Meta pixel on the page keeps (_fbp), so the server's events match it.
    if (marketing === 1) {
      var fbp = readCookie('_fbp');
      if (fbp && /^fb\.\d\.\d{10,13}\.\d{1,20}$/.test(fbp)) body.fbp = fbp;
    }
    for (var k in extra) if (extra[k] !== undefined) body[k] = extra[k];
    var json = JSON.stringify(body), a = body.a;
    // The server takes 8 KB: drop the page's oldest clicks, then its oldest errors, until it fits.
    while (json.length > 8000 && a && (a.c && a.c.length ? a.c.shift() : a.e && a.e.shift())) json = JSON.stringify(body);
    // text/plain keeps this a "simple" request: no CORS preflight, works with sendBeacon.
    // Without ids the response carries them, so use fetch to read it.
    if (beacon && id && nav.sendBeacon) {
      try { if (nav.sendBeacon(endpoint, new Blob([json], { type: 'text/plain' }))) return; } catch (e) {}
    }
    if (!id) awaiting++;
    // A pageview's answer carries the site's tracker config (cfg) in both modes.
    var read = !id || type === 'pageview';
    try {
      fetch(endpoint, { method: 'POST', body: json, keepalive: true, credentials: 'omit', headers: { 'Content-Type': 'text/plain' } })
        .then(function (r) { return r.status !== 202 ? null : read ? r.text() : ''; })
        .then(function (t) {
          if (t === null) return; // an error answer says nothing about the config
          var j = t ? JSON.parse(t) : {};
          if (!id) remember(j);
          if (type === 'pageview') config(j.cfg || {});
        })
        .catch(noop)
        .then(function () { if (!id) awaiting--; });
    } catch (e) { if (!id) awaiting--; }
  }

  // ---- tracker config from the server (docs/API.md, "Tracker config")
  // rm: Remember visitors. Keep the visitor in cookies as consent would (rt_consent=r), unless this page said no.
  // rec: record this visit. Load /js/replay.js once and hand it what it needs in window.founderdata._rec.
  // rec.c: wait for consent. Hold the recording until data-cookies="on" or founderdata('consent', true).
  // rec.x: pages that are never recorded. No recorder and no clicks or errors on a path that is one or starts with one + /.
  var rec = null, cfgSeen = false, held = null;
  function skip(p) {
    return rec && (rec.x || []).some(function (x) { return p === x || p.indexOf(x.slice(-1) === '/' ? x : x + '/') === 0; });
  }
  function config(cfg) {
    cfgSeen = true;
    if (cfg.rm && !cookies && !refused) {
      cookies = true;
      writeCookie(CONSENT, 'r', YEAR);
      ids();
    } else if (!cfg.rm && !dataCookies && readCookie(CONSENT) === 'r') consent(false);
    record(cfg.rec);
  }
  function record(r) {
    var id = ids();
    if (!r || rec || !id) return;
    held = null;
    if (r.c && !dataCookies && readCookie(CONSENT) !== '1') { held = r; return; }
    rec = r;
    api._rec = { site: siteId, sid: id.sid, host: host, url: /\/api\/event$/.test(endpoint) ? endpoint.slice(0, -6) + '/rec' : host + '/api/rec', cfg: rec };
    if (skip(loc.pathname)) return;
    var el = d.createElement('script');
    el.async = true;
    el.src = host + '/js/replay.js' + (rec.v ? '?v=' + encodeURIComponent(rec.v) : '');
    // A recorder that cannot load (the page's Content-Security-Policy, an ad blocker) is reported once, so the
    // site's settings can say why no recording arrives. One request, no data about the visitor.
    el.onerror = function () {
      fetch(api._rec.url + '/' + siteId + '?s=' + id.sid + '&h=blocked', { method: 'POST', body: '1', keepalive: true, credentials: 'omit' }).catch(noop);
    };
    (d.head || d.documentElement).appendChild(el);
  }

  // ---- Core Web Vitals (LCP, INP, CLS, TTFB, FCP) of this page load, measured as web-vitals does. They ride on
  // the ping sent when the page is first hidden: no request of their own.
  var vit = null, vitPath = loc.pathname, inter = {};
  try {
    var PO = w.PerformanceObserver, perf = w.performance, types = (PO && PO.supportedEntryTypes) || [];
    if (types.length) {
      vit = {};
      var nav0 = perf.getEntriesByType('navigation')[0] || {}, act = nav0.activationStart || 0;
      var hiddenAt = d.visibilityState === 'hidden' ? 0 : 1 / 0; // no paint times for a tab loaded in the background
      var ms = function (t) { return Math.max(0, t - act); };
      var watch = function (type, fn) {
        if (types.indexOf(type) >= 0) new PO(function (l) { l.getEntries().forEach(fn); }).observe({ type: type, buffered: true, durationThreshold: 40 });
      };
      var burst = 0, first = 0, last = 0, onEvent = function (e) {
        if (e.interactionId) inter[e.interactionId] = Math.max(inter[e.interactionId] || 0, e.duration);
      };
      if (nav0.responseStart > 0) vit.t = ms(nav0.responseStart);
      if (types.indexOf('layout-shift') >= 0) vit.c = 0;
      watch('paint', function (e) { if (e.name === 'first-contentful-paint' && e.startTime < hiddenAt) vit.f = ms(e.startTime); });
      watch('largest-contentful-paint', function (e) { if (e.startTime < hiddenAt) vit.l = ms(e.startTime); });
      watch('layout-shift', function (e) { // CLS: the largest burst of shifts under 1 s apart, 5 s at most
        if (e.hadRecentInput) return;
        if (burst && e.startTime - last < 1000 && e.startTime - first < 5000) burst += e.value;
        else { burst = e.value; first = e.startTime; }
        last = e.startTime;
        if (burst > vit.c) vit.c = burst;
      });
      watch('event', onEvent);
      watch('first-input', onEvent);
      d.addEventListener('visibilitychange', function () { if (d.visibilityState === 'hidden' && hiddenAt > perf.now()) hiddenAt = perf.now(); }, true);
    }
  } catch (e) { vit = null; }
  function vitals() { // once per page load
    var v = vit, k, n = 0, list = [];
    vit = null;
    if (!v) return;
    for (k in inter) list.push(inter[k]);
    // INP: the slowest interaction, or the 98th percentile past 50 interactions
    if (list.length) v.i = list.sort(function (a, b) { return b - a; })[Math.min(list.length - 1, Math.floor(list.length / 50))];
    for (k in v) { v[k] = k === 'c' ? Math.round(v[k] * 1e4) / 1e4 : Math.round(v[k]); n++; }
    if (n) { v.p = vitPath; return v; }
  }

  // ---- engaged time (only while the tab is visible)
  var visibleSince = d.visibilityState === 'visible' ? Date.now() : 0;
  var pending = 0, pings = 0;
  function flushTime(beacon, end) {
    if (visibleSince) { pending += Date.now() - visibleSince; visibleSince = d.visibilityState === 'visible' ? Date.now() : 0; }
    var v = beacon ? vitals() : undefined; // hidden: the vitals go now, even under a second
    var a = beacon || end ? activity() : undefined; // the page's clicks and errors, when it is hidden or left
    if (pending >= 1000 || v || a) { send('ping', { d: Math.round(pending), v: v, a: a }, beacon); pending = 0; }
  }

  // ---- page activity of a recorded visit: clicks, rage clicks (3 or more on one element, each within 1 s of the
  // last) and errors. Kept in memory until the server answers, then only when it records the visit. Sent with the
  // ping, never alone. Labels are visible text, never what someone typed; [data-fd-mask] and [data-fd-block] hide it.
  var clicks = [], errs = [], actAt = Date.now(), actPath = loc.pathname, lastEl = null, lastAt = 0;
  function watching() { return (rec || !cfgSeen) && !skip(loc.pathname); }
  function activity() {
    var a = { p: actPath, s: actAt }, n = clicks.length + errs.length;
    if (clicks.length) a.c = clicks;
    if (errs.length) a.e = errs;
    clicks = [];
    errs = [];
    lastEl = null;
    return n && rec && !skip(actPath) ? a : undefined;
  }
  // The text of an element, without what stays hidden: [data-fd-mask], [data-fd-block], editable parts, form fields.
  // pro/js/lib/digest.ts visibleText reads it the same way, so a click's label matches in both.
  function seen(el) {
    for (var s = '', c = el.firstChild; c && s.length < 200; c = c.nextSibling) {
      s += c.nodeType == 3 ? c.data : c.nodeType != 1 || /^(INPUT|TEXTAREA|SELECT|OPTION|SCRIPT|STYLE|NOSCRIPT|TEMPLATE|SVG|CANVAS|IFRAME|OBJECT)$/i.test(c.tagName) || c.isContentEditable || c.getAttribute('contenteditable') != null || c.matches('[data-fd-mask],[data-fd-block],[hidden],[aria-hidden="true"]') ? '' : ' ' + seen(c);
    }
    return s;
  }
  function noteClick(el, kind) {
    var now = Date.now();
    if (el === lastEl && now - lastAt < 1000) {
      var c = clicks[clicks.length - 1];
      c.n = (c.n || 1) + 1;
      // A rage click names its element too: tag plus first class, else id ("button.buy"), never text.
      if (c.n > 2) { c.r = 1; c.s = el.tagName.toLowerCase() + (el.classList && el.classList[0] ? '.' + el.classList[0] : el.id ? '#' + el.id : ''); }
    } else {
      var text = el.closest('[data-fd-mask],[data-fd-block]') || el.tagName === 'INPUT' ? '' : seen(el);
      text = text.replace(/\s+/g, ' ').trim() || el.getAttribute('aria-label') || el.tagName.toLowerCase();
      clicks.push({ t: now - actAt, l: text.slice(0, 40), k: kind });
      if (clicks.length > 30) clicks.shift();
    }
    lastEl = el;
    lastAt = now;
  }
  function noteError(m, src) {
    m = String(m || 'Error').slice(0, 200);
    if (errs.length < 5 && (!errs.length || errs[errs.length - 1].m !== m)) errs.push({ t: Date.now() - actAt, m: m, s: src.slice(-200) });
  }
  w.addEventListener('error', function (e) {
    if (watching() && e.message) noteError(e.message, e.filename ? e.filename.split(/[?#]/)[0] + ':' + e.lineno : '');
  });
  w.addEventListener('unhandledrejection', function (e) {
    if (watching()) noteError(e.reason && e.reason.message || e.reason, '');
  });
  d.addEventListener('submit', function (e) {
    var el = e.submitter || e.target;
    if (watching() && el && el.closest && !(el === lastEl && Date.now() - lastAt < 1000)) noteClick(el, 'submit');
  }, true);
  d.addEventListener('visibilitychange', function () {
    if (d.visibilityState === 'visible') visibleSince = Date.now();
    else flushTime(true);
  });
  w.addEventListener('pagehide', function () { flushTime(true); });
  setInterval(function () {
    if (d.visibilityState === 'visible' && pings < 30) { pings++; flushTime(false); }
  }, 60000);

  // ---- pageviews (including single-page-app navigation)
  var lastPage = null, firstView = true;
  function pageview() {
    var page = loc.pathname + loc.search;
    if (page === lastPage) return;
    if (lastPage !== null) flushTime(false, true);
    lastPage = page;
    actAt = Date.now();
    actPath = loc.pathname;
    pings = 0;
    send('pageview', { r: firstView ? d.referrer : '' });
    firstView = false;
  }
  var hist = w.history;
  if (hist && hist.pushState) {
    ['pushState', 'replaceState'].forEach(function (fn) {
      var orig = hist[fn];
      hist[fn] = function () { var r = orig.apply(this, arguments); setTimeout(pageview, 0); return r; };
    });
    w.addEventListener('popstate', pageview);
  }

  // ---- goals, outbound links, checkout links (Dodo Payments, Stripe Payment Links, Lemon Squeezy, Polar, Gumroad)
  function goal(name, props) {
    if (!name) return;
    send('goal', { n: String(name).slice(0, 64), p: props || undefined }, true);
  }
  // Ids for checkout metadata. Cookieless, they arrive with the first response (a moment after page load)
  // and are valid until midnight UTC.
  function attribution() {
    var id = ids();
    // The ml_* keys are the minilytics names, kept for one release.
    return id
      ? { rt_visitor_id: id.vid, rt_session_id: id.sid, rt_site_id: siteId, ml_visitor_id: id.vid, ml_session_id: id.sid, ml_site_id: siteId }
      : {};
  }
  // Dodo checkout links carry the visitor as metadata, Stripe Payment Links as client_reference_id, Lemon Squeezy as
  // checkout[custom], Polar as reference_id, Gumroad as URL parameters (its url_params). They're tagged
  // as soon as they appear on the page, not just on click, because other scripts (e.g. Umami's click tracking)
  // may copy the href and navigate before our click handler runs.
  function tagCheckoutLink(a) {
    try {
      var u = new URL(a.href);
      var att = attribution();
      if (!att.rt_visitor_id) return;
      if (/(^|\.)dodopayments\.com$/.test(u.hostname)) {
        u.searchParams.set('metadata_rt_visitor_id', att.rt_visitor_id);
        u.searchParams.set('metadata_rt_session_id', att.rt_session_id);
      } else if (u.hostname === 'buy.stripe.com') {
        // Stripe Payment Links pass client_reference_id to the Checkout Session. Never replace the site's own value.
        var ref = u.searchParams.get('client_reference_id');
        if (ref && ref.indexOf('rtv_') !== 0 && ref.indexOf('mlv_') !== 0) return;
        u.searchParams.set('client_reference_id', 'rtv_' + att.rt_visitor_id);
      } else if (/(^|\.)lemonsqueezy\.com$/.test(u.hostname) && u.pathname.indexOf('/checkout') === 0) {
        set(u, 'checkout[custom][', ']', att);
      } else if (u.hostname === 'buy.polar.sh' || (u.hostname === 'polar.sh' && /\/checkout/.test(u.pathname))) {
        var rid = u.searchParams.get('reference_id');
        if (rid && rid.indexOf('rtv_') !== 0) return;
        u.searchParams.set('reference_id', 'rtv_' + att.rt_visitor_id);
      } else if (/(^|\.)gumroad\.com$/.test(u.hostname) && (u.hostname !== 'gumroad.com' || u.pathname.indexOf('/l/') === 0)) {
        set(u, '', '', att);
      } else return;
      var next = u.toString();
      if (a.href !== next) a.href = next;
    } catch (e) {}
  }
  function set(u, pre, post, att) {
    ['rt_visitor_id', 'rt_session_id', 'rt_site_id'].forEach(function (k) { u.searchParams.set(pre + k + post, att[k]); });
  }
  function tagCheckoutLinks() {
    var links = d.querySelectorAll('a[href*="dodopayments.com"], a[href*="buy.stripe.com"], a[href*="lemonsqueezy.com"], a[href*="polar.sh"], a[href*="gumroad.com"]');
    for (var i = 0; i < links.length; i++) tagCheckoutLink(links[i]);
  }
  var tagQueued = false;
  function queueTag() {
    if (tagQueued) return;
    tagQueued = true;
    setTimeout(function () { tagQueued = false; tagCheckoutLinks(); }, 50);
  }
  if (w.MutationObserver) {
    new MutationObserver(queueTag).observe(d.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['href'] });
  }
  if (d.readyState === 'loading') d.addEventListener('DOMContentLoaded', tagCheckoutLinks);
  else tagCheckoutLinks();
  // Refresh right before a click starts, in case the session id rotated while the page sat idle.
  function onPress(e) {
    var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (a) tagCheckoutLink(a);
  }
  d.addEventListener('pointerdown', onPress, true);
  d.addEventListener('keydown', function (e) { if (e.key === 'Enter') onPress(e); }, true);
  function onClick(e) {
    var el = e.target && e.target.closest ? e.target : null;
    if (!el) return;
    var hit = e.type === 'click' && watching() && el.closest('a[href],button,[role=button],input[type=submit],input[type=button]');
    if (hit) noteClick(hit, hit.tagName === 'A' ? 'link' : hit.type === 'submit' && hit.form ? 'submit' : 'button');
    // data-ml-goal is the minilytics attribute, kept for one release.
    var g = el.closest('[data-rt-goal],[data-ml-goal]');
    if (g) {
      var props = {};
      for (var i = 0; i < g.attributes.length; i++) {
        var at = g.attributes[i];
        if (/^data-(rt|ml)-goal-/.test(at.name)) props[at.name.slice(13)] = at.value.slice(0, 255);
      }
      goal(g.getAttribute('data-rt-goal') || g.getAttribute('data-ml-goal'), Object.keys(props).length ? props : undefined);
    }
    var a = el.closest('a[href]');
    if (a) {
      tagCheckoutLink(a);
      try {
        var u = new URL(a.href, loc.href);
        var root = siteRoot();
        if (/^https?:$/.test(u.protocol) && u.hostname !== loc.hostname && u.hostname.slice(-root.length - 1) !== '.' + root && u.hostname !== root) {
          send('outbound', { n: u.origin + u.pathname }, true);
        }
      } catch (err) {}
    }
  }
  d.addEventListener('click', onClick, true);
  d.addEventListener('auxclick', onClick, true);

  // ---- public API
  function api(cmd, a, b) {
    if (cmd === 'goal' || cmd === 'track') goal(a, b);
    else if (cmd === 'identify' && a) {
      // user_id (or id), email and name name the person; other keys are traits (docs/API.md, "identify()").
      var p = {};
      for (var k in a) p[k] = a[k];
      p.user_id = a.user_id || a.id;
      delete p.id;
      send('identify', { p: p });
    }
    else if (cmd === 'pageview') { lastPage = null; pageview(); }
    else if (cmd === 'consent') consent(!!a);
    else if (cmd === 'marketing') setMarketing(!!a);
  }
  api.attribution = attribution;
  expose(api);

  // Consent queued before the script loaded applies to the first pageview too.
  var early = function (c) { return c === 'consent' || c === 'marketing'; };
  for (var q = 0; q < queued.length; q++) if (early(queued[q][0])) api.apply(null, queued[q]);
  pageview();
  for (q = 0; q < queued.length; q++) if (!early(queued[q][0])) api.apply(null, queued[q]);
})();
