/**
 * Rewrite the profile's outbound links into click-tracked ones.
 *
 * A non-bot click on a tracked link is the only engagement signal available
 * before a reply arrives, and it is what shortens the follow-up cadence. The
 * rewrite is idempotent per (job, destination): re-rendering the same
 * application reuses the token already embedded in the PDF that went out, so an
 * earlier submission's link never goes dead and the click history stays on one
 * row.
 */

import type { Profile } from "@domain";
import { badRequest } from "@server/infra/errors";
import type { RepoBundle } from "@server/repos";

export type ApplyTracerLinksInput = {
  profile: Profile;
  jobId: string;
  repos: RepoBundle;
  baseUrl: string;
};

export function applyTracerLinks(input: ApplyTracerLinksInput): Profile {
  const base = input.baseUrl.trim().replace(/\/+$/, "");
  if (base === "") {
    throw badRequest("applyTracerLinks requires a non-empty baseUrl");
  }
  if (input.jobId.trim() === "") {
    throw badRequest("applyTracerLinks requires a jobId");
  }

  const tokenByDestination = new Map<string, string>();
  for (const existing of input.repos.resumeLinks.listForJob(input.jobId)) {
    // Oldest first, so the first token minted for a destination is the one that
    // keeps being used.
    if (!tokenByDestination.has(existing.destinationUrl)) {
      tokenByDestination.set(existing.destinationUrl, existing.token);
    }
  }

  const links = input.profile.links.map((link) => {
    let token = tokenByDestination.get(link.url);
    if (token === undefined) {
      token = input.repos.resumeLinks.create({
        jobId: input.jobId,
        label: link.label,
        destinationUrl: link.url,
      }).token;
      tokenByDestination.set(link.url, token);
    }
    return { label: link.label, url: `${base}/r/${token}` };
  });

  // Only `links` changes; the remaining sections are read-only data shared with
  // the caller rather than copied, and the input object itself is untouched.
  return { ...input.profile, links };
}
