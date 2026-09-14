// stub until accounts/core merges
//
// Task A2 owns this file, including the ~1,500-domain committed list that
// `isDisposableDomain` really consults (generated once by
// scripts/gen-disposable-domains.mjs). This stub carries the frozen signatures
// and a handful of domains so lane B's tests can exercise the `email_blocked`
// path; the merge replaces it.
export interface NormalizedEmail {
  email: string;
  normalized: string;
  domain: string;
}

export class EmailRejected extends Error {
  constructor(readonly code: "email_invalid" | "email_blocked") {
    super(code === "email_invalid" ? "That doesn't look like an email address." : "That email domain isn't accepted.");
    this.name = "EmailRejected";
  }
}

const GMAIL_DOMAINS = new Set(["gmail.com", "googlemail.com"]);

/** stub: A2's real list is the committed dataset. These are the two the spec
 *  names in its own tests, plus a couple of obvious neighbours. */
export const DISPOSABLE_DOMAINS: ReadonlySet<string> = new Set([
  "mailinator.com",
  "10minutemail.com",
  "guerrillamail.com",
  "yopmail.com",
  "tempmail.com",
  "trashmail.com",
]);

export function normalizeEmail(raw: unknown): NormalizedEmail {
  if (typeof raw !== "string") throw new EmailRejected("email_invalid");
  const email = raw.trim();
  if (email.length === 0 || email.length > 254) throw new EmailRejected("email_invalid");
  const at = email.indexOf("@");
  if (at <= 0 || at !== email.lastIndexOf("@") || at === email.length - 1) throw new EmailRejected("email_invalid");
  let local = email.slice(0, at);
  const domain = email.slice(at + 1).toLowerCase();
  if (/[\s,;:<>()[\]\\"]/.test(local) || local.length > 64) throw new EmailRejected("email_invalid");
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain)) {
    throw new EmailRejected("email_invalid");
  }
  // A plus-tag is never part of the mailbox anywhere we have seen, and gmail
  // additionally ignores dots — which is the whole reason one grant per person
  // needs a normalised key rather than the address as typed.
  const plus = local.indexOf("+");
  if (plus === 0) throw new EmailRejected("email_invalid");
  if (plus > 0) local = local.slice(0, plus);
  const isGmail = GMAIL_DOMAINS.has(domain);
  const keyLocal = (isGmail ? local.replace(/\./g, "") : local).toLowerCase();
  if (keyLocal.length === 0) throw new EmailRejected("email_invalid");
  const keyDomain = isGmail ? "gmail.com" : domain;
  return { email, normalized: `${keyLocal}@${keyDomain}`, domain };
}

export function isDisposableDomain(domain: string): boolean {
  return DISPOSABLE_DOMAINS.has(domain.toLowerCase());
}
