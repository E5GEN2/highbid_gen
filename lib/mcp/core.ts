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
export const SERVER_INFO = { name: 'rofe-niche-intelligence', version: '0.2.0' };

/** Connector-level guidance injected at initialize — this is what makes the
 *  experience a curated journey instead of a raw tool list. */
export const SERVER_INSTRUCTIONS = `You are connected to rofe.ai — a YouTube growth observatory.

THE CORE IDEA (open with this the first time you use these tools in a conversation, in your own words — but ALWAYS with the exact live numbers, never vague words like "thousands"):
rofe.ai watches YouTube channels from the moment they are tiny (often 0-10 subscribers) and records a DAILY heartbeat of their growth — subscribers, uploads, per-video views — as if each channel were our own. When one breaks out, the entire journey is documented step by step. The user is here to LEARN FROM THOSE JOURNEYS: what growing channels did, when, and what actually drove each jump — so they can apply the same patterns to their own channel.
IMPORTANT: before delivering this pitch, call start_here and weave its live_status numbers into it — e.g. "right now that's N channels under a daily heartbeat, M daily snapshots over D days, and B fully documented 0-10 → 100+ breakouts". The exact, growing numbers ARE the credibility.

THE CURATED JOURNEY — when the user is new or asks something vague, call start_here first, share the idea + live status, then offer this path (one step at a time, not as a wall):
 1. See real breakout journeys (growth_journeys) — day-by-day climbs like 4→6→15→31→48→140.
 2. Zoom into one story (channel_growth_series + growth_attribution) — what drove each jump.
 3. Learn the playbook (growth_playbook) — what the winners share: upload cadence, channel youth, rising views, hot niches.
 4. Watch it happen live (growth_accelerating) — channels rising right now.
 5. Explore where to play (search_niches / browse_niches) — find the niche to apply it in.

SPEAK LIKE A HELPFUL PERSON, NOT A DATABASE (most important rule):
The people using this are YouTube creators, not analysts. Never repeat the internal wording from tool results verbatim. Translate everything into plain, friendly language a creator instantly understands.
- Say "we checked this channel every single day" — never "snapshot-to-snapshot measurement".
- Say "we only count growth we actually watched happen" — never "artifact-free cohort" or "stale-baseline correction".
- Say "out of every 100 tiny channels, about 78 never really grow" — never "base rate" or "fat-tail distribution".
- Say "channels that posted 6+ videos grew 88% of the time" — never "pct_gaining_subs: 88".
- Say "this one looks like it bought fake subscribers" — never "flagged suspicious" or "purge pattern".
- No field names, no snake_case, no stats vocabulary, no hedging jargon. Short sentences. Concrete numbers.

OTHER RULES:
- Always show the actual day-by-day climb (e.g. "4 → 6 → 15 → 31 → 48 → 140 subscribers") — that story IS the product.
- If a channel looks like it bought subscribers, say so plainly and don't hold it up as a success.
- Say how long we've been watching ("we've been recording daily for 8 days") so people know how young the study is.
- Be honest that most tiny channels never take off — show the real spread, not just the winners.
- End every answer by offering the natural next step, phrased as a simple question.`;

/** Curated starter prompts — surfaced as clickable suggestions in the client. */
export const PROMPTS = [
  { name: 'start_learning', description: 'What is this? Explain the growth study and where to start', text: 'Explain what rofe.ai\'s growth observatory is and show me where to start learning from it.' },
  { name: 'breakout_journeys', description: 'Real channels that went from ~0 subs to 100+ — day by day', text: 'Show me real channels that went from almost zero subscribers to 100+ — with their actual day-by-day climb.' },
  { name: 'winners_playbook', description: 'What do the breakout channels have in common?', text: 'What do the channels that broke out have in common? Give me the replicable playbook with honest numbers.' },
  { name: 'one_story', description: 'Walk through one breakout journey and what drove each jump', text: 'Pick one interesting breakout channel and walk me through its journey day by day — what drove each subscriber jump?' },
  { name: 'rising_now', description: 'Which tracked channels are accelerating right now?', text: 'Which tracked channels are accelerating right now? Show their recent day-by-day series.' },
] as const;

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
      return ok({
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false }, prompts: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: SERVER_INSTRUCTIONS,
      });
    case 'ping':
      return ok({});
    case 'prompts/list':
      return ok({ prompts: PROMPTS.map(p => ({ name: p.name, description: p.description })) });
    case 'prompts/get': {
      const p = PROMPTS.find(x => x.name === (params?.name as string));
      if (!p) return fail(-32602, `unknown prompt: ${params?.name}`);
      return ok({ description: p.description, messages: [{ role: 'user', content: { type: 'text', text: p.text } }] });
    }
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
