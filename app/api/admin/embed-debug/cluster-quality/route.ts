import { NextRequest, NextResponse } from 'next/server';
import { isAdmin } from '@/lib/admin-auth';
import { getPool } from '@/lib/db';
import { vectorPool, type EmbeddingSource } from '@/lib/vector-db';

/**
 * GET /api/admin/embed-debug/cluster-quality?customNicheId=…&source=thumbnail_v2&recentHours=24
 *
 * Built to investigate "why did clustering quality collapse?" after a
 * round of bulk-embedding. The hypothesis the user is testing is whether
 * recently-written embeddings (from a freshly cleaned key pool) are
 * actually valid Gemini vectors, or whether some compromised keys
 * returned garbage that's now polluting the cosine geometry.
 *
 * What it does:
 *   1. Pull every (video_id, embedding) for the niche from the matching
 *      vector table (thumb_v2 / title_v2 / combined_v2).
 *   2. Join the main DB stamp column (e.g. thumbnail_embedded_v2_at) to
 *      label each vector as "recent" (stamped within recentHours) or
 *      "old".
 *   3. Compute, in pure SQL inside pgvector:
 *        - vector dim distribution (sanity: should all be 3072)
 *        - L2 norm distribution (mean / min / max) per cohort
 *        - sampled pairwise cosine similarity matrices:
 *            recent × recent,  old × old,  recent × old
 *      Sampling = up to 20 from each cohort to keep the query bounded
 *      (a full N×M scan blows up at >100 vectors).
 *
 * What to read from the output:
 *   - If recent vectors have very different norm or any with len ≠ 3072
 *     → garbage from a compromised key.
 *   - If recent×recent mean similarity is close to 1.0 (e.g. > 0.95)
 *     while old×old is normal-looking (0.3-0.6) → recent embeddings are
 *     near-duplicates of each other, regardless of content. Classic
 *     compromised-key signature (deterministic junk vector).
 *   - If recent×old similarity is far below the cohort internals →
 *     recent vectors live in a totally separate region. Will pull
 *     HDBSCAN into a degenerate split.
 *   - If everything looks similar (no recent/old gap, normal norms,
 *     similar distribution) → not garbage, just HDBSCAN params too
 *     coarse for the now-densely-populated niche.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 60;

const SOURCE_TABLE: Record<EmbeddingSource, string> = {
  title_v1: 'niche_video_vectors',
  title_v2: 'niche_video_vectors_title_v2',
  thumbnail_v2: 'niche_video_vectors_thumb_v2',
  combined_v2: 'niche_video_vectors_combined_v2',
};

const SOURCE_STAMP: Record<EmbeddingSource, string> = {
  title_v1: 'title_embedded_at',
  title_v2: 'title_embedded_v2_at',
  thumbnail_v2: 'thumbnail_embedded_v2_at',
  combined_v2: 'combined_embedded_v2_at',
};

function parseSource(raw: string | null): EmbeddingSource {
  const v = (raw ?? 'thumbnail_v2') as EmbeddingSource;
  if (v in SOURCE_TABLE) return v;
  return 'thumbnail_v2';
}

interface Cohort {
  count: number;
  dims: { min: number; max: number };
  norms: { min: number; max: number; mean: number; sample: number[] };
  videoIdsSample: number[];
}

interface SimStats {
  pairs: number;
  min: number;
  max: number;
  mean: number;
  p50: number;
  p95: number;
}

export async function GET(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin token required' }, { status: 403 });

  const sp = req.nextUrl.searchParams;
  const customNicheId = parseInt(sp.get('customNicheId') ?? '');
  if (!Number.isFinite(customNicheId)) {
    return NextResponse.json({ error: 'customNicheId (int) required' }, { status: 400 });
  }
  const source = parseSource(sp.get('source'));
  const recentHours = Math.max(1, Math.min(720, parseInt(sp.get('recentHours') ?? '24') || 24));
  const sampleSize = Math.max(5, Math.min(50, parseInt(sp.get('sampleSize') ?? '20') || 20));
  const table = SOURCE_TABLE[source];
  const stamp = SOURCE_STAMP[source];

  const pool = await getPool();

  // 1. Get the full video_id list scoped to the niche, split by stamp.
  const splitRes = await pool.query<{
    video_id: number;
    cohort: 'recent' | 'old' | 'unembedded';
    stamped_at: Date | null;
  }>(
    `SELECT v.id AS video_id,
            CASE
              WHEN v.${stamp} IS NULL THEN 'unembedded'
              WHEN v.${stamp} > NOW() - ($2 || ' hours')::interval THEN 'recent'
              ELSE 'old'
            END AS cohort,
            v.${stamp} AS stamped_at
       FROM custom_niche_videos cnv
       JOIN niche_spy_videos v ON v.id = cnv.video_id
      WHERE cnv.custom_niche_id = $1
      ORDER BY v.${stamp} DESC NULLS LAST`,
    [customNicheId, String(recentHours)],
  );

  const recentIds = splitRes.rows.filter(r => r.cohort === 'recent').map(r => r.video_id);
  const oldIds    = splitRes.rows.filter(r => r.cohort === 'old').map(r => r.video_id);
  const unembedded = splitRes.rows.filter(r => r.cohort === 'unembedded').length;

  // Sample for the cohort stats — small but representative.
  const recentSampleIds = recentIds.slice(0, sampleSize);
  const oldSampleIds    = oldIds.slice(0, sampleSize);

  async function cohort(label: string, ids: number[]): Promise<Cohort | null> {
    if (ids.length === 0) return null;
    // Dim + norm in one query. pgvector exposes vector_dims() and
    // vector_norm() — that's enough to spot dim drift or non-normalised
    // (read: not-from-Gemini) vectors without paying to ship 3072 floats
    // back to Node.
    const r = await vectorPool.query<{
      video_id: number;
      dims: number;
      norm: number;
    }>(
      `SELECT video_id,
              vector_dims(embedding) AS dims,
              vector_norm(embedding) AS norm
         FROM ${table}
        WHERE video_id = ANY($1::int[])`,
      [ids],
    );
    if (r.rows.length === 0) return null;
    const dims = r.rows.map(x => Number(x.dims));
    const norms = r.rows.map(x => Number(x.norm));
    const sorted = [...norms].sort((a, b) => a - b);
    return {
      count: r.rows.length,
      dims: { min: Math.min(...dims), max: Math.max(...dims) },
      norms: {
        min: sorted[0],
        max: sorted[sorted.length - 1],
        mean: norms.reduce((a, b) => a + b, 0) / norms.length,
        sample: norms.slice(0, 10).map(n => Math.round(n * 1000) / 1000),
      },
      videoIdsSample: r.rows.slice(0, 10).map(x => x.video_id),
    };
  }

  const [recentCohort, oldCohort] = await Promise.all([
    cohort('recent', recentSampleIds),
    cohort('old', oldSampleIds),
  ]);

  // 2. Pairwise sim stats. pgvector's '<=>' is cosine distance (0=same,
  // 2=opposite). similarity = 1 - distance. Self-pairs filtered.
  async function pairwise(label: string, idsA: number[], idsB: number[]): Promise<SimStats | null> {
    if (idsA.length === 0 || idsB.length === 0) return null;
    const r = await vectorPool.query<{ sim: string }>(
      `SELECT 1 - (a.embedding <=> b.embedding) AS sim
         FROM ${table} a
         JOIN ${table} b ON b.video_id = ANY($2::int[])
        WHERE a.video_id = ANY($1::int[])
          AND a.video_id != b.video_id`,
      [idsA, idsB],
    );
    if (r.rows.length === 0) return null;
    const sims = r.rows.map(x => parseFloat(x.sim)).filter(Number.isFinite);
    sims.sort((a, b) => a - b);
    return {
      pairs: sims.length,
      min: sims[0],
      max: sims[sims.length - 1],
      mean: sims.reduce((a, b) => a + b, 0) / sims.length,
      p50: sims[Math.floor(sims.length * 0.5)],
      p95: sims[Math.floor(sims.length * 0.95)],
    };
  }

  const [recentXrecent, oldXold, recentXold] = await Promise.all([
    pairwise('recent×recent', recentSampleIds, recentSampleIds),
    pairwise('old×old', oldSampleIds, oldSampleIds),
    pairwise('recent×old', recentSampleIds, oldSampleIds),
  ]);

  return NextResponse.json({
    ok: true,
    customNicheId,
    source,
    table,
    stampColumn: stamp,
    recentHours,
    sampleSize,
    cohortCounts: {
      recent:     recentIds.length,
      old:        oldIds.length,
      unembedded,
      total:      splitRes.rows.length,
    },
    recent: recentCohort,
    old:    oldCohort,
    similarity: {
      recentXrecent,
      oldXold,
      recentXold,
    },
    interpretation: buildInterpretation({ recentCohort, oldCohort, recentXrecent, oldXold, recentXold }),
  });
}

function buildInterpretation(d: {
  recentCohort: Cohort | null;
  oldCohort: Cohort | null;
  recentXrecent: SimStats | null;
  oldXold: SimStats | null;
  recentXold: SimStats | null;
}): string[] {
  const out: string[] = [];

  // Dim sanity.
  if (d.recentCohort && (d.recentCohort.dims.min !== 3072 || d.recentCohort.dims.max !== 3072)) {
    out.push(`⚠ recent cohort has non-3072 embedding dims (${d.recentCohort.dims.min}..${d.recentCohort.dims.max}) — garbage`);
  }
  if (d.oldCohort && (d.oldCohort.dims.min !== 3072 || d.oldCohort.dims.max !== 3072)) {
    out.push(`⚠ old cohort has non-3072 embedding dims (${d.oldCohort.dims.min}..${d.oldCohort.dims.max})`);
  }

  // Norm drift (Gemini embeddings are L2-normalized, so norm ≈ 1.0).
  // > 5% drift from 1.0 is suspicious.
  const driftThresh = 0.05;
  if (d.recentCohort && Math.abs(d.recentCohort.norms.mean - 1.0) > driftThresh) {
    out.push(`⚠ recent cohort mean norm = ${d.recentCohort.norms.mean.toFixed(3)} (expected ≈ 1.0) — likely not Gemini output`);
  }
  if (d.oldCohort && Math.abs(d.oldCohort.norms.mean - 1.0) > driftThresh) {
    out.push(`⚠ old cohort mean norm = ${d.oldCohort.norms.mean.toFixed(3)} (expected ≈ 1.0)`);
  }

  // Cohort similarity comparison — the load-bearing signal.
  if (d.recentXrecent && d.oldXold) {
    const rr = d.recentXrecent.mean;
    const oo = d.oldXold.mean;
    const gap = rr - oo;
    if (rr > 0.95) {
      out.push(`⚠ recent×recent mean sim = ${rr.toFixed(3)} — recent vectors are near-duplicates of each other (garbage signature)`);
    } else if (gap > 0.15) {
      out.push(`⚠ recent vectors cluster much tighter than old (${rr.toFixed(3)} vs ${oo.toFixed(3)}) — recent batch may be polluted`);
    } else if (Math.abs(gap) < 0.05) {
      out.push(`✓ recent and old cohort similarity stats match (${rr.toFixed(3)} vs ${oo.toFixed(3)}) — embeddings look consistent`);
    }
  }

  if (d.recentXold && d.oldXold) {
    const ro = d.recentXold.mean;
    const oo = d.oldXold.mean;
    if (oo - ro > 0.15) {
      out.push(`⚠ recent×old mean sim = ${ro.toFixed(3)} is much lower than old×old (${oo.toFixed(3)}) — recent vectors live in a separate region`);
    } else {
      out.push(`✓ recent vectors sit in the same neighbourhood as old (${ro.toFixed(3)} vs ${oo.toFixed(3)})`);
    }
  }

  if (out.length === 0) {
    out.push('not enough cohort overlap to draw a conclusion (one side likely empty)');
  }
  return out;
}
