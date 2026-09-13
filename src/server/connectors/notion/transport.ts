/**
 * The direct half of the Notion row transport: the same REST calls the adapter
 * made inline before, moved behind `NotionRowTransport` so the Composio
 * implementation can stand in the one place `push` selects.
 *
 * Nothing about the direct path changed. The lane database still comes from
 * `config.databaseIds` or a one-off workspace search by title, keys are still
 * looked up in batched compound filters rather than one query per row, and a
 * dead token still fails the whole push instead of every row separately.
 */

import type { ConnectorAdapterContext } from "@domain";
import { badRequest } from "@server/infra/errors";
import {
  NOTION_FILTER_CONDITION_LIMIT,
  type NotionLaneRef,
  type NotionPageWrite,
  type NotionRowTransport,
  notionUrlFor,
  readNotionKeyCell,
} from "../composio/transport";
import {
  createPage,
  type NotionObject,
  notionCredentialsSchema,
  notionUrlFromId,
  plainText,
  queryAll,
  searchDatabases,
  updatePage,
} from "./api";
import {
  NOTION_DATABASES,
  NOTION_KEY_PROPERTY,
  toNotionProperties,
} from "./properties";

/** Databases the integration can see, indexed by lowercased title. */
export function indexByTitle(
  databases: NotionObject[],
): Map<string, NotionObject> {
  const byTitle = new Map<string, NotionObject>();
  for (const database of databases) {
    const title = plainText(database.title).trim().toLowerCase();
    if (title !== "" && !byTitle.has(title)) byTitle.set(title, database);
  }
  return byTitle;
}

/**
 * The internal integration secret on the connector row. Read lazily by each
 * method below, so building this transport on the Composio path — where the
 * row holds no credentials — costs nothing and throws nothing.
 */
export function readNotionToken(ctx: ConnectorAdapterContext): string {
  const parsed = notionCredentialsSchema.safeParse(
    ctx.connector.credentials ?? {},
  );
  if (!parsed.success) {
    throw badRequest(
      "Notion connector credentials are missing or malformed: expected { accessToken } holding the internal integration secret.",
      parsed.error.flatten(),
    );
  }
  return parsed.data.accessToken;
}

export function createDirectNotionRowTransport(args: {
  /**
   * Read the integration secret. A thunk, because this transport is built on
   * both paths — it is the `direct` argument `resolveNotionRowTransport` picks
   * between — and a Composio-only connector row has no secret to read.
   */
  readToken: () => string;
  fetchImpl: typeof fetch;
}): NotionRowTransport {
  /**
   * The workspace search is one request that answers every lane, so it runs
   * at most once per push and only when a lane has no configured id.
   */
  let inventory: Map<string, NotionObject> | null = null;

  return {
    mode: "direct",

    async openLane(input) {
      const configured = input.databaseId?.trim();
      if (configured) {
        return {
          kind: input.kind,
          databaseId: configured,
          url: notionUrlFromId(configured),
        };
      }

      const spec = NOTION_DATABASES[input.kind];
      inventory ??= indexByTitle(
        await searchDatabases(args.readToken(), args.fetchImpl),
      );
      const existing = inventory.get(spec.title.toLowerCase());
      if (!existing) {
        throw badRequest(
          `Notion connector has no "${spec.title}" database for the ${input.kind} lane: run connect to provision it, or set config.databaseIds.${input.kind}.`,
        );
      }
      return {
        kind: input.kind,
        databaseId: existing.id,
        url: existing.url ?? notionUrlFromId(existing.id),
      };
    },

    async findRowsByKey(lane: NotionLaneRef, keys: string[]) {
      const found = new Map<string, string>();
      const unique = [...new Set(keys)];

      for (
        let offset = 0;
        offset < unique.length;
        offset += NOTION_FILTER_CONDITION_LIMIT
      ) {
        const chunk = unique.slice(
          offset,
          offset + NOTION_FILTER_CONDITION_LIMIT,
        );
        const conditions = chunk.map((key) => ({
          property: NOTION_KEY_PROPERTY,
          title: { equals: key },
        }));
        const pages = await queryAll(
          args.readToken(),
          args.fetchImpl,
          lane.databaseId,
          {
            ...(conditions.length === 1 ? conditions[0] : { or: conditions }),
          },
        );

        for (const page of pages) {
          const key = readNotionKeyCell(page.properties, NOTION_KEY_PROPERTY);
          if (key !== "" && !found.has(key)) found.set(key, page.id);
        }
      }

      return found;
    },

    async write(input: NotionPageWrite) {
      const properties = input.row
        ? toNotionProperties(input.row)
        : {
            [NOTION_KEY_PROPERTY]: {
              title: [{ text: { content: input.title } }],
            },
          };

      if (input.pageId) {
        const page = await updatePage(
          args.readToken(),
          args.fetchImpl,
          input.pageId,
          properties,
        );
        return {
          id: page.id,
          url: page.url ?? notionUrlFor(page.id),
          outcome: "updated",
        };
      }

      const page = await createPage(
        args.readToken(),
        args.fetchImpl,
        input.parentId,
        properties,
      );
      return {
        id: page.id,
        url: page.url ?? notionUrlFor(page.id),
        outcome: "created",
      };
    },
  };
}
