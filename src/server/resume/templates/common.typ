// The one resume body every template renders, and the typography knobs a
// template is allowed to change.
//
// Templates differ in font, size, spacing and header alignment — never in
// structure. That is not a style preference: the fabrication gate compares the
// extracted PDF text against the profile, and the ATS gate halts a run on
// tables, sidebars or a broken reading order, so a template that reordered
// sections or boxed content would fail the pipeline rather than look better.
// Keeping the body here means a new template cannot introduce that failure.
//
// Every profile string is inserted as a *value* (`#field`) rather than spliced
// into markup, so a field containing `#`, `$`, `[` or `\` renders literally and
// cannot inject Typst code. Smart quotes and ligatures are off for the same
// reason: the extracted text has to match the profile byte for byte.

#let filled(parts) = parts.filter(part => part != none and part != "")

#let join-filled(parts, sep) = {
  let kept = filled(parts)
  if kept.len() == 0 { "" } else { kept.join(sep) }
}

#let date-range(start, end) = join-filled(
  (start, if end == none { "Present" } else { end }),
  " - ",
)

/// Drop the scheme so a tracked link still fits on the contact line, while the
/// clickable destination stays the full URL.
#let display-url(raw) = {
  let text-form = raw
  if text-form.starts-with("https://") {
    text-form = text-form.slice(8)
  } else if text-form.starts-with("http://") {
    text-form = text-form.slice(7)
  }
  if text-form.ends-with("/") { text-form = text-form.slice(0, -1) }
  text-form
}

/// The whole document. `/resume.json` is the profile the renderer wrote next to
/// this file in the compile directory.
#let resume(
  font: "Liberation Sans",
  size: 10pt,
  name-size: 18pt,
  name-tracking: 0.3pt,
  contact-size: 9.4pt,
  section-size: 10.8pt,
  section-tracking: 0.4pt,
  section-rule: true,
  header-align: center,
  margin-x: 0.6in,
  margin-y: 0.5in,
  leading: 0.62em,
  entry-gap: 0.8em,
) = {
  let cv = json("/resume.json")

  set document(title: cv.name + " - Resume", author: cv.name)
  set page(paper: "us-letter", margin: (x: margin-x, y: margin-y))
  set text(
    font: font,
    size: size,
    lang: "en",
    hyphenate: false,
    features: (liga: 0, clig: 0),
  )
  set par(leading: leading, spacing: leading, justify: false)
  set smartquote(enabled: false)

  let section(title) = {
    block(
      above: 1.1em,
      below: if section-rule { 0.2em } else { 0.45em },
      text(size: section-size, weight: "bold", tracking: section-tracking, upper(title)),
    )
    if section-rule {
      block(
        above: 0.3em,
        below: 0.6em,
        line(length: 100%, stroke: 0.5pt + luma(140)),
      )
    }
  }

  // One header line: bold lead, plain continuation, right-aligned meta. `1fr`
  // keeps this a single paragraph rather than a two-column grid.
  let entry-head(lead, rest, meta) = block(
    above: entry-gap,
    below: 0.35em,
    width: 100%,
  )[
    #text(weight: "bold", lead)#rest#h(1fr)#text(fill: luma(60), meta)
  ]

  let bullets(items) = {
    if items.len() == 0 { return }
    set par(leading: leading * 0.94, spacing: 0.38em)
    list(
      marker: [-],
      indent: 0pt,
      body-indent: 0.55em,
      spacing: 0.38em,
      tight: true,
      ..items.map(item => [#item]),
    )
  }

  // ── Header ─────────────────────────────────────────────────────────

  align(header-align)[
    #text(size: name-size, weight: "bold", tracking: name-tracking, cv.name)

    #v(-0.3em)
    #text(size: contact-size, join-filled((cv.location, cv.phone, cv.email), " | "))

    #v(-0.35em)
    #text(
      size: contact-size,
      cv.links
        .map(entry => link(entry.url, entry.label + ": " + display-url(entry.url)))
        .join(" | "),
    )
  ]

  // ── Summary ────────────────────────────────────────────────────────

  section("Summary")
  text(weight: "bold", cv.headline)
  parbreak()
  cv.summary

  // ── Experience ─────────────────────────────────────────────────────

  section("Experience")
  for role in cv.experience {
    let affiliation = join-filled((role.company, role.location), ", ")
    entry-head(
      role.title,
      if affiliation == "" { "" } else { ", " + affiliation },
      date-range(role.start, role.end),
    )
    bullets(role.bullets)
  }

  // ── Projects ───────────────────────────────────────────────────────

  if cv.projects.len() > 0 {
    section("Projects")
    for project in cv.projects {
      entry-head(
        project.name,
        if project.description == "" { "" } else { " - " + project.description },
        if project.url == none { "" } else { display-url(project.url) },
      )
      bullets(project.bullets)
    }
  }

  // ── Skills ─────────────────────────────────────────────────────────

  section("Skills")
  for group in cv.skills {
    block(above: 0.35em, below: 0.35em)[
      #text(weight: "bold", group.name + ": ")#group.keywords.join(", ")
    ]
  }

  // ── Education ──────────────────────────────────────────────────────

  section("Education")
  for school in cv.education {
    entry-head(school.school, "", date-range(school.start, school.end))
    block(above: 0.2em, below: 0.2em, school.degree)
  }
}
