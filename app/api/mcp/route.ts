/**
 * Remote MCP endpoint (Streamable HTTP / JSON-RPC 2.0) — the rofe.ai
 * niche-intelligence connector. Read-only, Bearer-token gated (v1).
 *
 *   POST /api/mcp   { jsonrpc:"2.0", id, method, params }
 *   methods: initialize | tools/list | tools/call | ping | notifications/*
 *
 * Auth: Authorization: Bearer <token> (env MCP_API_TOKEN or admin_config
 * 'mcp_api_token'). Stage 2 adds OAuth for the public claude.ai connector.
 */
import { NextRequest, NextResponse } from 'next/server';
import { isAuthorized, dispatch, SERVER_INFO } from '@/lib/mcp/core';
import { TOOLS } from '@/lib/mcp/tools';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 60;

const toolMap = new Map(TOOLS.map(t => [t.name, t]));

export async function POST(req: NextRequest) {
  if (!(await isAuthorized(req.headers.get('authorization')))) {
    // RFC 9728: point the client at the protected-resource metadata so it can
    // discover the auth server and start the OAuth flow.
    return NextResponse.json(
      { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'unauthorized' } },
      { status: 401, headers: { 'WWW-Authenticate': 'Bearer realm="mcp", resource_metadata="https://rofe.ai/.well-known/oauth-protected-resource"' } },
    );
  }

  const body = await req.json().catch(() => null);
  if (body == null || typeof body !== 'object') {
    return NextResponse.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }, { status: 400 });
  }

  // JSON-RPC batch support
  if (Array.isArray(body)) {
    const results = (await Promise.all(body.map(r => dispatch(r, toolMap)))).filter(r => r !== null);
    return NextResponse.json(results);
  }

  const res = await dispatch(body, toolMap);
  if (res === null) return new NextResponse(null, { status: 202 }); // notification: accepted, no body
  return NextResponse.json(res);
}

// Some clients probe the endpoint with GET; return a small descriptor.
export async function GET() {
  return NextResponse.json({
    server: SERVER_INFO,
    transport: 'streamable-http',
    note: 'POST JSON-RPC 2.0 with a Bearer token. Read-only niche-intelligence tools.',
    tools: TOOLS.map(t => t.name),
  });
}
