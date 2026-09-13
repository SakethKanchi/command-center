/**
 * The model client the server actually runs with: one object, whose provider,
 * model and key are resolved from settings on every call.
 *
 * `createLlmClient` freezes its configuration in a closure, which is right for
 * a test or a script but wrong for a dashboard — changing the model there would
 * otherwise mean restarting the process, and the one thing a settings screen
 * must not do is ask you to restart the thing you are configuring.
 *
 * Resolution is cheap (a synchronous SQLite read) and the underlying clients are
 * cached per configuration, so a run that calls the model four times builds one
 * client and reads three settings rows, not four clients.
 */

import { badRequest } from "@server/infra/errors";
import {
  createLlmClient,
  type LlmClient,
  type LlmCompleteJsonInput,
} from "@server/llm";
import type { SettingsRepo } from "@server/repos";
import { type LlmRuntimeConfig, resolveLlmConfig } from "@server/settings";

export function createConfiguredLlmClient(
  settings: SettingsRepo,
  options: { fetchImpl?: typeof fetch } = {},
): LlmClient {
  const cache = new Map<string, LlmClient>();

  const clientFor = (config: LlmRuntimeConfig): LlmClient => {
    const key = `${config.baseUrl}::${config.model}::${config.apiKey}`;
    const existing = cache.get(key);
    if (existing) return existing;
    const client = createLlmClient({ ...config, fetchImpl: options.fetchImpl });
    cache.set(key, client);
    return client;
  };

  return {
    get model(): string {
      return resolveLlmConfig(settings).model;
    },

    // `async` so a missing key arrives as a rejected promise like every other
    // model failure, rather than throwing on the caller's synchronous path.
    async completeJson<T>(input: LlmCompleteJsonInput): Promise<T> {
      const config = resolveLlmConfig(settings);
      if (config.apiKey === "") {
        // Said in terms of the two places a key can come from, because the
        // person reading it has a Settings screen and may never have seen the
        // environment variable.
        throw badRequest(
          "No model API key is configured. Add one in Settings, or set LLM_API_KEY.",
        );
      }
      return clientFor(config).completeJson<T>(input);
    },
  };
}
