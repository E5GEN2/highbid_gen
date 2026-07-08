import { NextRequest, NextResponse } from 'next/server';
import { isAdmin } from '@/lib/admin-auth';
import { getPool } from '@/lib/db';
import { vectorPool } from '@/lib/vector-db';
import { readQwenConfig, qwenHealth, ensureQwenBackfillRunning } from '@/lib/qwen-embed';

/**
 * Qwen embedding-space backfill control + status.
 *
 * GET  /api/admin/qwen-embed
 *   Config (token masked), queue/vector counts, last-hour rate, loop
 *   heartbeat, live health probe of the Colab server.
 *
 * POST /api/admin/qwen-embed
 *   Body: { url?, token?, enabled?, batch? } — upsert any subset into
 *   admin_config. Setting enabled=true also (re)starts the in-process loop.
 *   Rotate url/token here on every Colab/ngrok restart; no deploy needed.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const KEY_MAP: Record<string, string> = {
  url: 'qwen_embed_url',
  token: 'qwen_embed_token',
  enabled: 'qwen_backfill_enabled',
  batch: 'qwen_backfill_batch',
};

export async function GET(req: NextRequest) {
  if (!(await isAdmin(req))) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  const pool = await getPool();
  const cfg = await readQwenConfig();

  const [queue, stamped, vectors, lastHour, stamps] = await Promise.all([
    pool.query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM niche_spy_videos
        WHERE qwen_embedded_v1_at IS NULL
          AND title IS NOT NULL AND title <> ''
          AND thumbnail IS NOT NULL AND thumbnail <> ''
          AND thumbnail_dead_at IS NULL`,
    ),
    pool.query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM niche_spy_videos WHERE qwen_embedded_v1_at IS NOT NULL`,
    ),
    vectorPool.query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM niche_video_vectors_qwen_v1`,
    ).catch(() => ({ rows: [{ n: '0' }] })),
    pool.query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM niche_spy_videos WHERE qwen_embedded_v1_at > NOW() - INTERVAL '1 hour'`,
    ),
    pool.query<{ key: string; value: string }>(
      `SELECT key, value FROM admin_config WHERE key IN ('qwen_backfill_last_tick', 'qwen_backfill_note')`,
    ),
  ]);
  const stampMap: Record<string, string> = {};
  for (const r of stamps.rows) stampMap[r.key] = r.value;

  return NextResponse.json({
    config: {
      url: cfg.url,
      token: cfg.token ? cfg.token.slice(0, 6) + '…' : '',
      enabled: cfg.enabled,
      batch: cfg.batch,
    },
    queueRemaining: parseInt(queue.rows[0].n),
    stampedTotal: parseInt(stamped.rows[0].n),
    vectorsStored: parseInt(vectors.rows[0].n),
    embeddedLastHour: parseInt(lastHour.rows[0].n),
    loop: {
      lastTick: stampMap.qwen_backfill_last_tick || null,
      note: stampMap.qwen_backfill_note || null,
    },
    serverHealth: await qwenHealth(cfg),
  });
}

export async function POST(req: NextRequest) {
  if (!(await isAdmin(req))) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  const body = await req.json().catch(() => ({}));
  const pool = await getPool();

  for (const [short, key] of Object.entries(KEY_MAP)) {
    if (body[short] === undefined) continue;
    await pool.query(
      `INSERT INTO admin_config (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = $2`,
      [key, String(body[short])],
    );
  }
  if (String(body.enabled) === 'true') ensureQwenBackfillRunning();

  const cfg = await readQwenConfig();
  return NextResponse.json({
    ok: true,
    config: { url: cfg.url, token: cfg.token ? cfg.token.slice(0, 6) + '…' : '', enabled: cfg.enabled, batch: cfg.batch },
  });
}
