# Media conventions

Only media referenced by `index.html` or `style.css` should be committed.
Original captures and intermediate edits stay local; `.gitignore` excludes
source `.MOV` files and the `videos/datacollection/` working directory.

## `assets/fonts/`

Self-hosted Latin-subset WOFF2 files: Sora 600/700 and Inter 400/600. Keeping
them same-origin avoids an external font dependency.

## `assets/images/`

- Use WebP or JPEG posters, normally no wider than 1,600 px.
- Keep each image's HTML `width` and `height` equal to its intrinsic size.
- Method and result figures live in `images/Figs/`; video posters live directly
  in `images/`.

## `assets/videos/`

- Browser delivery format: H.264 MP4 with `yuv420p` and Fast Start (`moov`
  before `mdat`).
- Only `main.mp4` keeps audio; every other video is intentionally silent.
- Keep every committed file below GitHub's 100 MiB per-file limit.
- Videos are created only after a visitor clicks their poster, so they do not
  add to the initial page load.
