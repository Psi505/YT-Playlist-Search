/* Runs in the page's own JS world (manifest "world": "MAIN").
 *
 * Two reasons it lives here instead of in the extension world:
 *   1. ytcfg and ytInitialData are live objects here. The extension world can
 *      only see them by regexing a serialized copy of the document, which on a
 *      big playlist means allocating several megabytes on the main thread.
 *   2. innertube requests go out as the page itself, so they carry the same
 *      auth the site uses for private playlists like Watch Later.
 *
 * Responses are harvested here and only small batches cross the world boundary
 * — the raw JSON never gets structured-cloned.
 */
(function () {
  'use strict';

  const CHANNEL = 'ytpl';
  const MAX_ITEMS = 20000;
  const MAX_PAGES = 220;
  // The real continuation on a playlist sits ~16 levels down (tabs →
  // sectionList → itemSection → playlistVideoList → continuationItemViewModel →
  // continuationCommand → innertubeCommand → continuationCommand). Responses are
  // plain JSON with no cycles, so this only needs to be generous, not tight.
  const MAX_DEPTH = 60;
  // The header count includes videos the listing omits — deleted, private,
  // region-blocked — so an index legitimately lands short of it and an exact
  // match can never be the bar for "complete". A *large* shortfall is a
  // different thing: it means paging was truncated. This separates the two.
  const COMPLETE_RATIO = 0.5;
  const TOTAL_RE = /^([\d,]{1,9})\s+videos?$/;

  function post(msg) {
    msg.__ytpl = CHANNEL;
    window.postMessage(msg, location.origin);
  }

  /* ---------- extraction ---------- */

  // Both the old playlistVideoRenderer and the newer lockupViewModel shapes.
  function harvest(node, out, seen, depth) {
    if (!node || typeof node !== 'object' || out.length >= MAX_ITEMS || depth > MAX_DEPTH) return;
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) harvest(node[i], out, seen, depth + 1);
      return;
    }
    const lv = node.lockupViewModel;
    if (lv && lv.contentId) {
      const md = lv.metadata && lv.metadata.lockupMetadataViewModel;
      const t = md && md.title && md.title.content;
      if (t && !seen.has(lv.contentId)) {
        seen.add(lv.contentId);
        out.push([lv.contentId, t]);
      }
      return;
    }
    const pv = node.playlistVideoRenderer;
    if (pv && pv.videoId) {
      const t = pv.title &&
        (pv.title.simpleText || (pv.title.runs && pv.title.runs[0] && pv.title.runs[0].text));
      if (t && !seen.has(pv.videoId)) {
        seen.add(pv.videoId);
        out.push([pv.videoId, t]);
      }
      return;
    }
    for (const k in node) harvest(node[k], out, seen, depth + 1);
  }

  // Continuations sit at the tail of a list, so walk arrays backwards.
  function findToken(node, depth) {
    if (!node || typeof node !== 'object' || depth > MAX_DEPTH) return null;
    if (Array.isArray(node)) {
      for (let i = node.length - 1; i >= 0; i--) {
        const t = findToken(node[i], depth + 1);
        if (t) return t;
      }
      return null;
    }
    const cc = node.continuationCommand;
    if (cc && typeof cc.token === 'string' && cc.token) return cc.token;
    for (const k in node) {
      const t = findToken(node[k], depth + 1);
      if (t) return t;
    }
    return null;
  }

  function findTotal(node, depth) {
    if (!node || typeof node !== 'object' || depth > MAX_DEPTH) return 0;
    let best = 0;
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        const n = findTotal(node[i], depth + 1);
        if (n > best) best = n;
      }
      return best;
    }
    for (const k in node) {
      const v = node[k];
      if (typeof v === 'string') {
        const m = v.match(TOTAL_RE);
        if (m) {
          const n = parseInt(m[1].replace(/,/g, ''), 10);
          if (n > best) best = n;
        }
      } else if (v && typeof v === 'object') {
        const n = findTotal(v, depth + 1);
        if (n > best) best = n;
      }
    }
    return best;
  }

  // Scope the walk to the parts of a response that hold playlist items, so a
  // token belonging to comments or the sidebar can never be picked up.
  function roots(json) {
    const out = [];
    const tabs = json.contents && json.contents.twoColumnBrowseResultsRenderer &&
      json.contents.twoColumnBrowseResultsRenderer.tabs;
    if (tabs) out.push(tabs);
    if (Array.isArray(json.onResponseReceivedActions)) out.push(json.onResponseReceivedActions);
    if (!out.length) out.push(json);
    return out;
  }

  /* ---------- transport ---------- */

  function context() {
    const client = { clientName: 'WEB', clientVersion: '2.20240101.00.00', hl: 'en', gl: 'US' };
    try {
      client.clientVersion = ytcfg.get('INNERTUBE_CLIENT_VERSION') || client.clientVersion;
      const visitor = ytcfg.get('VISITOR_DATA');
      if (visitor) client.visitorData = visitor;
    } catch (e) {}
    return { client };
  }

  // Same scheme the site's own JS uses; without it private playlists 404.
  async function authHeader() {
    const m = document.cookie.match(/(?:^|;\s*)(?:__Secure-3PAPISID|SAPISID)=([^;]+)/);
    if (!m || !crypto.subtle) return null;
    const ts = Math.floor(Date.now() / 1000);
    const bytes = new TextEncoder().encode(ts + ' ' + m[1] + ' ' + location.origin);
    const buf = await crypto.subtle.digest('SHA-1', bytes);
    let hex = '';
    for (const b of new Uint8Array(buf)) hex += b.toString(16).padStart(2, '0');
    return 'SAPISIDHASH ' + ts + '_' + hex;
  }

  async function browse(body) {
    const headers = { 'Content-Type': 'application/json' };
    try {
      const auth = await authHeader();
      if (auth) {
        headers['Authorization'] = auth;
        headers['X-Origin'] = location.origin;
      }
    } catch (e) {}
    const res = await fetch('/youtubei/v1/browse?prettyPrint=false', {
      method: 'POST',
      credentials: 'include',
      headers: headers,
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const json = await res.json();
    if (json.error) throw new Error('innertube ' + (json.error.status || 'error'));
    return json;
  }

  /* ---------- indexing ---------- */

  let running = 0;

  function seedData() {
    const d = window.ytInitialData;
    if (!location.pathname.startsWith('/playlist')) return null;
    if (!d || !d.contents || !d.contents.twoColumnBrowseResultsRenderer) return null;
    return d;
  }

  async function index(listId, reqId) {
    const items = [];
    const seen = new Set();
    let total = 0;
    let token = null;
    let sent = 0;

    // Set only when the server itself ended the continuation chain. That, not
    // the header count, is the authority on having reached the end.
    let naturalEnd = false;

    const flush = (done, error) => {
      if (running !== reqId) return;
      post({
        type: 'batch',
        reqId: reqId,
        items: items.slice(sent),
        total: total,
        done: !!done,
        complete: !!done && !!items.length && naturalEnd &&
          (!total || items.length >= total * COMPLETE_RATIO),
        error: error || ''
      });
      sent = items.length;
    };

    // Page one is already sitting in the document on /playlist — no request.
    let firstNetworkPage = true;
    const seed = seedData();
    if (seed) {
      const rs = roots(seed);
      for (const r of rs) harvest(r, items, seen, 0);
      total = findTotal(seed.header, 0) || findTotal(seed.sidebar, 0) ||
        findTotal(seed.contents, 0);
      token = findToken(rs, 0);
      if (items.length) flush(false);
      // A seed with no continuation is only believable when it already covers
      // the whole playlist. Otherwise fall through and page from scratch — the
      // cold browse re-fetches page one, which dedupes to nothing but yields a
      // token we can actually follow.
      if (items.length && !token && total && items.length >= total) {
        naturalEnd = true;
        flush(true);
        return;
      }
    }

    for (let p = 0; p < MAX_PAGES && items.length < MAX_ITEMS; p++) {
      if (running !== reqId) return;
      let json;
      try {
        json = await browse(token
          ? { context: context(), continuation: token }
          : { context: context(), browseId: 'VL' + listId });
      } catch (e) {
        flush(true, String((e && e.message) || e));
        return;
      }
      const before = items.length;
      const rs = roots(json);
      for (const r of rs) harvest(r, items, seen, 0);
      if (!total) total = findTotal(json.header, 0);
      token = findToken(rs, 0);

      // The first network page may legitimately add nothing when it is just
      // re-fetching what the seed already gave us.
      const stalled = items.length === before && !firstNetworkPage;
      firstNetworkPage = false;
      // No token after a real response means the chain is exhausted. A stall
      // while a token is still being handed out is a loop guard, not an end.
      naturalEnd = !token;
      const done = !token || stalled;
      flush(done);
      if (done) return;
    }
    flush(true);
  }

  window.addEventListener('message', function (ev) {
    if (ev.source !== window || ev.origin !== location.origin) return;
    const d = ev.data;
    if (!d || d.__ytpl !== CHANNEL) return;

    if (d.type === 'peek') {
      const seed = seedData();
      post({
        type: 'peek',
        reqId: d.reqId,
        total: seed ? (findTotal(seed.header, 0) || findTotal(seed.sidebar, 0)) : 0
      });
      return;
    }

    if (d.type === 'index') {
      running = d.reqId;
      index(d.listId, d.reqId).catch(function (e) {
        if (running !== d.reqId) return;
        post({
          type: 'batch',
          reqId: d.reqId,
          items: [],
          total: 0,
          done: true,
          error: String((e && e.message) || e)
        });
      });
    }
  });
})();
