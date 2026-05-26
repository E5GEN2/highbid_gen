import { NextRequest, NextResponse } from 'next/server';
import { ProxyAgent, fetch as undiciFetch } from 'undici';
import { isAdmin } from '@/lib/admin-auth';
import { getPool } from '@/lib/db';
import { getRandomProxy, getProxyStats } from '@/lib/xgodo-proxy';

/**
 * GET /api/admin/tools/vid-gen/diag?n=10
 *
 * Single-purpose diagnostic: makes N independent Gemini calls — each
 * one with a fresh random (key, proxy) pair — and returns the exact
 * outcome of each. Returns the per-attempt detail (status, error,
 * proxy device, key id) so we can see WHY a generation run was
 * failing instead of getting an aggregate "fetch failed" message.
 *
 * Auth: admin Bearer token.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 120;

export async function GET(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin token required' }, { status: 403 });
  const n = Math.max(1, Math.min(parseInt(req.nextUrl.searchParams.get('n') || '8'), 20));
  const useProxy = req.nextUrl.searchParams.get('proxy') !== '0';   // default proxy on, ?proxy=0 to force direct
  const pool = await getPool();

  const proxyStats = await getProxyStats().catch(() => null);

  const attempts: Array<{
    i: number; keyId: number | null; keyPreview: string | null;
    proxyDevice: string | null; proxyUrl: string | null;
    status: number | null; error: string | null;
    elapsedMs: number; bodyPreview: string | null;
  }> = [];

  for (let i = 0; i < n; i++) {
    const keyRow = await pool.query<{ id: number; key: string }>(
      `SELECT id, key FROM xgodo_api_keys
        WHERE service = 'google_ai_studio' AND status = 'active'
        ORDER BY RANDOM() LIMIT 1`,
    );
    const k = keyRow.rows[0];
    if (!k) { attempts.push({ i, keyId: null, keyPreview: null, proxyDevice: null, proxyUrl: null, status: null, error: 'no keys', elapsedMs: 0, bodyPreview: null }); continue; }

    const proxy = useProxy ? await getRandomProxy().catch(() => null) : null;
    const proxyDevice = proxy?.deviceId?.slice(0, 8) ?? null;
    const proxyUrl = proxy?.url ? proxy.url.replace(/:[^@]+@/, ':REDACTED@') : null;

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${k.key}`;
    const init = {
      method: 'POST' as const,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: 'reply OK' }] }],
        generationConfig: { maxOutputTokens: 16 },
      }),
      signal: AbortSignal.timeout(30_000),
    };

    const t0 = Date.now();
    let status: number | null = null, error: string | null = null, bodyPreview: string | null = null;
    try {
      const res = proxy?.url
        ? await undiciFetch(url, { ...init, dispatcher: new ProxyAgent(proxy.url) })
        : await fetch(url, init);
      status = res.status;
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        bodyPreview = text.slice(0, 200);
      } else {
        bodyPreview = 'OK';
      }
    } catch (err) {
      error = (err as Error).message?.slice(0, 200) || 'unknown';
    }
    attempts.push({
      i, keyId: k.id, keyPreview: `${k.key.slice(0, 12)}…`,
      proxyDevice, proxyUrl,
      status, error, elapsedMs: Date.now() - t0, bodyPreview,
    });
  }

  // Quick summary
  const ok = attempts.filter(a => a.status === 200).length;
  const httpErrors = attempts.filter(a => a.status && a.status !== 200).length;
  const networkErrors = attempts.filter(a => a.error).length;
  return NextResponse.json({
    ok: true,
    proxyMode: useProxy ? 'proxy' : 'direct',
    proxyStats,
    summary: { tries: n, success: ok, httpErrors, networkErrors },
    attempts,
  });
}
