import { NextRequest, NextResponse } from 'next/server';
import { isAdmin } from '@/lib/admin-auth';
import { discoverChannels } from '@/lib/content-gen/discovery';
import { assembleMixedDrafts, assembleThemedDrafts, auditDrafts } from '@/lib/content-gen/assembler';
import { getDraftSpyStatuses } from '@/lib/content-gen/content-gen-seeds';
import { getPool } from '@/lib/db';

/**
 * GET /api/admin/content-gen/drafts
 *
 * The server-side assembler. Calls discoverChannels() then runs the
 * mixed + themed draft assemblers, returning everything the GUI needs to
 * render the cards. Also returns an audit block so we can verify cross-
 * rotation dedup is actually working.
 *
 * Query params:
 *   mode    'mixed' | 'themed' | 'both'    default 'both'
 *   n       channels per draft              default 10 (range 3-25)
 *   topK    candidate pool size to consider default 300 (range 50-500)
 *   audit   '1' to include audit block      default '1' (always on for now)
 *
 * Response shape:
 *   {
 *     ok, elapsedMs, params,
 *     candidate_pool_size,
 *     mixed_drafts: ListicleDraft[],
 *     themed_drafts: ListicleDraft[],
 *     audit?: { ... per-draft summaries + cross-draft channel overlap }
 *   }
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  if (!(await isAdmin(req))) {
    return NextResponse.json({ error: 'Admin token required' }, { status: 403 });
  }

  const sp = req.nextUrl.searchParams;
  const mode  = (sp.get('mode') ?? 'both') as 'mixed' | 'themed' | 'both';
  const n     = Math.max(3, Math.min(25, parseInt(sp.get('n') ?? '10') || 10));
  const topK  = Math.max(50, Math.min(500, parseInt(sp.get('topK') ?? '300') || 300));
  const audit = sp.get('audit') !== '0';

  const t0 = Date.now();
  const candidates = await discoverChannels({ topK });

  // Pull L1 labels for themed mode from the latest done global run.
  const pool = await getPool();
  const l1LabelsRes = await pool.query<{ id: number; label: string | null }>(
    `SELECT c.id, COALESCE(c.label, c.ai_label, c.auto_label) AS label
       FROM niche_tree_clusters c
       JOIN niche_tree_runs r ON r.id = c.run_id
      WHERE c.level = 1
        AND r.kind = 'global'
        AND r.status = 'done'
        AND r.id = (SELECT id FROM niche_tree_runs
                     WHERE kind='global' AND status='done'
                     ORDER BY started_at DESC NULLS LAST LIMIT 1)`,
  );
  const l1Labels = new Map<number, string | null>();
  for (const r of l1LabelsRes.rows) l1Labels.set(Number(r.id), r.label);

  const mixed  = mode !== 'themed' ? assembleMixedDrafts(candidates, n) : [];
  const themed = mode !== 'mixed'  ? assembleThemedDrafts(candidates, n, l1Labels) : [];

  // Per-group niche-spy completion (which channels' top videos have been
  // crawled) so the GUI can badge each group "fully spied".
  const spyStatus = await getDraftSpyStatuses([...mixed, ...themed]).catch(() => ({}));

  const elapsedMs = Date.now() - t0;

  return NextResponse.json({
    ok: true,
    elapsedMs,
    params: { mode, n, topK },
    candidate_pool_size: candidates.length,
    mixed_drafts:  mixed,
    themed_drafts: themed,
    spy_status: spyStatus,
    ...(audit ? { audit: auditDrafts([...mixed, ...themed]) } : {}),
  });
}
