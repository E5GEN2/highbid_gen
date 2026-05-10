/**
 * AI-powered cluster labels.
 *
 * The TF-IDF auto_label baked by cluster-niches.py is English-biased
 * (its stopword list is English-only) and produces nonsense for
 * non-English clusters — e.g. a tightly-coherent Russian YouTube-
 * monetisation niche of 323 videos got labelled "youtube 2026 000"
 * because the Latin tokens that survived the cleanup were the
 * brand name, year mentions, and "000" from "$5.000" amounts.
 *
 * This module sends each cluster's top titles + top channels to
 * Gemini Flash and asks for a short human-readable label in the
 * dominant language of the cluster. Result lands in the existing
 * `ai_label` column on niche_tree_clusters; the frontend prefers
 * ai_label over auto_label when populated.
 *
 * Cost: ~2K input tokens + ~30 output per call. At 5K clusters that's
 * ~15M tokens, well within Flash's quota. Wallclock ~15 min at 10
 * threads.
 */

import { getPool } from './db';
import { getPapaiApiKey } from './config';

const PAPAI_URL = 'https://papaiapi.com/v1beta/models/gemini-flash:generateContent';

const LABEL_PROMPT = `You are labeling a YouTube content niche.

Below are the top videos in this niche, with their titles and channel names. Write a short label (3-7 words) that captures what this niche is ABOUT.

Rules:
- Use the dominant language of the videos. If the titles are mostly Russian, write the label in Russian. Same for Spanish, Portuguese, etc.
- Lower-case unless proper nouns demand otherwise.
- No quotes, no trailing punctuation, no emojis.
- Don't say "videos about" or "channel that" — just the topic itself.
- If videos span multiple sub-topics, name the unifying theme.

Top videos:
{{VIDEOS}}

Top channels: {{CHANNELS}}

Respond with ONLY the label, nothing else.`;

export interface ClusterLabelInput {
  cluster_id: number;
  titles: string[];           // top 10 by views
  top_channels: string[];     // top 5
}

export interface ClusterLabelResult {
  cluster_id: number;
  ai_label: string | null;
  error?: string;
}

/**
 * Generate one cluster's AI label via Gemini Flash.
 */
export async function generateAiLabelForCluster(
  input: ClusterLabelInput,
  apiKey: string,
): Promise<ClusterLabelResult> {
  const titlesText = input.titles
    .slice(0, 10)
    .map((t, i) => `${i + 1}. ${(t || '').slice(0, 200)}`)
    .join('\n');
  const channelsText = input.top_channels.slice(0, 5).join(', ') || '(none)';

  const prompt = LABEL_PROMPT
    .replace('{{VIDEOS}}', titlesText)
    .replace('{{CHANNELS}}', channelsText);

  let res: Response;
  try {
    res = await fetch(PAPAI_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 64,
        },
      }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    return { cluster_id: input.cluster_id, ai_label: null, error: (err as Error).message?.slice(0, 200) };
  }

  if (!res.ok) {
    const errTxt = await res.text().catch(() => '');
    return { cluster_id: input.cluster_id, ai_label: null, error: `HTTP ${res.status}: ${errTxt.slice(0, 200)}` };
  }

  let json: { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  try {
    json = await res.json();
  } catch (err) {
    return { cluster_id: input.cluster_id, ai_label: null, error: 'invalid json: ' + (err as Error).message };
  }

  const text = json?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
  if (!text) {
    return { cluster_id: input.cluster_id, ai_label: null, error: 'no text in response' };
  }

  // Clean: drop wrapping quotes / fences / "Label: " prefixes the model
  // sometimes adds despite instructions.
  const cleaned = text
    .replace(/^["'`]|["'`]$/g, '')
    .replace(/^(label|niche|topic|category|тема|етикетка)\s*:\s*/i, '')
    .replace(/[“”]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);

  if (!cleaned) {
    return { cluster_id: input.cluster_id, ai_label: null, error: 'empty after cleaning' };
  }

  return { cluster_id: input.cluster_id, ai_label: cleaned };
}

export interface LabelBackfillProgress {
  total: number;
  processed: number;
  upserted: number;
  skipped: number;
  errors: number;
}

/**
 * Backfill ai_labels for clusters that don't already have one.
 * Picks top 10 videos by view_count per cluster.
 *
 * mode='missing' (default) — only labels clusters where ai_label IS NULL.
 * mode='all' — relabels every cluster (use after a prompt change).
 *
 * scope='all' (default) — every cluster in niche_tree_clusters.
 * scope='run:N' — only clusters belonging to global run N (and its L2 subdivides).
 */
export async function backfillClusterAiLabels(opts?: {
  mode?: 'missing' | 'all';
  scope?: 'all' | { runId: number };
  threads?: number;
  onProgress?: (p: LabelBackfillProgress) => void;
}): Promise<LabelBackfillProgress> {
  const pool = await getPool();
  const mode = opts?.mode ?? 'missing';
  const threads = Math.max(1, Math.min(opts?.threads ?? 10, 30));

  const apiKey = await getPapaiApiKey();
  if (!apiKey) {
    throw new Error('PAPAI_API_KEY not configured');
  }

  // Pull eligible clusters. Filter by scope first (run-restricted vs all),
  // then by ai_label presence depending on mode.
  let scopeFilter = '';
  const scopeArgs: number[] = [];
  if (opts?.scope && opts.scope !== 'all') {
    scopeFilter = `AND (run_id = $1 OR parent_cluster_id IN (SELECT id FROM niche_tree_clusters WHERE run_id = $1))`;
    scopeArgs.push(opts.scope.runId);
  }
  const labelFilter = mode === 'missing' ? `AND (ai_label IS NULL OR ai_label = '')` : '';

  const clustersRes = await pool.query<{
    id: number; auto_label: string | null; top_channels: string[] | null;
  }>(
    `SELECT id, auto_label, top_channels
       FROM niche_tree_clusters
      WHERE 1=1 ${scopeFilter} ${labelFilter}
      ORDER BY level DESC, video_count DESC`,    // L2 first (more useful), bigger first
    scopeArgs,
  );
  const clusters = clustersRes.rows;
  const total = clusters.length;
  let processed = 0, upserted = 0, skipped = 0, errors = 0;
  const emit = () => opts?.onProgress?.({ total, processed, upserted, skipped, errors });
  emit();

  // Build the work queue with each cluster's top titles fetched ahead.
  // We could fetch on-demand inside each worker, but a single bulk
  // query for all cluster titles is much faster (one round trip vs 5K).
  const titlesByCluster = new Map<number, string[]>();
  if (total > 0) {
    const ids = clusters.map(c => c.id);
    const titlesRes = await pool.query<{ cluster_id: number; title: string }>(
      `SELECT a.cluster_id, v.title
         FROM niche_tree_assignments a
         JOIN niche_spy_videos v ON v.id = a.video_id
        WHERE a.cluster_id = ANY($1)
          AND v.title IS NOT NULL AND v.title != ''
        ORDER BY a.cluster_id, v.view_count DESC NULLS LAST
        LIMIT $2`,
      [ids, ids.length * 50],   // 50 cap per cluster gives generous slack for the top-10 cut
    );
    for (const row of titlesRes.rows) {
      const arr = titlesByCluster.get(row.cluster_id) ?? [];
      if (arr.length < 10) arr.push(row.title);
      titlesByCluster.set(row.cluster_id, arr);
    }
  }

  // Worker pool — same shape as backfillClusterVectors.
  const queue = [...clusters];
  async function worker() {
    while (queue.length > 0) {
      const c = queue.shift();
      if (!c) return;
      const titles = titlesByCluster.get(c.id) ?? [];
      if (titles.length === 0) {
        skipped++;
        processed++;
        emit();
        continue;
      }
      const result = await generateAiLabelForCluster(
        {
          cluster_id: c.id,
          titles,
          top_channels: c.top_channels ?? [],
        },
        apiKey,
      );
      if (result.ai_label) {
        try {
          await pool.query(
            `UPDATE niche_tree_clusters SET ai_label = $1 WHERE id = $2`,
            [result.ai_label, c.id],
          );
          upserted++;
        } catch (err) {
          errors++;
          console.warn(`[cluster-labels] update ${c.id} failed:`, (err as Error).message);
        }
      } else {
        errors++;
        console.warn(`[cluster-labels] ${c.id} (${c.auto_label || ''}): ${result.error}`);
      }
      processed++;
      emit();
    }
  }
  await Promise.all(Array.from({ length: Math.min(threads, queue.length) }, () => worker()));

  return { total, processed, upserted, skipped, errors };
}
