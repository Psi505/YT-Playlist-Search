<p align="center">
  <img src="https://github.com/Psi505/YT-Playlist-Search/blob/main/YT-Playlist-Search/icons/128x128.png?raw=true"/>
</p>


# YouTube Playlist Search Extension

A fast, lightweight Chromium-based browser extension that adds an in-page search bar to YouTube playlists.

## Features

* Instant filtering of any playlist (including Watch Later) by video title
* Optimized caching and debounced filtering for large playlists
* No API keys or extra permissions required
* Compatible with Chrome, Edge, Brave, and other Chromium browsers

## Repository Structure

```
YT-Playlist-Search/            # root folder
└── YT-Playlist-Search/        # extension files
    ├── icons/
    │   ├── 48x48.png
    │   └── 128x128.png
    ├── manifest.json
    └── content_script.js
```

## Installation

1. Clone the repo:

   ```bash
   git clone https://github.com/Psi505/YT-Playlist-Search.git
   ```
2. In your browser, go to `chrome://extensions/`, enable **Developer mode**, click **Load unpacked**, and select the `YT-Playlist-Search/YT-Playlist-Search` folder.

That’s it—open YouTube, navigate to any playlist, and enjoy instant search!

