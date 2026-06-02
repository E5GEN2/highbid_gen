import { NextRequest, NextResponse } from 'next/server';
import { isAdmin } from '@/lib/admin-auth';
import { getPool } from '@/lib/db';

/**
 * Operator settings for the XG vid download tab. Single switch right now
 * (auto-pull on/off), kept as a generic settings endpoint so the future
 * "max per minute" / "max parallel" knobs can land here without
 * inventing new URLs.
 *
 * GET  → { autoPull: 'on' | 'off' }
 * POST { autoPull: 'on' | 'off' } → { autoPull: <new value> }
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

interface Settings { autoPull: 'on' | 'off' }

async function readSettings(): Promise<Settings> {
  const pool = await getPool();
  const r = await pool.query<{ value: string }>(
    `SELECT value FROM admin_config WHERE key = 'xg_vid_download_autopull' LIMIT 1`,
  );
  const v = r.rows[0]?.value;
  return { autoPull: v === 'off' ? 'off' : 'on' };
}

export async function GET(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin token required' }, { status: 403 });
  return NextResponse.json({ ok: true, ...(await readSettings()) });
}

export async function POST(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin token required' }, { status: 403 });
  const body = await req.json().catch(() => ({})) as { autoPull?: string };
  const next = body.autoPull === 'off' ? 'off' : body.autoPull === 'on' ? 'on' : null;
  if (!next) {
    return NextResponse.json({ ok: false, error: 'autoPull must be "on" or "off"' }, { status: 400 });
  }
  const pool = await getPool();
  await pool.query(
    `INSERT INTO admin_config (key, value, updated_at)
     VALUES ('xg_vid_download_autopull', $1, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
    [next],
  );
  return NextResponse.json({ ok: true, autoPull: next });
}
