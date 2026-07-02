import { NextRequest, NextResponse } from 'next/server';
import { isAdmin } from '@/lib/admin-auth';
import { getPool } from '@/lib/db';
import { submitImageGenBatch, tickImageGen, backfillDeviceInfo, getDeviceReputation, retryMissingImageGen, type ImageGenInput } from '@/lib/xgodo-imagegen';

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
    action?: string; tasks?: ImageGenInput[]; prompt?: string; aspect?: string; model?: string; purpose?: string; count?: number; pin?: boolean; dispatch?: string;
  };

  // Action: resubmit every purpose missing a success, pinned to good devices.
  if (body.action === 'retryMissing') {
    const r = await retryMissingImageGen();
    return NextResponse.json({ ok: true, ...r });
  }

  let inputs: ImageGenInput[] = [];
  if (Array.isArray(body.tasks) && body.tasks.length > 0) {
    inputs = body.tasks.filter(t => t && typeof t.prompt === 'string' && t.prompt.trim());
  } else if (body.prompt && body.prompt.trim()) {
    const n = Math.max(1, Math.min(50, body.count ?? 1));
    inputs = Array.from({ length: n }, () => ({ prompt: body.prompt!, aspect: body.aspect, model: body.model, purpose: body.purpose }));
  }
  if (inputs.length === 0) return NextResponse.json({ error: 'prompt or tasks[] required' }, { status: 400 });
  if (inputs.length > 50) return NextResponse.json({ error: 'max 50 tasks per call' }, { status: 400 });

  // dispatch:'any' -> run_immediately with no device (instant assign to any free
  // US worker; the reliable path). Otherwise device-affinity pin as before.
  const r = body.dispatch === 'any'
    ? await submitImageGenBatch(inputs, { dispatchAny: true })
    : await submitImageGenBatch(inputs, { pin: body.pin ?? true });
  return NextResponse.json({ ok: true, submitted: r.submitted, failed: r.failed, ids: r.ids, pinnedTo: r.pinnedTo, unpinned: r.unpinned, errors: r.errors });
}

export async function GET(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin token required' }, { status: 403 });
  const sp = req.nextUrl.searchParams;

  let tick: { polled: number; done: number; failed: number; errors: number } | null = null;
  if (sp.get('noTick') !== '1') {
    try { tick = await tickImageGen(); } catch { /* overwatch still returns the list */ }
    // Opportunistically backfill device info on any terminal rows missing it.
    try { await backfillDeviceInfo(40); } catch { /* best-effort */ }
  }
  const devices = await getDeviceReputation().catch(() => []);

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
            xgodo_temp_url, expires_at, image_name, worker_name, device_name, pinned_device, error,
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
    devices,
    images: rows.map(r => ({ ...r, file_url: r.downloaded ? `/api/admin/imagegen/file?id=${r.id}` : null })),
  });
}
