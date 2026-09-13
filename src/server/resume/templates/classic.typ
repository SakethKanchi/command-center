// The traditional CV look: Liberation Serif (metrically Times New Roman), a
// larger name, and letterspaced ruled headings.
//
// Serif at 10.5pt sets shorter than the sans at 10pt, so the extra size buys
// legibility rather than pages. Structure is unchanged, which is the point: the
// document reads as conventional to a human without giving a parser anything
// new to trip on.

#import "/common.typ": resume

#resume(
  font: "Liberation Serif",
  size: 10.5pt,
  name-size: 20pt,
  name-tracking: 0.8pt,
  contact-size: 9.8pt,
  section-size: 11.2pt,
  section-tracking: 1pt,
  margin-x: 0.7in,
  margin-y: 0.55in,
  leading: 0.6em,
)
