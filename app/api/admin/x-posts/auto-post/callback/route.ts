import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '../../../../../../lib/db';
import { handleOAuth2Callback } from '../../../../../../lib/twitter';

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get('code');
  const state = req.nextUrl.searchParams.get('state');

  if (!code || !state) {
    return new NextResponse(html('Error', 'Missing code or state parameter.'), {
      status: 400,
      headers: { 'Content-Type': 'text/html' },
    });
  }

  const pool = await getPool();

  // Retry token exchange — Twitter often returns transient 503s
  const MAX_RETRIES = 5;
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const { username } = await handleOAuth2Callback(pool, code, state);
      return new NextResponse(
        html('Connected!', `Successfully connected as <strong>@${username}</strong>. You can close this tab.`),
        { headers: { 'Content-Type': 'text/html' } }
      );
    } catch (error) {
      lastError = error;
      const msg = error instanceof Error ? error.message : String(error);
      const is503 = msg.includes('503') || msg.includes('Service Unavailable');
      if (!is503 || attempt === MAX_RETRIES) break;
      // Wait before retrying: 1s, 2s, 4s, 8s
      await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt - 1)));
    }
  }

  const msg = lastError instanceof Error ? lastError.message : 'Unknown error';
  return new NextResponse(html('Error', `OAuth callback failed: ${msg}`), {
    status: 500,
    headers: { 'Content-Type': 'text/html' },
  });
}

function html(title: string, body: string): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>body{background:#0a0a0a;color:#fff;font-family:system-ui;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.card{background:#111;border:1px solid #333;border-radius:16px;padding:40px;text-align:center;max-width:400px}
h1{margin:0 0 12px}p{color:#999;margin:0}</style>
</head><body><div class="card"><h1>${title}</h1><p>${body}</p></div></body></html>`;
}
