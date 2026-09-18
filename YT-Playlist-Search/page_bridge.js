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
  const COMPLETE_RATIO = 0.8;
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
      // The watch-page playlist panel: the `next` endpoint serves whole
      // playlists through this renderer, 200 at a time.
      const pp = node.playlistPanelVideoRenderer;
      if (pp && pp.videoId) {
        const t = pp.title &&
          (pp.title.simpleText || (pp.title.runs && pp.title.runs[0] && pp.title.runs[0].text));
        if (t && !seen.has(pp.videoId)) {
          seen.add(pp.videoId);
          out.push([pp.videoId, t]);
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

  // The watch-page panel carries its own next slice as nextContinuationData on
  // the playlist object (and on each panel continuation response). The other
  // continuation slots on a watch response belong to autoplay and comments.
  function panelContinuation(json) {
    const g = guard();
    let token = null;
    (function walk(node, depth) {
      if (token || !enter(g, node, depth)) return;
      if (Array.isArray(node)) {
        for (let i = node.length - 1; i >= 0; i--) walk(node[i], depth + 1);
        return;
      }
      const nd = node.nextContinuationData;
      if (nd && typeof nd.continuation === 'string' && nd.continuation) {
        token = nd.continuation;
        return;
      }
      for (const k of Object.keys(node)) walk(node[k], depth + 1);
    })(json, 0);
    return token;
  }

  // The `next` endpoint: the watch page's playlist panel.
  // Authenticated on purpose: private playlists answer nothing otherwise.
  async function nextApi(body) {
    return innertube('/youtubei/v1/next', body);
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
  // Authenticated sessions sometimes answer continuations through
  // onResponseReceivedEndpoints (with a reload command) instead of
  // onResponseReceivedActions, so both are accepted here.
  function roots(json) {
    const out = [];
    const tabs = json.contents && json.contents.twoColumnBrowseResultsRenderer &&
      json.contents.twoColumnBrowseResultsRenderer.tabs;
    if (tabs) out.push(tabs);
    if (Array.isArray(json.onResponseReceivedActions)) out.push(json.onResponseReceivedActions);
    if (Array.isArray(json.onResponseReceivedEndpoints)) out.push(json.onResponseReceivedEndpoints);
    if (!out.length) out.push(json);
    return out;
  }

  // Continuation pages hand the next token back inside the item list itself.
  // Scoped to the item arrays on purpose: a generic walk can grab a token for a
  // different slot (reload, sidebar), and following that one yields pages that
  // duplicate page one, which looks exactly like a dead chain.
  function continuationToken(json) {
    for (const key of ['onResponseReceivedActions', 'onResponseReceivedEndpoints']) {
      const arr = json[key];
      if (!Array.isArray(arr)) continue;
      for (const a of arr) {
        if (!a) continue;
        const items = (a.appendContinuationItemsAction &&
          a.appendContinuationItemsAction.continuationItems) ||
          (a.reloadContinuationItemsCommand &&
            a.reloadContinuationItemsCommand.continuationItems);
        if (!Array.isArray(items)) continue;
        for (let i = items.length - 1; i >= 0; i--) {
          const cvm = items[i] && items[i].continuationItemViewModel;
          const cc = cvm && cvm.continuationCommand &&
            cvm.continuationCommand.innertubeCommand &&
            cvm.continuationCommand.innertubeCommand.continuationCommand;
          if (cc && cc.token) return cc.token;
        }
      }
    }
    return null;
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

  // Shared transport for both endpoints. The header set is deliberately the
  // minimal one that the Aug 9 build proved works: SAPISIDHASH plus X-Origin
  // only when a session is actually logged in (private playlists answer
  // nothing without it, and both are required together). The extra visitor
  // and client headers YouTube's page sends are NOT included: a stale
  // X-Goog-Visitor-Id makes continuations reject with "Precondition check
  // failed", and the request bodies already carry the same context.
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  async function innertube(path, body, anonymous) {
    const headers = { 'Content-Type': 'application/json' };
    try {
      if (!anonymous) {
        const auth = await authHeader();
        if (auth) {
          // X-Origin rides ONLY with Authorization, exactly as the Aug 9
          // build did. Sent unconditionally it makes continuations reject
          // with "Precondition check failed".
          headers['Authorization'] = auth;
          headers['X-Origin'] = location.origin;
        }
      }
    } catch (e) {}
    // Shared-IP throttling answers 400 "Precondition check failed" or 429 for
    // roughly a minute. Waiting inside the run beats failing it: the first
    // retry comes after 40 quiet seconds, the second after 80.
    let lastErr = null;
    // Every innertube body carries the client context; the callers pass only
    // their command (browseId / playlistId / continuation) on top of it.
    const payload = Object.assign({ context: context() }, body);
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await sleep(40000);
      let res;
      try {
        res = await fetch(path + '?prettyPrint=false', {
          method: 'POST',
          credentials: 'include',
          headers: headers,
          body: JSON.stringify(payload)
        });
      } catch (e) {
        lastErr = e;
        continue;
      }
      let json = null;
      try { json = await res.json(); } catch (e) {}
      if (res.ok) {
        if (json && json.error) throw new Error('innertube ' + (json.error.status || 'error'));
        return json;
      }
      const msg = json && json.error && (json.error.message || json.error.status);
      lastErr = new Error('HTTP ' + res.status + (msg ? ': ' + msg : ''));
      const retryable = res.status === 429 || (msg && /precondition|rate|exhaust/i.test(msg));
      if (!retryable) break;
    }
    throw lastErr || new Error('request failed');
  }

  async function browse(body, anonymous) {
    return innertube('/youtubei/v1/browse', body, anonymous);
  }

  // The `next` endpoint: the watch page's playlist panel. It serves whole
  // playlists (200 per response) from its own quota pool, which is why it
  // keeps working when the browse endpoint starts answering empty.
  // Authenticated on purpose: private playlists answer nothing otherwise.
  async function nextApi(body) {
    return innertube('/youtubei/v1/next', body);
  }

  /* ---------- indexing ---------- */

  let running = 0;

  // YouTube's own scripts page through playlists whenever the page loads or
  // the user scrolls. Those responses are free index data on a connection
  // where our own API calls get throttled, so the bridge pools whatever
  // playlist items pass through the page's network. Not one request of ours
  // is spent. The pool merges into every index run at its start.
  const passive = { items: [], seen: new Set() };

  function harvestPassive(json) {
    try {
      const r = roots(json);
      const out = [];
      const s = new Set();
      for (const x of r) harvest(x, out, s);
      for (const pair of out) {
        if (passive.seen.has(pair[0]) || passive.items.length >= MAX_ITEMS) continue;
        passive.seen.add(pair[0]);
        passive.items.push(pair);
      }
    } catch (e) {}
  }

  (function () {
    const orig = window.fetch ? window.fetch.bind(window) : null;
    if (!orig) return;
    window.fetch = async function () {
      const res = await orig.apply(null, arguments);
      try {
        const a0 = arguments[0];
        const url = typeof a0 === 'string' ? a0 : (a0 && a0.url) || '';
        if (/\/youtubei\/v1\/(browse|next)(\?|$)/.test(url)) {
          res.clone().json().then(harvestPassive).catch(function () {});
        }
      } catch (e) {}
      return res;
    };
  })();

  function seedData() {
    const d = window.ytInitialData;
    if (!location.pathname.startsWith('/playlist')) return null;
    if (!d || !d.contents || !d.contents.twoColumnBrowseResultsRenderer) return null;
    return d;
  }

  async function index(listId, reqId, resumeToken, resumeChain, base, knownTotal) {
    // Holds only what has not been posted yet, never the whole playlist.
    let batch = [];
    const seen = new Set();
    // `base` is what the extension already holds from a previous partial run:
    // on a resumed run, seen tracks only freshly fetched videos.
    let baseCount = base || 0;
    let total = knownTotal || 0;
    let token = resumeToken || null;

    // Set only when the server itself ended the continuation chain. That, not
    // the header count, is the authority on having reached the end.
    let naturalEnd = false;

    // `next` first: whole panel in one call, separate quota. Resumed runs stay
    // on the chain whose token the cache already holds. Declared before the
    // seed block because the flush closure reports the chain with every batch.
    let api = resumeToken ? (resumeChain || 'browse') : 'next';

    // One-word-per-step breadcrumb, surfaced by the extension as a tooltip on
    // the status line when a playlist refuses to index fully.
    const trace = [];

    const flush = (done, error) => {
      if (running !== reqId) return;
      const have = baseCount + seen.size;
      post({
        type: 'batch',
        reqId: reqId,
        items: batch,
        total: total,
        done: !!done,
        complete: !!done && have > 0 && naturalEnd &&
          (!total || have >= total * COMPLETE_RATIO),
        error: error || '',
        nextToken: token || '',
        chain: api,
        dbg: trace.join(' ')
      });
      // postMessage clones synchronously, so the buffer can be dropped here.
      // Only one page is ever held: the extension world owns the full index and
      // the bridge has no reason to keep a second copy of it.
      batch = [];
    };

    // Page one is already sitting in the document on /playlist, so no request.
    // A resumed run skips it: those items already live in the extension.
    if (!token) {
      // The page's own traffic is free inventory: merge everything YouTube
      // itself has paged through while the user browsed or scrolled.
      for (const pair of passive.items) {
        if (seen.has(pair[0])) continue;
        seen.add(pair[0]);
        batch.push(pair);
      }
      if (passive.items.length) trace.push('pv' + seen.size);
      const seed = seedData();
      if (seed) {
        let rs = roots(seed);
        for (const r of rs) harvest(r, batch, seen);
        total = findTotal(seed.header) || findTotal(seed.sidebar) ||
          findTotal(seed.contents);
        token = findToken(rs);
        rs = null;
        const seedCount = seen.size;
        trace.push('seed' + seedCount + (token ? 'T' : '-'));
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
    } else {
      trace.push('resume');
    }

    // Passive traffic plus the seed can already cover the whole playlist
    // (the user scrolled it earlier). Declare victory without a single
    // request: on a throttled connection this is the one unbeatable path.
    if (total && baseCount + seen.size >= total) {
      naturalEnd = true;
      flush(true);
      return;
    }

    let json = null;
    let rs = null;
    let retried = false;
    // The seed's token, when present, belongs to the browse chain. The panel
    // endpoint re-serves the whole playlist from its own {playlistId} call, so
    // on that chain the seed token is dropped rather than followed.
    if (api === 'next') token = null;
    for (let p = 0; p < MAX_PAGES && baseCount + seen.size < MAX_ITEMS; p++) {
      if (running !== reqId) return;
      // Pace the chain. Rapid-fire continuation bursts are what trip YouTube
      // into answering with empty pages; ~50 requests spread over half a
      // minute index a 5,000-video playlist without tripping it.
      if (p > 0) await sleep(400);
      const wasContinuation = !!token;
      const send2 = b => api === 'next' ? nextApi(b) : browse(b);
      try {
        if (token) {
          json = await send2({ continuation: token });
        } else {
          json = await send2(api === 'next'
            ? { playlistId: listId }
            : { browseId: 'VL' + listId });
        }
      } catch (e) {
        if (api === 'next') {
          // The panel endpoint can fail where browse works; switch chains and
          // retry this page cold. A next-token means nothing on browse.
          api = 'browse';
          token = null;
          trace.push('toBrowse');
          try {
            json = await browse({ context: context(), browseId: 'VL' + listId });
          } catch (e2) {
            flush(true, String((e && e.message) || e));
            return;
          }
        } else {
          flush(true, String((e && e.message) || e));
          return;
        }
      }
      const before = seen.size;
      // On the panel chain, scope to the playlist itself: the rest of a next
      // response is watch-page furniture full of unrelated lockups.
      const wc = json.contents && json.contents.twoColumnWatchNextResults;
      const panel = wc && wc.playlist && wc.playlist.playlist;
      rs = (api === 'next' && panel) ? [panel] : roots(json);
      for (const r of rs) harvest(r, batch, seen);
      if (!total) total = findTotal(json.header);
      // The panel's own count is another voice in the total argument; only a
      // larger one moves the bar.
      if (panel && panel.totalVideos > total) total = panel.totalVideos;
      // Each chain carries its own token flavor: panel slices come from
      // nextContinuationData, browse pages from continuationItemViewModel and
      // friends. Scoped extraction first, generic walk as fallback.
      token = api === 'next'
        ? panelContinuation(json)
        : (continuationToken(json) || findToken(rs));
      let added = seen.size - before;
      trace.push('p' + p + '+' + added + (token ? 'T' : '-'));

      // Drop the parsed response before the next request. A browse response is
      // megabytes of objects; held across the await it would sit in memory
      // alongside the one being fetched and parsed, doubling the peak.
      json = null;
      rs = null;

      if (added === 0 && wasContinuation && api === 'next') {
        // The panel hands back a token even after its final page (it is the
        // autoplay slot), so one empty page here is the normal end. One
        // gentle retry first, in case a mid-chain page was throttled.
        await sleep(2500);
        try {
          json = await nextApi({ continuation: token });
          rs = roots(json);
          const b2 = seen.size;
          for (const r of rs) harvest(r, batch, seen);
          token = api === 'next'
            ? panelContinuation(json)
            : (continuationToken(json) || findToken(rs));
          added = seen.size - before;
          trace.push('w+' + (seen.size - b2) + (token ? 'T' : '-'));
          json = null;
          rs = null;
        } catch (e2) {
          trace.push('wx');
        }
        if (added > 0) {
          flush(false);
          continue;
        }
        if (total && baseCount + seen.size < total) {
          // The panel ended (Liked playlists cap their panel) or was cut off
          // while the header promises more: page through the rest on browse.
          api = 'browse';
          token = null;
          trace.push('toBrowse');
          flush(false);
          continue;
        }
        naturalEnd = true;
        flush(true);
        return;
      }

      if (added === 0 && wasContinuation && total && baseCount + seen.size < total) {
        // A continuation that yields nothing while the header promises more
        // usually means the endpoint is throttling this session. Back off on
        // the same token: first authenticated, then anonymous (which provably
        // works), with growing waits. A fresh token from a cold page-one fetch
        // is the last resort.
        let recovered = 0;
        if (token) {
          for (const at of [
            { wait: 2000, anon: false, tag: 'w' },
            { wait: 5000, anon: true, tag: 'na' },
            { wait: 10000, anon: true, tag: 'na2' }
          ]) {
            if (running !== reqId) return;
            await sleep(at.wait);
            try {
              json = await browse({ context: context(), continuation: token }, at.anon);
              rs = roots(json);
              const b2 = seen.size;
              for (const r of rs) harvest(r, batch, seen);
              token = continuationToken(json) || findToken(rs);
              recovered = seen.size - before;
              trace.push(at.tag + '+' + (seen.size - b2) + (token ? 'T' : '-'));
              json = null;
              rs = null;
            } catch (e2) {
              trace.push(at.tag + 'x');
            }
            if (recovered > 0 || !token) break;
          }
        }
        if (recovered === 0 && !retried) {
          retried = true;
          trace.push('re');
          try {
            // Re-derive a working position on the fast panel chain rather
            // than staying on whatever chain died: one call serves 200.
            api = 'next';
            json = await nextApi({ playlistId: listId });
            const p2 = json.contents && json.contents.twoColumnWatchNextResults &&
              json.contents.twoColumnWatchNextResults.playlist &&
              json.contents.twoColumnWatchNextResults.playlist.playlist;
            rs = p2 ? [p2] : roots(json);
            const b3 = seen.size;
            for (const r of rs) harvest(r, batch, seen);
            if (p2 && p2.totalVideos > total) total = p2.totalVideos;
            token = panelContinuation(json);
            recovered = seen.size - before;
            trace.push('r+' + (seen.size - b3) + (token ? 'T' : '-'));
            json = null;
            rs = null;
          } catch (e3) {
            trace.push('rex');
          }
        }
        if (recovered === 0 && total && baseCount + seen.size < total && !token) {
          // Dying short of the header count with an empty page is not a
          // natural end: those videos exist, the answers are just empty.
          flush(true, 'no continuation data');
          return;
        }
        if (token) {
          flush(false);
          continue;
        }
        naturalEnd = true;
        flush(true);
        return;
      }

      if (added === 0 && !wasContinuation) {
        // The first page re-covered ground the seed (or a previous run)
        // already indexed: expected. Follow its token if there is one;
        // otherwise, if the panel endpoint answered empty, switch chains.
        if (token) {
          flush(false);
          continue;
        }
        if (api === 'next' && total && baseCount + seen.size < total) {
          // The panel answered with nothing it will page (Liked playlists
          // cap it) while the header promises more: switch to browse.
          api = 'browse';
          token = null;
          trace.push('toBrowse');
          flush(false);
          continue;
        }
        if (api === 'next') {
          api = 'browse';
          token = null;
          trace.push('toBrowse');
          continue;
        }
        if (total && baseCount + seen.size < total) {
          flush(true, 'no continuation data');
          return;
        }
        naturalEnd = true;
        flush(true);
        return;
      }

      if (!token) {
        naturalEnd = true;
        flush(true);
        return;
      }
      flush(false);
    }
    naturalEnd = true;
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
        // The largest reported count wins: Liked playlists are capped in the
        // panel and in some header slots while the sidebar carries the truth.
        total: seed ? Math.max(
          findTotal(seed.header),
          findTotal(seed.sidebar),
          findTotal(seed.contents)
        ) : 0,
        passive: passive.items.length
      });
      return;
    }

    if (d.type === 'index') {
      running = d.reqId;
      index(d.listId, d.reqId, d.resumeToken, d.resumeChain, d.base, d.total).catch(function (e) {
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
