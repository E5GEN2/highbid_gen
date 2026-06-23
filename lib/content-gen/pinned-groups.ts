/**
 * Pinned draft-group snapshots — the durable layer that makes the Content Gen
 * "Niches" view stop reshuffling on every load.
 *
 * The assembler (assembleMixedDrafts) is a pure function of the LIVE candidate
 * pool, which drifts continuously: NOW()-based recency is 30% of composite_score,
 * new discoveries / re-enrichment change scores, a live thumbnail HEAD check
 * drops candidates fail-closed, and marking channels used shifts every slice. So
 * /drafts re-derived a different "top-N per niche" on every request and the group
 * you rendered dissolved before you could mark it used.
 *
 * This module freezes the assembled groups into content_gen_pinned_groups
 * (+ _members). /drafts serves the ACTIVE pins; only an explicit "Regenerate"
 * re-assembles. mark-used flips a pin to 'consumed' (kept greyed for audit) and
 * the route writes its EXACT channel set into content_gen_used_channels.
 */

import { getPool } from '../db';
import type { ListicleDraft, ListicleDraftItem } from './assembler';

function groupKey(draftId: string, n: number, salt: number): string {
  return `${draftId}__n${n}__${salt}`;
}

/** True if an active snapshot exists for this (mode, n). */
export async function hasActivePins(n: number, mode = 'mixed'): Promise<boolean> {
  const pool = await getPool();
  const r = await pool.query(
    `SELECT 1 FROM content_gen_pinned_groups WHERE status='active' AND mode=$1 AND n=$2 LIMIT 1`,
    [mode, n],
  );
  return (r.rowCount ?? 0) > 0;
}

interface PinnedGroupRow {
  group_key: string;
  draft_id: string;
  title: string;
  framing: string | null;
  mode: string;
  parent_l1_label: string | null;
  parent_l1_cluster_id: number | null;
  scale_mix_jsonb: ListicleDraft['scale_mix'] | null;
}

/**
 * Reconstruct ListicleDraft[] from pinned rows. The reconstructed draft.id is the
 * unique group_key (not the rotation id) so consumed + regenerated same-rotation
 * groups never collide on the React key / mark-used handle.
 */
async function readPinned(n: number, mode: string, status: 'active' | 'consumed'): Promise<ListicleDraft[]> {
  const pool = await getPool();
  const groups = await pool.query<PinnedGroupRow>(
    `SELECT group_key, draft_id, title, framing, mode, parent_l1_label, parent_l1_cluster_id, scale_mix_jsonb
       FROM content_gen_pinned_groups
      WHERE status=$1 AND mode=$2 AND n=$3
      ORDER BY created_at ASC`,
    [status, mode, n],
  );
  if ((groups.rowCount ?? 0) === 0) return [];
  const keys = groups.rows.map(g => g.group_key);
  const members = await pool.query<{ group_key: string; item_jsonb: ListicleDraftItem }>(
    `SELECT group_key, item_jsonb
       FROM content_gen_pinned_group_members
      WHERE group_key = ANY($1::text[])
      ORDER BY group_key, position ASC`,
    [keys],
  );
  const byGroup = new Map<string, ListicleDraftItem[]>();
  for (const m of members.rows) {
    if (!byGroup.has(m.group_key)) byGroup.set(m.group_key, []);
    byGroup.get(m.group_key)!.push(m.item_jsonb);
  }
  return groups.rows.map(g => ({
    id: g.group_key,
    title: g.title,
    framing: g.framing ?? '',
    mode: g.mode as ListicleDraft['mode'],
    parent_l1_label: g.parent_l1_label,
    parent_l1_cluster_id: g.parent_l1_cluster_id,
    items: byGroup.get(g.group_key) ?? [],
    scale_mix: g.scale_mix_jsonb ?? { small: 0, mid: 0, big: 0 },
  }));
}

export const readActivePinnedDrafts = (n: number, mode = 'mixed') => readPinned(n, mode, 'active');
export const readConsumedPinnedDrafts = (n: number, mode = 'mixed') => readPinned(n, mode, 'consumed');

/**
 * Replace the ACTIVE snapshot for (mode, n) with freshly-assembled drafts.
 * Consumed pins are left frozen. Wrapped in a transaction + an advisory lock so
 * two concurrent first-loads / Regenerates can't create duplicate active groups.
 */
export async function persistPinnedSnapshot(n: number, drafts: ListicleDraft[], mode = 'mixed'): Promise<void> {
  const pool = await getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Serialize persists for this (mode, n) — released on COMMIT/ROLLBACK.
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`cgpins:${mode}:${n}`]);
    // Drop the previous ACTIVE snapshot (members cascade). Consumed pins survive.
    await client.query(
      `DELETE FROM content_gen_pinned_groups WHERE status='active' AND mode=$1 AND n=$2`,
      [mode, n],
    );
    let salt = Date.now();
    for (const d of drafts) {
      if (d.items.length === 0) continue;
      const key = groupKey(d.id, n, salt++);
      await client.query(
        `INSERT INTO content_gen_pinned_groups
           (group_key, draft_id, title, framing, mode, n, parent_l1_label, parent_l1_cluster_id, scale_mix_jsonb, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'active')`,
        [key, d.id, d.title, d.framing, mode, n,
         d.parent_l1_label ?? null, d.parent_l1_cluster_id ?? null, JSON.stringify(d.scale_mix)],
      );
      for (let i = 0; i < d.items.length; i++) {
        const it = d.items[i];
        await client.query(
          `INSERT INTO content_gen_pinned_group_members (group_key, channel_id, position, item_jsonb)
             VALUES ($1,$2,$3,$4) ON CONFLICT (group_key, channel_id) DO NOTHING`,
          [key, it.candidate.channel_id, i, JSON.stringify(it)],
        );
      }
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Mark a pinned group consumed and return its EXACT channel set + audit labels.
 * The caller writes the channels into content_gen_used_channels. Returns empty
 * channelIds if the group_key is unknown.
 */
export async function consumePinnedGroup(
  key: string,
): Promise<{ channelIds: string[]; draftId: string; title: string }> {
  const pool = await getPool();
  const g = await pool.query<{ draft_id: string; title: string }>(
    `SELECT draft_id, title FROM content_gen_pinned_groups WHERE group_key=$1`, [key],
  );
  if ((g.rowCount ?? 0) === 0) return { channelIds: [], draftId: key, title: key };
  const m = await pool.query<{ channel_id: string }>(
    `SELECT channel_id FROM content_gen_pinned_group_members WHERE group_key=$1 ORDER BY position`, [key],
  );
  await pool.query(
    `UPDATE content_gen_pinned_groups SET status='consumed', consumed_at=NOW() WHERE group_key=$1`, [key],
  );
  return { channelIds: m.rows.map(r => r.channel_id), draftId: g.rows[0].draft_id, title: g.rows[0].title };
}

/** Un-consume a pinned group (flip back to active) and return its channel set. */
export async function freePinnedGroup(key: string): Promise<string[]> {
  const pool = await getPool();
  const m = await pool.query<{ channel_id: string }>(
    `SELECT channel_id FROM content_gen_pinned_group_members WHERE group_key=$1`, [key],
  );
  await pool.query(
    `UPDATE content_gen_pinned_groups SET status='active', consumed_at=NULL WHERE group_key=$1`, [key],
  );
  return m.rows.map(r => r.channel_id);
}
