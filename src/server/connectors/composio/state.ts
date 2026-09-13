/**
 * Composio's per-connector state, persisted inside the existing
 * `connectors.config` JSON blob.
 *
 * No new table and no new column: `connectors.status` is constrained to three
 * values by a CHECK, and a consent link in flight is none of them. Keeping the
 * broker's handles in `config` means the direct row and the Composio row are
 * the same row, which is exactly what lets the transport predicate read one
 * record and decide.
 */

import {
  CONNECTOR_LINK_STATES,
  type Connector,
  type ConnectorConfig,
  type ConnectorLinkState,
} from "@domain";
import { z } from "zod";

/** Single-user app: one account key per provider, matching the direct rows. */
export const COMPOSIO_ACCOUNT_KEY = "default";

const composioStateSchema = z.object({
  authConfigId: z.string().nullish(),
  connectedAccountId: z.string().nullish(),
  linkState: z.enum(CONNECTOR_LINK_STATES).nullish(),
  /** Human-readable account label, shown as the connector's target. */
  label: z.string().nullish(),
  /** ISO-8601 UTC, set when Composio first reported the account ACTIVE. */
  linkedAt: z.string().nullish(),
});

export type ComposioState = {
  authConfigId: string | null;
  connectedAccountId: string | null;
  linkState: ConnectorLinkState;
  label: string | null;
  linkedAt: string | null;
};

const EMPTY_STATE: ComposioState = {
  authConfigId: null,
  connectedAccountId: null,
  linkState: "none",
  label: null,
  linkedAt: null,
};

export function readComposioState(
  connector: Connector | null | undefined,
): ComposioState {
  const parsed = composioStateSchema.safeParse(
    connector?.config?.composio ?? {},
  );
  if (!parsed.success) return { ...EMPTY_STATE };
  return {
    authConfigId: parsed.data.authConfigId ?? null,
    connectedAccountId: parsed.data.connectedAccountId ?? null,
    linkState: parsed.data.linkState ?? "none",
    label: parsed.data.label ?? null,
    linkedAt: parsed.data.linkedAt ?? null,
  };
}

/**
 * The connector's config with the Composio block patched. The repo replaces
 * `config` wholesale, so the rest of the blob (Notion's resolved lane database
 * ids, for one) has to be carried across by hand or a link would erase it.
 */
export function mergeComposioState(
  connector: Connector | null | undefined,
  patch: Partial<ComposioState> | null,
): ConnectorConfig {
  const existingConfig = (connector?.config ?? {}) as Record<string, unknown>;
  const { composio: _dropped, ...rest } = existingConfig;
  if (patch === null) return rest;
  return { ...rest, composio: { ...readComposioState(connector), ...patch } };
}
