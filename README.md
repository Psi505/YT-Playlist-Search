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

