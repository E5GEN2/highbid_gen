import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';

/**
 * GET /api/niche-spy/clusters/scatter?keyword=X
 * Returns 2D scatter data for the latest cluster run.
 */
export async function GET(req: NextRequest) {
  const keyword = req.nextUrl.searchParams.get('keyword');
  if (!keyword) return NextResponse.json({ error: 'keyword required' }, { status: 400 });

  const pool = await getPool();

  // Get latest completed run
  const runRes = await pool.query(
    `SELECT id FROM niche_cluster_runs WHERE keyword = $1 AND status = 'done' ORDER BY started_at DESC LIMIT 1`,
    [keyword]
  );
  if (runRes.rows.length === 0) return NextResponse.json({ points: [] });

  const runId = runRes.rows[0].id;

  // Fetch all assignments with 2D coordinates
  const res = await pool.query(
    `SELECT a.video_id, a.cluster_index, a.x_2d, a.y_2d, v.title,
            COALESCE(c.label, c.auto_label, 'Cluster ' || a.cluster_index) as cluster_label
     FROM niche_cluster_assignments a
     LEFT JOIN niche_spy_videos v ON v.id = a.video_id
     LEFT JOIN niche_clusters c ON c.id = a.cluster_id
     WHERE a.run_id = $1
     ORDER BY a.cluster_index`,
    [runId]
  );

  return NextResponse.json({
    points: res.rows.map(r => ({
      videoId: r.video_id,
      clusterIndex: r.cluster_index,
      clusterLabel: r.cluster_label,
      x: parseFloat(r.x_2d),
      y: parseFloat(r.y_2d),
      title: r.title,
    })),
  });
}
