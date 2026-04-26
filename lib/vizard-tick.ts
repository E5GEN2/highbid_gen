/**
 * Shared Vizard polling tick.
 *
 * Lives outside the route directory so it can be imported from multiple
 * route handlers without violating Next.js's "no non-route exports from
 * route.ts" rule.
 *
 * Called from:
 *   - POST /api/admin/vizard/tick   (admin-token gated, manual trigger)
 *   - GET  /api/cron/vizard         (cron_secret gated, server-side cron)
 *
 * Polls Vizard for every vizard_project with status in ('pending', 'processing')
 * that has a vizard_project_id. Per project:
 *   - code 2000 → mark done, upsert clips
 *   - code 1000 → mark processing, bump last_polled_at
 *   - code 4xxx → mark error
 *
 * Internal rate limit: only polls projects whose last_polled_at is >25s
 * old, matching Vizard's 30s polling recommendation. Calling this twice
 * within 25s won't double-hit Vizard.
 */

import { getPool } from './db';
import { queryVizardProject, getVizardApiKey, type VizardClip } from './vizard';

export type VizardTickResult =
  | { ok: false; reason: 'no_api_key'; polled: 0; done: 0; errors: 0 }
  | { ok: true; polled: number; done: number; errors: number };

export async function runVizardTick(): Promise<VizardTickResult> {
  const pool = await getPool();
  const apiKey = await getVizardApiKey();
  if (!apiKey) {
    return { ok: false, reason: 'no_api_key', polled: 0, done: 0, errors: 0 };
  }

  const dueRes = await pool.query<{ id: number; vizard_project_id: string }>(
    `SELECT id, vizard_project_id
     FROM vizard_projects
     WHERE vizard_project_id IS NOT NULL
       AND status IN ('pending', 'processing')
       AND (last_polled_at IS NULL OR last_polled_at < NOW() - INTERVAL '25 seconds')
     ORDER BY created_at ASC
     LIMIT 10`
  );

  // Self-heal: idempotently create the unique index that ON CONFLICT
  // depends on (in case schema init hasn't run after a column add).
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_vizard_clips_vizard_video_id
     ON vizard_clips(vizard_video_id) WHERE vizard_video_id IS NOT NULL`
  ).catch(() => {});

  let polled = 0, done = 0, errors = 0;

  for (const row of dueRes.rows) {
    polled++;
    try {
      const result = await queryVizardProject(row.vizard_project_id, apiKey);

      // 2000 = done. Upsert clips, flip project to done.
      if (result.code === 2000 && Array.isArray(result.videos)) {
        for (const clip of result.videos as VizardClip[]) {
          // Two-step upsert: DELETE then INSERT. Avoids ON CONFLICT inference
          // edge cases on partial unique indexes.
          await pool.query(
            `DELETE FROM vizard_clips WHERE vizard_video_id = $1`,
            [String(clip.videoId)]
          );
          await pool.query(
            `INSERT INTO vizard_clips
               (project_id, vizard_video_id, video_url, duration_ms, title,
                transcript, viral_score, viral_reason, related_topic, clip_editor_url)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [
              row.id,
              String(clip.videoId),
              clip.videoUrl,
              clip.videoMsDuration,
              clip.title,
              clip.transcript,
              clip.viralScore,
              clip.viralReason,
              clip.relatedTopic,
              clip.clipEditorUrl,
            ]
          );
        }
        await pool.query(
          `UPDATE vizard_projects
           SET status = 'done', last_code = $1, clip_count = $2,
               last_polled_at = NOW(), completed_at = NOW(), error_message = NULL
           WHERE id = $3`,
          [result.code, result.videos.length, row.id]
        );
        done++;
        continue;
      }

      // 1000 = still processing. Just bump last_polled_at.
      if (result.code === 1000) {
        await pool.query(
          `UPDATE vizard_projects
           SET status = 'processing', last_code = $1, last_polled_at = NOW()
           WHERE id = $2`,
          [result.code, row.id]
        );
        continue;
      }

      // Any other code = error (4001-4008 per Vizard docs, plus 5xx leaks).
      await pool.query(
        `UPDATE vizard_projects
         SET status = 'error', last_code = $1, error_message = $2,
             last_polled_at = NOW(), completed_at = NOW()
         WHERE id = $3`,
        [result.code, result.errMsg || `Vizard code ${result.code}`, row.id]
      );
      errors++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown';
      await pool.query(
        `UPDATE vizard_projects
         SET last_polled_at = NOW(), error_message = $1
         WHERE id = $2`,
        [msg, row.id]
      );
      errors++;
    }
  }

  return { ok: true, polled, done, errors };
}
