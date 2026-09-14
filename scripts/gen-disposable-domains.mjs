#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// Regenerate src/main/accounts/disposable-domains.ts from the public
// `disposable-email-domains` dataset.
//
//   node scripts/gen-disposable-domains.mjs
//
// WHY A GENERATOR AND A COMMITTED FILE, rather than a runtime dependency: the
// list is data that changes a few times a year, and Slicely ships with no new
// runtime dependencies. A committed TypeScript array has no install step, no
// boot-time fetch to fail on a cold start, and no breakage the day the upstream
// repo is renamed or unpublished. Regenerating it is a deliberate act with a
// reviewable diff.
//
// IF THE FETCH FAILS THIS SCRIPT CHANGES NOTHING and exits non-zero. The
// committed list is the source of truth; a network blip must never silently
// empty it, because an empty list means every throwaway address is accepted.
// ─────────────────────────────────────────────────────────────────────────────
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "..", "src", "main", "accounts", "disposable-domains.ts");

const SOURCES = [
  "https://raw.githubusercontent.com/disposable-email-domains/disposable-email-domains/main/disposable_email_blocklist.conf",
];

/**
 * Domains that must never be blocked however the upstream list drifts.
 *
 * Every one of these is a mainstream mailbox provider that real people sign in
 * with, and a false positive here does not annoy a user — it locks them out of
 * the product with a message telling them their own email address is fake.
 * Community-maintained blocklists do occasionally take a swing at a privacy
 * mailbox (proton, tuta) because it offers aliases; an alias is not a
 * throwaway, and the one-grant-per-normalised-email rule already bounds what an
 * alias can win.
 */
const ALWAYS_ALLOWED = new Set([
  "gmail.com",
  "googlemail.com",
  "google.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "yahoo.com",
  "ymail.com",
  "aol.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "protonmail.com",
  "protonmail.ch",
  "proton.me",
  "pm.me",
  "tutanota.com",
  "tuta.io",
  "tutamail.com",
  "zoho.com",
  "fastmail.com",
  "fastmail.fm",
  "gmx.com",
  "gmx.de",
  "gmx.net",
  "web.de",
  "mail.com",
  "yandex.com",
  "yandex.ru",
  "qq.com",
  "163.com",
  "126.com",
  "naver.com",
  "hey.com",
]);

/** A plain registrable domain and nothing else: lowercase letters, digits,
 *  hyphens and dots, at least one dot, no wildcard, no scheme, no comment. */
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

async function fetchList(url) {
  const res = await fetch(url, { headers: { accept: "text/plain" } });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  const text = await res.text();
  if (text.length < 10_000) throw new Error(`${url} returned only ${text.length} bytes`);
  return text;
}

async function main() {
  const domains = new Set();
  for (const url of SOURCES) {
    const text = await fetchList(url);
    for (const raw of text.split("\n")) {
      const line = raw.trim().toLowerCase();
      if (!line || line.startsWith("#") || line.startsWith("//")) continue;
      if (!DOMAIN_RE.test(line)) continue;
      if (ALWAYS_ALLOWED.has(line)) continue;
      domains.add(line);
    }
  }
  if (domains.size < 1000) {
    throw new Error(`only ${domains.size} domains parsed — refusing to shrink the list`);
  }
  const sorted = [...domains].sort();
  const body = sorted.map((d) => `  "${d}",`).join("\n");
  const header = `// Throwaway-email domains, generated — DO NOT EDIT BY HAND.
//
// Source:    ${SOURCES.join("\n//            ")}
// Generated: ${new Date().toISOString().slice(0, 10)}
// Regenerate: node scripts/gen-disposable-domains.mjs
//
// Committed as data rather than taken as a dependency: no install step, no
// boot-time fetch, and no breakage the day the upstream repo moves. See the
// generator for the mainstream mailbox providers it refuses to include however
// the upstream list drifts — a false positive here tells a real person their own
// address is fake.
//
// ${sorted.length} domains.

export const DISPOSABLE_DOMAIN_LIST: readonly string[] = [
${body}
];
`;
  writeFileSync(OUT, header, "utf8");
  console.log(`[gen-disposable-domains] wrote ${sorted.length} domains to ${OUT}`);
}

main().catch((err) => {
  console.error(`[gen-disposable-domains] FAILED, nothing written: ${err.message}`);
  process.exit(1);
});
