import type { LlmClient } from "@server/llm";
import { describe, expect, it } from "vitest";
import { deterministicDraft, draftFromResumeText } from "./extract";

const RESUME = [
  "Ada Lovelace",
  "London, UK | ada.lovelace@analyticalengines.example | (555) 010-1234",
  "github.com/adalovelace",
  "",
  "SUMMARY",
  "Mathematician working on mechanical computation and its notation.",
  "",
  "EXPERIENCE",
  "Analytical Engines — Lead Analyst — London, UK — 1843 to 1852",
  "- Published the first algorithm intended for a general-purpose machine.",
  "- Documented looping and subroutine notation used by later designers.",
  "",
  "SKILLS",
  "Analysis, Mathematics, Notation",
].join("\n");

/** Everything the resume above actually states, as a well-behaved model would. */
const FAITHFUL = {
  name: "Ada Lovelace",
  headline: "Lead Analyst",
  email: "ada.lovelace@analyticalengines.example",
  phone: "(555) 010-1234",
  location: "London, UK",
  summary: "Mathematician working on mechanical computation and its notation.",
  links: [{ label: "GitHub", url: "https://github.com/adalovelace" }],
  skills: [
    { name: "Skills", keywords: ["Analysis", "Mathematics", "Notation"] },
  ],
  roles: [
    {
      company: "Analytical Engines",
      title: "Lead Analyst",
      location: "London, UK",
      startDate: "1843",
      endDate: "1852",
      bullets: [
        "Published the first algorithm intended for a general-purpose machine.",
        "Documented looping and subroutine notation used by later designers.",
      ],
    },
  ],
  education: [],
};

function llmReturning(payload: unknown): LlmClient {
  return {
    model: "stub-model",
    completeJson: async <T>() => payload as T,
  };
}

const brokenLlm: LlmClient = {
  model: "stub-model",
  completeJson: async () => {
    throw new Error("LLM_API_KEY is not configured");
  },
};

describe("draftFromResumeText", () => {
  it("keeps every field the resume actually states", async () => {
    const { draft, warnings } = await draftFromResumeText(
      RESUME,
      llmReturning(FAITHFUL),
    );

    expect(warnings).toEqual([]);
    expect(draft.name).toBe("Ada Lovelace");
    expect(draft.email).toBe("ada.lovelace@analyticalengines.example");
    expect(draft.phone).toBe("(555) 010-1234");
    expect(draft.roles[0]?.bullets).toHaveLength(2);
    expect(draft.skills[0]?.keywords).toEqual([
      "Analysis",
      "Mathematics",
      "Notation",
    ]);
  });

  it("drops an email the resume does not contain, and says so", async () => {
    // The characteristic hallucination: an address assembled from the name.
    // It would otherwise be saved as profile truth and then licence the same
    // invention in every generated resume, because the fabrication gate
    // measures generated copy against this draft.
    const { draft, warnings } = await draftFromResumeText(
      RESUME,
      llmReturning({ ...FAITHFUL, email: "ada.lovelace@gmail.com" }),
    );

    expect(draft.email).toBe("");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("ada.lovelace@gmail.com");
    // Everything the model got right survives the check.
    expect(draft.name).toBe("Ada Lovelace");
    expect(draft.roles[0]?.company).toBe("Analytical Engines");
  });

  it("drops an invented phone number and an invented link", async () => {
    const { draft, warnings } = await draftFromResumeText(
      RESUME,
      llmReturning({
        ...FAITHFUL,
        phone: "+1 (555) 867-5309",
        links: [
          { label: "GitHub", url: "https://github.com/adalovelace" },
          { label: "LinkedIn", url: "https://linkedin.com/in/ada-lovelace" },
        ],
      }),
    );

    expect(draft.phone).toBeNull();
    expect(draft.links).toEqual([
      { label: "GitHub", url: "https://github.com/adalovelace" },
    ]);
    expect(warnings.join(" ")).toContain("867-5309");
    expect(warnings.join(" ")).toContain("linkedin.com/in/ada-lovelace");
  });

  it("keeps a phone number the resume punctuates differently", async () => {
    // Same digits in the same order, reformatted. Dropping this would train
    // the user to ignore the warnings that matter.
    const { draft, warnings } = await draftFromResumeText(
      RESUME,
      llmReturning({ ...FAITHFUL, phone: "555-010-1234" }),
    );

    expect(draft.phone).toBe("555-010-1234");
    expect(warnings).toEqual([]);
  });

  it("recovers the header name when the model's is nowhere in the resume", async () => {
    const { draft, warnings } = await draftFromResumeText(
      RESUME,
      llmReturning({ ...FAITHFUL, name: "Charles Babbage" }),
    );

    // The resume states its own name on the first line. Blanking the field
    // would throw away an answer already in hand.
    expect(draft.name).toBe("Ada Lovelace");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("Charles Babbage");
    expect(warnings[0]).toContain("Ada Lovelace");
    expect(warnings[0]).toMatch(/check that it is right/i);
  });

  it("matches a link the resume prints without a scheme", async () => {
    const { draft, warnings } = await draftFromResumeText(
      RESUME,
      llmReturning({
        ...FAITHFUL,
        links: [
          { label: "GitHub", url: "https://www.github.com/adalovelace/" },
        ],
      }),
    );

    expect(draft.links).toHaveLength(1);
    expect(warnings).toEqual([]);
  });

  it("falls back to the regex pass and warns when the model is unavailable", async () => {
    const { draft, warnings } = await draftFromResumeText(RESUME, brokenLlm);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("unavailable");
    // The request still succeeds with what a resume states plainly.
    expect(draft.name).toBe("Ada Lovelace");
    expect(draft.email).toBe("ada.lovelace@analyticalengines.example");
    expect(draft.phone).toBe("(555) 010-1234");
    expect(draft.links).toEqual([
      { label: "GitHub", url: "https://github.com/adalovelace" },
    ]);
    // And claims nothing it cannot read without judgement.
    expect(draft.roles).toEqual([]);
    expect(draft.summary).toBe("");
  });

  it("falls back when the model answers with something unusable", async () => {
    const { draft, warnings } = await draftFromResumeText(
      RESUME,
      llmReturning("I could not read that resume, sorry!"),
    );

    expect(warnings).toHaveLength(1);
    expect(draft.name).toBe("Ada Lovelace");
  });

  it("returns an empty draft with a warning when there is no text", async () => {
    const { draft, warnings } = await draftFromResumeText(
      "   \n  ",
      llmReturning(FAITHFUL),
    );

    expect(draft.name).toBe("");
    expect(draft.roles).toEqual([]);
    expect(warnings).toHaveLength(1);
  });

  it("tolerates a model that omits fields entirely", async () => {
    const { draft } = await draftFromResumeText(
      RESUME,
      llmReturning({ name: "Ada Lovelace", headline: "Lead Analyst" }),
    );

    expect(draft.name).toBe("Ada Lovelace");
    expect(draft.email).toBe("");
    expect(draft.phone).toBeNull();
    expect(draft.roles).toEqual([]);
  });

  it("treats an N/A placeholder as absent rather than a value", async () => {
    const { draft } = await draftFromResumeText(
      RESUME,
      llmReturning({ ...FAITHFUL, phone: "N/A", location: "none" }),
    );

    expect(draft.phone).toBeNull();
    expect(draft.location).toBeNull();
  });

  it("substitutes the header name for a university offered as the name", async () => {
    // The defect this guards: a model answering with the university from the
    // education section passes "does it appear in the document?", because it
    // does. An organisation's name would otherwise be rendered onto the
    // resume and mailed to a recruiter.
    const { draft, warnings } = await draftFromResumeText(
      `${RESUME}\n\nEDUCATION\nStevens Institute of Technology — M.S. 2025`,
      llmReturning({ ...FAITHFUL, name: "Stevens Institute of Technology" }),
    );

    expect(draft.name).toBe("Ada Lovelace");
    expect(warnings.join(" ")).toContain("Stevens Institute of Technology");
    expect(warnings.join(" ")).toMatch(/organisation|section heading/);
    // Nothing else is thrown away over it.
    expect(draft.email).toBe("ada.lovelace@analyticalengines.example");
    expect(draft.roles).toHaveLength(1);
  });

  it("blanks the name when the document has no person-name to fall back on", async () => {
    const organisationsOnly = [
      "ANALYTICAL ENGINES LTD",
      "EXPERIENCE",
      "Lead Analyst, Analytical Engines Ltd, London",
      "EDUCATION",
      "Stevens Institute of Technology",
    ].join("\n");

    const { draft, warnings } = await draftFromResumeText(
      organisationsOnly,
      llmReturning({
        ...FAITHFUL,
        name: "Stevens Institute of Technology",
        email: "",
        phone: null,
        links: [],
      }),
    );

    expect(draft.name).toBe("");
    expect(warnings.join(" ")).toMatch(/left blank/);
  });

  it("substitutes the header name for a section heading offered as the name", async () => {
    const { draft, warnings } = await draftFromResumeText(
      RESUME,
      llmReturning({ ...FAITHFUL, name: "Professional Experience" }),
    );

    expect(draft.name).toBe("Ada Lovelace");
    expect(warnings).toHaveLength(1);
  });

  it("recovers the header name when the model returns none", async () => {
    const { draft, warnings } = await draftFromResumeText(
      RESUME,
      llmReturning({ ...FAITHFUL, name: "" }),
    );

    expect(draft.name).toBe("Ada Lovelace");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("returned no name");
  });

  it("keeps a link the PDF extractor wrapped across two lines", async () => {
    // pdfjs breaks a long URL at the right margin. Calling a link that is
    // demonstrably in the file "invented" is a false alarm, and false alarms
    // are how a user learns to click past the warning that was real.
    const wrapped = [
      "Ada Lovelace",
      "ada.lovelace@analyticalengines.example",
      "Portfolio: analyticalengines.example/writings/notes-on-the-",
      "analytical-engine",
    ].join("\n");

    const { draft, warnings } = await draftFromResumeText(
      wrapped,
      llmReturning({
        ...FAITHFUL,
        // The wrapped source carries no phone; leaving FAITHFUL's in would
        // make this test pass or fail on an unrelated drop.
        phone: null,
        links: [
          {
            label: "Portfolio",
            url: "https://analyticalengines.example/writings/notes-on-the-analytical-engine",
          },
        ],
      }),
    );

    expect(warnings).toEqual([]);
    expect(draft.links).toHaveLength(1);
  });

  it("keeps an email the PDF extractor wrapped across two lines", async () => {
    const { draft, warnings } = await draftFromResumeText(
      "Ada Lovelace\nada.lovelace@analyticalengines.\nexample\n",
      llmReturning({
        ...FAITHFUL,
        links: [],
        phone: null,
      }),
    );

    expect(draft.email).toBe("ada.lovelace@analyticalengines.example");
    expect(warnings).toEqual([]);
  });

  it("warns when no name could be read at all", async () => {
    const { draft, warnings } = await draftFromResumeText(
      "EXPERIENCE\nSenior Analyst at Analytical Engines Ltd\nSKILLS\nNotation",
      llmReturning({ ...FAITHFUL, name: "" }),
    );

    expect(draft.name).toBe("");
    expect(warnings.join(" ")).toContain("No name could be read");
  });
});

describe("deterministicDraft", () => {
  it("skips a contact line when picking the name", () => {
    const draft = deterministicDraft(
      ["ada@example.com", "+1 555 010 1234", "Ada Lovelace", "Engineer"].join(
        "\n",
      ),
    );

    expect(draft.name).toBe("Ada Lovelace");
  });

  it("picks the header name over the university in the education section", () => {
    // The real shape of a rendered resume: name in the header, contact block
    // beneath it, an education section further down. With no model available
    // this path is the primary one, and it must not return the institution.
    const draft = deterministicDraft(
      [
        "Saketh Reddy Kanchi",
        "Plainsboro, NJ | sakethkanchi3@gmail.com",
        "SUMMARY",
        "Full Stack AI Engineer",
        "EXPERIENCE",
        "Full Stack AI Engineer, Fund Flow OS, Jersey City, NJ Dec 2025 - Present",
        "EDUCATION",
        "Stevens Institute of Technology",
        "M.S. Computer Science",
      ].join("\n"),
    );

    expect(draft.name).toBe("Saketh Reddy Kanchi");
    expect(draft.email).toBe("sakethkanchi3@gmail.com");
  });

  it("returns no name rather than an organisation when the header has none", () => {
    const draft = deterministicDraft(
      [
        "sakethkanchi3@gmail.com | Plainsboro, NJ",
        "EDUCATION",
        "Stevens Institute of Technology",
        "Montalvo Technologies",
        "Gandhi Institute of Technology and Management",
      ].join("\n"),
    );

    // Every remaining line is an organisation. An empty field the user fills
    // in beats a wrong name they never notice.
    expect(draft.name).toBe("");
  });

  it("uses the email local part only to break a tie, never to invent a name", () => {
    const draft = deterministicDraft(
      [
        "Curriculum Vitae",
        "Saketh Reddy Kanchi",
        "sakethkanchi3@gmail.com",
      ].join("\n"),
    );

    // "Curriculum Vitae" is a plausible-looking name line and comes first;
    // the local part corroborates the real one.
    expect(draft.name).toBe("Saketh Reddy Kanchi");
  });

  it("keeps a name the email cannot corroborate", () => {
    const draft = deterministicDraft(
      ["Ada Lovelace", "countess@analyticalengines.example"].join("\n"),
    );

    expect(draft.name).toBe("Ada Lovelace");
  });

  it("finds nothing rather than guessing at an empty document", () => {
    const draft = deterministicDraft("EXPERIENCE\n\nSKILLS\n");

    expect(draft.name).toBe("");
    expect(draft.email).toBe("");
    expect(draft.phone).toBeNull();
    expect(draft.links).toEqual([]);
  });
});
