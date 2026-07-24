/** Authorization endpoint. GET renders a minimal consent page (v1: a single
 *  access-key gate = admin_config mcp_api_token). POST validates the key, mints
 *  a PKCE-bound auth code, and 302s back to the client's redirect_uri.
 *  Stage 2 replaces the access-key form with real rofe.ai user login. */
import { NextRequest, NextResponse } from 'next/server';
import { getClient, issueCode, verifyAccessKey, SCOPE, RESOURCE } from '@/lib/mcp/oauth';

export const dynamic = 'force-dynamic';

interface AuthParams {
  client_id: string; redirect_uri: string; state: string; scope: string;
  code_challenge: string; code_challenge_method: string; response_type: string; resource: string;
}
const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

function consentPage(p: AuthParams, error?: string): string {
  const hidden = (Object.entries(p) as [string, string][])
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('\n');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect rofe.ai</title><style>
body{font-family:-apple-system,system-ui,sans-serif;background:#0b0b0d;color:#e7e7ea;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
.card{background:#161619;border:1px solid #2a2a30;border-radius:14px;padding:32px;max-width:380px;width:90%}
h1{font-size:19px;margin:0 0 6px}p{color:#9a9aa2;font-size:14px;margin:0 0 20px;line-height:1.5}
input[type=password]{width:100%;box-sizing:border-box;padding:11px 12px;border-radius:8px;border:1px solid #33333a;background:#0e0e11;color:#fff;font-size:14px}
button{margin-top:16px;width:100%;padding:11px;border:0;border-radius:8px;background:#fff;color:#000;font-weight:600;font-size:14px;cursor:pointer}
.err{color:#ff6b6b;font-size:13px;margin-top:10px}.logo{font-weight:700;font-size:15px;margin-bottom:18px}
</style></head><body><form class="card" method="POST" action="/api/oauth/authorize">
<div class="logo">▲ rofe.ai</div>
<h1>Connect to your niche intelligence</h1>
<p>Claude wants to explore your rofe.ai niche data. Enter your access key to allow it.</p>
${hidden}
<input type="password" name="access_key" placeholder="Access key" autocomplete="off" autofocus>
${error ? `<div class="err">${esc(error)}</div>` : ''}
<button type="submit">Allow access</button>
</form></body></html>`;
}

function readParams(get: (k: string) => string | null): AuthParams {
  return {
    client_id: get('client_id') || '',
    redirect_uri: get('redirect_uri') || '',
    state: get('state') || '',
    scope: get('scope') || SCOPE,
    code_challenge: get('code_challenge') || '',
    code_challenge_method: get('code_challenge_method') || 'S256',
    response_type: get('response_type') || 'code',
    resource: get('resource') || RESOURCE,
  };
}

async function validClient(p: AuthParams): Promise<string | null> {
  if (p.response_type !== 'code') return 'unsupported response_type (only "code")';
  if (p.code_challenge_method !== 'S256') return 'PKCE S256 required';
  if (!p.code_challenge) return 'code_challenge required';
  const client = await getClient(p.client_id);
  if (!client) return 'unknown client_id';
  if (!client.redirect_uris.includes(p.redirect_uri)) return 'redirect_uri not registered';
  return null;
}

export async function GET(req: NextRequest) {
  const p = readParams(k => req.nextUrl.searchParams.get(k));
  const bad = await validClient(p);
  if (bad) return new NextResponse(`invalid authorization request: ${bad}`, { status: 400 });
  return new NextResponse(consentPage(p), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

export async function POST(req: NextRequest) {
  const form = await req.formData();
  const p = readParams(k => (form.get(k) != null ? String(form.get(k)) : null));
  const bad = await validClient(p);
  if (bad) return new NextResponse(`invalid authorization request: ${bad}`, { status: 400 });

  const accessKey = String(form.get('access_key') || '');
  if (!(await verifyAccessKey(accessKey))) {
    return new NextResponse(consentPage(p, 'Invalid access key — try again.'), { status: 401, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }

  const code = await issueCode({
    client_id: p.client_id, redirect_uri: p.redirect_uri, code_challenge: p.code_challenge, scope: p.scope, resource: p.resource,
  });
  const dest = new URL(p.redirect_uri);
  dest.searchParams.set('code', code);
  if (p.state) dest.searchParams.set('state', p.state);
  return NextResponse.redirect(dest.toString(), { status: 302 });
}
