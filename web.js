'use strict';

/* ═══════════════════════════════════════════════════════════════════
 * Project page interaction — the whole script is ~3KB, deferred, and
 * does four things:
 *   1. Media facades: videos stream only when the visitor clicks, with
 *      lightweight metadata warm-up near the viewport.
 *   2. Graceful "material pending" states (posters missing on purpose
 *      while the site is a template).
 *   3. BibTeX copy button.
 *   4. Accessible horizontal controls for the evaluation video rails.
 * ═══════════════════════════════════════════════════════════════════ */

/* ── -1. CDN base for heavy media ──────────────────────────────────── */

/* Videos and posters live in this repo, served either by GitHub Pages
 * (same-origin) or by jsDelivr — the free public CDN that fronts any
 * public GitHub repository (Cloudflare + Fastly, worldwide edges, ACAO:*
 * on every response including 404s, Range supported). We probe both CDN
 * endpoints on boot with a real CORS fetch (so a 404 — e.g. while the
 * repo is still private — counts as unreachable, unlike a no-cors
 * opaque response) and rewrite every assets/videos|images URL to the
 * fastest healthy endpoint. Constraints honored: jsDelivr serves no
 * file above 20MB, which is why main.mp4 is re-encoded to ~18MB.
 * Unreachable or slow (>1.5s) probes keep the page on same-origin URLs,
 * and any media that errors mid-playback on the CDN reverts to the
 * same-origin copy. (hf-mirror.com was tried and does NOT work: it
 * 302s xet-backed files back to cas-bridge.xethub.hf.co with a
 * text/plain redirect body, which Chrome's Opaque Response Blocking
 * kills for cross-origin media — zero China acceleration.) */
const ASSET_CDN_BASES = [
  'https://cdn.jsdelivr.net/gh/GalaxyGeneralRobotics/PASSAGE@main',
  'https://fastly.jsdelivr.net/gh/GalaxyGeneralRobotics/PASSAGE@main',
];

function probeCdnBase(base, timeoutMs = 3500, maxLatencyMs = 1500) {
  /* jsDelivr sends Access-Control-Allow-Origin: * on every response, so
   * a normal CORS fetch works and lets us check response.ok — the
   * no-cors variant cannot distinguish a 404 (repo still private) from
   * a hit. Also gates on latency: a CDN that answers slower than
   * maxLatencyMs would stall playback worse than same-origin. */
  const t0 = performance.now();
  return Promise.race([
    fetch(`${base}/assets/images/Figs/1.webp`, { mode: 'cors', cache: 'no-store' })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const ms = performance.now() - t0;
        if (ms > maxLatencyMs) throw new Error('too slow');
        return { base, ms };
      }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs)),
  ]);
}

const cdnReady = (async () => {
  try {
    const results = await Promise.allSettled(ASSET_CDN_BASES.map((b) => probeCdnBase(b)));
    const ok = results.filter((r) => r.status === 'fulfilled').sort((a, b) => a.value.ms - b.value.ms);
    if (!ok.length) throw new Error('all CDNs unreachable');
    const base = ok[0].value.base;
    window.__ASSET_CDN_ALT = ok.length > 1 ? ok[1].value.base : '';
    /* The repo keeps media under assets/, so the rewrite only swaps the
     * origin: ./assets/videos/x.mp4 -> <cdn>/gh/.../assets/videos/x.mp4. */
    const toCdn = (url) => url.replace(/^\.?\/?(assets\/)/, `${base}/$1`);
    for (const img of document.querySelectorAll('img[src^="assets/"], img[src^="./assets/"]')) {
      img.dataset.localSrc = img.getAttribute('src');
      img.src = toCdn(img.getAttribute('src'));
      img.addEventListener('error', () => {
        if (img.dataset.localSrc) { img.src = img.dataset.localSrc; delete img.dataset.localSrc; }
      }, { once: true });
    }
    const alt = window.__ASSET_CDN_ALT;
    for (const f of document.querySelectorAll('.facade[data-src^="assets/"], .facade[data-src^="./assets/"]')) {
      f.dataset.localSrc = f.dataset.src;
      f.dataset.src = toCdn(f.dataset.src);
      // Second CDN endpoint, precomputed: if the winning endpoint chokes on
      // the actual video stream (small probe passed, big file throttled),
      // the click handler fails over here first, same-origin last.
      if (alt) f.dataset.altSrc = toCdn(f.dataset.src).replace(base, alt);
    }
    return base;
  } catch {
    return '';  // both CDNs unreachable: stay same-origin
  }
})();

/* ── 0. Poster fade-in ──────────────────────────────────────────────── */

/* Posters decode off the main thread (decoding="async") and fade in once
 * their pixels are ready, so lazy-loaded frames far down the page never
 * pop in harshly. Cached images (already complete) fade in immediately.
 * Runs after the CDN rewrite so posters fetch from the chosen host once. */
cdnReady.then(() => {
  for (const img of document.querySelectorAll('.facade img, figure img')) {
    const show = () => img.classList.add('is-loaded');
    if (img.complete && img.naturalWidth > 0) show();
    else {
      img.addEventListener('load', show, { once: true });
      img.addEventListener('error', show, { once: true });  // never trap a dim frame on 404
    }
  }
});

/* ── 1. Media facades ─────────────────────────────────────────────── */

/* ── 1a. Video warm-up (prefetch before the click) ─────────────────── */

/* Videos stream on demand, but the click should not also pay for the
 * connection setup and the moov header. When a video facade approaches
 * the viewport we warm it: a hidden <video preload="metadata"> fetches
 * just the headers (plus whatever leading chunk the browser chooses),
 * sharing the HTTP cache with the real element that the click builds.
 * On click the same element is promoted: preload="auto" + play() pull
 * the stream at full speed. Priorities:
 *   1. the hero video — warmed right after load, preload="auto" (it is
 *      the one visitors actually click first);
 *   2. everything else — warmed in viewport order as it approaches, at
 *      most two at a time so warming never competes with rendering.
 * The queue drains as each warm-up settles (metadata or error). */
const WARM_MAX = 2;
const warmPending = [];
let warmActive = 0;

function warmStart(facade) {
  const media = document.createElement('video');
  media.playsInline = true;
  media.muted = true;             // silent placeholder; sound set on click
  media.className = 'facade__warm';
  media.preload = facade.dataset.priority === 'high' ? 'auto' : 'metadata';
  media.src = facade.dataset.src;
  // Flag once the first frame is already available: preload=auto may get
  // here BEFORE the click, and the click-side 'loadeddata' listener would
  // never fire — the poster would then sit on top of a playing video.
  media.addEventListener('loadeddata', () => { media._warmReady = true; }, { once: true });
  facade._warm = media;
  facade.appendChild(media);
  let settled = false;
  const done = () => {
    if (settled) return;
    settled = true;
    warmActive--;
    warmPump();
  };
  media.addEventListener('loadedmetadata', done, { once: true });
  media.addEventListener('error', done, { once: true });
  // Safety net: never hold a queue slot hostage by a stalled request.
  setTimeout(done, 15000);
}

function warmPump() {
  while (warmActive < WARM_MAX && warmPending.length) {
    const facade = warmPending.shift();
    if (facade.dataset.loaded || facade._warm) continue;  // stale entry
    if (facade.classList.contains('is-missing')) continue;  // no poster
    warmActive++;
    warmStart(facade);
  }
}

function warmQueue(facade) {
  if (facade.dataset.facade !== 'video' || !facade.dataset.src) return;
  if (facade._warm || facade.dataset.loaded) return;
  facade.dataset.queued = '1';
  warmPending.push(facade);
  warmPump();
}

{
  // Gate the warm-up queue on the CDN pick so warm requests hit the
  // chosen host directly (never local-first-then-rewritten).
  cdnReady.then(() => {
    const hero = document.querySelector('#main-video .facade[data-facade="video"]');
    if (hero) { hero.dataset.priority = 'high'; warmQueue(hero); }
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) {
        warmQueue(e.target);
        io.unobserve(e.target);     // warmed once is enough
      }
    }, { rootMargin: '150% 0px' });  // one and a half screens ahead
    for (const f of document.querySelectorAll('.facade[data-facade="video"]'))
      if (f !== hero) io.observe(f);
  });
}

for (const facade of document.querySelectorAll('.facade[data-facade="video"]')) {
  facade.addEventListener('click', () => {
    if (facade.dataset.loaded) return;
    const kind = facade.dataset.facade;
    const isMainVideo = kind === 'video' && Boolean(facade.closest('#main-video'));
    const missing = facade.classList.contains('is-missing');

    // No poster = template state; there is no media to play.
    if (missing) return;

    const src = facade.dataset.src || '';
    let media;
    if (kind === 'video') {
      // Reuse the warmed element when present: its cached headers and any
      // prefetched leading chunk carry over — the click streams at full
      // speed instead of paying connection + moov again.
      media = facade._warm || document.createElement('video');
      delete facade._warm;
      media.classList.remove('facade__warm');
      media.playsInline = true;
      media.autoplay = true;      // the click counts as the user gesture
      // Keep sound only on the hero video; qualitative-result clips are muted.
      media.muted = !isMainVideo;
      media.defaultMuted = media.muted;
      // Reassigning an identical src restarts the load algorithm and
      // discards the warmed progress — only set it when absent.
      if (!media.getAttribute('src')) media.src = src;
      media.preload = 'auto';     // full-speed streaming from here on
      // Failover chain when the CDN stream chokes. A stalled connection
      // that never delivered a byte fires NO DOM event at all, so an
      // unconditional first-frame watchdog arms here; 'error' and a
      // stalled-with-low-readyState pass cover streams that die later.
      const failovers = [facade.dataset.altSrc, facade.dataset.localSrc]
        .filter(Boolean).filter((s) => s !== src);
      delete facade.dataset.altSrc;
      let failoverTimer = null;
      const failoverNow = () => {
        if (!failovers.length) return;
        const next = failovers.shift();
        const at = media.currentTime;
        media.src = next;
        media.addEventListener('loadedmetadata', () => { media.currentTime = at; }, { once: true });
        media.play().catch(() => {});
        if (failovers.length) armWatchdog();
      };
      const armWatchdog = () => {
        clearTimeout(failoverTimer);
        failoverTimer = setTimeout(() => {
          if (media.readyState >= 2) return;
          failoverNow();
        }, 6000);
      };
      const stopWatchdog = () => clearTimeout(failoverTimer);
      if (failovers.length) {
        armWatchdog();
        media.addEventListener('error', failoverNow, { once: true });
        // 'stalled' = network suspended mid-buffer. Browsers re-request
        // on their own; swap hosts only if still starved 8s later.
        let stallTimer = null;
        media.addEventListener('stalled', () => {
          clearTimeout(stallTimer);
          stallTimer = setTimeout(() => {
            if (media.readyState < 3) failoverNow();
          }, 8000);
        });
        media.addEventListener('playing', () => clearTimeout(stallTimer));
      }
      media.addEventListener('loadeddata', stopWatchdog, { once: true });
      // Post-failover nudge: swapping src mid-load can leave the element
      // paused even though autoplay was requested — re-request on canplay.
      media.addEventListener('canplay', () => {
        if (media.paused) {
          media.play().catch(() => {});
          setTimeout(() => { if (media.paused) media.play().catch(() => {}); }, 600);
        }
      });
      // An explicit play() is a robust fallback if autoplay is ignored.
      media.play().catch(() => {});
      // Loading progress bar: grows with buffered / duration while the
      // first frames stream in, then dissolves. Pairs with the poster
      // staying visible so the visitor sees *why* they are waiting.
      media.addEventListener('progress', () => {
        if (!media.duration || !facade.dataset.loaded) return;
        const end = media.buffered.length ? media.buffered.end(media.buffered.length - 1) : 0;
        const pct = Math.min(100, (end / media.duration) * 100);
        facade.style.setProperty('--load-progress', `${pct.toFixed(1)}%`);
      });
      media.addEventListener('playing', () => facade.classList.add('is-buffered'), { once: true });
      media.addEventListener('loadeddata', () => {
        media.classList.add('is-ready');
        facade.classList.add('is-buffered');
      }, { once: true });
    }
    // Keep the overlays (label pill and poster) — re-appended after the media
    // so they float above it. The poster <img> stays too: the
    // video element shows nothing until its first frame arrives, and a
    // stalled CDN stream would otherwise stare back as a white rectangle.
    const overlays = [...facade.querySelectorAll('.facade__tag, .facade__fs, img')];
    facade.replaceChildren(media, ...overlays);
    const poster = facade.querySelector('img');
    if (poster) {
      const dropPoster = () => poster.remove();
      if (media._warmReady || media.readyState >= 2) {
        // Warm-cached videos already have their first frame, so the still
        // poster can be removed immediately.
        media.classList.add('is-ready');
        facade.classList.add('is-buffered');
        dropPoster();
      } else {
        media.addEventListener('loadeddata', dropPoster, { once: true });
        media.addEventListener('error', dropPoster, { once: true });
      }
    }
    // The hero video shares the same custom player as every other clip,
    // except it carries sound and does not loop.
    buildPlayer(facade, media, { loop: !isMainVideo });
    facade.dataset.loaded = '1';
  });
}

/* ── 1b. Loop player: tap + horizontal swipe ──────────────────────── */

/* Feed-style video: no control bar at all. Clips loop; tap toggles
 * playback (with a brief center-icon flash); swiping horizontally on the
 * video scrubs — a small time bubble appears while dragging. Fullscreen
 * lives in the bottom-right corner button, same as the demo facade. */
function buildPlayer(facade, video, opts = {}) {
  video.loop = opts.loop !== false;   // the hero video plays through once
  facade.classList.add('is-paused');
  facade.insertAdjacentHTML('beforeend', `
    <button class="player__center" type="button" aria-label="Play or pause">
      <svg class="i-play" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>
      <svg class="i-pause" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>
    </button>
    <div class="player__flash" aria-hidden="true">
      <svg class="i-play" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
      <svg class="i-pause" viewBox="0 0 24 24" fill="currentColor"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>
    </div>
    <div class="player__scrub" aria-hidden="true"><span data-cur>0:00</span>&hairsp;/&hairsp;<span data-dur>0:00</span></div>
    <div class="player__bar" role="slider" aria-label="Seek" aria-valuemin="0" tabindex="0">
      <div class="bar__track"><div class="bar__buf"></div><div class="bar__fill"></div></div>
      <div class="bar__thumb"></div>
    </div>
    <button class="facade__fs" type="button" aria-label="Fullscreen" title="Fullscreen">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/></svg>
    </button>`);

  const center = facade.querySelector('.player__center');
  const flash = facade.querySelector('.player__flash');
  const scrub = facade.querySelector('.player__scrub');
  const bar = facade.querySelector('.player__bar');
  const barFill = bar.querySelector('.bar__fill');
  const barBuf = bar.querySelector('.bar__buf');
  const btnFs = facade.querySelector(':scope > .facade__fs');
  const cur = scrub.querySelector('[data-cur]');
  const dur = scrub.querySelector('[data-dur]');

  const fmt = (s) => {
    if (!isFinite(s)) return '0:00';
    s = Math.max(0, Math.round(s));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };
  const toggle = () => { video.paused ? video.play() : video.pause(); };
  const flashNow = () => {
    flash.classList.add('show');
    clearTimeout(flash._t);
    flash._t = setTimeout(() => flash.classList.remove('show'), 550);
  };

  // A warmed video may already have metadata (loadedmetadata fired before
  // this player existed) — seed dur/cur from the live state, not just events.
  if (video.readyState >= 1 && isFinite(video.duration)) dur.textContent = fmt(video.duration);
  video.addEventListener('loadedmetadata', () => { dur.textContent = fmt(video.duration); });
  video.addEventListener('timeupdate', () => { cur.textContent = fmt(video.currentTime); });
  video.addEventListener('play', () => facade.classList.remove('is-paused'));
  video.addEventListener('pause', () => facade.classList.add('is-paused'));

  // Draggable seek bar along the bottom edge. Fill follows playback, the
  // lighter underlay follows what is buffered, and a pointer drag (or a
  // plain click at any x) seeks — the swipe time bubble doubles as the
  // drag tooltip so no extra chrome is needed.
  const setBar = () => {
    if (!isFinite(video.duration) || !video.duration) return;
    const pct = (video.currentTime / video.duration) * 100;
    barFill.style.width = `${pct}%`;
    bar.style.setProperty('--fill', `${pct}%`);   // drives the thumb
    bar.setAttribute('aria-valuemax', Math.round(video.duration));
    bar.setAttribute('aria-valuenow', Math.round(video.currentTime));
  };
  const setBuf = () => {
    if (video.buffered.length && video.duration)
      barBuf.style.width = `${(video.buffered.end(video.buffered.length - 1) / video.duration) * 100}%`;
  };
  video.addEventListener('timeupdate', setBar);
  video.addEventListener('progress', setBuf);
  video.addEventListener('seeked', setBar);
  const timeAt = (e) => {
    const rect = bar.getBoundingClientRect();
    return Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)) * (video.duration || 0);
  };
  const seekTo = (t) => {
    if (!video.duration) return;
    video.currentTime = Math.min(video.duration - 0.05, Math.max(0, t));
    setBar();
    cur.textContent = fmt(video.currentTime);
  };
  bar.addEventListener('pointerdown', (e) => {
    if (!video.duration) return;
    e.stopPropagation();               // never toggles playback
    bar.setPointerCapture(e.pointerId);
    seekTo(timeAt(e));
    scrub.classList.add('show');
    const move = (ev) => seekTo(timeAt(ev));
    const end = () => {
      bar.removeEventListener('pointermove', move);
      scrub.classList.remove('show');
    };
    bar.addEventListener('pointermove', move);
    bar.addEventListener('pointerup', end, { once: true });
    bar.addEventListener('pointercancel', end, { once: true });
  });
  bar.addEventListener('keydown', (e) => {   // keyboard seeking, ±5s
    if (!video.duration) return;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      seekTo(video.currentTime + (e.key === 'ArrowRight' ? 5 : -5));
    }
  });
  setBar();   // warmed videos are already mid-state when the player builds

  // Off-screen autoplay discipline: a playing video that scrolls out of
  // the viewport pauses itself (bandwidth + CPU go to what is visible).
  // No auto-resume on scroll-back — that would fight the visitor's intent.
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) if (!e.isIntersecting && !video.paused) video.pause();
    }, { threshold: 0.05 });  // small threshold: pause once fully ~gone
    io.observe(facade);
    video.addEventListener('emptied', () => io.disconnect(), { once: true });
  }

  center.addEventListener('click', (e) => { e.stopPropagation(); toggle(); flashNow(); });
  btnFs.addEventListener('click', (e) => {
    e.stopPropagation();
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else facade.requestFullscreen().catch(() => {});
  });

  // Inside evaluation rails, a horizontal gesture scrolls between cards.
  // Keep tap-to-pause, but leave per-video swipe scrubbing to standalone clips.
  if (facade.closest('[data-carousel]')) {
    video.addEventListener('click', () => { toggle(); flashNow(); });
    return;
  }

  // Tap vs swipe on the video itself. A horizontal drag scrubs (one full
  // video width = the whole clip); a plain tap toggles playback.
  let sx = 0, st = 0, dragging = false, moved = false;
  video.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    sx = e.clientX;
    st = video.currentTime;
    dragging = true;
    moved = false;
    video.setPointerCapture(e.pointerId);
  });
  video.addEventListener('pointermove', (e) => {
    if (!dragging || !video.duration) return;
    const dx = e.clientX - sx;
    if (!moved && Math.abs(dx) < 8) return;   // below the tap threshold
    moved = true;
    scrub.classList.add('show');
    video.currentTime = Math.min(
      video.duration - 0.05,
      Math.max(0, st + (dx / video.clientWidth) * video.duration));
  });
  const endDrag = () => {
    dragging = false;
    scrub.classList.remove('show');
  };
  video.addEventListener('pointerup', endDrag);
  video.addEventListener('pointercancel', endDrag);
  video.addEventListener('click', () => {
    if (moved) { moved = false; return; }      // that click was the end of a swipe
    toggle();
    flashNow();
  });
}

/* ── 1c. Evaluation video rails ─────────────────────────────────── */

for (const carousel of document.querySelectorAll('[data-carousel]')) {
  const track = carousel.querySelector('[data-carousel-track]');
  const prev = carousel.querySelector('[data-carousel-prev]');
  const next = carousel.querySelector('[data-carousel-next]');
  const nav = carousel.querySelector('.carousel-nav');
  if (!track || !prev || !next || !nav) continue;

  const maxScroll = () => Math.max(0, track.scrollWidth - track.clientWidth);
  const update = () => {
    const max = maxScroll();
    const isStatic = max < 2;
    nav.classList.toggle('is-static', isStatic);
    prev.disabled = isStatic || track.scrollLeft <= 2;
    next.disabled = isStatic || track.scrollLeft >= max - 2;
  };
  const step = () => {
    const card = track.querySelector('.clip-card');
    const gap = parseFloat(getComputedStyle(track).columnGap) || 0;
    return card ? card.getBoundingClientRect().width + gap : track.clientWidth;
  };
  const scroll = (direction) => track.scrollBy({
    left: direction * step(),
    behavior: matchMedia('(prefers-reduced-motion: reduce)').matches
      ? 'auto'
      : 'smooth',
  });

  prev.addEventListener('click', () => scroll(-1));
  next.addEventListener('click', () => scroll(1));
  track.addEventListener('scroll', update, { passive: true });
  track.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    scroll(event.key === 'ArrowLeft' ? -1 : 1);
  });

  if ('ResizeObserver' in window) new ResizeObserver(update).observe(track);
  else window.addEventListener('resize', update);
  requestAnimationFrame(update);
}

/* ── 2. BibTeX copy ───────────────────────────────────────────────── */

for (const btn of document.querySelectorAll('[data-copy]')) {
  btn.addEventListener('click', async () => {
    const text = document.querySelector(btn.dataset.copy)?.innerText || '';
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Non-secure contexts (plain http): classic fallback.
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
  });
}
