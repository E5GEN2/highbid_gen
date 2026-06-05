import { NextRequest, NextResponse } from 'next/server';
import { isAdmin } from '@/lib/admin-auth';
import { getPool } from '@/lib/db';
import { getOrEstimateRpm } from '@/lib/content-gen/rpm';

/**
 * Per-niche RPM cache.
 *
 * POST { videoIds?: number[], niches?: string[], geo?: string, force?: boolean }
 *   - videoIds → resolves each to its channel's analyzed niche_label
 *     (content_gen_channel_analysis) and estimates RPM for each distinct
 *     niche.
 *   - niches → estimate RPM for explicit niche labels.
 *   - Returns the {rpm_low, rpm_typical, rpm_high} per niche (cached or
 *     freshly estimated).
 *
 * GET ?niches=a,b  OR  (no params) → read the cache.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 120;

export async function POST(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin token required' }, { status: 403 });
  const body = await req.json().catch(() => ({})) as { videoIds?: number[]; niches?: string[]; geo?: string; force?: boolean };
  const geo = (body.geo ?? 'en').trim();
  const force = body.force === true;

  const pool = await getPool();
  const nicheLabels = new Set<string>();

  if (Array.isArray(body.niches)) {
    for (const n of body.niches) if (n && n.trim()) nicheLabels.add(n.trim());
  }
  if (Array.isArray(body.videoIds) && body.videoIds.length > 0) {
    const r = await pool.query<{ niche_label: string | null }>(
      `SELECT DISTINCT cga.niche_label
         FROM niche_spy_videos v
         JOIN content_gen_channel_analysis cga ON cga.channel_id = v.channel_id
        WHERE v.id = ANY($1::int[]) AND cga.niche_label IS NOT NULL`,
      [body.videoIds.filter(n => Number.isFinite(n))],
    );
    for (const row of r.rows) if (row.niche_label) nicheLabels.add(row.niche_label);
  }

  if (nicheLabels.size === 0) {
    return NextResponse.json({ error: 'no niches resolved — pass niches[] or videoIds[] whose channels are analyzed' }, { status: 400 });
  }

  const results = await Promise.all(Array.from(nicheLabels).map(async (label) => {
    try {
      const rpm = await getOrEstimateRpm(label, geo, force);
      return { niche: label, ...rpm };
    } catch (e) {
      return { niche: label, error: (e as Error).message };
    }
  }));

  return NextResponse.json({
    ok: true,
    geo,
    estimated: results.filter(r => !('error' in r) && !(r as { cached?: boolean }).cached).length,
    fromCache: results.filter(r => (r as { cached?: boolean }).cached).length,
    errored: results.filter(r => 'error' in r).length,
    results,
  });
}

export async function GET(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin token required' }, { status: 403 });
  const pool = await getPool();
  const niches = (req.nextUrl.searchParams.get('niches') ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  let rows;
  if (niches.length > 0) {
    rows = (await pool.query(`SELECT * FROM content_gen_rpm_cache WHERE niche_key = ANY($1::text[]) ORDER BY updated_at DESC`, [niches])).rows;
  } else {
    rows = (await pool.query(`SELECT * FROM content_gen_rpm_cache ORDER BY updated_at DESC LIMIT 200`)).rows;
  }
  return NextResponse.json({ ok: true, count: rows.length, cache: rows });
}
