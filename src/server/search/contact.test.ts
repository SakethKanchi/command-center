import { extractContactEmail } from "@server/search/contact";
import { describe, expect, it } from "vitest";

describe("extractContactEmail", () => {
  it("reads the address a posting offers for applications", () => {
    expect(
      extractContactEmail(
        "Send a CV and a short note to careers@acme.io and we will reply within a week.",
      ),
    ).toBe("careers@acme.io");
  });

  it("returns null for a posting that routes through a form", () => {
    expect(
      extractContactEmail("Apply through the portal. No agencies, please."),
    ).toBeNull();
  });

  it("prefers a recruiting alias over an unrelated address in the same posting", () => {
    // Postings mix in a benefits provider or a press contact. Writing a
    // tailored application to one of those wastes the only first impression
    // available, so ranking is by what the mailbox is for, not by position.
    expect(
      extractContactEmail(
        "Questions about our benefits: benefits-team@acme.io. To apply, write to recruiting@acme.io.",
      ),
    ).toBe("recruiting@acme.io");
  });

  it("skips mailboxes that discard replies", () => {
    expect(
      extractContactEmail(
        "This notice was sent from no-reply@acme.io; accessibility requests go to ada@acme.io.",
      ),
    ).toBeNull();
  });

  it("skips boilerplate and template domains", () => {
    expect(
      extractContactEmail("Contact hiring@example.com to learn more."),
    ).toBeNull();
  });

  it("does not read an asset reference as a mailbox", () => {
    expect(
      extractContactEmail('<img src="https://cdn.acme.io/logo@2x.png">'),
    ).toBeNull();
  });

  it("normalises case, because the same mailbox must dedupe", () => {
    expect(extractContactEmail("Write to Jobs@Acme.IO today")).toBe(
      "jobs@acme.io",
    );
  });

  it("keeps the first of two equally reachable addresses", () => {
    // A posting leads with its contact; later addresses belong to the boilerplate.
    expect(
      extractContactEmail("Reach dana@acme.io or, failing that, sam@acme.io."),
    ).toBe("dana@acme.io");
  });
});
