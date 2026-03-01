import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '../../../../../../lib/db';
import { getOAuthConfig } from '../../../../../../lib/twitter';

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get('code');
  const state = req.nextUrl.searchParams.get('state');

  if (!code || !state) {
    return new NextResponse(html('Error', '<p>Missing code or state parameter.</p>'), {
      status: 400,
      headers: { 'Content-Type': 'text/html' },
    });
  }

  const pool = await getPool();

  // Skip server-side token exchange — Railway IP gets 503 from Twitter.
  // Go straight to curl fallback so the code isn't consumed by failed retries.
  const cfg = await getOAuthConfig(pool);
  const curlCmd = `curl -s -X POST "https://api.x.com/2/oauth2/token" \\
  -H "Content-Type: application/x-www-form-urlencoded" \\
  -d "grant_type=authorization_code&client_id=${encodeURIComponent(cfg.clientId)}&code=${encodeURIComponent(code)}&redirect_uri=${encodeURIComponent(cfg.callbackUrl)}&code_verifier=${encodeURIComponent(cfg.codeVerifier)}"`;

  {
    const host = req.headers.get('host') || 'rofe.ai';
    const protocol = host.includes('localhost') ? 'http' : 'https';
    const saveUrl = `${protocol}://${host}/api/admin/x-posts/auto-post/save-tokens`;

    return new NextResponse(fallbackHtml(curlCmd, saveUrl), {
      headers: { 'Content-Type': 'text/html' },
    });
  }
}

function html(title: string, body: string): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>body{background:#0a0a0a;color:#fff;font-family:system-ui;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.card{background:#111;border:1px solid #333;border-radius:16px;padding:40px;text-align:center;max-width:500px}
h1{margin:0 0 12px}p{color:#999;margin:0}</style>
</head><body><div class="card"><h1>${title}</h1>${body}</div></body></html>`;
}

function fallbackHtml(curlCmd: string, saveUrl: string): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Manual Token Exchange</title>
<style>
body{background:#0a0a0a;color:#fff;font-family:system-ui;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.card{background:#111;border:1px solid #333;border-radius:16px;padding:32px;max-width:700px;text-align:left}
h1{margin:0 0 8px;text-align:center}
.sub{color:#f97316;text-align:center;margin:0 0 20px;font-size:14px}
.step{color:#ccc;margin:12px 0 6px;font-weight:600}
pre{background:#000;border:1px solid #333;border-radius:8px;padding:12px;font-size:12px;overflow-x:auto;white-space:pre-wrap;word-break:break-all;cursor:pointer}
pre:hover{border-color:#f97316}
textarea{width:100%;height:120px;background:#000;color:#0f0;border:1px solid #333;border-radius:8px;padding:12px;font-family:monospace;font-size:12px;resize:vertical}
button{background:#f97316;color:#000;border:none;border-radius:8px;padding:10px 24px;font-weight:600;cursor:pointer;font-size:14px;margin-top:8px}
button:hover{background:#fb923c}
button:disabled{opacity:0.5;cursor:not-allowed}
.ok{color:#22c55e;font-weight:600;margin-top:8px}
.err{color:#ef4444;margin-top:8px}
.hint{color:#666;font-size:12px;margin-top:4px}
</style>
</head><body><div class="card">
<h1>Manual Token Exchange</h1>
<p class="sub">Twitter returned 503 from our server. Run this curl from your terminal:</p>

<p class="step">1. Copy & run this in your terminal:</p>
<pre id="curl" onclick="navigator.clipboard.writeText(this.textContent);this.style.borderColor='#22c55e'">${curlCmd}</pre>
<p class="hint">Click to copy. Should return JSON with access_token and refresh_token.</p>

<p class="step">2. Paste the JSON response here:</p>
<textarea id="tokens" placeholder='{"token_type":"bearer","access_token":"...","refresh_token":"..."}'></textarea>

<button id="btn" onclick="saveTokens()">Save Tokens</button>
<div id="status"></div>

<script>
async function saveTokens() {
  const btn = document.getElementById('btn');
  const status = document.getElementById('status');
  const raw = document.getElementById('tokens').value.trim();
  if (!raw) { status.innerHTML = '<p class="err">Paste the JSON response first</p>'; return; }
  let data;
  try { data = JSON.parse(raw); } catch { status.innerHTML = '<p class="err">Invalid JSON</p>'; return; }
  if (!data.access_token) { status.innerHTML = '<p class="err">Missing access_token in response</p>'; return; }
  btn.disabled = true;
  btn.textContent = 'Saving...';
  try {
    const res = await fetch('${saveUrl}', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ access_token: data.access_token, refresh_token: data.refresh_token })
    });
    const result = await res.json();
    if (result.username) {
      status.innerHTML = '<p class="ok">Connected as @' + result.username + '! You can close this tab.</p>';
    } else {
      status.innerHTML = '<p class="err">' + (result.error || 'Failed to save') + '</p>';
      btn.disabled = false;
      btn.textContent = 'Save Tokens';
    }
  } catch (e) {
    status.innerHTML = '<p class="err">Network error: ' + e.message + '</p>';
    btn.disabled = false;
    btn.textContent = 'Save Tokens';
  }
}
</script>
</div></body></html>`;
}
