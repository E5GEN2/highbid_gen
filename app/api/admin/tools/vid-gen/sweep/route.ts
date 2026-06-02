import { NextRequest, NextResponse } from 'next/server';
import { isAdmin } from '@/lib/admin-auth';
import { getPool } from '@/lib/db';

/**
 * POST /api/admin/tools/vid-gen/sweep
 *
 * Force-mark wedged 'running' rows in vid_gen_runs as failed so the
 * auto-refill in-flight guard (and the UI's "running" indicator) can
 * unblock. Triggered manually by the operator / Claude when a run is
 * clearly stuck — the existing 10-minute auto-sweep inside
 * triggerAutoRefillIfNeeded is great for self-healing but too slow when
 * you can SEE a run is dead.
 *
 * Body (all optional):
 *   { runId?: string;            // kill exactly this run
 *     olderThanMinutes?: number; // kill all 'running' rows older than N
 *                                // minutes. Default 5. Mutually exclusive
 *                                // with runId — runId wins.
 *     onlyWedged?: boolean;      // when filtering by olderThanMinutes,
 *                                // restrict to rows that have done zero
 *                                // batches (workers that died before
 *                                // first DB UPDATE). Default true.
 *   }
 *
 * Response:
 *   { ok, killed: [{ id, mode, age_seconds, batches_total, theme_preview }] }
 *
 * Auth: admin Bearer token.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

interface KilledRow {
  id: string;
  mode: string;
  age_seconds: number;
  batches_total: number;
  theme: string | null;
}

export async function POST(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin token required' }, { status: 403 });

  const body = await req.json().catch(() => ({})) as {
    runId?: string;
    olderThanMinutes?: number;
    onlyWedged?: boolean;
  };

  const pool = await getPool();

  // Single-run mode: caller knows the exact UUID, kill that one.
  if (typeof body.runId === 'string' && body.runId.length > 0) {
    const killRes = await pool.query<KilledRow>(
      `UPDATE vid_gen_runs
          SET status = 'failed',
              completed_at = NOW(),
              last_error = COALESCE(last_error, 'manually swept via /sweep')
        WHERE id = $1 AND status = 'running'
        RETURNING id, mode,
                  EXTRACT(EPOCH FROM (NOW() - started_at))::int AS age_seconds,
                  batches_total, theme`,
      [body.runId],
    );
    return NextResponse.json({
      ok: true,
      mode: 'single',
      killed: killRes.rows.map(shape),
    });
  }

  // Bulk mode: filter by age + optional zero-batches flag (the wedge
  // signature). Default 5 minutes — anything faster than that risks
  // killing legitimately-active sync runs (maxDuration=300s).
  const olderThanMinutes = Math.max(1, Math.min(body.olderThanMinutes ?? 5, 720));
  const onlyWedged = body.onlyWedged !== false;   // default true

  const conds: string[] = [
    `status = 'running'`,
    `started_at < NOW() - ($1 || ' minutes')::interval`,
  ];
  if (onlyWedged) conds.push(`batches_total = 0`);

  const killRes = await pool.query<KilledRow>(
    `UPDATE vid_gen_runs
        SET status = 'failed',
            completed_at = NOW(),
            last_error = COALESCE(last_error, 'manually swept via /sweep (older than ' || $1 || ' min' || CASE WHEN $2::boolean THEN ', zero batches' ELSE '' END || ')')
      WHERE ${conds.join(' AND ')}
      RETURNING id, mode,
                EXTRACT(EPOCH FROM (NOW() - started_at))::int AS age_seconds,
                batches_total, theme`,
    [String(olderThanMinutes), onlyWedged],
  );

  return NextResponse.json({
    ok: true,
    mode: 'bulk',
    olderThanMinutes,
    onlyWedged,
    killed: killRes.rows.map(shape),
  });
}

function shape(r: KilledRow) {
  return {
    id: r.id,
    idShort: r.id.slice(0, 8),
    mode: r.mode,
    ageSeconds: Number(r.age_seconds),
    batchesTotal: r.batches_total,
    themePreview: r.theme ? r.theme.slice(0, 80).replace(/\s+/g, ' ') : null,
  };
}
