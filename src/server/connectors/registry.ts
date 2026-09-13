import type {
  ConnectorAdapter,
  ConnectorProvider,
  OutboundEmailAdapter,
} from "@domain";
import { gmailSendAdapter } from "./gmail-send";
import { notionAdapter } from "./notion";
import { googleSheetsAdapter } from "./sheets";

/**
 * Adapters that push command-center rows to an external destination.
 *
 * `gmail_send` is deliberately absent: it sends messages rather than
 * maintaining rows, so it implements `OutboundEmailAdapter` and is exported
 * separately. Keeping the registries apart means the row-push path cannot
 * accidentally address the mailbox.
 */
export const ROW_CONNECTOR_ADAPTERS = {
  google_sheets: googleSheetsAdapter,
  notion: notionAdapter,
} satisfies Partial<Record<ConnectorProvider, ConnectorAdapter>>;

export type RowConnectorProvider = keyof typeof ROW_CONNECTOR_ADAPTERS;

export const ROW_CONNECTOR_PROVIDERS = Object.keys(
  ROW_CONNECTOR_ADAPTERS,
) as RowConnectorProvider[];

export const outboundEmailAdapter: OutboundEmailAdapter = gmailSendAdapter;

/** Type guard: narrows a provider to one that accepts row pushes. */
export function isRowConnectorProvider(
  provider: ConnectorProvider,
): provider is RowConnectorProvider {
  return provider in ROW_CONNECTOR_ADAPTERS;
}

/**
 * Resolve the adapter for connect/status/disconnect, which apply uniformly
 * whether or not the provider pushes rows.
 */
export function getLifecycleAdapter(
  provider: ConnectorProvider,
): Pick<ConnectorAdapter, "connect" | "status" | "disconnect"> {
  return isRowConnectorProvider(provider)
    ? ROW_CONNECTOR_ADAPTERS[provider]
    : gmailSendAdapter;
}
