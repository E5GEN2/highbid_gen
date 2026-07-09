import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

function checkAuth(req: NextRequest): boolean {
  const token = req.cookies.get('admin_token')?.value;
  if (!token) return false;
  try {
    const decoded = Buffer.from(token, 'base64').toString();
    return decoded.startsWith('admin:') && decoded.endsWith(':rofe_admin_secret');
  } catch { return false; }
}

async function setConfig(key: string, value: string) {
  const pool = await getPool();
  await pool.query(
    `INSERT INTO admin_config (key, value) VALUES ($1,$2)
       ON CONFLICT (key) DO UPDATE SET value = $2`,
    [key, value],
  );
}

/** GET — current baker state + buffer counts. */
export async function GET() {
  const pool = await getPool();
  const cfg = await pool.query<{ key: string; value: string }>(
    `SELECT key, value FROM admin_config WHERE key IN ('niche_bend_baker_enabled','niche_bend_target')`,
  );
  const c: Record<string, string> = {};
  for (const r of cfg.rows) c[r.key] = r.value;
  const cnt = await pool.query<{ ready: string; rendering: string; error: string }>(
    `SELECT COUNT(*) FILTER (WHERE status='done') ready,
            COUNT(*) FILTER (WHERE status='rendering') rendering,
            COUNT(*) FILTER (WHERE status='error') error
     FROM niche_bends WHERE created_at > NOW() - INTERVAL '30 days'`,
  );
  return NextResponse.json({
    enabled: c.niche_bend_baker_enabled === 'true',
    target: parseInt(c.niche_bend_target) || 24,
    ready: parseInt(cnt.rows[0].ready) || 0,
    rendering: parseInt(cnt.rows[0].rendering) || 0,
    error: parseInt(cnt.rows[0].error) || 0,
  });
}

/** POST { enabled?, target? } — toggle the baker / set buffer target (admin). */
export async function POST(req: NextRequest) {
  if (!checkAuth(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  let body: { enabled?: boolean; target?: number };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'bad json' }, { status: 400 }); }
  if (typeof body.enabled === 'boolean') await setConfig('niche_bend_baker_enabled', String(body.enabled));
  if (Number.isFinite(body.target)) await setConfig('niche_bend_target', String(Math.max(1, Math.min(200, Number(body.target)))));
  return NextResponse.json({ ok: true });
}
