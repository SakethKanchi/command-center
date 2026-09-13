// The same document, denser: narrower margins, smaller body text, tighter
// leading, and a left-aligned header that costs no vertical space to centre.
//
// For a history long enough to spill over one page. Nothing is removed to buy
// the space — an ATS reads the same sections in the same order, and the section
// rules are dropped rather than the content, since the uppercase heading alone
// is what a parser keys off.

#import "/common.typ": resume

#resume(
  size: 9.5pt,
  name-size: 16pt,
  contact-size: 9pt,
  section-size: 10pt,
  section-tracking: 0.6pt,
  section-rule: false,
  header-align: left,
  margin-x: 0.5in,
  margin-y: 0.45in,
  leading: 0.55em,
  entry-gap: 0.62em,
)
