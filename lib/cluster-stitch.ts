/**
 * Cluster stitching — assigns stable_ids to a freshly-clustered run by
 * matching its clusters against the previous "done" L1 run via three
 * complementary overlap metrics.
 *
 *   prev run's clusters (with stable_ids)        new run's clusters (no stable_ids yet)
 *   ────────────────────────────────────         ──────────────────────────────────────
 *      C_old_1  members={v1,v2,v3,v4,v5}             C_new_a  members={v1,v2,v3,v100,v101}
 *      C_old_2  members={v6,v7,v8,v9}                C_new_b  members={v6,v7,v200}
 *                                                    C_new_c  members={v300,v301,v302} (born)
 *
 * Overlap is computed only over the intersection of memberships across
 * both runs (videos that existed in both). New videos that didn't exist
 * in the prev run are bonus members of whatever new cluster they land in
 * — they don't perturb the matching signal.
 *
 * For each (old, new) pair we compute:
 *   jaccard    = |inter| / |union|              symmetric overlap
 *   recall_old = |inter| / |old|                "% of old's members that went here"
 *   recall_new = |inter| / |new|                "% of new's members came from here"
 *
 * Resolution rules:
 *   ANY of jaccard / recall_old / recall_new ≥ 0.5
 *      → SAME cluster, inherit stable_id, log size delta (grew/shrank/same)
 *   one old → 2+ new each with recall_old ≥ 0.2  → SPLIT
 *   2+ old → one new each with recall_new ≥ 0.2  → MERGE
 *   no successor for old → DIED
 *   no predecessor for new → BORN, mint fresh stable_id
 *
 * The tiered SAME rule fixes the "ghost death" problem: when a noisy new
 * partition pushes 70% of an old cluster's members into noise but the
 * remaining 30% all land in a single new cluster (which is dominated by
 * them), Jaccard alone scores ~0.18 and falsely declares the old DIED
 * and the new BORN. recall_new catches this case (the new cluster IS
 * the old one's successor, just smaller). recall_old catches the inverse
 * (old's identity migrated to a much-larger new cluster that absorbed
 * many other clusters too — a soft merge).
 *
 * Outputs:
 *   - stable_id + parent_stable_id written onto niche_tree_clusters
 *   - one row per lifecycle event into niche_cluster_events
 */

import crypto from 'crypto';
import type { Pool } from 'pg';

export interface StitchResult {
  ok: true;
  matched: { same: number; grew: number; shrank: number; split: number; merged: number };
  born: number;
  died: number;
  prevRunId: number | null;
  totalNewClusters: number;
}

interface ClusterMembers {
  cluster_id: number;
  cluster_index: number;
  stable_id: string | null;
  video_ids: Set<number>;
}

const SAME_THRESHOLD = 0.5;     // ≥ this → inherit stable_id
const RELATED_THRESHOLD = 0.2;  // ≥ this → split / merge candidate

function mintStableId(level: 1 | 2): string {
  return `l${level}-${crypto.randomBytes(8).toString('hex')}`;
}

/**
 * Load every cluster's members for a given run + level into a Map.
 * Pulls from niche_tree_assignments where cluster_id is non-null
 * (excludes noise). One round trip per run.
 */
async function loadRunClusters(
  pool: Pool,
  runId: number,
  level: 1 | 2,
): Promise<Map<number, ClusterMembers>> {
  const res = await pool.query<{
    cluster_id: number;
    cluster_index: number;
    stable_id: string | null;
    video_id: number;
  }>(
    `SELECT a.cluster_id, c.cluster_index, c.stable_id, a.video_id
       FROM niche_tree_assignments a
       JOIN niche_tree_clusters c ON c.id = a.cluster_id
      WHERE a.run_id = $1 AND c.level = $2 AND a.cluster_id IS NOT NULL`,
    [runId, level],
  );
  const map = new Map<number, ClusterMembers>();
  for (const row of res.rows) {
    let entry = map.get(row.cluster_id);
    if (!entry) {
      entry = {
        cluster_id: row.cluster_id,
        cluster_index: row.cluster_index,
        stable_id: row.stable_id,
        video_ids: new Set<number>(),
      };
      map.set(row.cluster_id, entry);
    }
    entry.video_ids.add(row.video_id);
  }
  return map;
}

/**
 * Find the most recent done L1 global run before `excludeRunId`. Used as
 * the predecessor for stitching. Returns null if none found (cold start).
 */
async function findPredecessorRun(
  pool: Pool,
  excludeRunId: number,
): Promise<number | null> {
  const res = await pool.query<{ id: number }>(
    `SELECT id
       FROM niche_tree_runs
      WHERE kind = 'global'
        AND level = 1
        AND status = 'done'
        AND id != $1
      ORDER BY started_at DESC
      LIMIT 1`,
    [excludeRunId],
  );
  return res.rows[0]?.id ?? null;
}

/**
 * Jaccard similarity for two sets.
 */
function jaccard(a: Set<number>, b: Set<number>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  // Iterate the smaller set for speed
  const [smaller, larger] = a.size <= b.size ? [a, b] : [b, a];
  for (const x of smaller) if (larger.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/**
 * Stitch L1 clusters of `currentRunId` against the most recent prior L1 run.
 * Writes stable_ids onto niche_tree_clusters and lifecycle events into
 * niche_cluster_events. Idempotent — running twice produces the same labels
 * (overlap is deterministic) but doubles the events; callers should only
 * invoke once per run.
 */
export async function stitchL1Run(
  pool: Pool,
  currentRunId: number,
): Promise<StitchResult> {
  const prevRunId = await findPredecessorRun(pool, currentRunId);

  // Load current run's L1 clusters first — needed in both cold-start and
  // normal paths.
  const newClusters = await loadRunClusters(pool, currentRunId, 1);

  // Cold start: no predecessor → every new cluster is "born", mint fresh ids.
  if (prevRunId === null) {
    let born = 0;
    for (const cluster of newClusters.values()) {
      const stable_id = mintStableId(1);
      await pool.query(
        `UPDATE niche_tree_clusters SET stable_id = $1 WHERE id = $2`,
        [stable_id, cluster.cluster_id],
      );
      await pool.query(
        `INSERT INTO niche_cluster_events
           (run_id, stable_id, event, level, size_after, payload)
         VALUES ($1, $2, 'born', 1, $3, $4)`,
        [currentRunId, stable_id, cluster.video_ids.size, { reason: 'cold-start' }],
      );
      born++;
    }
    return {
      ok: true,
      matched: { same: 0, grew: 0, shrank: 0, split: 0, merged: 0 },
      born,
      died: 0,
      prevRunId: null,
      totalNewClusters: newClusters.size,
    };
  }

  const oldClusters = await loadRunClusters(pool, prevRunId, 1);

  // Compute overlap matrix: for each (old, new), compute three metrics.
  // Skip pairs whose intersection is 0 — saves a lot of work because most
  // pairs share zero members.
  type Match = {
    oldId: number;
    newId: number;
    inter: number;
    jaccard: number;
    recallOld: number;     // |inter| / |old|
    recallNew: number;     // |inter| / |new|
    sameScore: number;     // = max of the three (used for SAME ranking)
  };
  const matches: Match[] = [];
  for (const [newId, newC] of newClusters) {
    for (const [oldId, oldC] of oldClusters) {
      // Quick intersection count
      let inter = 0;
      const [smaller, larger] = oldC.video_ids.size <= newC.video_ids.size
        ? [oldC.video_ids, newC.video_ids]
        : [newC.video_ids, oldC.video_ids];
      for (const v of smaller) if (larger.has(v)) inter++;
      if (inter === 0) continue;
      const j = inter / (oldC.video_ids.size + newC.video_ids.size - inter);
      const ro = inter / oldC.video_ids.size;
      const rn = inter / newC.video_ids.size;
      const sameScore = Math.max(j, ro, rn);
      // Floor to keep matrix small but include anything that might trigger SAME
      if (sameScore >= 0.05) {
        matches.push({ oldId, newId, inter, jaccard: j, recallOld: ro, recallNew: rn, sameScore });
      }
    }
  }

  // Sort by intersection size DESC, sameScore DESC as tiebreaker.
  //
  // Intersection size is the right "primary successor" signal: the new
  // cluster that absorbed the most absolute members from the old is the
  // natural semantic continuation. Sorting purely by sameScore (Jaccard
  // / recall_old / recall_new) lets a tiny fragment cluster — say 100
  // videos all from the old — steal inheritance from the real 2300-
  // video successor whose recall_new only marginally lower (0.91 vs
  // 0.91, but 91 inter vs 2104 inter).
  matches.sort((a, b) => b.inter - a.inter || b.sameScore - a.sameScore);

  // Resolution state
  const oldClaimed = new Map<number, number>();     // oldId → newId (which new took this old's stable_id)
  const newAssigned = new Map<number, string>();    // newId → stable_id
  const eventsToWrite: Array<{
    stable_id: string;
    parent_stable_id: string | null;
    event: string;
    size_before: number | null;
    size_after: number | null;
    jaccard: number | null;
    payload: Record<string, unknown>;
  }> = [];

  // First pass: SAME — any of jaccard / recall_old / recall_new ≥ 0.5.
  // The tiered metric is critical when the new partition has a very
  // different noise rate from the old one (e.g. 25% → 44%); pure
  // Jaccard misses real continuations because the union balloons with
  // newly-noisy members. Greedy resolution: the strongest match wins.
  for (const m of matches) {
    if (m.sameScore < SAME_THRESHOLD) break;
    if (oldClaimed.has(m.oldId)) continue;     // this old already inherited by another
    if (newAssigned.has(m.newId)) continue;    // this new already inherited
    const oldC = oldClusters.get(m.oldId)!;
    const newC = newClusters.get(m.newId)!;
    if (!oldC.stable_id) continue;             // can't inherit a null
    oldClaimed.set(m.oldId, m.newId);
    newAssigned.set(m.newId, oldC.stable_id);
    const sizeDelta = newC.video_ids.size - oldC.video_ids.size;
    const event = sizeDelta === 0 ? 'same' : sizeDelta > 0 ? 'grew' : 'shrank';
    eventsToWrite.push({
      stable_id: oldC.stable_id,
      parent_stable_id: null,
      event,
      size_before: oldC.video_ids.size,
      size_after: newC.video_ids.size,
      jaccard: m.jaccard,
      payload: {
        delta: sizeDelta,
        prev_run_id: prevRunId,
        prev_cluster_index: oldC.cluster_index,
        new_cluster_index: newC.cluster_index,
        recall_old: m.recallOld,
        recall_new: m.recallNew,
        match_metric:
          m.sameScore === m.jaccard ? 'jaccard' :
          m.sameScore === m.recallOld ? 'recall_old' : 'recall_new',
      },
    });
  }

  // Second pass: SPLIT detection. An old cluster that wasn't claimed yet
  // but has ≥2 new clusters in the related-threshold zone → split.
  // The strongest of the related new clusters inherits (downgraded) and
  // the others get new stable_ids with parent_stable_id set.
  const oldToRelated = new Map<number, Match[]>();
  for (const m of matches) {
    // SPLIT candidate: an old that significantly seeded multiple news.
    // Use recall_old (% of old's members that went to this new) — the
    // metric that actually means "did this new inherit pieces of old?".
    if (m.recallOld < RELATED_THRESHOLD || m.sameScore >= SAME_THRESHOLD) continue;
    if (oldClaimed.has(m.oldId)) continue;
    if (newAssigned.has(m.newId)) continue;
    if (!oldToRelated.has(m.oldId)) oldToRelated.set(m.oldId, []);
    oldToRelated.get(m.oldId)!.push(m);
  }
  for (const [oldId, rels] of oldToRelated) {
    if (rels.length < 2) continue;            // not a split — fall through to other resolutions
    const oldC = oldClusters.get(oldId)!;
    if (!oldC.stable_id) continue;
    // Take all related newIds as siblings born from this parent
    for (const m of rels) {
      if (newAssigned.has(m.newId)) continue;
      const newC = newClusters.get(m.newId)!;
      const stable_id = mintStableId(1);
      newAssigned.set(m.newId, stable_id);
      eventsToWrite.push({
        stable_id,
        parent_stable_id: oldC.stable_id,
        event: 'split',
        size_before: oldC.video_ids.size,
        size_after: newC.video_ids.size,
        jaccard: m.jaccard,
        payload: {
          from: oldC.stable_id, sibling_count: rels.length, prev_run_id: prevRunId,
          prev_cluster_index: oldC.cluster_index, new_cluster_index: newC.cluster_index,
          recall_old: m.recallOld, recall_new: m.recallNew,
        },
      });
    }
    oldClaimed.set(oldId, -1);                // sentinel: mark this old "consumed by split"
  }

  // Third pass: MERGE detection. A new cluster that has ≥2 olds related to
  // it (and hasn't been claimed) → merge. Use recall_new (% of new's
  // members that came from each old) — the metric for "did this new
  // collect significant chunks of multiple olds?".
  const newToRelated = new Map<number, Match[]>();
  for (const m of matches) {
    if (m.recallNew < RELATED_THRESHOLD || m.sameScore >= SAME_THRESHOLD) continue;
    if (oldClaimed.has(m.oldId)) continue;
    if (newAssigned.has(m.newId)) continue;
    if (!newToRelated.has(m.newId)) newToRelated.set(m.newId, []);
    newToRelated.get(m.newId)!.push(m);
  }
  for (const [newId, rels] of newToRelated) {
    if (rels.length < 2) continue;
    const newC = newClusters.get(newId)!;
    rels.sort((a, b) => b.recallNew - a.recallNew);
    const primary = oldClusters.get(rels[0].oldId)!;
    if (!primary.stable_id) continue;
    const stable_id = mintStableId(1);
    newAssigned.set(newId, stable_id);
    const mergedParents = rels
      .map(r => oldClusters.get(r.oldId)?.stable_id)
      .filter((s): s is string => Boolean(s));
    eventsToWrite.push({
      stable_id,
      parent_stable_id: primary.stable_id,
      event: 'merged',
      size_before: rels.reduce((sum, r) => sum + (oldClusters.get(r.oldId)?.video_ids.size ?? 0), 0),
      size_after: newC.video_ids.size,
      jaccard: rels[0].jaccard,
      payload: {
        merged_parents: mergedParents, prev_run_id: prevRunId, new_cluster_index: newC.cluster_index,
        primary_recall_new: rels[0].recallNew,
      },
    });
    for (const r of rels) oldClaimed.set(r.oldId, -1);
  }

  // Fourth pass: any new cluster still without stable_id → BORN
  let born = 0;
  for (const [newId, newC] of newClusters) {
    if (newAssigned.has(newId)) continue;
    const stable_id = mintStableId(1);
    newAssigned.set(newId, stable_id);
    eventsToWrite.push({
      stable_id,
      parent_stable_id: null,
      event: 'born',
      size_before: null,
      size_after: newC.video_ids.size,
      jaccard: null,
      payload: { prev_run_id: prevRunId, new_cluster_index: newC.cluster_index },
    });
    born++;
  }

  // Fifth pass: any old cluster never claimed → DIED
  let died = 0;
  for (const [oldId, oldC] of oldClusters) {
    if (oldClaimed.has(oldId)) continue;
    if (!oldC.stable_id) continue;
    eventsToWrite.push({
      stable_id: oldC.stable_id,
      parent_stable_id: null,
      event: 'died',
      size_before: oldC.video_ids.size,
      size_after: null,
      jaccard: null,
      payload: { prev_run_id: prevRunId, prev_cluster_index: oldC.cluster_index },
    });
    died++;
  }

  // Persist: stable_ids in a single round-trip via UPDATE FROM VALUES.
  // Per-row UPDATE on 800+ clusters was eating 5 minutes of network
  // round trips; batched it's <1s.
  if (newAssigned.size > 0) {
    const updateRows: string[] = [];
    const updateArgs: (string | number | null)[] = [];
    let p = 1;
    for (const [newId, stable_id] of newAssigned) {
      const newC = newClusters.get(newId)!;
      const ev = eventsToWrite.find(e => e.stable_id === stable_id);
      const parent_stable_id = ev?.parent_stable_id ?? null;
      updateRows.push(`($${p++}::int, $${p++}::text, $${p++}::text)`);
      updateArgs.push(newC.cluster_id, stable_id, parent_stable_id);
    }
    await pool.query(
      `UPDATE niche_tree_clusters c
          SET stable_id = v.stable_id,
              parent_stable_id = v.parent_stable_id
         FROM (VALUES ${updateRows.join(', ')}) AS v(id, stable_id, parent_stable_id)
        WHERE c.id = v.id`,
      updateArgs,
    );
  }

  // Bulk-insert events — same chunked-multi-row approach.
  if (eventsToWrite.length > 0) {
    const CHUNK = 500;
    for (let off = 0; off < eventsToWrite.length; off += CHUNK) {
      const chunk = eventsToWrite.slice(off, off + CHUNK);
      const rows: string[] = [];
      const args: (number | string | null | object)[] = [];
      let p = 1;
      for (const ev of chunk) {
        rows.push(`($${p++}, $${p++}, $${p++}, $${p++}, 1, $${p++}, $${p++}, $${p++}, $${p++})`);
        args.push(
          currentRunId, ev.stable_id, ev.parent_stable_id, ev.event,
          ev.size_before, ev.size_after, ev.jaccard, ev.payload,
        );
      }
      await pool.query(
        `INSERT INTO niche_cluster_events
           (run_id, stable_id, parent_stable_id, event, level, size_before, size_after, jaccard, payload)
         VALUES ${rows.join(', ')}`,
        args,
      );
    }
  }

  // Tally
  const counts = { same: 0, grew: 0, shrank: 0, split: 0, merged: 0 };
  for (const ev of eventsToWrite) {
    if (ev.event in counts) counts[ev.event as keyof typeof counts]++;
  }

  return {
    ok: true,
    matched: counts,
    born,
    died,
    prevRunId,
    totalNewClusters: newClusters.size,
  };
}

/**
 * Stitch L2 clusters scoped to a single L1 parent.
 *
 * Called by the L2 baking loop after each L1 cluster's subdivide
 * finishes. The new L2 clusters live under `currentL1ClusterId` (in the
 * current run); the predecessor L2s live under whatever old L1 had the
 * SAME stable_id as currentL1ClusterId (the prior run's L1 with this
 * stable_id, if any).
 *
 *   - If the L1's stable_id was inherited (same/grew/shrank): match new
 *     L2s against old L2s under the inherited identity.
 *   - If the L1 was BORN or SPLIT: there's no L2 predecessor — all new
 *     L2s are "born" with no parent_stable_id from L2 stitching (they
 *     do still have parent_stable_id = the L1's stable_id by virtue of
 *     niche_tree_clusters.parent_cluster_id, but that's the niche-tree
 *     hierarchy, not stitching lineage).
 *   - If the L1 was MERGED: there are multiple old L2 sets to match
 *     against; we union them and let the matcher resolve as usual.
 *
 * Same tiered matching rule as L1: jaccard / recall_old / recall_new
 * each ≥ 0.5 → SAME. SPLIT / MERGED / BORN / DIED follow the L1 logic.
 */
export async function stitchL2ForL1(
  pool: Pool,
  currentRunId: number,
  currentL1ClusterId: number,
  currentL1StableId: string,
): Promise<{
  matched: { same: number; grew: number; shrank: number; split: number; merged: number };
  born: number;
  died: number;
  prevL1ClusterIds: number[];
  totalNewL2: number;
}> {
  // Find any prior L1 cluster row(s) that share this stable_id (the
  // history of this niche identity). Ordered by run_id DESC so the
  // most-recent prior wins for typical "last good predecessor" use.
  const prevL1Res = await pool.query<{ id: number; run_id: number }>(
    `SELECT id, run_id FROM niche_tree_clusters
      WHERE stable_id = $1 AND id != $2 AND level = 1
      ORDER BY run_id DESC`,
    [currentL1StableId, currentL1ClusterId],
  );
  const prevL1ClusterIds = prevL1Res.rows.map(r => r.id);

  // Load the current L1's L2 children (members keyed by L2 cluster_id).
  // niche_tree_clusters.parent_cluster_id points to the L1 row id.
  const newL2Res = await pool.query<{
    cluster_id: number; cluster_index: number; video_id: number;
  }>(
    `SELECT a.cluster_id, c.cluster_index, a.video_id
       FROM niche_tree_assignments a
       JOIN niche_tree_clusters c ON c.id = a.cluster_id
      WHERE a.cluster_id IS NOT NULL AND c.level = 2
        AND c.parent_cluster_id = $1`,
    [currentL1ClusterId],
  );
  const newL2 = new Map<number, ClusterMembers>();
  for (const row of newL2Res.rows) {
    let entry = newL2.get(row.cluster_id);
    if (!entry) {
      entry = { cluster_id: row.cluster_id, cluster_index: row.cluster_index, stable_id: null, video_ids: new Set() };
      newL2.set(row.cluster_id, entry);
    }
    entry.video_ids.add(row.video_id);
  }

  // No L2 children to stitch — bail (this happens for tiny L1s).
  if (newL2.size === 0) {
    return {
      matched: { same: 0, grew: 0, shrank: 0, split: 0, merged: 0 },
      born: 0, died: 0,
      prevL1ClusterIds, totalNewL2: 0,
    };
  }

  // Cold-start path: no prior L1 with this stable_id → everything's
  // born. (Happens for genuinely-new L1 niches.)
  if (prevL1ClusterIds.length === 0) {
    let born = 0;
    for (const c of newL2.values()) {
      const sid = mintStableId(2);
      await pool.query(
        `UPDATE niche_tree_clusters SET stable_id = $1, parent_stable_id = $2 WHERE id = $3`,
        [sid, currentL1StableId, c.cluster_id],
      );
      await pool.query(
        `INSERT INTO niche_cluster_events
           (run_id, stable_id, parent_stable_id, event, level, size_after, payload)
         VALUES ($1, $2, $3, 'born', 2, $4, $5)`,
        [currentRunId, sid, currentL1StableId, c.video_ids.size, { reason: 'l1-no-prior' }],
      );
      born++;
    }
    return {
      matched: { same: 0, grew: 0, shrank: 0, split: 0, merged: 0 },
      born, died: 0,
      prevL1ClusterIds, totalNewL2: newL2.size,
    };
  }

  // Load old L2s — union of children from ALL matching prior L1s (handles
  // merged L1s). De-dup by L2 cluster_id (run_id is implicit in the row).
  const oldL2Res = await pool.query<{
    cluster_id: number; cluster_index: number; stable_id: string | null; video_id: number;
  }>(
    `SELECT a.cluster_id, c.cluster_index, c.stable_id, a.video_id
       FROM niche_tree_assignments a
       JOIN niche_tree_clusters c ON c.id = a.cluster_id
      WHERE a.cluster_id IS NOT NULL AND c.level = 2
        AND c.parent_cluster_id = ANY($1::int[])`,
    [prevL1ClusterIds],
  );
  const oldL2 = new Map<number, ClusterMembers>();
  for (const row of oldL2Res.rows) {
    let entry = oldL2.get(row.cluster_id);
    if (!entry) {
      entry = { cluster_id: row.cluster_id, cluster_index: row.cluster_index, stable_id: row.stable_id, video_ids: new Set() };
      oldL2.set(row.cluster_id, entry);
    }
    entry.video_ids.add(row.video_id);
  }

  // Compute overlap matrix with same tiered metric as L1.
  type Match = { oldId: number; newId: number; inter: number; jaccard: number; recallOld: number; recallNew: number; sameScore: number };
  const matches: Match[] = [];
  for (const [newId, newC] of newL2) {
    for (const [oldId, oldC] of oldL2) {
      let inter = 0;
      const [smaller, larger] = oldC.video_ids.size <= newC.video_ids.size
        ? [oldC.video_ids, newC.video_ids]
        : [newC.video_ids, oldC.video_ids];
      for (const v of smaller) if (larger.has(v)) inter++;
      if (inter === 0) continue;
      const j = inter / (oldC.video_ids.size + newC.video_ids.size - inter);
      const ro = inter / oldC.video_ids.size;
      const rn = inter / newC.video_ids.size;
      const sameScore = Math.max(j, ro, rn);
      if (sameScore >= 0.05) {
        matches.push({ oldId, newId, inter, jaccard: j, recallOld: ro, recallNew: rn, sameScore });
      }
    }
  }
  matches.sort((a, b) => b.inter - a.inter || b.sameScore - a.sameScore);

  const oldClaimed = new Map<number, number>();
  const newAssigned = new Map<number, string>();
  const eventsToWrite: Array<{
    stable_id: string;
    parent_stable_id: string | null;
    event: string;
    size_before: number | null;
    size_after: number | null;
    jaccard: number | null;
    payload: Record<string, unknown>;
  }> = [];

  // SAME pass
  for (const m of matches) {
    if (m.sameScore < SAME_THRESHOLD) break;
    if (oldClaimed.has(m.oldId)) continue;
    if (newAssigned.has(m.newId)) continue;
    const oldC = oldL2.get(m.oldId)!;
    const newC = newL2.get(m.newId)!;
    if (!oldC.stable_id) continue;
    oldClaimed.set(m.oldId, m.newId);
    newAssigned.set(m.newId, oldC.stable_id);
    const sizeDelta = newC.video_ids.size - oldC.video_ids.size;
    const event = sizeDelta === 0 ? 'same' : sizeDelta > 0 ? 'grew' : 'shrank';
    eventsToWrite.push({
      stable_id: oldC.stable_id,
      parent_stable_id: currentL1StableId,        // L2's L1 parent stable_id, always set
      event,
      size_before: oldC.video_ids.size,
      size_after: newC.video_ids.size,
      jaccard: m.jaccard,
      payload: { delta: sizeDelta, recall_old: m.recallOld, recall_new: m.recallNew },
    });
  }

  // SPLIT
  const oldToRelated = new Map<number, Match[]>();
  for (const m of matches) {
    if (m.recallOld < RELATED_THRESHOLD || m.sameScore >= SAME_THRESHOLD) continue;
    if (oldClaimed.has(m.oldId)) continue;
    if (newAssigned.has(m.newId)) continue;
    if (!oldToRelated.has(m.oldId)) oldToRelated.set(m.oldId, []);
    oldToRelated.get(m.oldId)!.push(m);
  }
  for (const [oldId, rels] of oldToRelated) {
    if (rels.length < 2) continue;
    const oldC = oldL2.get(oldId)!;
    if (!oldC.stable_id) continue;
    for (const m of rels) {
      if (newAssigned.has(m.newId)) continue;
      const newC = newL2.get(m.newId)!;
      const sid = mintStableId(2);
      newAssigned.set(m.newId, sid);
      eventsToWrite.push({
        stable_id: sid,
        parent_stable_id: currentL1StableId,
        event: 'split',
        size_before: oldC.video_ids.size,
        size_after: newC.video_ids.size,
        jaccard: m.jaccard,
        payload: { from_l2: oldC.stable_id, sibling_count: rels.length, recall_old: m.recallOld },
      });
    }
    oldClaimed.set(oldId, -1);
  }

  // MERGE
  const newToRelated = new Map<number, Match[]>();
  for (const m of matches) {
    if (m.recallNew < RELATED_THRESHOLD || m.sameScore >= SAME_THRESHOLD) continue;
    if (oldClaimed.has(m.oldId)) continue;
    if (newAssigned.has(m.newId)) continue;
    if (!newToRelated.has(m.newId)) newToRelated.set(m.newId, []);
    newToRelated.get(m.newId)!.push(m);
  }
  for (const [newId, rels] of newToRelated) {
    if (rels.length < 2) continue;
    const newC = newL2.get(newId)!;
    rels.sort((a, b) => b.recallNew - a.recallNew);
    const sid = mintStableId(2);
    newAssigned.set(newId, sid);
    const mergedParents = rels.map(r => oldL2.get(r.oldId)?.stable_id).filter((s): s is string => Boolean(s));
    eventsToWrite.push({
      stable_id: sid,
      parent_stable_id: currentL1StableId,
      event: 'merged',
      size_before: rels.reduce((sum, r) => sum + (oldL2.get(r.oldId)?.video_ids.size ?? 0), 0),
      size_after: newC.video_ids.size,
      jaccard: rels[0].jaccard,
      payload: { merged_l2_parents: mergedParents },
    });
    for (const r of rels) oldClaimed.set(r.oldId, -1);
  }

  // BORN
  let born = 0;
  for (const [newId, newC] of newL2) {
    if (newAssigned.has(newId)) continue;
    const sid = mintStableId(2);
    newAssigned.set(newId, sid);
    eventsToWrite.push({
      stable_id: sid,
      parent_stable_id: currentL1StableId,
      event: 'born',
      size_before: null,
      size_after: newC.video_ids.size,
      jaccard: null,
      payload: {},
    });
    born++;
  }

  // DIED
  let died = 0;
  for (const [oldId, oldC] of oldL2) {
    if (oldClaimed.has(oldId)) continue;
    if (!oldC.stable_id) continue;
    eventsToWrite.push({
      stable_id: oldC.stable_id,
      parent_stable_id: currentL1StableId,
      event: 'died',
      size_before: oldC.video_ids.size,
      size_after: null,
      jaccard: null,
      payload: {},
    });
    died++;
  }

  // Persist stable_ids onto current L2 rows in one round trip
  if (newAssigned.size > 0) {
    const updateRows: string[] = [];
    const updateArgs: (string | number)[] = [];
    let p = 1;
    for (const [newId, sid] of newAssigned) {
      const newC = newL2.get(newId)!;
      updateRows.push(`($${p++}::int, $${p++}::text)`);
      updateArgs.push(newC.cluster_id, sid);
    }
    await pool.query(
      `UPDATE niche_tree_clusters c
          SET stable_id = v.stable_id,
              parent_stable_id = $${p++}
         FROM (VALUES ${updateRows.join(', ')}) AS v(id, stable_id)
        WHERE c.id = v.id`,
      [...updateArgs, currentL1StableId],
    );
  }

  // Persist events in one round trip
  if (eventsToWrite.length > 0) {
    const rows: string[] = [];
    const args: (number | string | null | object)[] = [];
    let p = 1;
    for (const ev of eventsToWrite) {
      rows.push(`($${p++}, $${p++}, $${p++}, $${p++}, 2, $${p++}, $${p++}, $${p++}, $${p++})`);
      args.push(currentRunId, ev.stable_id, ev.parent_stable_id, ev.event,
                ev.size_before, ev.size_after, ev.jaccard, ev.payload);
    }
    await pool.query(
      `INSERT INTO niche_cluster_events
         (run_id, stable_id, parent_stable_id, event, level, size_before, size_after, jaccard, payload)
       VALUES ${rows.join(', ')}`,
      args,
    );
  }

  const counts = { same: 0, grew: 0, shrank: 0, split: 0, merged: 0 };
  for (const ev of eventsToWrite) {
    if (ev.event in counts) counts[ev.event as keyof typeof counts]++;
  }
  return { matched: counts, born, died, prevL1ClusterIds, totalNewL2: newL2.size };
}
