import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { isAdmin } from '@/lib/admin-auth';

/**
 * GET /api/admin/agents/targets — List all thread targets
 * POST /api/admin/agents/targets — Set target for a keyword
 * DELETE /api/admin/agents/targets — Remove target for a keyword
 */
export async function GET(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  const pool = await getPool();
  const res = await pool.query("SELECT * FROM agent_thread_targets ORDER BY keyword");
  return NextResponse.json({ targets: res.rows });
}

export async function POST(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  const pool = await getPool();
  const { keyword, targetThreads, enabled } = await req.json();

  if (!keyword) return NextResponse.json({ error: 'keyword required' }, { status: 400 });

  await pool.query(`
    INSERT INTO agent_thread_targets (keyword, target_threads, enabled)
    VALUES ($1, $2, $3)
    ON CONFLICT (keyword) DO UPDATE SET
      target_threads = EXCLUDED.target_threads,
      enabled = EXCLUDED.enabled
  `, [keyword, targetThreads || 0, enabled !== false]);

  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  const pool = await getPool();
  const { keyword } = await req.json();
  if (!keyword) return NextResponse.json({ error: 'keyword required' }, { status: 400 });
  await pool.query("DELETE FROM agent_thread_targets WHERE keyword = $1", [keyword]);
  return NextResponse.json({ ok: true });
}
