import { NextRequest, NextResponse } from 'next/server';
import { isAdmin } from '@/lib/admin-auth';
import { discoverChannels, type DiscoveryCandidate } from '@/lib/content-gen/discovery';
import { assembleMixedDrafts, assembleThemedDrafts, auditDrafts, type ListicleDraft } from '@/lib/content-gen/assembler';
import { getDraftSpyStatuses } from '@/lib/content-gen/content-gen-seeds';
import { hasActivePins, readActivePinnedDrafts, readConsumedPinnedDrafts, persistPinnedSnapshot } from '@/lib/content-gen/pinned-groups';
import { filterShortsFocusedCandidates } from '@/lib/content-gen/shorts-profile';
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
 *   refresh '1' to FORCE re-assembly        default off
 *
 * MIXED drafts are served from a STABLE pinned snapshot (content_gen_pinned_groups)
 * so the cards don't reshuffle between loads — the bug where a rendered group
 * dissolved before it could be marked used. The live assembler runs only when no
 * active snapshot exists yet or refresh=1; the result is persisted and read back.
 * THEMED drafts stay live (not shown in the main Niches UI). consumed_drafts are
 * pins already marked used, returned for greyed audit display.
 *
 * Response shape:
 *   {
 *     ok, elapsedMs, params,
 *     candidate_pool_size,
 *     mixed_drafts: ListicleDraft[],       // active pinned snapshot
 *     consumed_drafts: ListicleDraft[],    // pins marked used (greyed)
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
  const refresh = sp.get('refresh') === '1';

  const t0 = Date.now();
  const wantMixed  = mode !== 'themed';
  const wantThemed = mode !== 'mixed';

  // Live discovery is heavy (562K-row aggregation + live thumbnail revalidation),
  // so run it lazily — only when we must re-assemble (refresh, no snapshot yet, or
  // themed mode). Serving an existing pinned snapshot skips it entirely.
  let candidates: DiscoveryCandidate[] | null = null;
  let candidatePoolSize = 0;
  let shortsExcludedCount = 0;
  const loadCandidates = async (): Promise<DiscoveryCandidate[]> => {
    if (candidates) return candidates;
    const rawCandidates = await discoverChannels({ topK });
    // #14: drop Shorts-focused channels from the draft pool (≥95% shorts or no
    // long video in 3 months). Profiles only the top candidates (cached); an
    // excluded channel's niche slot refills with the next candidate.
    const { kept, excluded } = await filterShortsFocusedCandidates(rawCandidates)
      .catch(() => ({ kept: rawCandidates, excluded: [] as string[] }));
    candidates = kept;
    candidatePoolSize = kept.length;
    shortsExcludedCount = excluded.length;
    return kept;
  };

  // MIXED — served from the stable pinned snapshot. Re-assemble + persist only on
  // refresh or when no active snapshot exists yet, then read the pins back so the
  // UI gets the durable group_key ids (used by mark-used).
  let mixed: ListicleDraft[] = [];
  let consumed: ListicleDraft[] = [];
  if (wantMixed) {
    if (!refresh && (await hasActivePins(n))) {
      mixed = await readActivePinnedDrafts(n);
    } else {
      const cands = await loadCandidates();
      await persistPinnedSnapshot(n, assembleMixedDrafts(cands, n));
      mixed = await readActivePinnedDrafts(n);
    }
    consumed = await readConsumedPinnedDrafts(n);
  }

  // THEMED — unchanged live assembly (not surfaced in the main Niches view).
  let themed: ListicleDraft[] = [];
  if (wantThemed) {
    const cands = await loadCandidates();
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
    themed = assembleThemedDrafts(cands, n, l1Labels);
  }

  // Per-group niche-spy completion (which channels' top videos have been
  // crawled) so the GUI can badge each group "fully spied". Ledger-only read.
  const spyStatus = await getDraftSpyStatuses([...mixed, ...themed, ...consumed]).catch(() => ({}));

  const elapsedMs = Date.now() - t0;

  return NextResponse.json({
    ok: true,
    elapsedMs,
    params: { mode, n, topK, refresh },
    candidate_pool_size: candidatePoolSize,
    shorts_excluded: shortsExcludedCount,
    mixed_drafts:  mixed,
    consumed_drafts: consumed,
    themed_drafts: themed,
    spy_status: spyStatus,
    ...(audit ? { audit: auditDrafts([...mixed, ...themed]) } : {}),
  });
}
