(function() {
  // 1) Inject a helper <style> once for our filtered‐out class
  const style = document.createElement('style');
  style.textContent = `
    ._ytpl-hidden-by-search { display: none !important; }
  `;
  document.head.appendChild(style);

  // 2) Wait for the chips bar to appear
  const waitFor = (sel, cb) => {
    const el = document.querySelector(sel);
    if (el) return cb(el);
    new MutationObserver((_, obs) => {
      const e2 = document.querySelector(sel);
      if (e2) {
        obs.disconnect();
        cb(e2);
      }
    }).observe(document.body, { childList: true, subtree: true });
  };

  const chipsSel = 'ytd-feed-filter-chip-bar-renderer iron-selector#chips';

  waitFor(chipsSel, chips => {
    // Build & style the search input
    const input = document.createElement('input');
    input.type = 'search';
    input.placeholder = 'Search this playlist';
    Object.assign(input.style, {
      width:           '350px',
      height:          '35px',
      padding:         '0 12px',
      fontSize:        '15px',
      color:           '#FFF',
      background:      '#181818',
      border:          '1px solid #383838',
      borderRadius:    '16px',
      outline:         'none',
      boxSizing:       'border-box',
      marginLeft:      '22px',
      marginRight:     '14px',
      alignSelf:       'center',
      fontFamily:      'Roboto, Arial, sans-serif'
    });
    input.autocomplete = 'off';

    // Insert after the chips
    chips.parentNode.insertBefore(input, chips.nextSibling);

    // 3) Grab your playlist contents
    const listContainer = document.querySelector(
      '#primary ytd-playlist-video-list-renderer #contents'
    );
    if (!listContainer) return;

    // 4) Build our cache of {el, title}
    const cache = [];
    const collect = () => {
      listContainer.querySelectorAll(
        'ytd-playlist-video-renderer, ytd-playlist-panel-video-renderer'
      ).forEach(el => {
        if (!cache.some(x => x.el === el)) {
          cache.push({
            el,
            title: (el.querySelector('#video-title')?.textContent || '')
                     .trim()
                     .toLowerCase()
          });
        }
      });
    };

    // 5) Filtering logic using class toggles
    let lastQ = '';
    const doFilter = () => {
      const q = lastQ;
      cache.forEach(item => {
        // fewer writes: only toggle class, not style.display
        if (!q || item.title.includes(q)) {
          item.el.classList.remove('_ytpl-hidden-by-search');
        } else {
          item.el.classList.add('_ytpl-hidden-by-search');
        }
      });
    };

    // 6) Debounce + skip duplicates
    let timer;
    const schedule = () => {
      const q = input.value.trim().toLowerCase();
      if (q === lastQ) return;       // skip if unchanged
      lastQ = q;
      clearTimeout(timer);
      timer = setTimeout(doFilter, 200);  // 200ms debounce
    };

    // 7) Observe new items
    collect(); doFilter();
    new MutationObserver(() => {
      collect(); 
      // immediately apply current filter to new items
      doFilter();
    }).observe(listContainer, { childList: true, subtree: true });

    // 8) Wire up typing
    input.addEventListener('input', schedule);
  });
})();
