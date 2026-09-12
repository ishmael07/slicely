/* Slicely landing page — two jobs: fill in the links from config.js, and reveal
   sections as they scroll into view (skipped entirely under reduced motion). */
(() => {
  'use strict';

  // ---- links -----------------------------------------------------------------
  // Every CTA ships a real href in the HTML and ALSO carries data-href="APP_URL"
  // (or DOWNLOAD_URL / REPO_URL). The href is what makes the link work, focusable
  // and keyboard-reachable with no JavaScript at all; config.js is what the owner
  // edits, and this loop applies it over the top.
  //
  // Two copies of a URL can disagree. Silently preferring config.js would leave a
  // stale URL sitting in the markup for the next reader to take as truth, so a
  // divergence is reported rather than quietly papered over.
  const cfg = window.SLICELY_SITE || {};

  document.querySelectorAll('[data-href]').forEach((el) => {
    const key = el.getAttribute('data-href');
    const url = cfg[key];
    const inMarkup = el.getAttribute('href');

    if (typeof url !== 'string' || !url) {
      console.warn(`[Slicely site] config.js has no ${key} — keeping the href in the HTML (${inMarkup}).`);
      return;
    }
    if (inMarkup && inMarkup !== url) {
      console.warn(
        `[Slicely site] ${key} is "${url}" in config.js but "${inMarkup}" in the HTML — ` +
          'using config.js. Update the markup to match.'
      );
    }
    el.setAttribute('href', url);
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
