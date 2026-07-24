/**
 * Minimal OAuth 2.1 authorization server for the rofe.ai MCP connector.
 * rofe.ai is its own auth server (same origin). Implements exactly what a
 * Claude custom connector needs: RFC 9728 protected-resource metadata,
 * RFC 8414 AS metadata, RFC 7591 dynamic client registration, and an
 * authorization-code + PKCE(S256) flow. State persisted in Postgres so
 * tokens survive app redeploys.
 *
 * v1 consent (`/authorize`): a single access-key gate (admin_config
 * mcp_api_token). Stage 2 swaps this for real rofe.ai user login so each
 * external creator gets their own scoped token.
 */
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { getPool } from '@/lib/db';

export const ISSUER = 'https://rofe.ai';
export const RESOURCE = 'https://rofe.ai/api/mcp';
export const SCOPE = 'mcp:tools';
const CODE_TTL_MS = 10 * 60 * 1000;          // 10 min auth code
const ACCESS_TTL_S = 3600;                    // 1h access token
const REFRESH_TTL_MS = 30 * 24 * 3600 * 1000; // 30d refresh token

let tablesReady = false;
async function ensureTables(): Promise<void> {
  if (tablesReady) return;
  const pool = await getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mcp_oauth_clients (
      client_id TEXT PRIMARY KEY,
      client_secret TEXT,
      redirect_uris TEXT[] NOT NULL,
      client_name TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS mcp_oauth_codes (
      code TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      redirect_uri TEXT NOT NULL,
      code_challenge TEXT,
      scope TEXT,
      resource TEXT,
      expires_at TIMESTAMPTZ NOT NULL
    );
    CREATE TABLE IF NOT EXISTS mcp_oauth_tokens (
      access_token TEXT PRIMARY KEY,
      refresh_token TEXT UNIQUE,
      client_id TEXT,
      scope TEXT,
      resource TEXT,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  tablesReady = true;
}

const rand = (n = 32) => randomBytes(n).toString('base64url');

// ── metadata documents ────────────────────────────────────────────────────
export function protectedResourceMetadata() {
  return { resource: RESOURCE, authorization_servers: [ISSUER], scopes_supported: [SCOPE], bearer_methods_supported: ['header'] };
}
export function authorizationServerMetadata() {
  return {
    issuer: ISSUER,
    authorization_endpoint: `${ISSUER}/api/oauth/authorize`,
    token_endpoint: `${ISSUER}/api/oauth/token`,
    registration_endpoint: `${ISSUER}/api/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    scopes_supported: [SCOPE],
  };
}

// ── dynamic client registration (RFC 7591) ────────────────────────────────
export async function registerClient(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  await ensureTables();
  const redirect_uris = Array.isArray(body.redirect_uris) ? (body.redirect_uris as string[]).filter(u => typeof u === 'string') : [];
  if (redirect_uris.length === 0) throw new Error('redirect_uris required');
  const client_id = `mcp_${rand(16)}`;
  const client_secret = rand(24);
  const pool = await getPool();
  await pool.query(
    `INSERT INTO mcp_oauth_clients (client_id, client_secret, redirect_uris, client_name) VALUES ($1,$2,$3,$4)`,
    [client_id, client_secret, redirect_uris, String(body.client_name ?? 'client')],
  );
  return {
    client_id, client_secret,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    redirect_uris,
    client_name: body.client_name ?? 'client',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: (body.token_endpoint_auth_method as string) || 'none',
  };
}

export async function getClient(client_id: string): Promise<{ client_id: string; client_secret: string | null; redirect_uris: string[] } | null> {
  await ensureTables();
  const pool = await getPool();
  const r = await pool.query<{ client_id: string; client_secret: string | null; redirect_uris: string[] }>(
    `SELECT client_id, client_secret, redirect_uris FROM mcp_oauth_clients WHERE client_id = $1`, [client_id],
  );
  return r.rows[0] ?? null;
}

// ── authorization code ────────────────────────────────────────────────────
export async function issueCode(p: { client_id: string; redirect_uri: string; code_challenge: string; scope: string; resource: string }): Promise<string> {
  await ensureTables();
  const code = rand(24);
  const pool = await getPool();
  await pool.query(
    `INSERT INTO mcp_oauth_codes (code, client_id, redirect_uri, code_challenge, scope, resource, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6, NOW() + ($7||' milliseconds')::interval)`,
    [code, p.client_id, p.redirect_uri, p.code_challenge, p.scope, p.resource, String(CODE_TTL_MS)],
  );
  return code;
}

/** Exchange an auth code for tokens; verifies PKCE + redirect_uri. Single-use. */
export async function exchangeCode(code: string, redirect_uri: string, code_verifier: string): Promise<Tokens> {
  await ensureTables();
  const pool = await getPool();
  const r = await pool.query<{ client_id: string; redirect_uri: string; code_challenge: string | null; scope: string; resource: string; expires_at: Date }>(
    `DELETE FROM mcp_oauth_codes WHERE code = $1 RETURNING client_id, redirect_uri, code_challenge, scope, resource, expires_at`, [code],
  );
  const row = r.rows[0];
  if (!row) throw new Error('invalid_grant: code not found');
  if (row.expires_at.getTime() < Date.now()) throw new Error('invalid_grant: code expired');
  if (row.redirect_uri !== redirect_uri) throw new Error('invalid_grant: redirect_uri mismatch');
  // PKCE S256
  if (row.code_challenge) {
    if (!code_verifier) throw new Error('invalid_grant: code_verifier required');
    const digest = createHash('sha256').update(code_verifier).digest('base64url');
    if (digest !== row.code_challenge) throw new Error('invalid_grant: PKCE verification failed');
  }
  return issueTokens({ client_id: row.client_id, scope: row.scope, resource: row.resource });
}

export interface Tokens { access_token: string; token_type: 'Bearer'; expires_in: number; refresh_token: string; scope: string; }

async function issueTokens(p: { client_id: string; scope: string; resource: string }): Promise<Tokens> {
  const pool = await getPool();
  const access_token = `mcpat_${rand(32)}`;
  const refresh_token = `mcprt_${rand(32)}`;
  await pool.query(
    `INSERT INTO mcp_oauth_tokens (access_token, refresh_token, client_id, scope, resource, expires_at)
     VALUES ($1,$2,$3,$4,$5, NOW() + ($6||' seconds')::interval)`,
    [access_token, refresh_token, p.client_id, p.scope, p.resource, String(ACCESS_TTL_S)],
  );
  // opportunistic GC of long-expired rows (cheap, indexed by pkey scan bound)
  await pool.query(`DELETE FROM mcp_oauth_tokens WHERE expires_at < NOW() - ($1||' milliseconds')::interval`, [String(REFRESH_TTL_MS)]).catch(() => {});
  return { access_token, token_type: 'Bearer', expires_in: ACCESS_TTL_S, refresh_token, scope: p.scope };
}

export async function refresh(refresh_token: string): Promise<Tokens> {
  await ensureTables();
  const pool = await getPool();
  const r = await pool.query<{ client_id: string; scope: string; resource: string }>(
    `SELECT client_id, scope, resource FROM mcp_oauth_tokens WHERE refresh_token = $1`, [refresh_token],
  );
  const row = r.rows[0];
  if (!row) throw new Error('invalid_grant: refresh_token not found');
  return issueTokens({ client_id: row.client_id, scope: row.scope, resource: row.resource });
}

/** Used by /api/mcp to validate an OAuth-issued Bearer token. */
export async function validateAccessToken(token: string): Promise<{ scope: string; resource: string } | null> {
  if (!token.startsWith('mcpat_')) return null;
  await ensureTables();
  const pool = await getPool();
  const r = await pool.query<{ scope: string; resource: string; expires_at: Date }>(
    `SELECT scope, resource, expires_at FROM mcp_oauth_tokens WHERE access_token = $1`, [token],
  );
  const row = r.rows[0];
  if (!row || row.expires_at.getTime() < Date.now()) return null;
  return { scope: row.scope, resource: row.resource };
}

/** Consent gate (v1): the shared access key === admin_config mcp_api_token. */
export async function verifyAccessKey(key: string): Promise<boolean> {
  if (!key) return false;
  let expected = process.env.MCP_API_TOKEN || '';
  if (!expected) {
    const pool = await getPool();
    const r = await pool.query<{ value: string }>(`SELECT value FROM admin_config WHERE key='mcp_api_token'`);
    expected = r.rows[0]?.value ?? '';
  }
  if (!expected || key.length !== expected.length) return false;
  try { return timingSafeEqual(Buffer.from(key), Buffer.from(expected)); } catch { return false; }
}
