import type {
  ProfileCompleteness,
  ProfileDraft,
  ProfileRole,
  RoleSuggestion,
} from "@domain";
import { ApiError, request } from "@web/lib/api";

/**
 * Everything the profile screen needs that is not a React component: the three
 * endpoints, the rules for rejecting a file before it leaves the machine, the
 * validation that blocks a save, and the model behind the import review.
 *
 * The review model is the important one. A parsed resume is a *proposal*, so
 * nothing here ever writes: `importResume` returns a draft, `reviewRows` says
 * how it differs from what is on file, and `applyReview` folds in only the
 * paths the user accepted. The single `PUT` stays in the user's hands.
 */

export type ProfileResponse = {
  profile: ProfileDraft;
  /** `seed` means nobody has saved yet and this is the committed fallback. */
  source: "stored" | "seed";
  completeness: ProfileCompleteness;
};

export type ProfileSaveResponse = {
  profile: ProfileDraft;
  completeness: ProfileCompleteness;
};

export type ResumeImportResponse = {
  draft: ProfileDraft;
  /** Server's own words. Rendered verbatim; never summarised away. */
  warnings: string[];
  extractedChars: number;
  fileName: string;
};

export function fetchProfile(signal?: AbortSignal): Promise<ProfileResponse> {
  return request<ProfileResponse>(
    "/api/profile",
    signal ? { signal } : undefined,
  );
}

export function saveProfile(
  draft: ProfileDraft,
  signal?: AbortSignal,
): Promise<ProfileSaveResponse> {
  return request<ProfileSaveResponse>("/api/profile", {
    method: "PUT",
    body: JSON.stringify(draft),
    ...(signal ? { signal } : {}),
  });
}

/* ── suggested roles ────────────────────────────────────────────────────── */

export type RoleSuggestionResponse = {
  suggestions: RoleSuggestion[];
  generatedAt: string | null;
  /** The stored set no longer describes the profile on file, or there is none. */
  stale: boolean;
  /** `seed` means no resume has been saved, so there is nothing to suggest from. */
  profileSource: "stored" | "seed";
};

/** Reads whatever is stored. Never spends a model call. */
export function fetchRoleSuggestions(
  signal?: AbortSignal,
): Promise<RoleSuggestionResponse> {
  return request<RoleSuggestionResponse>(
    "/api/profile/role-suggestions",
    signal ? { signal } : undefined,
  );
}

/** Asks the model for a fresh set and stores it. Slow by nature. */
export function generateRoleSuggestions(
  signal?: AbortSignal,
): Promise<RoleSuggestionResponse> {
  return request<RoleSuggestionResponse>("/api/profile/role-suggestions", {
    method: "POST",
    ...(signal ? { signal } : {}),
  });
}

/* ── file gate ──────────────────────────────────────────────────────────── */

export const RESUME_EXTENSIONS = [".pdf", ".docx", ".txt", ".md"] as const;

/**
 * `accept` for the file input. Extensions only, matching the server: browsers
 * report an empty or invented MIME type for `.md` often enough that a
 * type-based filter silently hides valid files from the picker.
 */
export const RESUME_ACCEPT = RESUME_EXTENSIONS.join(",");

/**
 * The server's own limit, restated. Rejecting here only spares the user a slow
 * upload that was always going to be refused — the 400 is still the authority,
 * and its message is what gets shown when the two ever disagree.
 */
export const MAX_RESUME_BYTES = 5 * 1024 * 1024;

const MEGABYTE = 1024 * 1024;

/** Why this file cannot be sent, in the words the dropzone shows. */
export function rejectResume(file: File): string | null {
  const name = file.name.toLowerCase();
  const known = RESUME_EXTENSIONS.some((extension) => name.endsWith(extension));
  if (!known) {
    return `Cannot read “${file.name}”: only ${RESUME_EXTENSIONS.join(", ")} resumes can be imported.`;
  }
  if (file.size > MAX_RESUME_BYTES) {
    return `“${file.name}” is ${(file.size / MEGABYTE).toFixed(1)} MB; the import limit is ${Math.round(MAX_RESUME_BYTES / MEGABYTE)} MB.`;
  }
  if (file.size === 0) return `“${file.name}” is empty — nothing to read.`;
  return null;
}

/* ── import ─────────────────────────────────────────────────────────────── */

/**
 * `XMLHttpRequest`, not `fetch`, for exactly one reason: `fetch` cannot report
 * how much of a request body has gone out, and a resume upload with no
 * progress on a slow connection looks like a hung page. The envelope handling
 * below is deliberately identical to `request()`'s, so a server error reaches
 * the user as the same `ApiError` whichever transport carried it.
 */
export function importResume(
  file: File,
  options: {
    /** 0–1 of the body sent. Called only when the browser knows the total. */
    onProgress?: (fraction: number) => void;
    signal?: AbortSignal;
  } = {},
): Promise<ResumeImportResponse> {
  const path = "/api/profile/import";

  return new Promise<ResumeImportResponse>((resolve, reject) => {
    const body = new FormData();
    body.append("file", file, file.name);

    const xhr = new XMLHttpRequest();
    xhr.open("POST", path);

    xhr.upload?.addEventListener("progress", (event) => {
      if (event.lengthComputable && event.total > 0) {
        options.onProgress?.(Math.min(1, event.loaded / event.total));
      }
    });

    xhr.addEventListener("load", () => {
      // The bytes are all out by now; anything still pending is the server
      // reading the document, which is not upload progress.
      options.onProgress?.(1);
      try {
        resolve(unwrapImport(xhr.status, xhr.responseText, path));
      } catch (cause) {
        reject(cause);
      }
    });

    xhr.addEventListener("error", () => {
      reject(
        new ApiError(
          `Cannot reach the Command Center server at ${path}. Is it running on port 8787?`,
          "NETWORK",
          0,
        ),
      );
    });

    xhr.addEventListener("abort", () => {
      reject(new ApiError("Upload cancelled.", "ABORTED", 0));
    });

    if (options.signal) {
      if (options.signal.aborted) {
        reject(new ApiError("Upload cancelled.", "ABORTED", 0));
        return;
      }
      options.signal.addEventListener("abort", () => xhr.abort(), {
        once: true,
      });
    }

    xhr.send(body);
  });
}

function unwrapImport(
  status: number,
  text: string,
  path: string,
): ResumeImportResponse {
  let payload: unknown;
  try {
    payload = JSON.parse(text) as unknown;
  } catch {
    throw new ApiError(
      `${path} answered ${status} with a body that is not JSON.`,
      "BAD_RESPONSE",
      status,
    );
  }

  const envelope = payload as
    | { ok: true; data: ResumeImportResponse }
    | { ok: false; error?: { code?: string; message?: string } };

  if (envelope && typeof envelope === "object" && envelope.ok === false) {
    throw new ApiError(
      envelope.error?.message ?? "The server rejected the request.",
      envelope.error?.code ?? "UNKNOWN",
      status,
    );
  }
  if (!envelope || typeof envelope !== "object" || envelope.ok !== true) {
    throw new ApiError(
      `${path} answered in an unrecognised shape.`,
      "BAD_RESPONSE",
      status,
    );
  }
  return envelope.data;
}

/* ── validation ─────────────────────────────────────────────────────────── */

/**
 * Dotted path into the draft: `name`, `links.2.url`, `roles.0.company`. One
 * string is the error key, the DOM id and the review row key at once, so an
 * error can never point at a control that does not exist.
 */
export type FieldPath = string;

export type FieldErrors = Record<FieldPath, string>;

export function fieldId(path: FieldPath): string {
  return `profile-${path.replace(/\./g, "-")}`;
}

/**
 * A plausible address, not RFC 5322. The server and the mail provider are the
 * real judges; this only catches the typo the user can still see on screen.
 */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * What blocks a save, and nothing more. An incomplete profile is a normal
 * state — the server's `completeness` is what says so — and refusing to store
 * one would mean the user could not stop halfway. So only two things are
 * errors: a profile with nobody's name on it, and a value that is malformed
 * rather than absent.
 */
export function validateDraft(draft: ProfileDraft): FieldErrors {
  const errors: FieldErrors = {};

  if (draft.name.trim() === "") {
    errors.name = "A name is required — it is the top line of every resume.";
  }
  if (draft.email.trim() !== "" && !EMAIL.test(draft.email.trim())) {
    errors.email = "That does not look like an email address.";
  }

  draft.links.forEach((link, index) => {
    const url = link.url.trim();
    if (url !== "") {
      let scheme: string | null = null;
      try {
        scheme = new URL(url).protocol;
      } catch {
        scheme = null;
      }
      if (scheme !== "http:" && scheme !== "https:") {
        errors[`links.${index}.url`] = "Needs a full URL, including https://.";
      }
      if (link.label.trim() === "") {
        errors[`links.${index}.label`] = "Name this link.";
      }
    }
  });

  draft.roles.forEach((role, index) => {
    const touched =
      role.company.trim() !== "" ||
      role.title.trim() !== "" ||
      role.bullets.some((bullet) => bullet.trim() !== "");
    if (!touched) return;
    if (role.company.trim() === "") {
      errors[`roles.${index}.company`] = "Which company?";
    }
    if (role.title.trim() === "") {
      errors[`roles.${index}.title`] = "Which title?";
    }
  });

  draft.projects.forEach((project, index) => {
    const touched =
      project.name.trim() !== "" ||
      project.description.trim() !== "" ||
      project.bullets.some((bullet) => bullet.trim() !== "");
    if (!touched) return;
    if (project.name.trim() === "") {
      errors[`projects.${index}.name`] = "Name this project.";
    }
    const url = (project.url ?? "").trim();
    if (url !== "") {
      let scheme: string | null = null;
      try {
        scheme = new URL(url).protocol;
      } catch {
        scheme = null;
      }
      if (scheme !== "http:" && scheme !== "https:") {
        errors[`projects.${index}.url`] =
          "Needs a full URL, including https://.";
      }
    }
  });

  draft.education.forEach((entry, index) => {
    const touched =
      entry.school.trim() !== "" || (entry.credential ?? "").trim() !== "";
    if (touched && entry.school.trim() === "") {
      errors[`education.${index}.school`] = "Which school?";
    }
  });

  draft.skills.forEach((group, index) => {
    if (group.name.trim() === "" && group.keywords.length > 0) {
      errors[`skills.${index}.name`] = "Name this group.";
    }
  });

  return errors;
}

/* ── review ─────────────────────────────────────────────────────────────── */

/** The slices of a draft the import review can accept or reject on its own. */
export const REVIEW_PATHS = [
  "name",
  "headline",
  "email",
  "phone",
  "location",
  "summary",
  "links",
  "skills",
  "roles",
  "projects",
  "education",
] as const;

export type ReviewPath = (typeof REVIEW_PATHS)[number];

export type ReviewRow = {
  path: ReviewPath;
  label: string;
  /** What is on file now, one entry per line. Empty means "not set". */
  current: string[];
  /** What the parse produced, same shape. */
  incoming: string[];
  /** The import has something here, and it differs from what is stored. */
  changed: boolean;
};

const REVIEW_LABELS: Record<ReviewPath, string> = {
  name: "Name",
  headline: "Headline",
  email: "Email",
  phone: "Phone",
  location: "Location",
  summary: "Summary",
  links: "Links",
  skills: "Skills",
  roles: "Experience",
  projects: "Projects",
  education: "Education",
};

/**
 * A role's dates are free text all the way from the parser, so they are shown
 * as written rather than reformatted into a precision nobody claimed. An
 * absent end date is the one inference worth making: it means "current".
 */
export function roleDates(
  role: Pick<ProfileRole, "startDate" | "endDate">,
): string {
  const start = (role.startDate ?? "").trim();
  const end = (role.endDate ?? "").trim();
  if (start === "" && end === "") return "";
  return `${start || "?"} – ${end || "present"}`;
}

/** One draft slice rendered as the lines the review shows side by side. */
function slice(draft: ProfileDraft, path: ReviewPath): string[] {
  switch (path) {
    case "links":
      return draft.links
        .filter((link) => link.url.trim() !== "" || link.label.trim() !== "")
        .map((link) => `${link.label || "link"} — ${link.url}`);
    case "skills":
      return draft.skills
        .filter(
          (group) => group.name.trim() !== "" || group.keywords.length > 0,
        )
        .map((group) => `${group.name}: ${group.keywords.join(", ")}`);
    case "roles":
      return draft.roles
        .filter(
          (role) => role.company.trim() !== "" || role.title.trim() !== "",
        )
        .map((role) => {
          const when = roleDates(role);
          const kept = role.bullets.filter((bullet) => bullet.trim() !== "");
          const head = `${role.title || "role"} · ${role.company || "?"}`;
          const tail =
            kept.length === 1 ? "1 bullet" : `${kept.length} bullets`;
          return when ? `${head} (${when}) — ${tail}` : `${head} — ${tail}`;
        });
    case "projects":
      return draft.projects
        .filter(
          (project) =>
            project.name.trim() !== "" || project.description.trim() !== "",
        )
        .map((project) => {
          const kept = project.bullets.filter((bullet) => bullet.trim() !== "");
          const head = project.description
            ? `${project.name || "project"} — ${project.description}`
            : project.name || "project";
          if (kept.length === 0) return head;
          return `${head} (${kept.length === 1 ? "1 bullet" : `${kept.length} bullets`})`;
        });
    case "education":
      return draft.education
        .filter(
          (entry) =>
            entry.school.trim() !== "" ||
            (entry.credential ?? "").trim() !== "",
        )
        .map((entry) =>
          entry.credential
            ? `${entry.credential} · ${entry.school}`
            : entry.school,
        );
    default: {
      // The six scalar paths, narrowed by exhaustion of the collection cases.
      const text = (draft[path] ?? "").trim();
      return text === "" ? [] : [text];
    }
  }
}

/**
 * Side-by-side view of the parse against what is stored.
 *
 * A path the parser found nothing for is not a change: a resume that omits a
 * phone number is not an instruction to delete the one on file. That is the
 * whole reason an import cannot simply overwrite the profile.
 */
export function reviewRows(
  current: ProfileDraft,
  incoming: ProfileDraft,
): ReviewRow[] {
  return REVIEW_PATHS.map((path) => {
    const before = slice(current, path);
    const after = slice(incoming, path);
    return {
      path,
      label: REVIEW_LABELS[path],
      current: before,
      incoming: after,
      changed: after.length > 0 && after.join("\n") !== before.join("\n"),
    };
  });
}

/**
 * Folds the accepted paths of `incoming` into `base`. Everything not accepted
 * keeps the stored value, so rejecting a row is a real decision rather than a
 * delayed overwrite. Arrays are copied because the result is about to become
 * editable form state and must not alias the response.
 */
export function applyReview(
  base: ProfileDraft,
  incoming: ProfileDraft,
  accepted: ReadonlySet<ReviewPath>,
): ProfileDraft {
  const next: ProfileDraft = {
    ...base,
    links: base.links.map((link) => ({ ...link })),
    skills: base.skills.map((group) => ({
      ...group,
      keywords: [...group.keywords],
    })),
    roles: base.roles.map((role) => ({ ...role, bullets: [...role.bullets] })),
    projects: base.projects.map((project) => ({
      ...project,
      bullets: [...project.bullets],
    })),
    education: base.education.map((entry) => ({ ...entry })),
  };

  for (const path of accepted) {
    switch (path) {
      case "links":
        next.links = incoming.links.map((link) => ({ ...link }));
        break;
      case "skills":
        next.skills = incoming.skills.map((group) => ({
          ...group,
          keywords: [...group.keywords],
        }));
        break;
      case "roles":
        next.roles = incoming.roles.map((role) => ({
          ...role,
          bullets: [...role.bullets],
        }));
        break;
      case "projects":
        next.projects = incoming.projects.map((project) => ({
          ...project,
          bullets: [...project.bullets],
        }));
        break;
      case "education":
        next.education = incoming.education.map((entry) => ({ ...entry }));
        break;
      // Split by nullability rather than collapsed into a `default`, which
      // would ask TypeScript to correlate `next[path]` with `incoming[path]`
      // across a key union it cannot narrow. Listing every path also makes
      // the switch exhaustive, so a new field forces a decision here.
      case "name":
      case "headline":
      case "email":
      case "summary":
        next[path] = incoming[path];
        break;
      case "phone":
      case "location":
        next[path] = incoming[path];
        break;
    }
  }

  return next;
}

/**
 * Whether the form holds anything the server does not. Compared as JSON
 * because a draft is plain data whose keys all come from the same factory,
 * which makes this both correct and cheaper than a field walk.
 */
export function isDirty(saved: ProfileDraft, working: ProfileDraft): boolean {
  return JSON.stringify(saved) !== JSON.stringify(working);
}

/**
 * Reorders one entry of a repeated list. Shared by every list on the form —
 * links, skills, roles, bullets, education — so the reorder buttons cannot
 * behave differently in one section than another. An out-of-range target is a
 * no-op rather than an error: the buttons at the ends are disabled, and a key
 * repeat that outruns a re-render must not drop the row.
 */
export function moveItem<T>(items: T[], from: number, to: number): T[] {
  if (from === to || to < 0 || to >= items.length) return items;
  const next = [...items];
  const [moved] = next.splice(from, 1);
  if (moved === undefined) return items;
  next.splice(to, 0, moved);
  return next;
}
