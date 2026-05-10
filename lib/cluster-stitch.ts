/**
 * Cluster stitching — assigns stable_ids to a freshly-clustered run by
 * matching its clusters against the previous "done" L1 run via member-set
 * Jaccard overlap.
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
 * Resolution rules per (old, new) pair:
 *   jaccard ≥ 0.5  → SAME cluster, inherit stable_id, log size delta
 *   0.2 ≤ j < 0.5  + two news compete for one old → SPLIT
 *   0.2 ≤ j < 0.5  + two olds map into one new → MERGE
 *   no successor for old → DIED
 *   no predecessor for new → BORN, mint fresh stable_id
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

  // Compute overlap matrix: for each (old, new), compute Jaccard.
  // Skip pairs whose intersection is 0 — saves a lot of work because most
  // pairs share zero members.
  type Match = { oldId: number; newId: number; jaccard: number };
  const matches: Match[] = [];
  for (const [newId, newC] of newClusters) {
    for (const [oldId, oldC] of oldClusters) {
      // Quick test: do they share any members at all?
      let any = false;
      for (const v of newC.video_ids) if (oldC.video_ids.has(v)) { any = true; break; }
      if (!any) continue;
      const j = jaccard(oldC.video_ids, newC.video_ids);
      if (j >= 0.05) matches.push({ oldId, newId, jaccard: j });   // floor to keep matrix small
    }
  }

  // Sort matches by jaccard descending — we'll greedily resolve from the
  // strongest signals first.
  matches.sort((a, b) => b.jaccard - a.jaccard);

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

  // First pass: SAME (jaccard ≥ 0.5). Greedy — strongest match wins.
  for (const m of matches) {
    if (m.jaccard < SAME_THRESHOLD) break;
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
      payload: { delta: sizeDelta, prev_run_id: prevRunId, prev_cluster_index: oldC.cluster_index, new_cluster_index: newC.cluster_index },
    });
  }

  // Second pass: SPLIT detection. An old cluster that wasn't claimed yet
  // but has ≥2 new clusters in the related-threshold zone → split.
  // The strongest of the related new clusters inherits (downgraded) and
  // the others get new stable_ids with parent_stable_id set.
  const oldToRelated = new Map<number, Match[]>();
  for (const m of matches) {
    if (m.jaccard < RELATED_THRESHOLD || m.jaccard >= SAME_THRESHOLD) continue;
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
        payload: { from: oldC.stable_id, sibling_count: rels.length, prev_run_id: prevRunId, prev_cluster_index: oldC.cluster_index, new_cluster_index: newC.cluster_index },
      });
    }
    oldClaimed.set(oldId, -1);                // sentinel: mark this old "consumed by split"
  }

  // Third pass: MERGE detection. A new cluster that has ≥2 olds related to
  // it (and hasn't been claimed) → merge. Mint a new stable_id with
  // parent_stable_id set (we record only the strongest parent; others go
  // into payload.merged_parents for forensics).
  const newToRelated = new Map<number, Match[]>();
  for (const m of matches) {
    if (m.jaccard < RELATED_THRESHOLD || m.jaccard >= SAME_THRESHOLD) continue;
    if (oldClaimed.has(m.oldId)) continue;
    if (newAssigned.has(m.newId)) continue;
    if (!newToRelated.has(m.newId)) newToRelated.set(m.newId, []);
    newToRelated.get(m.newId)!.push(m);
  }
  for (const [newId, rels] of newToRelated) {
    if (rels.length < 2) continue;
    const newC = newClusters.get(newId)!;
    rels.sort((a, b) => b.jaccard - a.jaccard);
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
      payload: { merged_parents: mergedParents, prev_run_id: prevRunId, new_cluster_index: newC.cluster_index },
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

  // Persist: stable_ids onto current clusters, then events log
  for (const [newId, stable_id] of newAssigned) {
    const newC = newClusters.get(newId)!;
    const ev = eventsToWrite.find(e => e.stable_id === stable_id);
    const parent_stable_id = ev?.parent_stable_id ?? null;
    await pool.query(
      `UPDATE niche_tree_clusters SET stable_id = $1, parent_stable_id = $2 WHERE id = $3`,
      [stable_id, parent_stable_id, newC.cluster_id],
    );
  }

  // Bulk-insert events
  for (const ev of eventsToWrite) {
    await pool.query(
      `INSERT INTO niche_cluster_events
         (run_id, stable_id, parent_stable_id, event, level, size_before, size_after, jaccard, payload)
       VALUES ($1, $2, $3, $4, 1, $5, $6, $7, $8)`,
      [
        currentRunId, ev.stable_id, ev.parent_stable_id, ev.event,
        ev.size_before, ev.size_after, ev.jaccard, ev.payload,
      ],
    );
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
