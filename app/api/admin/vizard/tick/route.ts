import { NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { queryVizardProject, getVizardApiKey, type VizardClip } from '@/lib/vizard';

// Always run fresh — tick state lives in the DB, not in any cache.
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * POST or GET /api/admin/vizard/tick
 *
 * Polls Vizard for every vizard_project with status in ('pending', 'processing')
 * that has a vizard_project_id. For each:
 *   - code 2000 → mark done, upsert clips
 *   - code 1000 → mark processing, update last_polled_at
 *   - code 4xxx → mark error
 *
 * Called by:
 *   1. The admin UI from the Vizard tab (while at least one project is
 *      processing, the client pings tick every 30s, then re-fetches /projects).
 *   2. Optional future cron for headless progress.
 *
 * Rate limit: we look at projects polled >25s ago to give Vizard breathing
 * room, matching their 30s polling recommendation.
 */
async function runTick() {
  const pool = await getPool();
  const apiKey = await getVizardApiKey();
  if (!apiKey) {
    return { ok: false, reason: 'no_api_key' as const, polled: 0, done: 0, errors: 0 };
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

  let polled = 0, done = 0, errors = 0;

  for (const row of dueRes.rows) {
    polled++;
    try {
      const result = await queryVizardProject(row.vizard_project_id, apiKey);

      // 2000 = done. Upsert clips, flip project to done.
      if (result.code === 2000 && Array.isArray(result.videos)) {
        for (const clip of result.videos as VizardClip[]) {
          await pool.query(
            `INSERT INTO vizard_clips
               (project_id, vizard_video_id, video_url, duration_ms, title,
                transcript, viral_score, viral_reason, related_topic, clip_editor_url)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             ON CONFLICT (vizard_video_id) DO UPDATE SET
               video_url = EXCLUDED.video_url,
               duration_ms = EXCLUDED.duration_ms,
               title = EXCLUDED.title,
               transcript = EXCLUDED.transcript,
               viral_score = EXCLUDED.viral_score,
               viral_reason = EXCLUDED.viral_reason,
               related_topic = EXCLUDED.related_topic,
               clip_editor_url = EXCLUDED.clip_editor_url`,
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

      // Any other code = error (4001-4008 per docs, plus HTTP 5xx leaking through).
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

  return { ok: true as const, polled, done, errors };
}

export async function POST() {
  const result = await runTick();
  return NextResponse.json(result);
}

// Allow GET too so a user could cron it with a simple curl.
export async function GET() {
  const result = await runTick();
  return NextResponse.json(result);
}
