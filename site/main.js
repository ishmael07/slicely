/* Slicely landing page — interactions: scroll reveal, waitlist modal, form submit. */
(() => {
  'use strict';

  // ---- CONFIG --------------------------------------------------------------
  // Paste your Google Apps Script web-app URL here (see site/README.md).
  // While it's the placeholder below, the form runs in DEMO mode: it shows the
  // success state and logs the payload to the console instead of sending it.
  const WAITLIST_ENDPOINT = 'https://script.google.com/macros/s/AKfycbxFQi9fOMlqXYmGfeCWCsHkgzRumpZ8uoZC12nVohWFhNMx3CzLjrAbABebQ8qWXJiVxQ/exec';
  const isConfigured = (url) => /^https:\/\/script\.google\.com\//.test(url);

  // ---- scroll reveal -------------------------------------------------------
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const reveals = document.querySelectorAll('.reveal');

  if (reduceMotion || !('IntersectionObserver' in window)) {
    reveals.forEach((el) => el.classList.add('in'));
  } else {
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
    // Hero content is above the fold — reveal immediately on load.
    requestAnimationFrame(() => {
      document.querySelectorAll('.hero .reveal').forEach((el) => el.classList.add('in'));
    });
  }

  // ---- waitlist modal ------------------------------------------------------
  const modal = document.getElementById('waitlist');
  const form = document.getElementById('waitlist-form');
  const formState = modal.querySelector('[data-state="form"]');
  const successState = modal.querySelector('[data-state="success"]');
  const errEl = modal.querySelector('.form-err');
  let lastFocused = null;

  const openModal = () => {
    lastFocused = document.activeElement;
    resetModal();
    modal.hidden = false;
    document.body.style.overflow = 'hidden';
    const firstInput = form.querySelector('input');
    if (firstInput) firstInput.focus();
    document.addEventListener('keydown', onKeydown);
  };

  const closeModal = () => {
    modal.hidden = true;
    document.body.style.overflow = '';
    document.removeEventListener('keydown', onKeydown);
    if (lastFocused && lastFocused.focus) lastFocused.focus();
  };

  const resetModal = () => {
    formState.hidden = false;
    successState.hidden = true;
    errEl.hidden = true;
    form.reset();
    const submit = form.querySelector('button[type="submit"]');
    submit.disabled = false;
    submit.textContent = 'Join the list';
  };

  const showSuccess = () => {
    formState.hidden = true;
    successState.hidden = false;
    successState.querySelector('.btn').focus();
  };

  // Simple focus trap within the modal.
  function onKeydown(e) {
    if (e.key === 'Escape') return closeModal();
    if (e.key !== 'Tab') return;
    const focusable = modal.querySelectorAll(
      'button:not([disabled]), input, textarea, a[href]'
    );
    const visible = Array.from(focusable).filter((el) => el.offsetParent !== null);
    if (!visible.length) return;
    const first = visible[0];
    const last = visible[visible.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  document.querySelectorAll('[data-open-waitlist]').forEach((b) =>
    b.addEventListener('click', openModal)
  );
  document.querySelectorAll('[data-close-waitlist]').forEach((b) =>
    b.addEventListener('click', closeModal)
  );

  // ---- form submit ---------------------------------------------------------
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errEl.hidden = true;

    const data = {
      name: form.name.value.trim(),
      email: form.email.value.trim(),
      usage: form.usage.value.trim(),
      comments: form.comments.value.trim(),
    };

    if (!data.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) {
      errEl.textContent = 'Please enter a valid email address.';
      errEl.hidden = false;
      form.email.focus();
      return;
    }

    const submit = form.querySelector('button[type="submit"]');
    submit.disabled = true;
    submit.textContent = 'Joining…';

    // Demo mode: no endpoint configured yet.
    if (!isConfigured(WAITLIST_ENDPOINT)) {
      console.info('[Slicely waitlist] demo mode — would submit:', data);
      setTimeout(showSuccess, 450);
      return;
    }

    try {
      // Apps Script web apps accept simple POSTs; form-encoded avoids a CORS
      // preflight, and we use no-cors so the opaque response still resolves.
      const body = new URLSearchParams(data).toString();
      await fetch(WAITLIST_ENDPOINT, {
        method: 'POST',
        mode: 'no-cors',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
      showSuccess();
    } catch (err) {
      console.error('[Slicely waitlist] submit failed:', err);
      errEl.textContent = 'Something went wrong — please try again, or email us directly.';
      errEl.hidden = false;
      submit.disabled = false;
      submit.textContent = 'Join the list';
    }
  });
})();
