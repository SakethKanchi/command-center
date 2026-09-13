import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Connector,
  ConnectorAdapterContext,
  ConnectorCredentials,
  OutboundEmailRequest,
} from "@domain";
import type { Mock } from "vitest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { gmailSendAdapter } from "./index";

type Lane = "token" | "profile" | "send" | "revoke";
type StubCall = { lane: Lane; url: string; init: RequestInit };

type StubResponseInit = {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
};

function stubResponse(init: StubResponseInit = {}): Response {
  const status = init.status ?? 200;
  const headers = init.headers ?? {};
  const bodyText =
    typeof init.body === "string"
      ? init.body
      : init.body === undefined
        ? ""
        : JSON.stringify(init.body);

  const fake = {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name: string) =>
        headers[name] ?? headers[name.toLowerCase()] ?? null,
    },
    text: async () => bodyText,
  };
  // Stub seam: the adapter only reads ok/status/headers.get/text().
  return fake as unknown as Response;
}

function laneFor(url: string): Lane {
  if (url.includes("oauth2.googleapis.com/revoke")) return "revoke";
  if (url.includes("oauth2.googleapis.com/token")) return "token";
  if (url.includes("/users/me/profile")) return "profile";
  if (url.includes("/messages/send")) return "send";
  throw new Error(`Test stub received an unexpected URL: ${url}`);
}

type Harness = {
  ctx: ConnectorAdapterContext;
  calls: StubCall[];
  refreshed: ConnectorCredentials[];
  fetchImpl: Mock;
  callsFor: (lane: Lane) => StubCall[];
};

function createHarness(
  scenario: Partial<Record<Lane, Response[]>>,
  overrides: { connector?: Partial<Connector> } = {},
): Harness {
  const queues: Record<Lane, Response[]> = {
    token: [...(scenario.token ?? [])],
    profile: [...(scenario.profile ?? [])],
    send: [...(scenario.send ?? [])],
    revoke: [...(scenario.revoke ?? [])],
  };
  const calls: StubCall[] = [];
  const refreshed: ConnectorCredentials[] = [];

  const fetchImpl = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const lane = laneFor(url);
    calls.push({ lane, url, init: init ?? {} });
    const next = queues[lane].shift();
    if (!next) {
      throw new Error(`Test stub has no queued ${lane} response for ${url}`);
    }
    return next;
  });

  const connector: Connector = {
    id: "connector-gmail-send",
    provider: "gmail_send",
    accountKey: "me@example.com",
    displayName: "Gmail send",
    status: "connected",
    credentials: {
      clientId: "client-id",
      clientSecret: "client-secret",
      refreshToken: "refresh-token",
    },
    config: { fromAddress: "me@example.com", displayName: "Saketh Kanchi" },
    lastConnectedAt: null,
    lastSyncedAt: "2025-09-04T15:33:20.000Z",
    lastError: null,
    createdAt: "2026-09-13T00:00:00.000Z",
    updatedAt: "2026-09-13T00:00:00.000Z",
    ...overrides.connector,
  };

  return {
    ctx: {
      connector,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      onCredentialsRefreshed: (credentials) => refreshed.push(credentials),
    },
    calls,
    refreshed,
    fetchImpl,
    callsFor: (lane) => calls.filter((call) => call.lane === lane),
  };
}

const tokenOk = () =>
  stubResponse({ body: { access_token: "access-token", expires_in: 3600 } });
const profileOk = (emailAddress = "me@example.com") =>
  stubResponse({ body: { emailAddress } });
const sendOk = (id = "msg-1", threadId = "thread-1") =>
  stubResponse({ body: { id, threadId } });

function baseRequest(
  overrides: Partial<OutboundEmailRequest> = {},
): OutboundEmailRequest {
  return {
    to: "recruiter@corp.example",
    subject: "Following up on the Staff Engineer role",
    body: "Hi there,\nThanks for the update.",
    ...overrides,
  };
}

function decodeRaw(call: StubCall | undefined): string {
  if (!call) throw new Error("expected a recorded Gmail call");
  const payload = JSON.parse(String(call.init.body)) as { raw: string };
  return Buffer.from(payload.raw, "base64url").toString("utf8");
}

function headerBlock(raw: string): string {
  return raw.split("\r\n\r\n")[0] ?? "";
}

function decodeEncodedWords(headerValue: string): string {
  const words = headerValue.match(/=\?UTF-8\?B\?([^?]*)\?=/g) ?? [];
  return words
    .map((word) => {
      const payload = /=\?UTF-8\?B\?([^?]*)\?=/.exec(word)?.[1] ?? "";
      return Buffer.from(payload, "base64");
    })
    .reduce((all, chunk) => Buffer.concat([all, chunk]), Buffer.alloc(0))
    .toString("utf8");
}

let fixtureDir = "";
let resumePath = "";
const resumeBytes = Buffer.from(
  Array.from({ length: 200 }, (_, index) => (index * 37) % 256),
);

beforeAll(async () => {
  fixtureDir = await mkdtemp(join(tmpdir(), "gmail-send-test-"));
  resumePath = join(fixtureDir, "resume.pdf");
  await writeFile(resumePath, resumeBytes);
});

afterAll(async () => {
  await rm(fixtureDir, { recursive: true, force: true });
});

describe("gmailSendAdapter.send", () => {
  it("sends a single-part text/plain message with RFC 2822 headers", async () => {
    const harness = createHarness({
      token: [tokenOk()],
      send: [sendOk("msg-42", "thread-9")],
    });

    const result = await gmailSendAdapter.send(harness.ctx, baseRequest());

    expect(harness.callsFor("send")).toHaveLength(1);
    const raw = decodeRaw(harness.callsFor("send")[0]);

    expect(raw).toContain('From: "Saketh Kanchi" <me@example.com>\r\n');
    expect(raw).toContain("To: recruiter@corp.example\r\n");
    expect(raw).toContain(
      "Subject: Following up on the Staff Engineer role\r\n",
    );
    expect(raw).toContain("MIME-Version: 1.0\r\n");
    expect(raw).toContain('Content-Type: text/plain; charset="UTF-8"\r\n');
    expect(raw).not.toContain("multipart/mixed");
    expect(headerBlock(raw)).toMatch(
      /^Date: \w{3}, \d{2} \w{3} \d{4} \d{2}:\d{2}:\d{2} \+0000$/m,
    );
    expect(raw.split("\r\n\r\n").slice(1).join("\r\n\r\n")).toBe(
      "Hi there,\r\nThanks for the update.",
    );

    expect(result).toMatchObject({
      messageId: "msg-42",
      threadId: "thread-9",
      to: "recruiter@corp.example",
      subject: "Following up on the Staff Engineer role",
      webUrl: "https://mail.google.com/mail/u/0/#all/msg-42",
    });
    expect(result.sentAt).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
  });

  it("builds multipart/mixed with a base64 attachment and a non-colliding boundary", async () => {
    const harness = createHarness({ token: [tokenOk()], send: [sendOk()] });

    await gmailSendAdapter.send(
      harness.ctx,
      baseRequest({
        attachments: [
          {
            filename: "resume.pdf",
            mimeType: "application/pdf",
            path: resumePath,
          },
        ],
      }),
    );

    const raw = decodeRaw(harness.callsFor("send")[0]);
    const boundary = /boundary="([^"]+)"/.exec(raw)?.[1];
    expect(boundary).toBeTruthy();
    if (!boundary) throw new Error("no boundary");

    expect(raw).toContain(
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
    );
    expect(raw.endsWith(`--${boundary}--\r\n`)).toBe(true);

    const segments = raw.split(`--${boundary}`);
    // [preamble+headers, text part, attachment part, "--\r\n"]
    expect(segments).toHaveLength(4);

    const textPart = segments[1];
    expect(textPart).toContain('Content-Type: text/plain; charset="UTF-8"');
    expect(textPart).toContain("Hi there,\r\nThanks for the update.");

    const attachmentPart = segments[2];
    expect(attachmentPart).toContain("Content-Type: application/pdf");
    expect(attachmentPart).toContain(
      'Content-Disposition: attachment; filename="resume.pdf"',
    );
    expect(attachmentPart).toContain("Content-Transfer-Encoding: base64");

    const payload =
      (attachmentPart ?? "").split("\r\n\r\n")[1]?.trimEnd() ?? "";
    expect(payload.replace(/\r\n/g, "")).toBe(resumeBytes.toString("base64"));
    for (const line of payload.split("\r\n")) {
      expect(line.length).toBeLessThanOrEqual(76);
    }

    for (const segment of segments.slice(1, 3)) {
      const content = segment.split("\r\n\r\n").slice(1).join("\r\n\r\n");
      expect(content).not.toContain(boundary);
    }
  });

  it("RFC 2047 encodes a non-ASCII subject so it decodes back unchanged", async () => {
    const harness = createHarness({ token: [tokenOk()], send: [sendOk()] });
    const subject = "Grüße vom Bewerbungs-Agenten ✉";

    await gmailSendAdapter.send(harness.ctx, baseRequest({ subject }));

    const raw = decodeRaw(harness.callsFor("send")[0]);
    const subjectLine = /^Subject: (.*)$/m.exec(headerBlock(raw))?.[1] ?? "";

    expect(subjectLine).toContain("=?UTF-8?B?");
    expect(subjectLine).not.toContain("Grüße");
    expect(decodeEncodedWords(subjectLine)).toBe(subject);
  });

  it("folds a long non-ASCII subject into encoded words under 76 chars each", async () => {
    const harness = createHarness({ token: [tokenOk()], send: [sendOk()] });
    const subject = `Rückmeldung zur Bewerbung ✉ ${"ü".repeat(80)}`;

    await gmailSendAdapter.send(harness.ctx, baseRequest({ subject }));

    const raw = decodeRaw(harness.callsFor("send")[0]);
    const block = headerBlock(raw);
    const folded =
      /^Subject: ((?:.*\r\n )*.*)$/m.exec(block)?.[1] ??
      (() => {
        throw new Error("no subject header");
      })();

    const words = folded.match(/=\?UTF-8\?B\?[^?]*\?=/g) ?? [];
    expect(words.length).toBeGreaterThan(1);
    for (const word of words) {
      expect(word.length).toBeLessThanOrEqual(75);
    }
    expect(decodeEncodedWords(folded)).toBe(subject);
  });

  it("threads a reply: In-Reply-To, References, and threadId on the request", async () => {
    const harness = createHarness({ token: [tokenOk()], send: [sendOk()] });

    await gmailSendAdapter.send(
      harness.ctx,
      baseRequest({
        threadId: "thread-77",
        inReplyToMessageId: "CABc123@mail.gmail.com",
      }),
    );

    const call = harness.callsFor("send")[0];
    const raw = decodeRaw(call);

    expect(raw).toContain("In-Reply-To: <CABc123@mail.gmail.com>\r\n");
    expect(raw).toContain("References: <CABc123@mail.gmail.com>\r\n");
    expect(JSON.parse(String(call?.init.body))).toMatchObject({
      threadId: "thread-77",
    });
  });

  it("omits threading headers and threadId for a fresh message", async () => {
    const harness = createHarness({ token: [tokenOk()], send: [sendOk()] });

    await gmailSendAdapter.send(harness.ctx, baseRequest());

    const call = harness.callsFor("send")[0];
    expect(decodeRaw(call)).not.toContain("In-Reply-To");
    expect(JSON.parse(String(call?.init.body))).not.toHaveProperty("threadId");
  });

  it("rejects CRLF in the recipient and in the subject", async () => {
    const injectedTo = createHarness({});
    await expect(
      gmailSendAdapter.send(
        injectedTo.ctx,
        baseRequest({
          to: "recruiter@corp.example\r\nBcc: attacker@evil.test",
        }),
      ),
    ).rejects.toMatchObject({ status: 400, code: "INVALID_REQUEST" });
    expect(injectedTo.fetchImpl).not.toHaveBeenCalled();

    const injectedSubject = createHarness({});
    await expect(
      gmailSendAdapter.send(
        injectedSubject.ctx,
        baseRequest({ subject: "Hello\r\nX-Injected: yes" }),
      ),
    ).rejects.toMatchObject({ status: 400, code: "INVALID_REQUEST" });
    expect(injectedSubject.fetchImpl).not.toHaveBeenCalled();
  });

  it("strips CRLF and quotes out of an attachment filename", async () => {
    const harness = createHarness({ token: [tokenOk()], send: [sendOk()] });

    await gmailSendAdapter.send(
      harness.ctx,
      baseRequest({
        attachments: [
          {
            filename: 'resume"\r\nX-Injected: yes.pdf',
            mimeType: "application/pdf",
            path: resumePath,
          },
        ],
      }),
    );

    const raw = decodeRaw(harness.callsFor("send")[0]);
    expect(raw).toContain(
      'Content-Disposition: attachment; filename="resumeX-Injected: yes.pdf"',
    );
    expect(raw).not.toContain("\r\nX-Injected:");
  });
});

describe("gmailSendAdapter.connect", () => {
  it("refuses to send as an address the mailbox does not own", async () => {
    const harness = createHarness({
      token: [tokenOk()],
      profile: [profileOk("someone.else@example.com")],
    });

    await expect(gmailSendAdapter.connect(harness.ctx)).rejects.toMatchObject({
      status: 400,
      code: "INVALID_REQUEST",
      message: expect.stringContaining("someone.else@example.com"),
    });
  });

  it("accepts a case-insensitive match and reports the mailbox as the target", async () => {
    const harness = createHarness(
      { token: [tokenOk()], profile: [profileOk("me@example.com")] },
      {
        connector: {
          config: { fromAddress: "Me@Example.COM", displayName: "Saketh" },
        },
      },
    );

    const health = await gmailSendAdapter.connect(harness.ctx);

    expect(health).toMatchObject({
      provider: "gmail_send",
      connected: true,
      status: "connected",
      target: "me@example.com",
      destinationUrl: "https://mail.google.com/mail/u/0/#sent",
      lastError: null,
    });
  });

  it("hands a refreshed access token back to the service layer", async () => {
    const harness = createHarness({
      token: [
        stubResponse({
          body: { access_token: "fresh-token", expires_in: 1800 },
        }),
      ],
      profile: [profileOk()],
    });

    await gmailSendAdapter.connect(harness.ctx);

    expect(harness.refreshed).toHaveLength(1);
    expect(harness.refreshed[0]).toMatchObject({
      accessToken: "fresh-token",
      refreshToken: "refresh-token",
    });
    expect(Number(harness.refreshed[0]?.accessTokenExpiresAt)).toBeGreaterThan(
      Date.now(),
    );
  });

  it("reuses a still-valid access token instead of refreshing", async () => {
    const harness = createHarness(
      { profile: [profileOk()] },
      {
        connector: {
          credentials: {
            clientId: "client-id",
            clientSecret: "client-secret",
            refreshToken: "refresh-token",
            accessToken: "cached-token",
            accessTokenExpiresAt: Date.now() + 600_000,
          },
        },
      },
    );

    await gmailSendAdapter.connect(harness.ctx);

    expect(harness.callsFor("token")).toHaveLength(0);
    expect(harness.refreshed).toHaveLength(0);
    expect(harness.callsFor("profile")[0]?.init.headers).toMatchObject({
      Authorization: "Bearer cached-token",
    });
  });
});

describe("gmailSendAdapter reliability", () => {
  it("retries a 429 once and then succeeds", async () => {
    const harness = createHarness({
      token: [tokenOk()],
      send: [
        stubResponse({
          status: 429,
          headers: { "Retry-After": "0" },
          body: { error: { message: "Rate limit exceeded" } },
        }),
        sendOk("msg-retry", "thread-retry"),
      ],
    });

    const result = await gmailSendAdapter.send(harness.ctx, baseRequest());

    expect(harness.callsFor("send")).toHaveLength(2);
    expect(result.messageId).toBe("msg-retry");
  });

  it("never re-sends after a 400", async () => {
    const harness = createHarness({
      token: [tokenOk()],
      send: [
        stubResponse({
          status: 400,
          body: { error: { message: "Invalid to header" } },
        }),
      ],
    });

    await expect(
      gmailSendAdapter.send(harness.ctx, baseRequest()),
    ).rejects.toMatchObject({ status: 400, code: "INVALID_REQUEST" });
    expect(harness.callsFor("send")).toHaveLength(1);
  });

  it("rejects a missing attachment path without issuing a send", async () => {
    const harness = createHarness({ token: [tokenOk()], send: [sendOk()] });
    const missing = join(fixtureDir, "does-not-exist.pdf");

    await expect(
      gmailSendAdapter.send(
        harness.ctx,
        baseRequest({
          attachments: [
            {
              filename: "missing.pdf",
              mimeType: "application/pdf",
              path: missing,
            },
          ],
        }),
      ),
    ).rejects.toMatchObject({
      status: 400,
      code: "INVALID_REQUEST",
      message: expect.stringContaining(missing),
    });
    expect(harness.fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects attachments over Gmail's 25MB cap before reading them", async () => {
    const bigA = join(fixtureDir, "big-a.bin");
    const bigB = join(fixtureDir, "big-b.bin");
    await writeFile(bigA, "");
    await writeFile(bigB, "");
    await truncate(bigA, 13 * 1024 * 1024);
    await truncate(bigB, 13 * 1024 * 1024);

    const harness = createHarness({ token: [tokenOk()], send: [sendOk()] });

    await expect(
      gmailSendAdapter.send(
        harness.ctx,
        baseRequest({
          attachments: [
            {
              filename: "a.bin",
              mimeType: "application/octet-stream",
              path: bigA,
            },
            {
              filename: "b.bin",
              mimeType: "application/octet-stream",
              path: bigB,
            },
          ],
        }),
      ),
    ).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining("over the 26214400 byte limit"),
    });
    expect(harness.fetchImpl).not.toHaveBeenCalled();
  });

  it("reports an auth failure through status instead of throwing", async () => {
    const harness = createHarness({
      token: [
        stubResponse({
          status: 400,
          body: { error: "invalid_grant", error_description: "Token revoked" },
        }),
      ],
    });

    const health = await gmailSendAdapter.status(harness.ctx);

    expect(health).toMatchObject({
      provider: "gmail_send",
      connected: false,
      status: "error",
      target: "me@example.com",
    });
    expect(health.lastError).toContain("Token revoked");
  });

  it("treats an already-revoked token as a successful disconnect", async () => {
    const harness = createHarness({
      revoke: [stubResponse({ status: 400, body: { error: "invalid_token" } })],
    });

    const health = await gmailSendAdapter.disconnect(harness.ctx);

    expect(harness.callsFor("revoke")).toHaveLength(1);
    expect(harness.callsFor("revoke")[0]?.url).toContain("token=refresh-token");
    expect(health).toMatchObject({
      provider: "gmail_send",
      connected: false,
      status: "disconnected",
      destinationUrl: null,
      lastError: null,
    });
  });
});
