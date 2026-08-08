/* Runs in the page's own JS world (manifest "world": "MAIN").
 *
 * Two reasons it lives here instead of in the extension world:
 *   1. ytcfg and ytInitialData are live objects here. The extension world can
 *      only see them by regexing a serialized copy of the document, which on a
 *      big playlist means allocating several megabytes on the main thread.
 *   2. innertube requests go out as the page itself, so they carry the same
 *      auth the site uses for private playlists like Watch Later.
 *
 * Responses are harvested here and only small batches cross the world boundary.
 * The raw JSON never gets structured-cloned.
 */
(function () {
  'use strict';

  const REQ_EVT = 'ytpl-req';
  const RES_EVT = 'ytpl-res';
  const MAX_ITEMS = 20000;
  const MAX_PAGES = 220;
  // The real continuation on a playlist sits ~16 levels down (tabs →
  // sectionList → itemSection → playlistVideoList → continuationItemViewModel →
  // continuationCommand → innertubeCommand → continuationCommand), so this needs
  // headroom. It is safe to be generous only because the walks below mark
  // visited nodes; without that, depth is an exponent, not a limit.
  const MAX_DEPTH = 60;
  // The header count includes videos the listing omits (deleted, private,
  // region-blocked), so an index legitimately lands short of it and an exact
  // match can never be the bar for "complete". A *large* shortfall is a
  // different thing: it means paging was truncated. This separates the two.
  const COMPLETE_RATIO = 0.5;
  const TOTAL_RE = /^([\d,]{1,15})\s+videos?$/;

  // Deliberately NOT window.postMessage. YouTube posts ~28,000 messages per
  // second to itself, and Chrome deserializes a MessageEvent's payload lazily:
  // reading ev.data to check whether a message is ours forces a full structured
  // clone of every one of them. Measured at hundreds of MB/s of garbage while
  // this script was otherwise completely idle.
  //
  // A namespaced CustomEvent on document is a private channel: the listener
  // fires only for our own events, so the page's traffic never touches us. The
  // detail is a JSON string, which crosses the world boundary without any
  // cloning subtleties.
  function post(msg) {
    document.dispatchEvent(new CustomEvent(RES_EVT, { detail: JSON.stringify(msg) }));
  }

  /* ---------- extraction ---------- */

  // ytInitialData is a live object graph, not a tree. YouTube's own code shares
  // and back-references sub-objects, so the same node is reachable by many
  // distinct paths. A plain recursive walk re-explores each shared subtree once
  // per path, and the path count grows combinatorially with depth: on a graph
  // with any cycle it is bounded only by MAX_DEPTH, which at these depths is
  // effectively unbounded work and unbounded allocation.
  //
  // Marking nodes as visited makes every walk linear in nodes instead. The
  // visit budget is a hard backstop so a pathological shape can still only cost
  // a fixed amount rather than hanging the tab.
  const MAX_VISITS = 300000;

  function guard() {
    return { seen: new WeakSet(), left: MAX_VISITS };
  }

  // Depth is checked before marking, so a node abandoned at the depth limit
  // stays eligible if it is reached again by a shorter path.
  function enter(g, node, depth) {
    if (!node || typeof node !== 'object') return false;
    if (depth > MAX_DEPTH || g.left <= 0) return false;
    if (g.seen.has(node)) return false;
    g.seen.add(node);
    g.left--;
    return true;
  }

  // Both the old playlistVideoRenderer and the newer lockupViewModel shapes.
  function harvest(root, out, seen) {
    const g = guard();
    (function walk(node, depth) {
      if (out.length >= MAX_ITEMS || !enter(g, node, depth)) return;
      if (Array.isArray(node)) {
        for (let i = 0; i < node.length; i++) walk(node[i], depth + 1);
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
      for (const k in node) walk(node[k], depth + 1);
    })(root, 0);
  }

  // Continuations sit at the tail of a list, so walk arrays backwards.
  function findToken(root) {
    const g = guard();
    return (function walk(node, depth) {
      if (!enter(g, node, depth)) return null;
      if (Array.isArray(node)) {
        for (let i = node.length - 1; i >= 0; i--) {
          const t = walk(node[i], depth + 1);
          if (t) return t;
        }
        return null;
      }
      const cc = node.continuationCommand;
      if (cc && typeof cc.token === 'string' && cc.token) return cc.token;
      for (const k in node) {
        const t = walk(node[k], depth + 1);
        if (t) return t;
      }
      return null;
    })(root, 0);
  }

  function findTotal(root) {
    const g = guard();
    return (function walk(node, depth) {
      if (!enter(g, node, depth)) return 0;
      let best = 0;
      if (Array.isArray(node)) {
        for (let i = 0; i < node.length; i++) {
          const n = walk(node[i], depth + 1);
          if (n > best) best = n;
        }
        return best;
      }
      for (const k in node) {
        const v = node[k];
        if (typeof v === 'string') {
          // Pre-filter before the regex. A response holds hundreds of thousands
          // of strings and almost none can match; match() allocates a result
          // object every time it is called, so screening with two non-allocating
          // checks first is most of this walk's cost.
          if (v.length <= 32 && v.indexOf('video') > 0) {
            const m = v.match(TOTAL_RE);
            if (m) {
              const n = parseInt(m[1].replace(/,/g, ''), 10);
              if (n > best) best = n;
            }
          }
        } else if (v && typeof v === 'object') {
          const n = walk(v, depth + 1);
          if (n > best) best = n;
        }
      }
      return best;
    })(root, 0);
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
    // Holds only what has not been posted yet, never the whole playlist.
    let batch = [];
    const seen = new Set();
    let total = 0;
    let token = null;

    // Set only when the server itself ended the continuation chain. That, not
    // the header count, is the authority on having reached the end.
    let naturalEnd = false;

    const flush = (done, error) => {
      if (running !== reqId) return;
      post({
        type: 'batch',
        reqId: reqId,
        items: batch,
        total: total,
        done: !!done,
        complete: !!done && seen.size > 0 && naturalEnd &&
          (!total || seen.size >= total * COMPLETE_RATIO),
        error: error || ''
      });
      // postMessage clones synchronously, so the buffer can be dropped here.
      // Only one page is ever held: the extension world owns the full index and
      // the bridge has no reason to keep a second copy of it.
      batch = [];
    };

    // Page one is already sitting in the document on /playlist, so no request.
    let firstNetworkPage = true;
    const seed = seedData();
    if (seed) {
      let rs = roots(seed);
      for (const r of rs) harvest(r, batch, seen);
      total = findTotal(seed.header) || findTotal(seed.sidebar) ||
        findTotal(seed.contents);
      token = findToken(rs);
      rs = null;
      const seedCount = seen.size;
      if (seedCount) flush(false);
      // A seed with no continuation is only believable when it already covers
      // the whole playlist. Otherwise fall through and page from scratch. The
      // cold browse re-fetches page one, which dedupes to nothing but yields a
      // token we can actually follow.
      if (seedCount && !token && total && seedCount >= total) {
        naturalEnd = true;
        flush(true);
        return;
      }
    }

    let json = null;
    let rs = null;
    for (let p = 0; p < MAX_PAGES && seen.size < MAX_ITEMS; p++) {
      if (running !== reqId) return;
      try {
        json = await browse(token
          ? { context: context(), continuation: token }
          : { context: context(), browseId: 'VL' + listId });
      } catch (e) {
        flush(true, String((e && e.message) || e));
        return;
      }
      const before = seen.size;
      rs = roots(json);
      for (const r of rs) harvest(r, batch, seen);
      if (!total) total = findTotal(json.header);
      token = findToken(rs);

      // Drop the parsed response before the next request. A browse response is
      // megabytes of objects; held across the await it would sit in memory
      // alongside the one being fetched and parsed, doubling the peak.
      json = null;
      rs = null;

      // The first network page may legitimately add nothing when it is just
      // re-fetching what the seed already gave us.
      const stalled = seen.size === before && !firstNetworkPage;
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

  document.addEventListener(REQ_EVT, function (ev) {
    let d;
    try { d = JSON.parse(ev.detail); } catch (e) { return; }
    if (!d) return;

    if (d.type === 'peek') {
      const seed = seedData();
      post({
        type: 'peek',
        reqId: d.reqId,
        total: seed ? (findTotal(seed.header) || findTotal(seed.sidebar)) : 0
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
