/**
 * Minimal Streamable-HTTP MCP server core (JSON-RPC 2.0) for the rofe.ai
 * niche-intelligence connector. Hand-rolled (no @modelcontextprotocol/sdk) so
 * it mounts cleanly as a Next App-Router route and reuses lib/ query functions.
 * READ-ONLY: every tool is a bounded, indexed read — no writes, no ops surface.
 *
 * Auth (v1): Bearer token, compared to env MCP_API_TOKEN or admin_config
 * 'mcp_api_token'. OAuth for the public claude.ai connector comes in stage 2.
 */
import { getPool } from '@/lib/db';

export const PROTOCOL_VERSION = '2024-11-05';
export const SERVER_INFO = { name: 'rofe-niche-intelligence', version: '0.1.0' };

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;   // JSON Schema for arguments
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

// ── auth ──────────────────────────────────────────────────────────────────
export async function isAuthorized(authHeader: string | null): Promise<boolean> {
  const token = authHeader?.replace(/^Bearer\s+/i, '').trim();
  if (!token) return false;
  // OAuth-issued access token (the connector path).
  if (token.startsWith('mcpat_')) {
    const { validateAccessToken } = await import('./oauth');
    return (await validateAccessToken(token)) !== null;
  }
  // Direct shared token (curl / internal testing).
  let expected = process.env.MCP_API_TOKEN || '';
  if (!expected) {
    try {
      const pool = await getPool();
      const r = await pool.query<{ value: string }>(
        `SELECT value FROM admin_config WHERE key = 'mcp_api_token'`,
      );
      expected = r.rows[0]?.value ?? '';
    } catch { /* fail closed */ }
  }
  // constant-ish time compare
  if (!expected || token.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < token.length; i++) diff |= token.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

// ── JSON-RPC dispatch ─────────────────────────────────────────────────────
interface RpcReq { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown>; }

/** Returns the JSON-RPC response object, or null for notifications (no reply). */
export async function dispatch(req: RpcReq, tools: Map<string, McpTool>): Promise<unknown | null> {
  const { id, method, params } = req;
  const ok = (result: unknown) => ({ jsonrpc: '2.0', id, result });
  const fail = (code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } });

  // Notifications (client→server, no id, no reply expected)
  if (typeof method === 'string' && method.startsWith('notifications/')) return null;

  switch (method) {
    case 'initialize':
      return ok({ protocolVersion: PROTOCOL_VERSION, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO });
    case 'ping':
      return ok({});
    case 'tools/list':
      return ok({ tools: [...tools.values()].map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) });
    case 'tools/call': {
      const name = (params?.name as string) || '';
      const t = tools.get(name);
      if (!t) return fail(-32602, `unknown tool: ${name}`);
      try {
        const out = await t.handler((params?.arguments as Record<string, unknown>) ?? {});
        return ok({ content: [{ type: 'text', text: typeof out === 'string' ? out : JSON.stringify(out) }] });
      } catch (e) {
        // Tool errors are returned as tool results (isError), not protocol errors.
        return ok({ content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true });
      }
    }
    default:
      return fail(-32601, `method not found: ${method}`);
  }
}

// ── shared query helpers (reused across niche tools) ──────────────────────
/** Canonical niche label projection used everywhere in the app. */
export const NICHE_LABEL_SQL = `COALESCE(NULLIF(c.label,''), c.ai_label, c.auto_label, 'Cluster '||c.cluster_index)`;

/** id of the latest completed global niche-tree run (the active tree). */
export async function latestGlobalRunId(): Promise<number | null> {
  const pool = await getPool();
  const r = await pool.query<{ id: number }>(
    `SELECT id FROM niche_tree_runs WHERE kind='global' AND status='done' ORDER BY started_at DESC NULLS LAST LIMIT 1`,
  );
  return r.rows[0]?.id ?? null;
}

/** clamp an int argument into [min,max] with a default. */
export function clampInt(v: unknown, def: number, min: number, max: number): number {
  const n = parseInt(String(v ?? def));
  return Math.min(Math.max(Number.isFinite(n) ? n : def, min), max);
}
