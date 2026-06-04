import { NextRequest, NextResponse } from 'next/server';
import { isAdmin } from '@/lib/admin-auth';
import { discoverChannels } from '@/lib/content-gen/discovery';
import { assembleMixedDrafts, assembleThemedDrafts, auditDrafts } from '@/lib/content-gen/assembler';
import { getPool } from '@/lib/db';

/**
 * GET /api/admin/content-gen/drafts-audit
 *
 * Compact diagnostic for the draft assembler. Use this to verify the
 * cross-rotation dedup is working and no channels are leaking between
 * drafts that should be distinct.
 *
 * Returns:
 *   - pool size + audit summary (total drafts, total items, distinct
 *     channels, distinct niches, duplicate channel ids if any)
 *   - per-draft summary table: id / title / mode / item count / distinct
 *     niches / scale mix / channel id list
 *   - cross-draft overlap matrix: for every pair (mixed only by default),
 *     how many channels appear in both
 *
 * No drafts payload — just the audit numbers. The /drafts endpoint
 * returns the full draft data for the GUI to consume.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  if (!(await isAdmin(req))) {
    return NextResponse.json({ error: 'Admin token required' }, { status: 403 });
  }

  const sp = req.nextUrl.searchParams;
  const n     = Math.max(3, Math.min(25, parseInt(sp.get('n') ?? '10') || 10));
  const topK  = Math.max(50, Math.min(500, parseInt(sp.get('topK') ?? '300') || 300));

  const t0 = Date.now();
  const candidates = await discoverChannels({ topK });

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

  const mixed  = assembleMixedDrafts(candidates, n);
  const themed = assembleThemedDrafts(candidates, n, l1Labels);

  const mixedAudit  = auditDrafts(mixed);
  const themedAudit = auditDrafts(themed);
  const combinedAudit = auditDrafts([...mixed, ...themed]);

  // Cross-draft overlap matrix (mixed only — themed are expected to
  // overlap since each L1 surfaces its top channels separately).
  const overlap: Array<{ a: string; b: string; shared: number; jaccard: number }> = [];
  for (let i = 0; i < mixed.length; i++) {
    for (let j = i + 1; j < mixed.length; j++) {
      const idsA = new Set(mixed[i].items.map(it => it.candidate.channel_id));
      const idsB = new Set(mixed[j].items.map(it => it.candidate.channel_id));
      let shared = 0;
      for (const id of idsA) if (idsB.has(id)) shared++;
      const union = idsA.size + idsB.size - shared;
      overlap.push({
        a:       mixed[i].id,
        b:       mixed[j].id,
        shared,
        jaccard: union > 0 ? Math.round((shared / union) * 1000) / 1000 : 0,
      });
    }
  }

  // Channel reuse histogram — how many times each channel appears across
  // ALL drafts (mixed + themed). Helps spot if certain hero channels
  // dominate every draft.
  const channelReuseHist: Record<number, number> = {};
  const combinedCounter = new Map<string, number>();
  for (const d of [...mixed, ...themed]) {
    for (const it of d.items) {
      combinedCounter.set(it.candidate.channel_id, (combinedCounter.get(it.candidate.channel_id) ?? 0) + 1);
    }
  }
  for (const c of combinedCounter.values()) {
    channelReuseHist[c] = (channelReuseHist[c] ?? 0) + 1;
  }

  return NextResponse.json({
    ok: true,
    elapsedMs: Date.now() - t0,
    params: { n, topK },
    candidate_pool_size: candidates.length,
    mixed: {
      draft_count:         mixed.length,
      ...mixedAudit,
      overlap_matrix:      overlap,
      note:                'duplicate_channel_ids in mixed should be EMPTY — cross-rotation dedup means every channel appears in at most one mixed draft.',
    },
    themed: {
      draft_count: themed.length,
      ...themedAudit,
      note:        'Themed drafts CAN overlap (each L1 picks its top channels independently) — that is expected.',
    },
    combined: combinedAudit,
    channel_reuse_histogram: {
      note: 'Channel-id → how many drafts (mixed + themed combined) it appears in. Histogram: appearances → count.',
      ...channelReuseHist,
    },
  });
}
