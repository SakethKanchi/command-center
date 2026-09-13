#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
/**
 * Interactive connector setup for the Command Center.
 *
 * One Google consent grants Sheets + Gmail-send + Gmail-read, so a single
 * browser round trip lights up two of the three external apps. Notion uses a
 * plain integration token and needs no callback server.
 *
 * Credentials are written straight into the `connectors` table in the shapes
 * the adapters validate, so no `.env` file ever holds a refresh token.
 *
 *   node scripts/connect.mjs google
 *   node scripts/connect.mjs notion
 *   node scripts/connect.mjs composio
 *   node scripts/connect.mjs status
 */
import { createServer } from "node:http";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { DatabaseSync } from "node:sqlite";

const CALLBACK_PORT = 4599;
const CALLBACK_PATH = "/oauth/callback";
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;

// Sheets write + Gmail send in one consent. No read scope is requested:
// this project never reads the mailbox, and asking for access we do not use
// is both a worse consent screen and a larger blast radius if the token leaks.
const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/userinfo.email",
];

function openDatabase() {
  const path = resolve(
    process.env.DATABASE_PATH ??
      `${process.env.DATA_DIR ?? "data"}/command-center.db`,
  );
  if (!existsSync(path)) {
    fail(`Database not found at ${path}.
Run: npm run migrate`);
  }
  return new DatabaseSync(path);
}

function fail(message) {
  console.error(`\n  ✗ ${message}\n`);
  process.exit(1);
}

function saveConnector(db, { provider, displayName, credentials, config }) {
  const now = new Date().toISOString();
  const existing = db
    .prepare("SELECT id FROM connectors WHERE provider = ? AND account_key = ?")
    .get(provider, "default");

  if (existing) {
    db.prepare(
      `UPDATE connectors
          SET display_name = ?, status = 'connected', credentials = ?, config = ?,
              last_connected_at = ?, last_error = NULL, updated_at = ?
        WHERE id = ?`,
    ).run(
      displayName,
      JSON.stringify(credentials),
      JSON.stringify(config),
      now,
      now,
      existing.id,
    );
    return existing.id;
  }

  const id = randomUUID();
  db.prepare(
    `INSERT INTO connectors
       (id, provider, account_key, display_name, status, credentials, config,
        last_connected_at, created_at, updated_at)
     VALUES (?, ?, 'default', ?, 'connected', ?, ?, ?, ?, ?)`,
  ).run(
    id,
    provider,
    displayName,
    JSON.stringify(credentials),
    JSON.stringify(config),
    now,
    now,
    now,
  );
  return id;
}

async function prompt(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(question);
    return answer.trim();
  } finally {
    rl.close();
  }
}

function tryOpenBrowser(url) {
  for (const cmd of ["xdg-open", "open"]) {
    try {
      const child = spawn(cmd, [url], { stdio: "ignore", detached: true });
      child.unref();
      return true;
    } catch {
      // try the next opener
    }
  }
  return false;
}

/** Single-shot local callback server that resolves with the OAuth code. */
function awaitOauthCode(expectedState) {
  return new Promise((resolvePromise, rejectPromise) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, `http://localhost:${CALLBACK_PORT}`);
      if (url.pathname !== CALLBACK_PATH) {
        res.writeHead(404).end("not found");
        return;
      }

      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const error = url.searchParams.get("error");

      const finish = (body) => {
        res.writeHead(200, { "Content-Type": "text/html" }).end(body);
        server.close();
      };

      if (error) {
        finish(`<h2>Authorization failed</h2><p>${error}</p>`);
        rejectPromise(new Error(`Google returned error: ${error}`));
        return;
      }
      if (state !== expectedState) {
        finish("<h2>State mismatch</h2><p>Restart the setup.</p>");
        rejectPromise(new Error("OAuth state mismatch — possible CSRF."));
        return;
      }
      if (!code) {
        finish("<h2>No code returned</h2>");
        rejectPromise(
          new Error("Google did not return an authorization code."),
        );
        return;
      }

      finish(
        "<h2>Connected.</h2><p>You can close this tab and return to the terminal.</p>",
      );
      resolvePromise(code);
    });

    server.on("error", rejectPromise);
    server.listen(CALLBACK_PORT, "127.0.0.1");
    setTimeout(
      () => {
        server.close();
        rejectPromise(new Error("Timed out waiting for the Google callback."));
      },
      5 * 60 * 1000,
    ).unref();
  });
}

async function exchangeCode({ clientId, clientSecret, code }) {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: REDIRECT_URI,
    }),
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(
      `Token exchange failed (${response.status}): ${body.error_description ?? body.error ?? "unknown"}`,
    );
  }
  if (!body.refresh_token) {
    throw new Error(
      "Google returned no refresh_token. Revoke prior access at " +
        "https://myaccount.google.com/permissions and retry — consent must be re-granted.",
    );
  }
  return body;
}

async function whoami(accessToken) {
  const response = await fetch(
    "https://www.googleapis.com/oauth2/v2/userinfo",
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!response.ok) return null;
  const body = await response.json();
  return body.email ?? null;
}

async function createSpreadsheet(accessToken) {
  const response = await fetch(
    "https://sheets.googleapis.com/v4/spreadsheets",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        properties: { title: "Job Search Command Center" },
        sheets: [
          { properties: { title: "Opportunities" } },
          { properties: { title: "Applications" } },
          { properties: { title: "Interviews" } },
          { properties: { title: "Follow-ups" } },
        ],
      }),
    },
  );
  const body = await response.json();
  if (!response.ok) {
    throw new Error(
      `Could not create the spreadsheet (${response.status}): ${body.error?.message ?? "unknown"}`,
    );
  }
  return { id: body.spreadsheetId, url: body.spreadsheetUrl };
}

async function connectGoogle() {
  console.log(`
  Google setup — grants Sheets + Gmail send in one consent.

  If you have not made an OAuth client yet:
    1. https://console.cloud.google.com/projectcreate  (any project name)
    2. APIs & Services > Library > enable "Google Sheets API" and "Gmail API"
    3. APIs & Services > OAuth consent screen > External > add yourself
       under "Test users"
    4. Credentials > Create credentials > OAuth client ID
         Application type: Web application
         Authorized redirect URI: ${REDIRECT_URI}
    5. Copy the client ID and client secret below.
`);

  const clientId = await prompt("  Google OAuth client ID: ");
  if (!clientId) fail("Client ID is required.");
  const clientSecret = await prompt("  Google OAuth client secret: ");
  if (!clientSecret) fail("Client secret is required.");

  const state = randomBytes(16).toString("hex");
  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", GOOGLE_SCOPES.join(" "));
  authUrl.searchParams.set("access_type", "offline");
  // Forces a refresh_token even when this client was consented before.
  authUrl.searchParams.set("prompt", "consent");
  authUrl.searchParams.set("state", state);

  const pending = awaitOauthCode(state);
  console.log(
    `\n  Opening your browser. If nothing happens, visit:\n\n  ${authUrl}\n`,
  );
  tryOpenBrowser(authUrl.toString());

  const code = await pending;
  const tokens = await exchangeCode({ clientId, clientSecret, code });
  const email = await whoami(tokens.access_token);
  if (!email) fail("Could not read the authorized account's email address.");
  console.log(`  Authorized as ${email}`);

  const credentials = {
    clientId,
    clientSecret,
    refreshToken: tokens.refresh_token,
    accessToken: tokens.access_token,
    accessTokenExpiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
  };

  const existingId = await prompt(
    "\n  Spreadsheet ID to use (blank = create a new one): ",
  );
  let spreadsheet;
  if (existingId) {
    spreadsheet = {
      id: existingId,
      url: `https://docs.google.com/spreadsheets/d/${existingId}`,
    };
  } else {
    spreadsheet = await createSpreadsheet(tokens.access_token);
    console.log(`  Created spreadsheet: ${spreadsheet.url}`);
  }

  const db = openDatabase();
  try {
    saveConnector(db, {
      provider: "google_sheets",
      displayName: `Sheets (${email})`,
      credentials,
      config: {
        spreadsheetId: spreadsheet.id,
        spreadsheetUrl: spreadsheet.url,
      },
    });
    saveConnector(db, {
      provider: "gmail_send",
      displayName: `Gmail (${email})`,
      credentials,
      config: { fromAddress: email },
    });
  } finally {
    db.close();
  }

  console.log(`
  ✓ google_sheets connected — ${spreadsheet.url}
  ✓ gmail_send    connected — sends as ${email}
`);
}

async function connectNotion() {
  console.log(`
  Notion setup.

    1. https://www.notion.so/my-integrations > New integration
    2. Copy the "Internal Integration Secret" (starts with ntn_ or secret_)
    3. Open the Notion page that should hold the command center,
       then ... > Connections > add your integration
    4. Copy that page's ID: the 32-hex chunk in its URL
`);

  const accessToken = await prompt("  Notion integration secret: ");
  if (!accessToken) fail("Integration secret is required.");
  const parentPageRaw = await prompt("  Notion parent page ID or URL: ");
  if (!parentPageRaw) fail("Parent page is required.");

  const match = parentPageRaw.replace(/-/g, "").match(/[0-9a-f]{32}/i);
  if (!match) {
    fail(`Could not find a 32-character page ID in "${parentPageRaw}".`);
  }
  const parentPageId = match[0];

  const probe = await fetch("https://api.notion.com/v1/users/me", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Notion-Version": "2022-06-28",
    },
  });
  const probeBody = await probe.json();
  if (!probe.ok) {
    fail(
      `Notion rejected the token (${probe.status}): ${probeBody.message ?? "unknown"}`,
    );
  }
  const botName = probeBody.name ?? "integration";

  const pageProbe = await fetch(
    `https://api.notion.com/v1/pages/${parentPageId}`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Notion-Version": "2022-06-28",
      },
    },
  );
  if (!pageProbe.ok) {
    const body = await pageProbe.json();
    fail(
      `The integration cannot see that page (${pageProbe.status}): ${body.message ?? "unknown"}.\n` +
        "    Open the page in Notion, then ... > Connections > add your integration.",
    );
  }

  const db = openDatabase();
  try {
    saveConnector(db, {
      provider: "notion",
      displayName: `Notion (${botName})`,
      credentials: { accessToken },
      config: { parentPageId },
    });
  } finally {
    db.close();
  }

  console.log(`
  ✓ notion connected — databases will be created under page ${parentPageId}
`);
}

function showStatus() {
  const db = openDatabase();
  try {
    const rows = db
      .prepare(
        `SELECT provider, account_key, display_name, status, config,
                last_connected_at, last_synced_at, last_error
         FROM connectors ORDER BY provider`,
      )
      .all();

    console.log("\n  Connectors\n  ----------");
    if (rows.length === 0) {
      console.log("  none configured yet\n");
      return;
    }
    for (const row of rows) {
      const mark = row.status === "connected" ? "✓" : "✗";
      console.log(`  ${mark} ${row.provider.padEnd(14)} ${row.status}`);
      if (row.display_name) console.log(`      ${row.display_name}`);
      const config = row.config ? JSON.parse(row.config) : {};
      if (config.spreadsheetUrl) console.log(`      ${config.spreadsheetUrl}`);
      if (config.parentPageId) console.log(`      page ${config.parentPageId}`);
      if (config.fromAddress) console.log(`      from ${config.fromAddress}`);
      if (row.last_synced_at) {
        console.log(`      last sync ${row.last_synced_at}`);
      }
      if (row.last_error) console.log(`      error: ${row.last_error}`);
    }
    console.log();
  } finally {
    db.close();
  }
}

const COMPOSIO_BASE_URL = "https://backend.composio.dev/api/v3.1";
const COMPOSIO_DASHBOARD_URL = "https://platform.composio.dev";

/**
 * Never print a whole key, even one the user believes is broken: terminals get
 * pasted into issues and shared on a projector. Head and tail are enough to
 * tell two keys apart, and the length is the actual diagnostic — a full
 * Composio key is far longer than the ~23 characters a masked copy yields.
 */
function maskKey(key) {
  if (key.length <= 12) return `${key.slice(0, 3)}…${key.slice(-2)}`;
  return `${key.slice(0, 5)}…${key.slice(-4)}`;
}

function truncationAdvice(key) {
  return `  The dashboard displays keys masked, so a copy taken from the key list
  rather than the reveal/copy control is the usual cause. ${key.length} characters
  is short for a Composio key.

  Get a full one:
    1. ${COMPOSIO_DASHBOARD_URL}
    2. Settings > API Keys
    3. Copy the FULL key (use the copy button — do not retype what is shown)
    4. Put it in .env as COMPOSIO_API_KEY=... and re-run: npm run connect composio`;
}

/**
 * Key doctor. Connecting an app through Composio fails with a 401 the UI can
 * only report second-hand, so this asks Composio directly and prints its own
 * wording — a rejected key and an unreachable network are different problems
 * and must not be reported as the same one.
 *
 * Exits non-zero for anything except a key Composio accepts, so it works as a
 * pre-flight check.
 */
async function checkComposio() {
  // Same source the server reads, and the real environment still wins over the
  // file, so this diagnoses the key the app would actually use.
  if (existsSync(".env")) process.loadEnvFile(".env");

  const raw = process.env.COMPOSIO_API_KEY ?? "";
  const key = raw.trim();

  console.log("\n  Composio key check\n  ------------------");
  if (!key) {
    console.log(`  COMPOSIO_API_KEY  not set${raw ? " (whitespace only)" : ""}

  Composio is the no-Google-Cloud path: one hosted consent per app instead of
  an OAuth client of your own. Without a key, connect each app directly
  (npm run connect google, npm run connect notion).

  To use Composio instead:
    1. ${COMPOSIO_DASHBOARD_URL}
    2. Settings > API Keys > create a key
    3. Copy the FULL key into .env as COMPOSIO_API_KEY=...
    4. Re-run: npm run connect composio
`);
    process.exit(1);
  }

  console.log(`  COMPOSIO_API_KEY  set
  masked            ${maskKey(key)}
  length            ${key.length} characters${key === raw ? "" : " (trimmed)"}
  endpoint          GET ${COMPOSIO_BASE_URL}/toolkits?limit=1
`);

  let response;
  try {
    response = await fetch(`${COMPOSIO_BASE_URL}/toolkits?limit=1`, {
      headers: { "x-api-key": key },
    });
  } catch (cause) {
    // A DNS failure or an offline laptop says nothing about the key, and
    // calling it invalid here would send the user to regenerate a good one.
    console.log(`  ✗ Could not reach Composio: ${cause instanceof Error ? cause.message : String(cause)}

  This is a network problem, not a verdict on your key — the key was neither
  accepted nor rejected. Check your connection or a proxy, then re-run:
  npm run connect composio
`);
    process.exit(1);
  }

  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }

  if (response.ok) {
    const count = Array.isArray(body?.items) ? body.items.length : null;
    const scale = count === null ? "" : `, ${count} toolkit returned`;
    console.log(`  ✓ Composio accepted this key (HTTP ${response.status}${scale}).

  Next: start the app (npm run dev), open http://localhost:5173/apps and press
  Connect on a card that reports Composio as its transport. Consent happens on
  the provider's own screen; the card turns green by itself.

  Direct credentials still win where they exist, so an app connected with
  npm run connect google keeps using its own OAuth token.
`);
    return;
  }

  // Composio's own wording, verbatim: a paraphrase of someone else's auth
  // error is how a user ends up debugging the wrong thing.
  const said = body?.error?.message ?? text.trim();
  const fix = body?.error?.suggested_fix ?? null;
  const slug = body?.error?.slug ?? body?.error?.code ?? null;
  const quoted = [said || "(no message returned)", fix]
    .filter(Boolean)
    .map((line) => `    ${line}`)
    .join("\n");

  if (response.status === 401 || response.status === 403) {
    const tag = slug ? `, ${slug}` : "";
    console.log(`  ✗ Composio rejected this key (HTTP ${response.status}${tag}).

  Composio says:
${quoted}

${truncationAdvice(key)}
`);
    process.exit(1);
  }

  const tag = slug ? ` (${slug})` : "";
  console.log(`  ✗ Composio answered HTTP ${response.status}${tag}.

  Composio says:
${quoted}

  Not an authentication failure, so the key itself was not rejected. If this
  persists, check https://status.composio.dev and re-run: npm run connect composio
`);
  process.exit(1);
}

const commands = {
  google: connectGoogle,
  notion: connectNotion,
  composio: checkComposio,
  status: async () => showStatus(),
};

const command = process.argv[2];
if (!command || !(command in commands)) {
  console.error(`
  Usage: node scripts/connect.mjs <google|notion|composio|status>

    google   Google OAuth -> google_sheets + gmail_send connectors
    notion   Notion integration token -> notion connector
    composio Check COMPOSIO_API_KEY against Composio and explain a rejection
    status   Show configured connectors
`);
  process.exit(1);
}

commands[command]().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
