import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';

/**
 * GET /api/niche-spy/count?niche=weight+loss
 * Return the number of videos stored for a given niche (keyword).
 * Admin-level API — requires admin cookie.
 */
export async function GET(req: NextRequest) {
  // Admin auth
  const cookies = req.headers.get('cookie') || '';
  const adminToken = cookies.match(/admin_token=([^;]+)/)?.[1];
  if (!adminToken) {
    // Also allow via x-admin-token header for API access
    const headerToken = req.headers.get('x-admin-token');
    if (!headerToken) return NextResponse.json({ error: 'Admin access required', count: 0 }, { status: 403 });
    try {
      const decoded = Buffer.from(headerToken, 'base64').toString();
      if (!decoded.includes('rofe_admin_secret')) return NextResponse.json({ error: 'Invalid admin token', count: 0 }, { status: 403 });
    } catch { return NextResponse.json({ error: 'Invalid admin token', count: 0 }, { status: 403 }); }
  } else {
    try {
      const decoded = Buffer.from(adminToken, 'base64').toString();
      if (!decoded.includes('rofe_admin_secret')) return NextResponse.json({ error: 'Invalid admin token', count: 0 }, { status: 403 });
    } catch { return NextResponse.json({ error: 'Invalid admin token', count: 0 }, { status: 403 }); }
  }

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
