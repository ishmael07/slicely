// ─────────────────────────────────────────────────────────────────────────────
// One mailbox is one person.
//
// The free grant is keyed on a NORMALISED email address, so the normalisation
// is load-bearing: `Jane.Doe+slicely@googlemail.com` and `janedoe@gmail.com`
// are the same inbox at Google, and if Slicely treated them as two people a
// single Gmail account would be an unlimited credit printer. Gmail ignores
// dots in the local part and everything from the first `+`; `googlemail.com` is
// an alias of `gmail.com`. Outside Gmail a dot IS significant (plenty of
// providers deliver `jane.doe@` and `janedoe@` to different people), but the
// `+tag` convention is honoured almost everywhere and stripping it is harmless
// where it is not.
//
// The DISPLAY address is kept exactly as the provider gave it. A person should
// see the address they signed in with, not our internal key — and the two
// travel together so no caller has to remember which is which.
//
// REJECTION IS EXPLICIT, never a silent repair. `normalizeEmail` throws rather
// than returning a plausible-looking guess, because a guess would become an
// account's identity: `+tag@gmail.com` has no local part at all once the tag is
// stripped, and normalising it to `""@gmail.com` would hand whoever asked next
// the same "person".
// ─────────────────────────────────────────────────────────────────────────────
import { DISPOSABLE_DOMAIN_LIST } from "./disposable-domains";

/** An address, twice: as it is shown and as it is keyed. `domain` is the
 *  normalised (lowercased, de-aliased) domain, the same one `normalized` ends
 *  with, so a caller checking `isDisposableDomain` and a caller looking up the
 *  grant are asking about the same thing. */
export interface NormalizedEmail {
  email: string;
  normalized: string;
  domain: string;
}

/**
 * Why an address was turned away, in the wire codes the client already knows.
 *
 * `email_invalid` is "that is not an address" and is the waitlist route's 400.
 * `email_blocked` is "that address is not welcome" — a throwaway domain, or an
 * account the owner has blocked by hand — and is a 403 on the sign-in path.
 * Two codes because they need two different sentences: one is a typo, the other
 * is a policy.
 */
export class EmailRejected extends Error {
  constructor(readonly code: "email_invalid" | "email_blocked") {
    super(code === "email_invalid" ? "That doesn't look like an email address." : "That email address can't be used.");
    this.name = "EmailRejected";
  }
}

/** Domains that are really the same mailbox under another name. Applied BEFORE
 *  the per-provider local-part rules, so `jane.doe@googlemail.com` gets Gmail's
 *  dot rule rather than the general one. */
const DOMAIN_ALIASES: Record<string, string> = {
  "googlemail.com": "gmail.com",
};

/** Providers that ignore dots in the local part. Gmail is the only one worth
 *  encoding: it is the only mainstream provider that documents the behaviour,
 *  and guessing wrong merges two strangers into one account. */
const DOT_INSENSITIVE = new Set(["gmail.com"]);

/** The longest an email address may be (RFC 5321's path limit). Also the reason
 *  a 250-character local part is refused rather than hashed into a key. */
const MAX_LENGTH = 254;

/** A domain, after lowercasing: letters, digits, dots and hyphens, with at
 *  least one dot. Deliberately narrow — an internationalised domain reaches us
 *  punycoded from both providers, and `jane@localhost` is not an address a
 *  person can be verified at. */
const DOMAIN_RE = /^[a-z0-9.-]+$/;

/**
 * An address as display text and as a grant key, or `EmailRejected`.
 *
 * The order of the checks matters: length and shape first (so nothing long or
 * hostile reaches the string work), then the domain alias, then the
 * provider-specific local-part rules, then the "is there anything left?" check
 * — which is the one that catches `+tag@gmail.com`.
 */
export function normalizeEmail(raw: unknown): NormalizedEmail {
  if (typeof raw !== "string") throw new EmailRejected("email_invalid");
  const email = raw.trim();
  if (email.length === 0 || email.length > MAX_LENGTH) throw new EmailRejected("email_invalid");
  // No whitespace or control characters anywhere: `jane doe@example.com` is a
  // typo, and a newline would let one address forge two ledger lines.
  // eslint-disable-next-line no-control-regex
  if (/[\s\x00-\x1f\x7f]/.test(email)) throw new EmailRejected("email_invalid");

  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1) throw new EmailRejected("email_invalid");
  // Exactly one `@`. `jane@@example.com` has a local part of "jane@", which no
  // provider would have verified, so it is a forgery attempt or a typo.
  if (email.indexOf("@") !== at) throw new EmailRejected("email_invalid");

  let local = email.slice(0, at).toLowerCase();
  const rawDomain = email.slice(at + 1).toLowerCase();
  if (!DOMAIN_RE.test(rawDomain) || !rawDomain.includes(".")) {
    throw new EmailRejected("email_invalid");
  }
  // A dot cannot start, end or double up in a domain name.
  if (rawDomain.startsWith(".") || rawDomain.endsWith(".") || rawDomain.includes("..")) {
    throw new EmailRejected("email_invalid");
  }
  const domain = DOMAIN_ALIASES[rawDomain] ?? rawDomain;

  // Drop the tag first, then the dots — `jane.doe+a.b@gmail.com`'s tag may
  // itself contain dots, and stripping dots first would leave them behind.
  const plus = local.indexOf("+");
  if (plus >= 0) local = local.slice(0, plus);
  if (DOT_INSENSITIVE.has(domain)) local = local.replace(/\./g, "");
  if (local.length === 0) throw new EmailRejected("email_invalid");

  return { email, normalized: `${local}@${domain}`, domain };
}

/** The bundled throwaway-domain list. A Set built once at module load: the
 *  array is ~8,800 entries and every sign-in asks it a question. */
export const DISPOSABLE_DOMAINS: ReadonlySet<string> = new Set(DISPOSABLE_DOMAIN_LIST);

/**
 * True when this domain only ever hands out temporary inboxes.
 *
 * MATCHED AS A SUFFIX, NOT AS A STRING. Wildcard subdomains are how these
 * services work — mailinator delivers `anything.mailinator.com` to the same
 * public inbox — so an exact-match check is bypassed by typing one extra label.
 * Every suffix is asked about, from the whole domain down to the last two labels.
 *
 * TWO IS WHERE IT STOPS, and that is the safety rail rather than an optimisation:
 * a walk that went down to one label would ask whether "com" is disposable, and
 * one bad entry in a generated 8,800-line list would then refuse every address on
 * a whole TLD. Nothing in the list is a public suffix (the generator's
 * ALWAYS_ALLOWED set is about the other direction), but this is the check that
 * makes it not matter.
 *
 * Lowercased and de-dotted first, because neither case nor a trailing root dot
 * may be a way around the list.
 */
export function isDisposableDomain(domain: string): boolean {
  const clean = domain.trim().toLowerCase().replace(/\.+$/, "");
  const labels = clean.split(".");
  for (let i = 0; i + 2 <= labels.length; i += 1) {
    if (DISPOSABLE_DOMAINS.has(labels.slice(i).join("."))) return true;
  }
  return false;
}
