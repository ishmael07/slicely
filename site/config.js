/* Slicely landing page — the only place URLs live.
 *
 * Every link in the page carries a data-href="<KEY>" attribute; main.js reads
 * this object on load and fills the real href in. Change a URL here and it
 * changes everywhere, including terms.html / privacy.html footers.
 *
 * Before launch, the owner fills APP_URL in — it is a placeholder until the Fly
 * app exists.
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
