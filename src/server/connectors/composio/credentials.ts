/**
 * Which Composio credential this process has, and therefore which call path
 * the client must use.
 *
 * Composio issues two credential classes and they are not interchangeable:
 *
 * | | project key | user key |
 * |---|---|---|
 * | prefix   | `ck_` / `ak_`                  | `uak_` |
 * | headers  | `x-api-key`                    | `x-user-api-key` + `x-org-id` + `x-project-id` |
 * | execute  | `POST /tools/execute/{slug}`   | open a tool-router session, execute inside it |
 *
 * A CONSUMER project — what `composio login` gives an individual — issues only
 * the user key, so a client that knows just `x-api-key` cannot connect at all.
 * Both paths were confirmed live; see `client.ts` for the session sequence.
 *
 * The user key is read from the CLI's own credential file rather than asked
 * for, because it is already on disk after `composio login` and copying a
 * secret into `.env` by hand is how secrets end up in git.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { logger } from "@server/infra/logger";
import { z } from "zod";

/** A user key is identified by its prefix, never by length. */
export const COMPOSIO_USER_KEY_PREFIX = "uak_";

export type ComposioCredentialKind = "project" | "user";

export type ComposioCredential = {
  kind: ComposioCredentialKind;
  apiKey: string;
  /** Origin only, e.g. `https://backend.composio.dev`. */
  origin: string;
  /** Present on the user path; the org the CLI logged into. */
  orgId: string | null;
  /** Where this came from, for a health message that names the remedy. */
  source: "environment" | "cli";
};

/**
 * The CLI writes more than this; only these fields are load-bearing, and an
 * unknown extra field must never make the file unreadable.
 */
const cliCredentialSchema = z.object({
  api_key: z.string().min(1),
  base_url: z.string().url().optional(),
  org_id: z.string().min(1).optional(),
});

/** `https://backend.composio.dev/api/v3.1` → `https://backend.composio.dev`. */
export function originOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).origin;
  } catch {
    return baseUrl.replace(/\/api\/v3(\.\d+)?\/?$/, "").replace(/\/+$/, "");
  }
}

export function classifyComposioKey(apiKey: string): ComposioCredentialKind {
  return apiKey.startsWith(COMPOSIO_USER_KEY_PREFIX) ? "user" : "project";
}

/** `~/.composio`, or `COMPOSIO_CACHE_DIR` when the CLI was pointed elsewhere. */
export function composioCacheDir(): string {
  const configured = (process.env.COMPOSIO_CACHE_DIR ?? "").trim();
  return configured === "" ? join(homedir(), ".composio") : configured;
}

/**
 * The CLI credential, or `null` when absent, unreadable or malformed.
 *
 * Every failure is a fallback rather than a throw: this file belongs to
 * another program, and a user who never installed the CLI is the normal case,
 * not an error. The contents are never logged.
 */
export function readCliCredential(): ComposioCredential | null {
  const path = join(composioCacheDir(), "user_data.json");
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    logger.warn("Composio CLI credential file is not valid JSON", { path });
    return null;
  }

  const result = cliCredentialSchema.safeParse(parsed);
  if (!result.success) return null;

  const apiKey = result.data.api_key.trim();
  if (apiKey === "") return null;

  return {
    kind: classifyComposioKey(apiKey),
    apiKey,
    origin: originOf(result.data.base_url ?? "https://backend.composio.dev"),
    orgId: result.data.org_id ?? null,
    source: "cli",
  };
}

/**
 * Resolve the credential to use.
 *
 * Precedence: an explicitly supplied key, then `COMPOSIO_API_KEY`, then the
 * CLI file. The environment wins because it is the deliberate, per-deployment
 * choice; the CLI file is the convenience for a developer already logged in.
 * Read lazily on purpose — a key added while the server runs takes effect on
 * the next call, and a test can stub the environment after import.
 */
export function resolveComposioCredential(
  options: { apiKey?: string | null; baseUrl?: string } = {},
): ComposioCredential | null {
  const explicit = (options.apiKey ?? "").trim();
  const fromEnv = (process.env.COMPOSIO_API_KEY ?? "").trim();
  const key = explicit !== "" ? explicit : fromEnv;

  if (key !== "") {
    return {
      kind: classifyComposioKey(key),
      apiKey: key,
      origin: originOf(options.baseUrl ?? "https://backend.composio.dev"),
      orgId: (process.env.COMPOSIO_ORG_ID ?? "").trim() || null,
      source: "environment",
    };
  }

  return readCliCredential();
}

/** True when any credential is available, without revealing which. */
export function hasComposioCredential(apiKey?: string | null): boolean {
  return resolveComposioCredential({ apiKey }) !== null;
}
