import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db';
import { getPapaiApiKey } from '@/lib/config';
import { validateProject, setStepRunning, setStepProgress, setStepDone, setStepError, logStep } from '@/lib/clipping-pipeline';
import { planChunks, extractChunks, analyzeVideoChunk, mergeChunkResults, VIDEO_ANALYSIS_PROMPT, type GeminiFilesResponse } from '@/lib/gemini-files';

/**
 * POST /api/clipping/projects/{id}/analyze
 * Run AI video analysis (chunked). Fire-and-forget.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: projectId } = await params;
  const validation = await validateProject(req, projectId, { sourceVideo: true });
  if (validation instanceof NextResponse) return validation;
  const { project } = validation;

  const apiKey = await getPapaiApiKey();
  if (!apiKey) return NextResponse.json({ error: 'PAPAI_API_KEY not configured' }, { status: 500 });

  const started = await setStepRunning(projectId, 'analyze', { percent: 0 });
  if (!started) return NextResponse.json({ ok: true, step: 'analyze', status: 'already-running' });

  runAnalysis(projectId, project.source_path as string, project.video_duration as number | null, apiKey).catch(async (err) => {
    await setStepError(projectId, err.message);
    await logStep(projectId, 'analyze', 'error', err.message);
  });

  return NextResponse.json({ ok: true, step: 'analyze', status: 'started' });
}

async function runAnalysis(projectId: string, sourcePath: string, videoDuration: number | null, apiKey: string) {
  const fileUrl = `file://${sourcePath}`;

  // Get duration if not stored
  let duration = videoDuration;
  if (!duration) {
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const execFileAsync = promisify(execFile);
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'quiet', '-print_format', 'json', '-show_format', sourcePath,
    ], { timeout: 30000 });
    duration = parseFloat(JSON.parse(stdout).format.duration);
    await pool.query(`UPDATE clipping_projects SET video_duration = $1 WHERE id = $2`, [duration, projectId]);
  }

  const chunks = planChunks(duration);
  await logStep(projectId, 'analyze', 'active', `Analyzing ${chunks.length} chunks for ${Math.round(duration)}s video`);

  // Create analysis record
  const analysisRes = await pool.query(
    `INSERT INTO clipping_analyses (project_id, video_url, status, prompt) VALUES ($1, $2, 'processing', $3) RETURNING id`,
    [projectId, fileUrl, VIDEO_ANALYSIS_PROMPT]
  );
  const analysisId = analysisRes.rows[0].id;

  // Extract chunks sequentially
  const extractedChunks = await extractChunks(fileUrl, chunks, (extracted, total) => {
    setStepProgress(projectId, { phase: 'extract', extracted, total, percent: Math.round((extracted / total) * 30) }).catch(() => {});
  });
  await logStep(projectId, 'extract', 'done', `Extracted ${extractedChunks.size} chunks`, undefined, analysisId);

  // Analyze in parallel
  let completedChunks = 0;
  const chunkResults: (GeminiFilesResponse | null)[] = new Array(chunks.length).fill(null);

  await Promise.all(chunks.map(async (chunk) => {
    const result = await analyzeVideoChunk(fileUrl, apiKey, chunk, extractedChunks);
    chunkResults[chunk.index] = result;
    completedChunks++;
    await setStepProgress(projectId, {
      phase: 'analyze', chunksCompleted: completedChunks, chunksTotal: chunks.length,
      percent: 30 + Math.round((completedChunks / chunks.length) * 70),
    });
    await logStep(projectId, 'process_chunk', 'done',
      `Chunk ${chunk.index + 1}/${chunks.length}: ${result.analysis.total_segments} segments in ${result.duration_ms}ms`,
      { chunkIndex: chunk.index, segments: result.analysis.total_segments }, analysisId);
  }));

  // Merge
  const validResults = chunkResults.filter((r): r is GeminiFilesResponse => r !== null);
  const merged = mergeChunkResults(validResults);

  await pool.query(
    `UPDATE clipping_analyses SET status='done', video_duration_seconds=$1, total_segments=$2, segments=$3,
     raw_response=$4, tokens_in=$5, tokens_out=$6, duration_ms=$7, completed_at=NOW() WHERE id=$8`,
    [merged.analysis.video_duration_seconds, merged.analysis.total_segments,
     JSON.stringify(merged.analysis.segments), merged.raw_response,
     merged.tokens_in, merged.tokens_out, merged.duration_ms, analysisId]
  );

  await setStepDone(projectId);
  await logStep(projectId, 'analyze', 'done', `${merged.analysis.total_segments} segments`, {
    totalSegments: merged.analysis.total_segments, duration: merged.analysis.video_duration_seconds,
  }, analysisId);
}

export const maxDuration = 600;
