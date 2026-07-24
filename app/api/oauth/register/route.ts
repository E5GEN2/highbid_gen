/** RFC 7591 Dynamic Client Registration. The Claude connector POSTs its
 *  redirect_uris here and gets a client_id back. */
import { NextRequest, NextResponse } from 'next/server';
import { registerClient } from '@/lib/mcp/oauth';

export const dynamic = 'force-dynamic';
const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const client = await registerClient(body);
    return NextResponse.json(client, { status: 201, headers: CORS });
  } catch (e) {
    return NextResponse.json(
      { error: 'invalid_client_metadata', error_description: (e as Error).message },
      { status: 400, headers: CORS },
    );
  }
}
export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}
