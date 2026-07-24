/** Token endpoint. authorization_code (with PKCE verify) + refresh_token grants.
 *  Public-client friendly (no client_secret required — PKCE is the proof). */
import { NextRequest, NextResponse } from 'next/server';
import { exchangeCode, refresh } from '@/lib/mcp/oauth';

export const dynamic = 'force-dynamic';
const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Cache-Control': 'no-store',
};

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const grant_type = String(form.get('grant_type') || '');

    if (grant_type === 'authorization_code') {
      const tokens = await exchangeCode(
        String(form.get('code') || ''),
        String(form.get('redirect_uri') || ''),
        String(form.get('code_verifier') || ''),
      );
      return NextResponse.json(tokens, { headers: CORS });
    }
    if (grant_type === 'refresh_token') {
      const tokens = await refresh(String(form.get('refresh_token') || ''));
      return NextResponse.json(tokens, { headers: CORS });
    }
    return NextResponse.json({ error: 'unsupported_grant_type' }, { status: 400, headers: CORS });
  } catch (e) {
    const msg = (e as Error).message || 'invalid_grant';
    return NextResponse.json({ error: 'invalid_grant', error_description: msg }, { status: 400, headers: CORS });
  }
}
export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}
