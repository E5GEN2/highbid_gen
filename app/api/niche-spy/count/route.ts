import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { isAdmin } from '@/lib/admin-auth';

/**
 * GET /api/niche-spy/count?niche=weight+loss
 * Return the number of videos stored for a given niche (keyword).
 * Admin-level API.
 */
export async function GET(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin access required', count: 0 }, { status: 403 });

  const niche = req.nextUrl.searchParams.get('niche');
  if (!niche) return NextResponse.json({ error: 'niche parameter required', count: 0 }, { status: 400 });

  try {
    const pool = await getPool();
    const result = await pool.query(
      'SELECT COUNT(*) as cnt FROM niche_spy_videos WHERE keyword = $1',
      [niche.trim()]
    );
    return NextResponse.json({ count: parseInt(result.rows[0].cnt) });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Query failed', count: 0 }, { status: 500 });
  }
}
