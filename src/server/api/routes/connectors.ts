/**
 * Connector lifecycle endpoints.
 *
 * `GET /connectors` always answers with one entry per provider, configured or
 * not: a dashboard that hides unconfigured integrations gives the user nothing
 * to click, which is the exact failure this app exists to avoid. Unconfigured
 * entries carry a `setupHint` naming both ways to connect.
 */

import { CONNECTOR_PROVIDERS, type ConnectorHealth } from "@domain";
import {
  disconnectProvider,
  linkProvider,
  notConfiguredHealth,
  providerAuthMode,
  syncProviderStatus,
} from "@server/connectors/composio/service";
import {
  disconnectConnector,
  getConnectorHealth,
} from "@server/connectors/service";
import { badRequest } from "@server/infra/errors";
import { logger } from "@server/infra/logger";
import { Hono } from "hono";
import { z } from "zod";
import type { ApiDeps } from "../app";
import { ok } from "../respond";

const providerParam = z.enum(CONNECTOR_PROVIDERS);

function parseProvider(value: string | undefined) {
  const result = providerParam.safeParse(value);
  if (!result.success) {
    throw badRequest(
      `Unknown connector provider "${value ?? ""}". Expected one of: ${CONNECTOR_PROVIDERS.join(", ")}.`,
    );
  }
  return result.data;
}

export function createConnectorRoutes(deps: ApiDeps): Hono {
  const routes = new Hono();

  /**
   * Health for one provider, whichever transport it is on. The direct probe is
   * the existing service call, so a directly connected provider reports
   * exactly what it reported before — plus which transport answered.
   */
  const health = async (
    provider: (typeof CONNECTOR_PROVIDERS)[number],
  ): Promise<ConnectorHealth> => {
    const mode = providerAuthMode(provider, { repos: deps.repos });
    if (mode === "composio") {
      return syncProviderStatus(provider, { repos: deps.repos });
    }
    if (mode === "direct") {
      const direct = await getConnectorHealth({ provider }, deps);
      return { ...direct, authMode: "direct", linkState: "none" };
    }
    return notConfiguredHealth(
      provider,
      deps.repos.connectors.getByProvider(provider),
    );
  };

  routes.get("/connectors", async (c) => {
    const connectors = deps.repos.connectors
      .list()
      .map((connector) => deps.repos.connectors.toSummary(connector));

    // One bad provider must not blank the page: a probe that throws becomes an
    // `error` row so the other two still render and stay actionable.
    const entries = await Promise.all(
      CONNECTOR_PROVIDERS.map(async (provider) => {
        try {
          return await health(provider);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          logger.warn("Connector health probe failed", { provider, message });
          const errorRow: ConnectorHealth = {
            provider,
            accountKey: "default",
            connected: false,
            status: "error",
            target: null,
            destinationUrl: null,
            lastSyncedAt: null,
            lastError: message,
            // Omitted when neither transport is set up. Defaulting to
            // "direct" here would have the card offer a transport the
            // provider does not have, which is the dead end the UI now
            // avoids by branching on this field. Annotated so a drift
            // between this row and `ConnectorHealth` fails the build.
            authMode:
              providerAuthMode(provider, { repos: deps.repos }) ?? undefined,
            linkState: "none",
            connectedAccountId: null,
            setupHint: null,
          };
          return errorRow;
        }
      }),
    );

    return ok(c, { connectors, health: entries });
  });

  /**
   * Start a Composio Connect Link. The response is a URL the browser opens;
   * consent happens on Composio's side, so this app never sees a client
   * secret and the user never provisions an OAuth app.
   */
  routes.post("/connectors/:provider/link", async (c) => {
    const provider = parseProvider(c.req.param("provider"));
    const ticket = await linkProvider(provider, {
      repos: deps.repos,
      callbackUrl: `${deps.baseUrl.replace(/\/+$/, "")}/apps?linked=${provider}`,
    });
    return ok(c, ticket);
  });

  /** Polled by the UI after the consent popup returns. */
  routes.get("/connectors/:provider/status", async (c) => {
    const provider = parseProvider(c.req.param("provider"));
    return ok(c, { health: await health(provider) });
  });

  /**
   * Forget the connector. Revokes the grant only — the user's spreadsheet,
   * pages and mail are untouched, by both transports.
   */
  routes.post("/connectors/:provider/disconnect", async (c) => {
    const provider = parseProvider(c.req.param("provider"));
    const mode = providerAuthMode(provider, { repos: deps.repos });

    if (mode === "direct") {
      const result = await disconnectConnector({ provider }, deps);
      return ok(c, {
        health: { ...result, authMode: "direct", linkState: "none" as const },
      });
    }

    return ok(c, {
      health: await disconnectProvider(provider, { repos: deps.repos }),
    });
  });

  return routes;
}
