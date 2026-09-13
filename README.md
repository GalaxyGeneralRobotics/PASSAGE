# PASSAGE Project Page

Static academic project page for the paper. The site is plain HTML, CSS, and
JavaScript with no backend server, so it can be deployed on any static host.

```
PASSAGE/
├── index.html        page structure — all TODO markers live here
├── style.css         design system: tokens, fonts, components, no framework
├── web.js            deferred: media facades and custom video player
└── assets/
    ├── fonts/        self-hosted woff2 (Sora + Inter, 78KB total)
    ├── images/       posters + figures   (see assets/README.md)
    └── videos/       mp4 clips           (see assets/README.md)
```

## Page content

The page content and media order live in `index.html`. Missing posters degrade
to a small "material pending" panel, so unfinished links or media never break
the rest of the page.

1. **Text**: title, subtitle, authors, affiliations, abstract, bibtex —
   search `TODO` in `index.html`.
2. **Links**: arXiv / GitHub buttons in the header `<nav class="links">`;
   delete buttons that do not apply.
3. **Main video**: `assets/videos/main.mp4` + poster
   `assets/images/main_poster.jpg`.
4. **Sub videos**: one facade block per clip; poster in `assets/images/`, clip
   in `assets/videos/`. Only the main video keeps audio.
5. **Figures**: the method overview is `PASSAGE_publish.webp`; quantitative
   figures live under `assets/images/Figs/`. Keep every image's intrinsic
   `width`/`height` attributes matched to the real file so the layout does not
   shift while images load.
## Deploy

Any static host works (the page is three files + assets). Page media
(videos/posters) load through jsDelivr — the free public CDN that fronts
GitHub repos (Cloudflare + Fastly edges, ACAO:*, Range). `web.js` probes
`cdn.jsdelivr.net` and `fastly.jsdelivr.net` at boot with a CORS fetch
(a 404 — e.g. while the repo is still private — counts as unreachable)
and rewrites `assets/videos|images` URLs to the fastest healthy
endpoint, falling back to the same-origin GitHub Pages copies if both
CDNs are unreachable or slow (>1.5s). Requirements: the repo must be
public, and no media file may exceed jsDelivr's 20MB per-file cap
(`main.mp4` is re-encoded to ~18MB for exactly that reason). No extra
uploads: the CDN reads straight from this repo's `main` branch.

For local preview, use the included server so long videos can seek to content
that has not buffered yet (`python3 -m http.server` in Python 3.10 does not
handle the required HTTP byte-range requests):

```bash
cd PASSAGE
python3 serve.py 8000
```

Then open `http://localhost:8000/`. A video range request will receive
`206 Partial Content`, matching the behavior expected from a production static
host.

Production: put the folder behind nginx / object storage / GitHub Pages.
There is no server-side component. Serve over HTTPS so clipboard and other
secure-context browser APIs are available.

## Why the page loads fast

The requirement was "optimize resource loading; huge static assets must not
slow the page down". From first principles the page ships a fixed, tiny
budget (~100KB: html+css+js+fonts) and **everything heavy is opt-in**:

| Cost | Mitigation |
| --- | --- |
| Multi-MB videos | click-to-play facades; nearby clips warm only their metadata, with at most two warm-ups active at once |
| Images / posters | `loading="lazy"` + `decoding="async"` + intrinsic `width`/`height` (no layout shift); keep posters ≤ ~150KB as WebP/JPEG |
| Webfonts | 4 self-hosted latin-subset woff2, 78KB total, `font-display: swap` + 2 preloads — headings Sora, body Inter |
| Frameworks / build | none — plain HTML/CSS/JS, `defer` script |

Encoding targets for `assets/videos/` (renders ~380–780px wide on the page):
main video H.264 ≤ 8 Mbps 1080p with AAC audio; sub clips H.264 ≤ 4 Mbps and
normally ≤ 720p with no audio. Prefer H.264 MP4 with Fast Start — it plays
widely and streams via range requests from any static host.
