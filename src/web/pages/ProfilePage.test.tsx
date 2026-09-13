/** @vitest-environment jsdom */
import type { ProfileCompleteness, ProfileDraft } from "@domain";
import { RESUME_TEMPLATES } from "@domain";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { ProfilePage } from "@web/pages/ProfilePage";
import {
  Link,
  MemoryRouter,
  Route,
  Routes,
  useLocation,
} from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The profile builder, the resume import and the readiness checklist.
 *
 * Two transports are stubbed because the page uses two on purpose: `fetch` for
 * the JSON endpoints, and `XMLHttpRequest` for the multipart upload, which is
 * the only way a browser will report how much of a request body has gone out.
 *
 * The assertion that matters most in this file is negative: after an import,
 * `puts` must still be empty. An import that saved itself would overwrite a
 * hand-written history with a parser's guess, and that is the one thing this
 * screen must never do on its own.
 */

const STORED: ProfileDraft = {
  name: "Ada Lovelace",
  headline: "Staff Backend Engineer",
  email: "ada@example.com",
  phone: "+1 416 555 0134",
  location: "Toronto, Canada",
  links: [{ label: "GitHub", url: "https://github.com/ada" }],
  summary: "Backend engineer on payments systems.",
  skills: [{ name: "Languages", keywords: ["TypeScript", "Go"] }],
  roles: [
    {
      company: "Monzo",
      title: "Senior Backend Engineer",
      location: "London, UK",
      startDate: "2022-01",
      endDate: null,
      bullets: ["Cut checkout p99 from 840ms to 210ms."],
    },
  ],
  projects: [
    {
      name: "kafka-lag-exporter",
      description: "Prometheus exporter for consumer lag",
      url: "https://github.com/ada/kafka-lag-exporter",
      bullets: ["Sampled 40 partitions a second on one goroutine."],
    },
  ],
  education: [
    {
      school: "University of Waterloo",
      credential: "BASc, Computer Engineering",
      location: null,
      startDate: "2014-09",
      endDate: "2019-04",
    },
  ],
};

const INCOMPLETE: ProfileCompleteness = {
  score: 55,
  missing: [
    "A phone number or a second way to reach you",
    "At least two roles with bullet points",
    "A summary of 40 words or more",
  ],
  ready: false,
};

const READY: ProfileCompleteness = { score: 92, missing: [], ready: true };

/** Bodies of every PUT the page issued, in order. */
let puts: ProfileDraft[] = [];
let getReply: () => { status: number; body: unknown };
let putReply: (draft: ProfileDraft) => { status: number; body: unknown };

/* ── upload transport ───────────────────────────────────────────────────── */

type XhrHandlers = Record<string, () => void>;

/**
 * Enough of `XMLHttpRequest` to drive the upload: the load/error/abort events,
 * a settable status and body, and an `upload` target that can emit progress.
 * Each instance registers itself so a test can answer it whenever it likes.
 */
class FakeXhr {
  static sent: FakeXhr[] = [];

  status = 0;
  responseText = "";
  method = "";
  url = "";
  body: FormData | null = null;

  private readonly handlers: XhrHandlers = {};
  private readonly uploadHandlers: Record<
    string,
    (event: {
      lengthComputable: boolean;
      loaded: number;
      total: number;
    }) => void
  > = {};

  readonly upload = {
    addEventListener: (
      type: string,
      handler: (event: {
        lengthComputable: boolean;
        loaded: number;
        total: number;
      }) => void,
    ) => {
      this.uploadHandlers[type] = handler;
    },
  };

  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }

  addEventListener(type: string, handler: () => void) {
    this.handlers[type] = handler;
  }

  send(body: FormData) {
    this.body = body;
    FakeXhr.sent.push(this);
  }

  abort() {
    this.handlers.abort?.();
  }

  /** Reports partial upload progress, the way a slow connection would. */
  progress(loaded: number, total: number) {
    this.uploadHandlers.progress?.({ lengthComputable: true, loaded, total });
  }

  answer(status: number, payload: unknown) {
    this.status = status;
    this.responseText = JSON.stringify(payload);
    this.handlers.load?.();
  }
}

function importPayload(
  overrides: {
    draft?: Partial<ProfileDraft>;
    warnings?: string[];
    extractedChars?: number;
    fileName?: string;
  } = {},
) {
  return {
    ok: true,
    data: {
      draft: {
        name: "Ada Lovelace",
        headline: "Principal Platform Engineer",
        email: "ada@example.com",
        phone: null,
        location: null,
        links: [],
        summary: "",
        skills: [],
        roles: [],
        projects: [],
        education: [],
        ...overrides.draft,
      },
      warnings: overrides.warnings ?? [],
      extractedChars: overrides.extractedChars ?? 4821,
      fileName: overrides.fileName ?? "ada-resume.pdf",
    },
  };
}

function installFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const json = (reply: { status: number; body: unknown }) =>
        ({
          status: reply.status,
          json: async () => reply.body,
        }) as unknown as Response;

      // The template panel loads its own catalogue; without this the page
      // would render with that panel in its error state.
      if (url === "/api/resume/templates") {
        return json({
          status: 200,
          body: {
            ok: true,
            data: { templates: RESUME_TEMPLATES, selected: "ats" },
          },
        });
      }
      if (url === "/api/profile" && (init?.method ?? "GET") === "GET") {
        return json(getReply());
      }
      if (url === "/api/profile" && init?.method === "PUT") {
        const draft = JSON.parse(String(init.body)) as ProfileDraft;
        puts.push(draft);
        return json(putReply(draft));
      }
      throw new Error(`No stub route for ${init?.method ?? "GET"} ${url}`);
    }),
  );
}

function UrlProbe() {
  const location = useLocation();
  return <output data-testid="path">{location.pathname}</output>;
}

async function mount() {
  const view = render(
    <MemoryRouter initialEntries={["/profile"]}>
      <Routes>
        <Route
          path="/profile"
          element={
            <>
              <ProfilePage />
              {/* An in-app destination, which is what the unsaved-changes
                  guard has to intercept. */}
              <Link to="/pipeline">Pipeline</Link>
            </>
          }
        />
        <Route path="/pipeline" element={<p>Pipeline screen</p>} />
      </Routes>
      <UrlProbe />
    </MemoryRouter>,
  );
  // The save button exists only in the loaded state. Waiting on the `h1` is
  // not enough: the loading shape carries the same heading, by design.
  await screen.findByRole("button", { name: /save profile/i });
  return view;
}

const file = (name: string, content = "resume text here") =>
  new File([content], name, { type: "application/octet-stream" });

async function choose(chosen: File) {
  const input = document.getElementById("resume-file") as HTMLInputElement;
  await act(async () => {
    fireEvent.change(input, { target: { files: [chosen] } });
  });
}

/**
 * Scoped to the form on purpose: the import review labels its rows with the
 * same words the form labels its fields with, which is correct on screen and
 * ambiguous to a document-wide query.
 */
const field = (label: string) =>
  within(document.getElementById("profile-form") as HTMLElement).getByLabelText(
    label,
  );

const lastUpload = () => FakeXhr.sent[FakeXhr.sent.length - 1] as FakeXhr;

beforeEach(() => {
  puts = [];
  FakeXhr.sent = [];
  getReply = () => ({
    status: 200,
    body: {
      ok: true,
      data: { profile: STORED, source: "stored", completeness: INCOMPLETE },
    },
  });
  putReply = (draft) => ({
    status: 200,
    body: { ok: true, data: { profile: draft, completeness: READY } },
  });
  installFetch();
  vi.stubGlobal("XMLHttpRequest", FakeXhr);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("profile form", () => {
  it("edits and saves the stored profile", async () => {
    await mount();

    const headline = field("Headline");
    await act(async () => {
      fireEvent.change(headline, { target: { value: "Principal Engineer" } });
    });

    expect(screen.getByTestId("save-state")).toHaveTextContent(
      "Unsaved changes",
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /save profile/i }));
    });

    expect(puts).toHaveLength(1);
    expect(puts[0]?.headline).toBe("Principal Engineer");
    // The saved profile is what the server echoed, so nothing is left dirty.
    expect(screen.getByTestId("save-state")).toHaveTextContent("Profile saved");
  });

  it("reports a malformed email next to the field and puts the caret there", async () => {
    await mount();

    await act(async () => {
      fireEvent.change(field("Email"), {
        target: { value: "ada@example" },
      });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /save profile/i }));
    });

    // Nothing was sent, the reason is on the field, and the caret is on it.
    expect(puts).toHaveLength(0);
    expect(
      screen.getByText("That does not look like an email address."),
    ).toBeInTheDocument();
    expect(field("Email")).toHaveFocus();
  });

  it("saves an incomplete profile rather than trapping a half-filled form", async () => {
    await mount();

    await act(async () => {
      fireEvent.change(field("Summary"), {
        target: { value: "" },
      });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /save profile/i }));
    });

    // An incomplete profile is a normal state; `completeness` is what says the
    // resume pipeline is blocked, not a form that refuses to store the work.
    expect(puts).toHaveLength(1);
    expect(puts[0]?.summary).toBe("");
  });

  it("adds, reorders and removes a role bullet", async () => {
    await mount();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add bullet" }));
    });
    await act(async () => {
      fireEvent.change(field("Bullet 2"), {
        target: { value: "Led the migration off the monolith." },
      });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Move bullet 2 up" }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /save profile/i }));
    });

    expect(puts[0]?.roles[0]?.bullets).toEqual([
      "Led the migration off the monolith.",
      "Cut checkout p99 from 840ms to 210ms.",
    ]);
  });

  it("warns before following an in-app link with unsaved edits", async () => {
    await mount();

    await act(async () => {
      fireEvent.change(field("Name"), {
        target: { value: "Ada L." },
      });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("link", { name: "Pipeline" }));
    });

    // Still here, with the choice stated rather than the edits silently gone.
    expect(screen.getByTestId("path")).toHaveTextContent("/profile");
    const dialog = screen.getByRole("alertdialog");
    expect(dialog).toHaveTextContent("Leave with unsaved changes?");

    await act(async () => {
      fireEvent.click(
        within(dialog).getByRole("button", { name: /keep editing/i }),
      );
    });
    expect(field("Name")).toHaveValue("Ada L.");

    await act(async () => {
      fireEvent.click(screen.getByRole("link", { name: "Pipeline" }));
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /discard and leave/i }),
      );
    });
    expect(screen.getByTestId("path")).toHaveTextContent("/pipeline");
  });

  it("lets an unchanged profile through a link without interrupting", async () => {
    await mount();
    await act(async () => {
      fireEvent.click(screen.getByRole("link", { name: "Pipeline" }));
    });
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(screen.getByTestId("path")).toHaveTextContent("/pipeline");
  });
});

describe("resume readiness", () => {
  it("names what is missing and says the resume pipeline is blocked", async () => {
    await mount();

    const panel = screen.getByRole("region", { name: /resume readiness/i });
    expect(panel).toHaveTextContent("Resume tailoring is blocked");
    const items = within(panel).getAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual(INCOMPLETE.missing);
  });

  it("says so plainly once nothing is missing", async () => {
    getReply = () => ({
      status: 200,
      body: {
        ok: true,
        data: { profile: STORED, source: "stored", completeness: READY },
      },
    });
    await mount();

    const panel = screen.getByRole("region", { name: /resume readiness/i });
    expect(panel).toHaveTextContent("Complete enough to tailor a resume.");
    expect(within(panel).queryAllByRole("listitem")).toHaveLength(0);
  });
});

describe("resume import", () => {
  it("shows the parse as a reviewable draft and writes nothing until the user accepts and saves", async () => {
    await mount();
    await choose(file("ada-resume.pdf"));

    // Uploading, with real byte progress rather than an indefinite spinner.
    await act(async () => {
      lastUpload().progress(512, 2048);
    });
    expect(screen.getByText("25%")).toBeInTheDocument();

    await act(async () => {
      lastUpload().answer(
        200,
        importPayload({ draft: { headline: "Principal Platform Engineer" } }),
      );
    });

    const review = screen.getByRole("region", { name: /review import/i });
    expect(review).toHaveTextContent("Principal Platform Engineer");
    // What it would replace is shown beside it.
    expect(review).toHaveTextContent("Staff Backend Engineer");

    // The destructive-action guard: a parse is a proposal, never a write.
    expect(puts).toHaveLength(0);
    expect(field("Headline")).toHaveValue("Staff Backend Engineer");

    await act(async () => {
      fireEvent.click(within(review).getByRole("button", { name: /^accept/i }));
    });

    // Accepted into the form — and still not saved.
    expect(field("Headline")).toHaveValue("Principal Platform Engineer");
    expect(puts).toHaveLength(0);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /save profile/i }));
    });
    expect(puts).toHaveLength(1);
    expect(puts[0]?.headline).toBe("Principal Platform Engineer");
  });

  it("keeps a field the user unticked out of the merge", async () => {
    await mount();
    await choose(file("ada-resume.pdf"));
    await act(async () => {
      lastUpload().answer(
        200,
        importPayload({
          draft: {
            headline: "Principal Platform Engineer",
            summary: "Parsed summary paragraph.",
          },
        }),
      );
    });

    const review = screen.getByRole("region", { name: /review import/i });
    await act(async () => {
      fireEvent.click(within(review).getByLabelText("Summary"));
    });
    await act(async () => {
      fireEvent.click(within(review).getByRole("button", { name: /^accept/i }));
    });

    expect(field("Headline")).toHaveValue("Principal Platform Engineer");
    expect(field("Summary")).toHaveValue(
      "Backend engineer on payments systems.",
    );
  });

  it("tells the user a scanned PDF yielded no text instead of failing silently", async () => {
    await mount();
    await choose(file("scan.pdf"));
    await act(async () => {
      lastUpload().answer(
        200,
        importPayload({
          fileName: "scan.pdf",
          extractedChars: 0,
          draft: { name: "", headline: "", email: "" },
          warnings: [
            "scan.pdf has no text layer — it looks like a scanned or photographed page.",
          ],
        }),
      );
    });

    expect(screen.getByTestId("import-empty")).toHaveTextContent(
      "No text could be read out of scan.pdf",
    );
    expect(screen.getByTestId("import-warnings")).toHaveTextContent(
      "scan.pdf has no text layer",
    );
    expect(puts).toHaveLength(0);
  });

  it("surfaces a warning on an otherwise successful parse", async () => {
    await mount();
    await choose(file("ada-resume.pdf"));
    await act(async () => {
      lastUpload().answer(
        200,
        importPayload({
          draft: { headline: "Principal Platform Engineer" },
          warnings: ["Dropped an email address that was not in the document."],
        }),
      );
    });

    expect(screen.getByTestId("import-warnings")).toHaveTextContent(
      "Dropped an email address that was not in the document.",
    );
  });

  it("refuses a file type on the dropzone without clearing the form", async () => {
    await mount();

    await act(async () => {
      fireEvent.change(field("Name"), {
        target: { value: "Ada L." },
      });
    });
    await choose(file("resume.pages"));

    expect(screen.getByTestId("dropzone-error")).toHaveTextContent(
      "only .pdf, .docx, .txt, .md resumes can be imported",
    );
    // Refused locally: nothing left the machine, and the typed form survived.
    expect(FakeXhr.sent).toHaveLength(0);
    expect(field("Name")).toHaveValue("Ada L.");
  });

  it("refuses a file over the limit before uploading it", async () => {
    await mount();
    const big = new File(["x".repeat(6 * 1024 * 1024)], "big.pdf");
    await choose(big);

    expect(screen.getByTestId("dropzone-error")).toHaveTextContent(
      "the import limit is 5 MB",
    );
    expect(FakeXhr.sent).toHaveLength(0);
  });

  it("shows the server's rejection message verbatim", async () => {
    await mount();
    await choose(file("ada-resume.pdf"));
    await act(async () => {
      lastUpload().answer(400, {
        ok: false,
        error: {
          code: "BAD_REQUEST",
          message: 'Cannot read "ada-resume.pdf": the file is not a valid PDF.',
        },
      });
    });

    expect(screen.getByTestId("dropzone-error")).toHaveTextContent(
      'Cannot read "ada-resume.pdf": the file is not a valid PDF.',
    );
  });

  it("accepts a dropped file, not only a picked one", async () => {
    await mount();
    const zone = screen.getByTestId("resume-dropzone");
    const dropped = file("dragged.txt");

    await act(async () => {
      fireEvent.drop(zone, { dataTransfer: { files: [dropped] } });
    });

    await waitFor(() => {
      expect(FakeXhr.sent).toHaveLength(1);
    });
    expect(lastUpload().url).toBe("/api/profile/import");
    expect(lastUpload().method).toBe("POST");
  });
});

describe("profile load", () => {
  it("offers a retry with the server's message when the profile cannot be read", async () => {
    getReply = () => ({
      status: 500,
      body: {
        ok: false,
        error: { code: "INTERNAL", message: "Profile store is unreadable." },
      },
    });

    render(
      <MemoryRouter initialEntries={["/profile"]}>
        <ProfilePage />
      </MemoryRouter>,
    );

    expect(
      await screen.findByText("Profile store is unreadable."),
    ).toBeInTheDocument();

    getReply = () => ({
      status: 200,
      body: {
        ok: true,
        data: { profile: STORED, source: "stored", completeness: INCOMPLETE },
      },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    });

    expect(await screen.findByLabelText("Name")).toHaveValue("Ada Lovelace");
  });

  it("says the committed example is not yet anyone's profile", async () => {
    getReply = () => ({
      status: 200,
      body: {
        ok: true,
        data: { profile: STORED, source: "seed", completeness: INCOMPLETE },
      },
    });
    await mount();

    expect(screen.getByText(/shipped example profile/i)).toBeInTheDocument();
  });
});
