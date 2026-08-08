<p align="center">
  <img src="https://github.com/Psi505/YT-Playlist-Search/blob/main/YT-Playlist-Search/icons/128x128.png?raw=true"/>
</p>


# YouTube Playlist Search Extension

A fast, lightweight Chromium-based browser extension that adds an in-page search bar to YouTube playlists.

## Features

* Search any playlist — including Watch Later — by title, with results appearing as you type
* Indexes the **whole** playlist, not just the part you've scrolled to, so every match is reachable
* Results render into their own virtualized list: only a screenful of rows exists at a time, so a 20,000-video playlist costs the same as a 20-video one
* Multi-word search is order-independent (`piano concerto` matches *Concerto for Piano*), and accents are ignored (`bela` matches *Béla*)
* First page of results comes straight out of the page's own data — no request, no waiting
* Index is cached for 6 hours and re-checked against the playlist's current video count, so an edited playlist refreshes itself
* No API keys. The only permission is `storage`, which Chromium grants without an install warning
* Compatible with Chrome, Edge, Brave, and other Chromium browsers

## How it works

Indexing runs in the page's own JavaScript world, which buys two things: `ytcfg`
and `ytInitialData` can be read as live objects rather than scraped out of a
serialized copy of the document, and requests to YouTube's internal `browse`
endpoint go out as the page itself — which is what lets private playlists like
Watch Later index without a scroll-through.

Search deliberately does *not* filter YouTube's own list. YouTube keeps only a
few hundred rows in the DOM at a time, so hiding non-matching rows can never
reveal a match you haven't scrolled to. Drawing our own list from the index
removes that ceiling.

Cold-indexing a large playlist is bounded by YouTube: continuation tokens are
strictly sequential at 100 videos per request, so ~5,000 videos means ~50 round
trips. Results stream in and are searchable throughout, and the index is cached
afterwards.

## Repository Structure

```
YT-Playlist-Search/            # root folder
└── YT-Playlist-Search/        # extension files
    ├── icons/
    │   ├── 48x48.png
    │   └── 128x128.png
    ├── manifest.json
    ├── page_bridge.js         # runs in the page's world: indexing
    └── content_script.js      # runs in the extension's world: UI
```

## Installation

1. **Get the code**

   * **Clone with Git** (if you have Git):

     ```bash
     git clone https://github.com/Psi505/YT-Playlist-Search.git
     ```
   * **Or Download ZIP** (no Git needed):

     1. Go to the [YT-Playlist-Search](https://github.com/Psi505/YT-Playlist-Search) repo.
     2. Click **Code** → **Download ZIP** and extract it.

2. **Load the extension in your browser**

   * Open `chrome://extensions/` (or `edge://extensions/`, `brave://extensions/`).
   * Enable **Developer mode**.
   * Click **Load unpacked** and select the `YT-Playlist-Search/YT-Playlist-Search` folder.

That’s it—open YouTube, navigate to any playlist, and enjoy instant search!

> **Tip:** For easier management, you can move the `YT-Playlist-Search` repo folder into a permanent location—such as an `Extensions` folder inside your user profile—so that you don’t accidentally delete or relocate it when you restart or clean up your downloads.

