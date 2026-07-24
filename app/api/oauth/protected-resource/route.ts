/** RFC 9728 Protected Resource Metadata — served at /.well-known/oauth-protected-resource
 *  via next.config rewrite. Tells the MCP client which auth server to use. */
import { NextResponse } from 'next/server';
import { protectedResourceMetadata } from '@/lib/mcp/oauth';

export const dynamic = 'force-dynamic';
const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export function GET() {
  return NextResponse.json(protectedResourceMetadata(), { headers: CORS });
}
export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}
