/* Slicely landing page — the URLs the owner edits.
 *
 * Every CTA in index.html carries BOTH a real href in the markup and a
 * data-href="<KEY>"; main.js reads this object on load and applies it over the
 * top. The href is what makes the link work, focusable and keyboard-reachable
 * with no JavaScript at all; this file is what you edit. Keep the two in step —
 * main.js warns in the console when they disagree, naming both values.
 *
 * Before launch, the owner fills APP_URL in — it is a placeholder until the Fly
 * app exists. Change it here AND in the href attributes in index.html.
 *
 * CONTACT_EMAIL has no consumer on this page and is not meant to grow one: the
 * only place the site names an address is terms.html and privacy.html, and those
 * two run no JavaScript on purpose, so they carry the literal {{CONTACT_EMAIL}}
 * placeholder that the lawyer review replaces. It is kept here because the
 * launch spec fixes this object's shape, and because the owner filling in "the
 * config file" should find every value they own in one place rather than
 * discovering a second one later.
 */
window.SLICELY_SITE = {
  APP_URL: "https://app.slicely.example",
  DOWNLOAD_URL: "https://github.com/ishmael07/slicely/releases/latest",
  REPO_URL: "https://github.com/ishmael07/slicely",
  CONTACT_EMAIL: "{{CONTACT_EMAIL}}",
};
