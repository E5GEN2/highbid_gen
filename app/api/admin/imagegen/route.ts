import { NextRequest, NextResponse } from 'next/server';
import { isAdmin } from '@/lib/admin-auth';
import { getPool } from '@/lib/db';
import { submitImageGenTask, tickImageGen, type ImageGenInput } from '@/lib/xgodo-imagegen';

/**
 * Image-generation tool — submit + overwatch.
 *
 *   POST /api/admin/imagegen
 *     { tasks: [{prompt, aspect?, model?, purpose?}], ... }  (batch)
 *     or { prompt, aspect?, model?, purpose?, count? }       (single/N copies)
 *
 *   GET /api/admin/imagegen?status=&purpose=&limit=&noTick=
 *     Polls in-flight tasks (downloads finished ones), then returns the list.
 *     This is the overwatch surface for Claude / the admin GUI.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 120;

export async function POST(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin token required' }, { status: 403 });
  const body = await req.json().catch(() => ({})) as {
    tasks?: ImageGenInput[]; prompt?: string; aspect?: string; model?: string; purpose?: string; count?: number;
  };

  let inputs: ImageGenInput[] = [];
  if (Array.isArray(body.tasks) && body.tasks.length > 0) {
    inputs = body.tasks.filter(t => t && typeof t.prompt === 'string' && t.prompt.trim());
  } else if (body.prompt && body.prompt.trim()) {
    const n = Math.max(1, Math.min(50, body.count ?? 1));
    inputs = Array.from({ length: n }, () => ({ prompt: body.prompt!, aspect: body.aspect, model: body.model, purpose: body.purpose }));
  }
  if (inputs.length === 0) return NextResponse.json({ error: 'prompt or tasks[] required' }, { status: 400 });
  if (inputs.length > 50) return NextResponse.json({ error: 'max 50 tasks per call' }, { status: 400 });

  const results = await Promise.all(inputs.map(submitImageGenTask));
  const submitted = results.filter(r => r.ok) as Array<{ ok: true; id: number; plannedTaskId: string }>;
  const errors = results.filter(r => !r.ok) as Array<{ ok: false; error: string }>;
  return NextResponse.json({
    ok: true,
    submitted: submitted.length,
    failed: errors.length,
    ids: submitted.map(s => s.id),
    errors: errors.map(e => e.error),
  });
}

export async function GET(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin token required' }, { status: 403 });
  const sp = req.nextUrl.searchParams;

  let tick: { polled: number; done: number; failed: number; errors: number } | null = null;
  if (sp.get('noTick') !== '1') {
    try { tick = await tickImageGen(); } catch { /* overwatch still returns the list */ }
  }

  const status = sp.get('status');
  const purpose = sp.get('purpose');
  const limit = Math.max(1, Math.min(500, parseInt(sp.get('limit') ?? '100')));
  const where: string[] = [];
  const args: unknown[] = [];
  if (status) { args.push(status); where.push(`status = $${args.length}`); }
  if (purpose) { args.push(`${purpose}%`); where.push(`purpose LIKE $${args.length}`); }
  args.push(limit);

  const pool = await getPool();
  const rows = (await pool.query(
    `SELECT id, purpose, prompt, aspect, model, status, planned_task_id, job_task_id,
            xgodo_temp_url, expires_at, image_name, worker_name, error,
            (local_path IS NOT NULL) AS downloaded,
            submitted_at, finished_at, last_polled_at
       FROM imagegen_tasks
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY id DESC
      LIMIT $${args.length}`,
    args,
  )).rows;

  const counts = (await pool.query<{ status: string; n: number }>(
    `SELECT status, COUNT(*)::int AS n FROM imagegen_tasks GROUP BY status`,
  )).rows.reduce((a, r) => { a[r.status] = r.n; return a; }, {} as Record<string, number>);

  return NextResponse.json({
    ok: true,
    tick,
    counts,
    images: rows.map(r => ({ ...r, file_url: r.downloaded ? `/api/admin/imagegen/file?id=${r.id}` : null })),
  });
}
