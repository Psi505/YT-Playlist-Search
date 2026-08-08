/* YouTube Playlist Search: extension world.
 *
 * Search results are rendered into our own virtualized list rather than by
 * hiding rows in YouTube's. YouTube only keeps a few hundred rows in the DOM
 * at a time, so filtering in place can never show a match that hasn't been
 * scrolled to. Drawing our own list from the index sidesteps that entirely and
 * costs one screenful of nodes no matter how big the playlist is.
 *
 * Data comes from page_bridge.js, which runs in the page's world.
 */
(function () {
  'use strict';

  const REQ_EVT = 'ytpl-req';
  const RES_EVT = 'ytpl-res';
  const ROW_H = 84;
  const OVERSCAN = 6;
  const CACHE_TTL = 6 * 60 * 60 * 1000;
  // Bumped to discard indexes written by builds that could persist a partial.
  const CACHE_V = 3;
  const MAX_INDEXES = 3;
  const MAX_VIEW_H = 4000;
  // Rows show the thumbnail at 112x63. What costs memory is the decoded bitmap,
  // which is width * height * 4 bytes no matter how small the JPEG is: mqdefault
  // (320x180) is 230KB decoded, default (120x90) is 43KB. Take the smaller one
  // unless the display actually has the pixels to show the difference.
  const THUMB = (window.devicePixelRatio || 1) > 1.5 ? 'mqdefault' : 'default';
  const PEEK_TIMEOUT = 2500;
  const INDEX_TIMEOUT = 120000;

  const ITEM_SELECTORS = [
    'yt-lockup-view-model',
    'ytd-playlist-video-renderer',
    'ytd-playlist-panel-video-renderer'
  ].join(', ');
  const LIST_SELECTORS = [
    '#primary ytd-playlist-video-list-renderer #contents',
    'ytd-playlist-video-list-renderer #contents',
    'ytd-playlist-video-list-renderer',
    'ytd-playlist-panel-renderer #items'
  ];
  const CHIPS_SELECTORS = [
    'ytd-feed-filter-chip-bar-renderer iron-selector#chips',
    'yt-feed-filter-chip-bar-renderer #chips'
  ];
  const DURATION_RE = /(?:^|[^\d])((?:\d{1,2}:)?\d{1,2}:\d{2})(?:$|[^\d])/;

  /* ---------- styles ---------- */

  const style = document.createElement('style');
  style.textContent = [
    '#ytpl-search.ytpl-inline{width:350px;height:35px;margin:0 14px 0 22px;border-radius:16px;',
    'font-size:15px;align-self:center}',
    '#ytpl-search.ytpl-block{display:block;width:340px;height:34px;margin:8px 16px 10px 8px;',
    'border-radius:8px;font-size:14px}',
    '#ytpl-search{padding:0 12px;box-sizing:border-box;outline:none;',
    'font-family:Roboto,Arial,sans-serif;color:var(--yt-spec-text-primary,#fff);',
    'background:var(--yt-spec-badge-chip-background,#181818);',
    'border:1px solid var(--yt-spec-10-percent-layer,#383838)}',
    '#ytpl-search:focus{border-color:var(--yt-spec-text-secondary,#909090)}',
    '#ytpl-status{color:var(--yt-spec-text-secondary,#aaa);font-size:13px;',
    'font-family:Roboto,Arial,sans-serif}',
    '#ytpl-status.ytpl-inline{margin-left:2px;align-self:center;white-space:nowrap}',
    '#ytpl-status.ytpl-block{display:block;margin:0 16px 10px 10px}',
    '#ytpl-panel{position:relative;width:100%;contain:layout paint}',
    '#ytpl-sizer{position:relative;width:100%}',
    '.ytpl-row{position:absolute;top:0;left:0;right:0;height:' + ROW_H + 'px;display:flex;',
    'align-items:center;gap:12px;padding:0 8px;box-sizing:border-box;text-decoration:none;',
    'border-radius:10px;color:inherit;contain:layout paint}',
    '.ytpl-row:hover{background:var(--yt-spec-badge-chip-background,#272727)}',
    '.ytpl-num{flex:0 0 34px;text-align:right;font-size:12px;',
    'color:var(--yt-spec-text-secondary,#aaa);font-family:Roboto,Arial,sans-serif}',
    '.ytpl-thumb{flex:0 0 auto;width:112px;height:63px;object-fit:cover;border-radius:8px;',
    'background:var(--yt-spec-10-percent-layer,#282828)}',
    '.ytpl-title{font-size:14px;line-height:1.4;font-family:Roboto,Arial,sans-serif;',
    'color:var(--yt-spec-text-primary,#fff);display:-webkit-box;-webkit-line-clamp:2;',
    '-webkit-box-orient:vertical;overflow:hidden}',
    '#ytpl-empty{padding:24px 8px;font-size:14px;font-family:Roboto,Arial,sans-serif;',
    'color:var(--yt-spec-text-secondary,#aaa)}'
  ].join('');
  (document.head || document.documentElement).appendChild(style);

  /* ---------- text ---------- */

  // Fold case and strip combining marks once, at index time, so a keystroke
  // only costs an indexOf per title instead of a fresh allocation per title.
  function norm(s) {
    return s.toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '');
  }

  function makeMatcher(q) {
    const toks = norm(q).split(/\s+/).filter(Boolean);
    if (!toks.length) return null;
    if (toks.length === 1) {
      const t = toks[0];
      return s => s.indexOf(t) !== -1;
    }
    return s => toks.every(t => s.indexOf(t) !== -1);
  }

  /* ---------- storage ---------- */

  function storeGet(key) {
    return new Promise(resolve => {
      try {
        chrome.storage.local.get(key, o => {
          void chrome.runtime.lastError;
          resolve((o && o[key]) || null);
        });
      } catch (e) {
        resolve(null);
      }
    });
  }

  function storeSet(key, val) {
    try {
      chrome.storage.local.set({ [key]: val }, () => void chrome.runtime.lastError);
    } catch (e) {}
  }

  /* ---------- bridge ---------- */

  let reqSeq = 0;
  const pending = new Map();

  // A private CustomEvent channel, not window messages. See page_bridge.js: a
  // window 'message' listener here has to read ev.data to identify its own
  // traffic, and that deserializes every message YouTube posts to itself
  // (~28,000/s), which was the dominant source of memory churn in this
  // extension. This listener fires only for our own events.
  document.addEventListener(RES_EVT, ev => {
    let d;
    try { d = JSON.parse(ev.detail); } catch (e) { return; }
    if (!d || (d.type !== 'peek' && d.type !== 'batch')) return;
    const cb = pending.get(d.reqId);
    if (cb) cb(d);
  });

  function send(msg) {
    document.dispatchEvent(new CustomEvent(REQ_EVT, { detail: JSON.stringify(msg) }));
  }

  // Resolves null when the page-world script isn't there at all.
  function peek() {
    return new Promise(resolve => {
      const reqId = ++reqSeq;
      const to = setTimeout(() => { pending.delete(reqId); resolve(null); }, PEEK_TIMEOUT);
      pending.set(reqId, d => { clearTimeout(to); pending.delete(reqId); resolve(d); });
      send({ type: 'peek', reqId: reqId });
    });
  }

  /* ---------- index model ---------- */

  const indexes = new Map();

  function getIndex(listId) {
    let m = indexes.get(listId);
    if (m) {
      // Map iterates in insertion order, so re-inserting makes this the most
      // recently used and leaves the eviction candidate first.
      indexes.delete(listId);
      indexes.set(listId, m);
      return m;
    }
    m = {
      listId: listId,
      items: [],
      ids: new Set(),
      total: 0,
      done: false,
      complete: false,
      error: '',
      cachePromise: null,
      bridge: false,
      started: false,
      listeners: new Set()
    };
    indexes.set(listId, m);
    // Without this, browsing playlists in one tab retains every index visited.
    // Cached ones reload from storage in milliseconds, so holding them costs
    // memory for no real benefit.
    for (const key of indexes.keys()) {
      if (indexes.size <= MAX_INDEXES) break;
      const victim = indexes.get(key);
      if (key === listId || (victim && victim.listeners.size)) continue;
      indexes.delete(key);
    }
    return m;
  }

  function addItems(m, pairs) {
    let added = 0;
    for (const pair of pairs) {
      const id = pair[0], title = pair[1];
      if (!id || !title || m.ids.has(id)) continue;
      m.ids.add(id);
      m.items.push({ id: id, title: title, norm: norm(title), pos: m.items.length + 1 });
      added++;
    }
    return added;
  }

  function notify(m) {
    for (const fn of m.listeners) {
      try { fn(m); } catch (e) {}
    }
  }

  // Cheap half: a storage read and a peek at the count already in the page. No
  // network, no response parsing. Safe to run on every playlist you open.
  function loadCache(listId) {
    const m = getIndex(listId);
    // Memoize the promise, not a flag: focusing the box while this is still in
    // flight must wait for it, or ensureIndex reads m.bridge before it is set
    // and wrongly concludes the page script is missing.
    if (m.cachePromise) return m.cachePromise;

    m.cachePromise = (async () => {
      const [cached, peeked] = await Promise.all([storeGet('idx:' + listId), peek()]);
      m.bridge = !!peeked;
      const pageTotal = peeked ? peeked.total : 0;
      if (pageTotal > m.total) m.total = pageTotal;

      // A stale cache is caught by TTL; an edited playlist is caught by the
      // count the page itself reports, which costs nothing to read.
      if (cached && cached.v === CACHE_V && Array.isArray(cached.items) &&
          Date.now() - cached.at < CACHE_TTL &&
          (!pageTotal || cached.total === pageTotal)) {
        addItems(m, cached.items);
        m.total = cached.total || m.items.length;
        m.done = true;
        m.complete = true;
      }
      notify(m);
      return m;
    })();
    return m.cachePromise;
  }

  // Expensive half: ~50 sequential requests, each a multi-megabyte response to
  // parse. Deferred until the search box is actually used, because most visits
  // to a playlist never search it and were paying for this anyway.
  async function ensureIndex(listId) {
    const m = await loadCache(listId);
    if (m.done || m.started) return m;
    m.started = true;

    if (!m.bridge) {
      m.error = 'page script unavailable';
      m.done = true;
      notify(m);
      return m;
    }

    const key = 'idx:' + listId;
    const reqId = ++reqSeq;
    const finish = () => {
      pending.delete(reqId);
      clearTimeout(guard);
      m.done = true;
      // Never persist a short index. A cached partial is worse than no cache,
      // because it looks authoritative for the whole TTL.
      if (!m.error && m.complete) {
        storeSet(key, {
          v: CACHE_V,
          at: Date.now(),
          total: m.total || m.items.length,
          items: m.items.map(i => [i.id, i.title])
        });
      }
      notify(m);
    };
    const guard = setTimeout(() => {
      if (!m.done) { m.error = m.error || 'timed out'; finish(); }
    }, INDEX_TIMEOUT);

    pending.set(reqId, d => {
      if (d.items && d.items.length) addItems(m, d.items);
      if (d.total > m.total) m.total = d.total;
      if (d.error) m.error = d.error;
      if (d.done) { m.complete = !!d.complete; finish(); }
      else notify(m);
    });
    send({ type: 'index', reqId: reqId, listId: listId });
    return m;
  }

  /* ---------- page probing ---------- */

  function isRendered(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 || r.height > 0;
  }

  // A lockup can also be a playlist or channel card; require a watch link that
  // carries the list param, or a duration badge.
  function isVideoLockup(el) {
    const links = el.querySelectorAll('a[href*="/watch?v="]');
    if (!links.length) return false;
    for (const a of links) if (/[?&]list=/.test(a.href)) return true;
    return Array.prototype.some.call(
      el.querySelectorAll('badge-shape, yt-thumbnail-badge-view-model'),
      b => DURATION_RE.test(b.textContent || '')
    );
  }

  function findList() {
    for (const sel of LIST_SELECTORS) {
      const els = document.querySelectorAll(sel);
      for (const el of els) if (isRendered(el)) return el;
    }
    // The newer lockup-based playlist UI has none of the selectors above, so
    // find a real video lockup and climb to whatever contains the set.
    const scope = document.querySelector('#primary') || document;
    for (const l of scope.querySelectorAll('yt-lockup-view-model')) {
      if (!isRendered(l) || !isVideoLockup(l)) continue;
      return l.closest(
        'yt-section-list-renderer, ytd-section-list-renderer, [id*="contents"]'
      ) || l.parentElement;
    }
    return null;
  }

  // On /playlist the page itself scrolls; in the watch-page sidebar the list
  // lives inside its own scrolling box. Returns null to mean "the window".
  function scrollParentOf(el) {
    let n = el.parentElement;
    while (n && n !== document.body && n !== document.documentElement) {
      const oy = getComputedStyle(n).overflowY;
      if (/(auto|scroll|overlay)/.test(oy) && n.scrollHeight > n.clientHeight + 1) return n;
      n = n.parentElement;
    }
    return null;
  }

  function firstOf(selectors) {
    for (const s of selectors) {
      const el = document.querySelector(s);
      if (el && isRendered(el)) return el;
    }
    return null;
  }

  // Take the longest candidate, not the first: on lockups the thumbnail anchor
  // matches first and has no text, which would silently yield an empty title.
  function titleOf(el) {
    let best = '';
    const nodes = el.querySelectorAll(
      '#video-title, #video-title-link, h3 a, a[href*="/watch?v="]'
    );
    for (const n of nodes) {
      const t = (n.textContent || '').replace(/\s+/g, ' ').trim();
      if (t.length > best.length) best = t;
    }
    return best;
  }

  // Line the box up with the thumbnails by measuring, not by a fixed indent:
  // YouTube's left gutter shifts with viewport width and layout revisions.
  function alignInput(input, status, list) {
    const item = Array.prototype.find.call(
      list.querySelectorAll(ITEM_SELECTORS),
      el => isVideoLockup(el) && isRendered(el)
    );
    if (!item) return false;
    const ref = item.querySelector(
      'ytd-thumbnail, yt-thumbnail-view-model, a#thumbnail, #thumbnail, ' +
      '#video-title-link, #video-title'
    ) || item;
    const delta = Math.round(
      ref.getBoundingClientRect().left - input.getBoundingClientRect().left
    );
    // A wild delta means we measured something unrelated; leave it alone.
    if (Math.abs(delta) < 400 && delta !== 0) {
      // Base off the computed margin, not the inline one: the inline style is
      // empty on the first pass, so reading it would silently drop the margin
      // the stylesheet already applies and land the box short by that much.
      for (const el of [input, status]) {
        const base = parseFloat(getComputedStyle(el).marginLeft) || 0;
        el.style.marginLeft = (base + delta) + 'px';
      }
    }
    return true;
  }

  /* ---------- ui ---------- */

  let ui = null;

  function mount() {
    const listId = new URLSearchParams(location.search).get('list');
    if (!listId) return false;
    const list = findList();
    if (!list) return false;
    if (ui && ui.list === list && ui.input.isConnected) return true;
    if (ui) ui.destroy();

    const input = document.createElement('input');
    input.type = 'search';
    input.id = 'ytpl-search';
    input.placeholder = 'Search this playlist';
    input.autocomplete = 'off';
    input.spellcheck = false;

    const status = document.createElement('span');
    status.id = 'ytpl-status';
    status.style.display = 'none';

    const chips = firstOf(CHIPS_SELECTORS);
    if (chips && chips.parentNode) {
      input.className = 'ytpl-inline';
      status.className = 'ytpl-inline';
      chips.parentNode.insertBefore(input, chips.nextSibling);
      input.insertAdjacentElement('afterend', status);
    } else {
      input.className = 'ytpl-block';
      status.className = 'ytpl-block';
      list.parentNode.insertBefore(input, list);
      input.insertAdjacentElement('afterend', status);
    }

    const panel = document.createElement('div');
    panel.id = 'ytpl-panel';
    panel.style.display = 'none';
    const sizer = document.createElement('div');
    sizer.id = 'ytpl-sizer';
    const empty = document.createElement('div');
    empty.id = 'ytpl-empty';
    empty.style.display = 'none';
    empty.textContent = 'No matches.';
    panel.append(empty, sizer);
    list.parentNode.insertBefore(panel, list);

    const listDisplay = list.style.display;
    let query = '';
    let results = [];
    let active = false;
    let savedScroll = 0;
    let scroller = null;

    /* --- virtualized rows --- */

    const pool = [];
    let winStart = -1, winEnd = -1;

    function makeRow() {
      const a = document.createElement('a');
      a.className = 'ytpl-row';
      const num = document.createElement('span');
      num.className = 'ytpl-num';
      const img = document.createElement('img');
      img.className = 'ytpl-thumb';
      img.loading = 'lazy';
      img.decoding = 'async';
      const t = document.createElement('span');
      t.className = 'ytpl-title';
      a.append(num, img, t);
      sizer.appendChild(a);
      return { el: a, num: num, img: img, t: t, id: null, y: -1 };
    }

    function fillRow(row, item, slot) {
      const y = slot * ROW_H;
      if (row.y !== y) {
        row.el.style.transform = 'translateY(' + y + 'px)';
        row.y = y;
      }
      if (row.id !== item.id) {
        row.id = item.id;
        row.num.textContent = item.pos;
        row.t.textContent = item.title;
        row.img.src = 'https://i.ytimg.com/vi/' + item.id + '/' + THUMB + '.jpg';
        row.el.href = '/watch?v=' + encodeURIComponent(item.id) +
          '&list=' + encodeURIComponent(listId) + '&index=' + item.pos;
      }
      if (row.el.style.display === 'none') row.el.style.display = '';
    }

    function renderWindow() {
      // Everything measured before anything is written, so a scroll frame
      // never triggers a synchronous re-layout.
      const n = results.length;
      // Work in the panel's own coordinate space: where the visible region
      // starts relative to the panel top. That is the same arithmetic whether
      // the page scrolls or an ancestor box does, which is what the watch-page
      // sidebar needs.
      const panelTop = panel.getBoundingClientRect().top;
      const viewTop = (scroller ? scroller.getBoundingClientRect().top : 0) - panelTop;
      // Clamped because the row pool is sized from this. An unconstrained
      // scrolling ancestor can report its full content height here, which would
      // build thousands of rows and thumbnails instead of one screenful.
      const viewH = Math.min(
        scroller ? scroller.clientHeight : window.innerHeight, MAX_VIEW_H);
      const first = Math.max(0, Math.floor(viewTop / ROW_H) - OVERSCAN);
      const last = Math.max(first, Math.min(
        n, Math.ceil((viewTop + viewH) / ROW_H) + OVERSCAN
      ));

      const h = (n * ROW_H) + 'px';
      if (sizer.style.height !== h) sizer.style.height = h;
      const showEmpty = (active && n === 0) ? '' : 'none';
      if (empty.style.display !== showEmpty) empty.style.display = showEmpty;

      if (first === winStart && last === winEnd) return;
      winStart = first;
      winEnd = last;

      const need = last - first;
      while (pool.length < need) pool.push(makeRow());
      for (let k = 0; k < pool.length; k++) {
        if (k < need) {
          fillRow(pool[k], results[first + k], first + k);
        } else if (pool[k].el.style.display !== 'none') {
          pool[k].el.style.display = 'none';
          // Drop the thumbnail so Chrome can release the decoded bitmap, which
          // is far larger than the encoded file. Clearing id forces a refill.
          pool[k].img.removeAttribute('src');
          pool[k].id = null;
        }
      }
    }

    let raf = 0;
    function onScroll() {
      if (raf) return;
      raf = requestAnimationFrame(() => { raf = 0; renderWindow(); });
    }

    /* --- search --- */

    function recompute() {
      const m = getIndex(listId);
      const match = makeMatcher(query);
      results = [];
      if (match) {
        const items = m.items;
        for (let i = 0; i < items.length; i++) {
          if (match(items[i].norm)) results.push(items[i]);
        }
      }
      winStart = winEnd = -1;
      if (active) renderWindow();
      updateStatus();
    }

    function setActive(on) {
      if (active === on) return;
      active = on;
      if (on) {
        // Resolved here, not at mount: the list has to be laid out and
        // scrollable before its scrolling ancestor can be identified.
        scroller = scrollParentOf(list);
        savedScroll = scroller ? scroller.scrollTop : window.scrollY;
        list.style.display = 'none';
        panel.style.display = '';
        (scroller || window).addEventListener('scroll', onScroll, { passive: true });
        window.addEventListener('resize', onScroll);
        // Start at the top of the results rather than wherever the list was.
        if (scroller) scroller.scrollTop = 0;
        else {
          const top = panel.getBoundingClientRect().top + window.scrollY;
          if (window.scrollY > top) window.scrollTo(0, top);
        }
      } else {
        (scroller || window).removeEventListener('scroll', onScroll);
        window.removeEventListener('resize', onScroll);
        panel.style.display = 'none';
        list.style.display = listDisplay;
        if (scroller) scroller.scrollTop = savedScroll;
        else window.scrollTo(0, savedScroll);
        scroller = null;
      }
    }

    function updateStatus() {
      const m = getIndex(listId);
      let t;
      if (query) {
        t = results.length.toLocaleString() +
          (results.length === 1 ? ' match' : ' matches');
        if (!m.done) t += ' so far…';
      } else if (m.done) {
        const n = m.items.length;
        if (!n) {
          t = 'Index failed (' + (m.error || 'no videos found') + ')';
        } else if (!m.complete) {
          // Say what actually happened rather than presenting a short index
          // as the whole playlist.
          t = n.toLocaleString() + ' of ' + (m.total || '?').toLocaleString() +
            ' indexed (' + (m.error || 'stopped early') + ')';
        } else {
          t = n.toLocaleString() + (n === 1 ? ' video' : ' videos');
          // The gap is deleted/private entries YouTube counts but won't list.
          // Naming it stops a normal shortfall from reading as a failure.
          if (m.total > n) t += ' (' + (m.total - n).toLocaleString() + ' unavailable)';
        }
      } else if (!m.started) {
        // Nothing has been indexed yet by design. The count still comes free
        // from what the page already reported, so the line is not empty.
        t = m.total ? m.total.toLocaleString() + ' videos' : '';
      } else if (m.total) {
        t = 'Indexing ' + m.items.length.toLocaleString() + '/' +
          m.total.toLocaleString() + '…';
      } else {
        t = m.items.length
          ? 'Indexing ' + m.items.length.toLocaleString() + '…'
          : 'Indexing…';
      }
      status.textContent = t;
      status.style.display = t ? '' : 'none';
    }

    // Focus is the earliest reliable signal of intent to search, so indexing
    // starts there rather than on the first keystroke: by the time a query is
    // typed the first pages are usually already in.
    let indexRequested = false;
    function beginIndex() {
      if (indexRequested) return;
      indexRequested = true;
      // Widen only for the duration of the run: the DOM fallback matters only
      // while indexing is actually happening.
      setWide(true);
      ensureIndex(listId).then(onIndexUpdate);
    }
    input.addEventListener('focus', beginIndex);

    input.addEventListener('input', () => {
      beginIndex();
      query = input.value.trim();
      setActive(!!query);
      recompute();
    });
    input.addEventListener('keydown', e => {
      if (e.key === 'Escape' && query) {
        e.stopPropagation();
        input.value = '';
        query = '';
        setActive(false);
        recompute();
      }
    });

    /* --- fallback: merge whatever YouTube renders --- */

    // Only ever touches nodes the observer reports as added, so scrolling a
    // large playlist stays O(new rows) rather than O(rows on screen).
    function harvestEl(el) {
      const a = el.querySelector('a[href*="/watch?v="]');
      if (!a) return false;
      const mv = a.href.match(/[?&]v=([\w-]+)/);
      if (!mv) return false;
      const title = titleOf(el);
      if (!title) return false;
      return addItems(getIndex(listId), [[mv[1], title]]) > 0;
    }

    let aligned = false;
    let refreshPending = false;
    function scheduleRefresh() {
      if (refreshPending) return;
      refreshPending = true;
      setTimeout(() => {
        refreshPending = false;
        if (!aligned && !active) aligned = alignInput(input, status, list);
        recompute();
      }, 200);
    }

    // The subtree observer exists only to pick up rows YouTube renders *while
    // we are indexing*, as a fallback for when the API path cannot be reached.
    // Outside that window it is pure cost: YouTube churns this subtree
    // constantly, and each batch allocates NodeLists through querySelectorAll
    // and titleOf whether or not we have any use for them. Measured at ~10MB/s
    // of garbage on an idle 888-video playlist.
    //
    // Narrow means watching the parent's direct children, which still catches
    // the list being swapped out — the only thing we need when not indexing.
    let wide = null;
    function setWide(on) {
      if (wide === on) return;
      wide = on;
      mo.disconnect();
      if (on) mo.observe(list, { childList: true, subtree: true });
      else if (list.parentNode) mo.observe(list.parentNode, { childList: true });
    }

    const mo = new MutationObserver(muts => {
      if (!list.isConnected || !input.isConnected) {
        instance.destroy();
        scheduleMount();
        return;
      }
      if (!wide) return;
      if (getIndex(listId).done) { setWide(false); return; }
      let added = false;
      for (const mut of muts) {
        for (const node of mut.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.matches && node.matches(ITEM_SELECTORS)) {
            added = harvestEl(node) || added;
          } else if (node.querySelectorAll) {
            for (const el of node.querySelectorAll(ITEM_SELECTORS)) {
              added = harvestEl(el) || added;
            }
          }
        }
      }
      if (added) scheduleRefresh();
    });
    setWide(false);

    // Seed from what's already on screen.
    for (const el of list.querySelectorAll(ITEM_SELECTORS)) harvestEl(el);
    aligned = alignInput(input, status, list);

    const onIndexUpdate = () => {
      if (ui !== instance) return;
      // Indexing can finish without any further DOM mutation, so the observer
      // has to be narrowed here too rather than only from its own callback.
      if (getIndex(listId).done) setWide(false);
      recompute();
    };

    const instance = {
      list: list,
      input: input,
      listId: listId,
      destroy() {
        mo.disconnect();
        (scroller || window).removeEventListener('scroll', onScroll);
        window.removeEventListener('resize', onScroll);
        getIndex(listId).listeners.delete(onIndexUpdate);
        list.style.display = listDisplay;
        input.remove();
        status.remove();
        panel.remove();
        if (ui === instance) ui = null;
      }
    };
    ui = instance;

    getIndex(listId).listeners.add(onIndexUpdate);
    loadCache(listId).then(onIndexUpdate);
    updateStatus();
    return true;
  }

  /* ---------- lifecycle ---------- */

  // Retries only while unmounted, then stops. No permanent timer forcing a
  // layout on every YouTube page.
  let retryTimer = 0;
  let retriesLeft = 0;

  function scheduleMount() {
    retriesLeft = 40;
    if (retryTimer) return;
    retryTimer = setInterval(() => {
      let ok = false;
      try { ok = mount(); } catch (e) {}
      if (ok || --retriesLeft <= 0) {
        clearInterval(retryTimer);
        retryTimer = 0;
      }
    }, 400);
  }

  function onNavigate() {
    const listId = new URLSearchParams(location.search).get('list');
    if (ui && ui.listId !== listId) ui.destroy();
    scheduleMount();
  }

  document.addEventListener('yt-navigate-finish', onNavigate);
  window.addEventListener('popstate', onNavigate);

  try { mount(); } catch (e) {}
  scheduleMount();
})();
