/* Slicely landing page — two jobs: fill in the links from config.js, and reveal
   sections as they scroll into view (skipped entirely under reduced motion). */
(() => {
  'use strict';

  // ---- links -----------------------------------------------------------------
  // Every CTA carries data-href="APP_URL" (or DOWNLOAD_URL / REPO_URL) instead of a
  // literal URL, so config.js is the single place a URL is written down. A key with
  // no value in config.js leaves the element inert and says so in the console, which
  // is louder than a link that silently goes nowhere.
  const cfg = window.SLICELY_SITE || {};

  document.querySelectorAll('[data-href]').forEach((el) => {
    const key = el.getAttribute('data-href');
    const url = cfg[key];
    if (typeof url === 'string' && url) {
      el.setAttribute('href', url);
    } else {
      el.setAttribute('aria-disabled', 'true');
      console.warn(`[Slicely site] config.js has no ${key} — this link is inert.`);
    }
  });

  // ---- scroll reveal ---------------------------------------------------------
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const reveals = document.querySelectorAll('.reveal');

  if (reduceMotion || !('IntersectionObserver' in window)) {
    reveals.forEach((el) => el.classList.add('in'));
    return;
  }

  const io = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('in');
          io.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.12, rootMargin: '0px 0px -8% 0px' }
  );
  reveals.forEach((el) => io.observe(el));

  // Hero content is above the fold — reveal it immediately rather than waiting for
  // a scroll that may never come.
  requestAnimationFrame(() => {
    document.querySelectorAll('.hero .reveal').forEach((el) => el.classList.add('in'));
  });
})();
