/** RFC 8414 Authorization Server Metadata — served at
 *  /.well-known/oauth-authorization-server via next.config rewrite. */
import { NextResponse } from 'next/server';
import { authorizationServerMetadata } from '@/lib/mcp/oauth';

export const dynamic = 'force-dynamic';
const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export function GET() {
  return NextResponse.json(authorizationServerMetadata(), { headers: CORS });
}
export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}
