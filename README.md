# Aurora — Live Animated Background for iPhone Lock Screen

A perfectly-looping northern-lights animation (6 s, 30 fps, 1080×2340 — the
iPhone lock screen aspect ratio), plus the pipeline that renders it.

- **`aurora-wallpaper.mp4`** — the ready-to-use looping wallpaper video
- **`preview.gif`** — small preview of the animation
- **`index.html`** — the animation itself (open in any browser for a live preview)
- **`render.mjs`** — offline renderer (headless Chromium → PNG frames → ffmpeg)

## Put it on your iPhone lock screen

iOS animates **Live Photos** on the lock screen (press and hold, and the
wake animation on supported models). Convert the MP4 to a Live Photo:

### Option A — intoLive app (easiest)
1. AirDrop / save `aurora-wallpaper.mp4` to your iPhone (it lands in Photos).
2. Install the free **intoLive** app from the App Store.
3. Open intoLive → pick the video → **Make** → save as Live Photo.
4. Settings → Wallpaper → **Add New Wallpaper** → **Photos** → choose the
   Live Photo → make sure the Live Photo (◉) toggle is on → Set as Lock Screen.
5. Press and hold the lock screen (or just raise to wake on newer iOS
   versions) and the aurora flows.

### Option B — Shortcuts / other converters
Any "video to Live Photo" shortcut or app works — the video is a clean
6-second seamless loop, so any segment of it looks right.

### Option C — live web preview
Open `index.html` in Safari (or serve it with `npx serve .`) for the
full-screen animated version in the browser.

## Re-render / customize

```bash
npm install
npm run render     # writes aurora-wallpaper.mp4 + preview.gif
```

Tweak the look in `index.html`:

- `ribbons` — colors, position, sway amplitude and speed of each aurora curtain
- `LOOP` — seconds per loop (keep wave speeds integers for a seamless loop)
- `RENDER_W` / `RENDER_H` — output resolution
- star count, mountain ridges, sky gradient — all in the same file

Every time-dependent term is `sin(2π · k · t / LOOP)` with integer `k`, so
the last frame flows back into the first with no visible seam.
