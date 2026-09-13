/**
 * The outreach recipient a posting states in its own prose.
 *
 * Outreach has to be addressed to somebody, and this app has exactly two
 * honest sources for that address: the posting says it, or a human types it.
 * Guessing `first.last@company.com` from a domain pattern is the one thing
 * deliberately not done here — a fabricated recipient is the same class of
 * failure the resume fabrication gate exists to stop, except the blast radius
 * is a stranger's inbox.
 *
 * Derived at write time next to the other posting-derived columns so search can
 * say, per row, whether outreach is even possible.
 */

/**
 * Deliberately narrower than RFC 5322: no quoted local parts, no address
 * literals. A posting that states a contact states it plainly, and every
 * exotic form this rejects would be rejected again by the Gmail connector's
 * header validation.
 */
const EMAIL =
  /[A-Za-z0-9][A-Za-z0-9._%+-]*@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\.[A-Za-z]{2,24}/g;

/**
 * Local parts that are never a person who reads replies. Sending a tailored
 * application to `noreply@` or an accessibility hotline is worse than sending
 * nothing: it burns the one first impression on an address that discards it.
 */
const UNREACHABLE_LOCAL =
  /^(?:no[-._]?reply|do[-._]?not[-._]?reply|donotrespond|unsubscribe|bounce|mailer[-._]?daemon|postmaster|webmaster|abuse|privacy|security|legal|compliance|dmca|copyright|support|help(?:desk)?|info|sales|marketing|billing|accounts?(?:payable|receivable)?|press|media|investors?|accessibility|ada|eeo|affirmative[-._]?action)(?:[+.].*)?$/i;

/** Domains that only ever appear in boilerplate, sample text, or markup. */
const UNREACHABLE_DOMAIN =
  /(?:^|\.)(?:example\.(?:com|org|net)|example|test|invalid|localhost|domain\.com|yourcompany\.com|email\.com|sentry\.io|w3\.org|schema\.org|googleapis\.com|cloudfront\.net)$/i;

/**
 * A trailing file extension means the match came out of a URL or an image
 * reference, not a mailbox: `logo@2x.png`, `hero@example.cdn.jpg`.
 */
const ASSET_SUFFIX = /\.(?:png|jpe?g|gif|svg|webp|css|js|json|pdf|woff2?)$/i;

/**
 * Local parts that mean "this mailbox exists to receive applications",
 * strongest first. A posting that names both a recruiting alias and an
 * engineer's address is asking for the alias.
 */
const PREFERRED_LOCAL: RegExp[] = [
  /^(?:careers?|jobs?|recruit(?:ing|ment)?|hiring|talent|apply|applications?)\b/i,
  /^(?:hr|people|peopleops|human[-._]?resources)\b/i,
];

function rank(local: string): number {
  for (const [index, pattern] of PREFERRED_LOCAL.entries()) {
    if (pattern.test(local)) return index;
  }
  return PREFERRED_LOCAL.length;
}

/**
 * The address a posting offers for applications, or null.
 *
 * Null is the common case and an entirely acceptable answer: most boards route
 * through an ATS form and publish no mailbox at all. The caller's job is then
 * to say so rather than to invent one.
 */
export function extractContactEmail(
  descriptionText: string | null | undefined,
): string | null {
  if (!descriptionText) return null;

  let best: string | null = null;
  let bestRank = Number.POSITIVE_INFINITY;

  for (const match of descriptionText.matchAll(EMAIL)) {
    // Trailing sentence punctuation is outside the match by construction, but
    // a posting that writes "mailto:careers@acme.com." still hands over a
    // clean address; the case is covered by the pattern's final-label rule.
    const address = match[0].toLowerCase();
    const at = address.lastIndexOf("@");
    const local = address.slice(0, at);
    const domain = address.slice(at + 1);

    if (address.length > 320) continue;
    if (ASSET_SUFFIX.test(domain)) continue;
    if (UNREACHABLE_LOCAL.test(local)) continue;
    if (UNREACHABLE_DOMAIN.test(domain)) continue;

    const score = rank(local);
    // Strictly better only: among equally-ranked addresses the first one wins,
    // because postings lead with the contact and trail off into unrelated
    // addresses (a hiring manager's, then a benefits provider's).
    if (score < bestRank) {
      best = address;
      bestRank = score;
    }
  }

  return best;
}
