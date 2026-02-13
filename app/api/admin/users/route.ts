import { NextResponse } from 'next/server';
import { getPool } from '../../../../lib/db';

export async function GET() {
  try {
    const pool = await getPool();
    const result = await pool.query(`
      SELECT
        u.id,
        u.name,
        u.email,
        u.image,
        u.created_at,
        u.updated_at AS last_login,
        COALESCE(sc.seen_count, 0) AS channels_seen,
        COALESCE(sc.last_seen_at, NULL) AS last_active
      FROM users u
      LEFT JOIN (
        SELECT
          user_id,
          COUNT(*) AS seen_count,
          MAX(seen_at) AS last_seen_at
        FROM user_seen_channels
        GROUP BY user_id
      ) sc ON sc.user_id = u.id
      ORDER BY u.created_at DESC
    `);

    return NextResponse.json({ success: true, users: result.rows });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to fetch users' },
      { status: 500 }
    );
  }
}
