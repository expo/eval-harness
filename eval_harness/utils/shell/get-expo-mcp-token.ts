#!/usr/bin/env bun
/**
 * One-time interactive bootstrap for headless Expo MCP (mcp.expo.dev) auth.
 *
 * mcp.expo.dev requires real OAuth -- it rejects EXPO_TOKEN / robot-user
 * tokens outright, and offers no service-account grant. This completes a
 * real browser login via OAuth 2.0 Dynamic Client Registration + Authorization
 * Code + PKCE, then prints the client_id and refresh_token to push as EAS
 * secrets (EXPO_MCP_CLIENT_ID, EXPO_MCP_REFRESH_TOKEN). From there,
 * eval::refresh_expo_mcp_token (eval_harness/utils/shell/agents.sh) refreshes
 * the access token every authoring run and rewrites EXPO_MCP_REFRESH_TOKEN
 * itself via `eas env:update` -- refresh tokens for this server rotate on
 * every use, so re-running this script should only be needed if that chain
 * is ever broken (e.g. the token is revoked, or a run's `eas env:update`
 * call fails after the old refresh_token was already consumed).
 *
 * Adapted from a script shared by the Expo team
 * (https://gist.github.com/Kudo/d13ee741dca041dd6578c1f667880c2f), with one
 * deliberate change: this registers the OAuth client with
 * `grant_types: ["authorization_code", "refresh_token"]` (the original only
 * requested `authorization_code`) -- requesting `refresh_token` explicitly is
 * what causes the server to actually issue one, which the harness's
 * self-refresh loop depends on.
 *
 * Usage: bun eval_harness/utils/shell/get-expo-mcp-token.ts
 */

const BASE_URL = 'https://mcp.expo.dev';
const MCP_RESOURCE = `${BASE_URL}/mcp`;
const FLOW_TIMEOUT_MS = 5 * 60 * 1000;

interface AuthServerMetadata {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
}

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
}

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

function randomToken(byteLength = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${init?.method ?? 'GET'} ${url} failed with ${response.status}: ${body}`);
  }
  return (await response.json()) as T;
}

async function discoverMetadata(): Promise<{ authServer: AuthServerMetadata; scope: string }> {
  const resourceMetadata = await fetchJson<{ authorization_servers: string[]; scopes_supported?: string[] }>(
    `${BASE_URL}/.well-known/oauth-protected-resource`
  );
  const authServerUrl = resourceMetadata.authorization_servers[0].replace(/\/$/, '');
  const authServer = await fetchJson<AuthServerMetadata>(
    `${authServerUrl}/.well-known/oauth-authorization-server`
  );
  const scope = resourceMetadata.scopes_supported?.join(' ') ?? 'mcp:access';
  return { authServer, scope };
}

async function registerClient(
  registrationEndpoint: string,
  redirectUri: string,
  scope: string
): Promise<string> {
  const registration = await fetchJson<{ client_id: string }>(registrationEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'eval-experiments get-expo-mcp-token bootstrap',
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: 'none',
      // Explicitly requesting refresh_token here (not just authorization_code)
      // is what makes the server actually issue one -- see file header.
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope,
    }),
  });
  return registration.client_id;
}

function waitForCallback(expectedState: string): {
  port: number;
  authorizationCode: Promise<string>;
  stop: () => void;
} {
  let resolveCode: (code: string) => void;
  let rejectCode: (error: Error) => void;
  const authorizationCode = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname !== '/callback') {
        return new Response('Not found', { status: 404 });
      }
      const error = url.searchParams.get('error');
      if (error) {
        const description = url.searchParams.get('error_description') ?? '';
        rejectCode(new Error(`Authorization failed: ${error} ${description}`.trim()));
        return new Response('Authorization failed. You can close this tab.', { status: 400 });
      }
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      if (!code || state !== expectedState) {
        rejectCode(new Error('Callback missing code or state mismatch'));
        return new Response('Invalid callback. You can close this tab.', { status: 400 });
      }
      resolveCode(code);
      return new Response(
        '<html><body><h3>Authentication complete.</h3><p>You can close this tab and return to the terminal.</p></body></html>',
        { headers: { 'Content-Type': 'text/html' } }
      );
    },
  });

  return { port: server.port, authorizationCode, stop: () => server.stop(true) };
}

async function exchangeCodeForToken(
  tokenEndpoint: string,
  params: { code: string; clientId: string; redirectUri: string; codeVerifier: string }
): Promise<TokenResponse> {
  return await fetchJson<TokenResponse>(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: params.code,
      redirect_uri: params.redirectUri,
      client_id: params.clientId,
      code_verifier: params.codeVerifier,
      resource: MCP_RESOURCE,
    }),
  });
}

async function verifyToken(accessToken: string): Promise<void> {
  const response = await fetch(MCP_RESOURCE, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'get-expo-mcp-token', version: '1.0.0' },
      },
    }),
  });
  if (!response.ok) {
    throw new Error(`Token verification against MCP server failed with ${response.status}`);
  }
}

async function main() {
  console.error('Discovering OAuth metadata...');
  const { authServer, scope } = await discoverMetadata();

  const state = randomToken();
  const codeVerifier = randomToken(48);
  const codeChallenge = base64url(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier)))
  );

  const { port, authorizationCode, stop } = waitForCallback(state);
  const redirectUri = `http://localhost:${port}/callback`;

  try {
    console.error('Registering OAuth client (DCR)...');
    const clientId = await registerClient(authServer.registration_endpoint, redirectUri, scope);

    const authorizeUrl = new URL(authServer.authorization_endpoint);
    authorizeUrl.search = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      scope,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      resource: MCP_RESOURCE,
    }).toString();

    console.error(`Opening browser for authorization. If it does not open, visit:\n${authorizeUrl}\n`);
    Bun.spawn(['open', authorizeUrl.toString()]);

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const code = await Promise.race([
      authorizationCode,
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error('Timed out waiting for authorization')), FLOW_TIMEOUT_MS);
      }),
    ]).finally(() => clearTimeout(timeoutId));

    console.error('Exchanging authorization code for token...');
    const token = await exchangeCodeForToken(authServer.token_endpoint, {
      code,
      clientId,
      redirectUri,
      codeVerifier,
    });

    console.error('Verifying token against MCP server...');
    await verifyToken(token.access_token);

    if (!token.refresh_token) {
      console.error(
        '\nWarning: no refresh_token was returned. The harness self-refresh loop needs one -- ' +
          'double-check the DCR request above still includes "refresh_token" in grant_types.'
      );
    }

    console.error('\nSuccess. Push these as EAS secrets (production environment):\n');
    console.log(`EXPO_MCP_CLIENT_ID=${clientId}`);
    console.log(`EXPO_MCP_REFRESH_TOKEN=${token.refresh_token ?? '(none returned -- see warning above)'}`);
    console.error(`\n(access_token itself is not needed -- it expires in ${token.expires_in ?? '?'}s and the harness mints its own each run)`);
    console.error('\nExample push commands (adjust for whether these vars already exist -- env:create vs env:update):');
    console.error('  eas env:create production --name EXPO_MCP_CLIENT_ID --value "<value above>" --type string --visibility plaintext --non-interactive');
    console.error('  eas env:create production --name EXPO_MCP_REFRESH_TOKEN --value "<value above>" --type string --visibility secret --non-interactive');
  } finally {
    stop();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
