/* Slicely landing page — the only place URLs live.
 *
 * Every link in the page carries a data-href="<KEY>" attribute; main.js reads
 * this object on load and fills the real href in. Change a URL here and it
 * changes everywhere, including terms.html / privacy.html footers.
 *
 * Before launch, the owner fills in:
 *   APP_URL        the deployed web app (placeholder until the Fly app exists)
 *   CONTACT_EMAIL  the address in the legal pages and the footer
 */
window.SLICELY_SITE = {
  APP_URL: "https://app.slicely.example",
  DOWNLOAD_URL: "https://github.com/ishmael07/slicely/releases/latest",
  REPO_URL: "https://github.com/ishmael07/slicely",
  CONTACT_EMAIL: "{{CONTACT_EMAIL}}",
};
