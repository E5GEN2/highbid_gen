/**
 * Per-channel Shorts profile — used to exclude Shorts-focused channels from
 * the content-gen draft/hero pool (user 2026-06-20 #14). Computed LAZILY and
 * ONLY for channels that become draft candidates (never a full-DB pass), then
 * cached in content_gen_channel_shorts so repeat draft loads are cheap.
 *
 * Policy: a channel is "Shorts-focused" (excluded) if ≥95% of its recent
 * uploads are Shorts (≤61s) OR it has posted no long video in the last 3
 * months. Unknown (too-small duration sample) → NOT excluded (keep).
 */
import { getPool } from '../db';
import { fetchChannelRecentUploads } from '../yt-recent-uploads';
import { pickRandomActiveYtPair } from '../yt-keys';

export interface ShortsProfile {
  channel_id: string;
  shorts_ratio: number;          // 0..1 over the sampled recent uploads with a known duration
  last_long_upload_at: string | null;
  sample_n: number;              // # of sampled uploads with a known duration
  computed_at: string;
}

const FRESH_MS = 14 * 24 * 3600 * 1000;  // reuse a cached profile for 14 days
const SHORT_MAX_S = 61;                  // ≤61s ⇒ a Short (matches deep-analysis)
const SHORTS_RATIO_GATE = 0.95;          // ≥95% shorts ⇒ excluded
const NO_LONG_MONTHS = 3;                // no long upload in N months ⇒ excluded
const MIN_SAMPLE = 5;                    // below this, "unknown" — never exclude

/** Cache-first shorts profile for ONE channel. Returns null only when there's
 *  neither a cached row nor a usable YT key. */
export async function getShortsProfile(channelId: string): Promise<ShortsProfile | null> {
  const pool = await getPool();
  const cached = (await pool.query<ShortsProfile>(
    `SELECT channel_id, shorts_ratio, last_long_upload_at::text AS last_long_upload_at,
            sample_n, computed_at::text AS computed_at
       FROM content_gen_channel_shorts WHERE channel_id = $1`, [channelId],
  )).rows[0] ?? null;
  if (cached && (Date.now() - new Date(cached.computed_at).getTime()) < FRESH_MS) return cached;

  const pair = await pickRandomActiveYtPair();
  if (!pair) return cached;  // no key → reuse stale if present, else null

  // The uploads playlist id is the channel id with a "UU" prefix.
  const uploadsPlaylistId = channelId.startsWith('UC') ? 'UU' + channelId.slice(2) : channelId;
  try {
    const res = await fetchChannelRecentUploads(uploadsPlaylistId, pair, { maxVideos: 50 });
    const dated = res.videos.filter(v => v.durationSeconds != null);
    const longs = dated.filter(v => (v.durationSeconds ?? 0) > SHORT_MAX_S);
    const shortsN = dated.length - longs.length;
    const lastLong = longs.map(v => v.publishedAt).filter((p): p is string => !!p).sort().pop() ?? null;
    const prof: ShortsProfile = {
      channel_id: channelId,
      shorts_ratio: dated.length ? shortsN / dated.length : 0,
      last_long_upload_at: lastLong,
      sample_n: dated.length,
      computed_at: new Date().toISOString(),
    };
    await pool.query(
      `INSERT INTO content_gen_channel_shorts (channel_id, shorts_ratio, last_long_upload_at, sample_n, computed_at)
       VALUES ($1,$2,$3,$4,NOW())
       ON CONFLICT (channel_id) DO UPDATE SET shorts_ratio = EXCLUDED.shorts_ratio,
         last_long_upload_at = EXCLUDED.last_long_upload_at, sample_n = EXCLUDED.sample_n, computed_at = NOW()`,
      [prof.channel_id, prof.shorts_ratio, prof.last_long_upload_at, prof.sample_n],
    );
    return prof;
  } catch {
    return cached;  // transient YT failure → reuse stale if present
  }
}

/** Drop Shorts-focused channels from a candidate pool. Profiles ONLY the
 *  top-`topK` candidates by score (the realistic draft picks — NOT the whole
 *  pool/DB; user 2026-06-20), cached + concurrency-limited. Channels ranked
 *  below topK, or with no usable profile, are kept. The assembler is unchanged
 *  — it just receives a pool with the Shorts-focused candidates removed, so an
 *  excluded channel's niche slot refills with the next candidate (replace, not
 *  delete). */
export async function filterShortsFocusedCandidates<T extends { channel_id: string; composite_score: number }>(
  candidates: T[], topK = 60, concurrency = 6,
): Promise<{ kept: T[]; excluded: string[] }> {
  const top = [...candidates].sort((a, b) => b.composite_score - a.composite_score).slice(0, topK);
  const focused = new Set<string>();
  let i = 0;
  const worker = async () => {
    while (i < top.length) {
      const c = top[i++];
      try { if (isShortsFocused(await getShortsProfile(c.channel_id))) focused.add(c.channel_id); }
      catch { /* keep on error */ }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return { kept: candidates.filter(c => !focused.has(c.channel_id)), excluded: [...focused] };
}

/** The exclusion decision. Unknown (sample too small / null) → keep (false). */
export function isShortsFocused(p: ShortsProfile | null): boolean {
  if (!p || p.sample_n < MIN_SAMPLE) return false;
  if (p.shorts_ratio >= SHORTS_RATIO_GATE) return true;
  const cutoff = Date.now() - NO_LONG_MONTHS * 30.44 * 24 * 3600 * 1000;
  if (!p.last_long_upload_at || new Date(p.last_long_upload_at).getTime() < cutoff) return true;
  return false;
}
