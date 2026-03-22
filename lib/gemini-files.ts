/**
 * Gemini Files API client — video analysis via PapaiAPI
 * Endpoint: POST https://papaiapi.com/v1/files/chat
 * Supports file URL or file upload (multipart)
 *
 * For long videos (>5min), automatically chunks into time ranges,
 * analyzes each chunk separately, and merges results.
 */

/** Max chunk duration in seconds — each API call covers this much video */
const CHUNK_DURATION_SECONDS = 60; // 1 minute — API times out on longer chunks

const VIDEO_ANALYSIS_PROMPT = `Analyze this video. Break it into 2-4 second segments covering every second. For each segment provide start/end in seconds, visual description, exact speech transcription (word-for-word, "" if none), and audio notes ("" if nothing notable). Timestamps must be continuous with no gaps. Respond with ONLY this JSON, no other text: {"video_duration_seconds":<total>,"segments":[{"start":0.0,"end":3.0,"visual":"...","speech":"...","audio":"..."}]}`;

function makeChunkPrompt(startSec: number, endSec: number): string {
  return `Analyze ONLY the portion from ${startSec}s to ${endSec}s of this video. Break it into 2-4 second segments. Use ABSOLUTE timestamps (from video start, not relative). First segment starts at ${startSec}s, last ends at ${endSec}s. For each: start/end seconds, visual description, exact speech ("" if none), audio notes ("" if nothing). Respond with ONLY JSON: {"video_duration_seconds":${endSec - startSec},"segments":[{"start":${startSec}.0,"end":...,"visual":"...","speech":"...","audio":"..."}]}`;
}

export interface VideoSegment {
  start: number;
  end: number;
  visual: string;
  speech: string;
  audio: string;
}

export interface VideoAnalysisResult {
  video_duration_seconds: number;
  total_segments: number;
  segments: VideoSegment[];
}

export interface GeminiFilesResponse {
  analysis: VideoAnalysisResult;
  raw_response: string;
  tokens_in: number;
  tokens_out: number;
  duration_ms: number;
}

/** Represents a time range chunk for scheduled analysis */
export interface AnalysisChunk {
  index: number;
  startSec: number;
  endSec: number;
  label: string; // e.g. "0:00–5:00"
}

/**
 * Plan chunks for a video of a given duration.
 * Videos ≤ CHUNK_DURATION_SECONDS get a single chunk (full video).
 * Longer videos are split into CHUNK_DURATION_SECONDS ranges.
 */
export function planChunks(durationSeconds: number): AnalysisChunk[] {
  if (durationSeconds <= CHUNK_DURATION_SECONDS) {
    return [{ index: 0, startSec: 0, endSec: durationSeconds, label: 'Full video' }];
  }

  const chunks: AnalysisChunk[] = [];
  let start = 0;
  let i = 0;
  while (start < durationSeconds) {
    const end = Math.min(start + CHUNK_DURATION_SECONDS, durationSeconds);
    const startMin = Math.floor(start / 60);
    const startS = Math.floor(start % 60);
    const endMin = Math.floor(end / 60);
    const endS = Math.floor(end % 60);
    chunks.push({
      index: i,
      startSec: start,
      endSec: end,
      label: `${startMin}:${startS.toString().padStart(2, '0')}–${endMin}:${endS.toString().padStart(2, '0')}`,
    });
    start = end;
    i++;
  }
  return chunks;
}

/**
 * Analyze a full video (single chunk, ≤5min) via the Gemini Files API.
 */
export async function analyzeVideoByUrl(
  fileUrl: string,
  apiKey: string,
  customPrompt?: string,
): Promise<GeminiFilesResponse> {
  const prompt = customPrompt || VIDEO_ANALYSIS_PROMPT;
  return callGeminiFiles(fileUrl, apiKey, prompt);
}

/**
 * Analyze a specific time range of a video via the Gemini Files API.
 * For local files (file://), extracts the chunk with ffmpeg first.
 */
/**
 * Pre-extract all chunks from a local video file sequentially.
 * Must be called before analyzeVideoChunk for local files.
 * Returns map of chunk index → extracted file path.
 */
export async function extractChunks(
  fileUrl: string,
  chunks: AnalysisChunk[],
  onProgress?: (extracted: number, total: number) => void,
): Promise<Map<number, string>> {
  const result = new Map<number, string>();
  if (!fileUrl.startsWith('file://') || chunks.length <= 1) return result;

  const localPath = fileUrl.replace('file://', '');
  const fs = await import('fs');
  const path = await import('path');
  const { execFile } = await import('child_process');
  const { promisify } = await import('util');
  const execFileAsync = promisify(execFile);

  const chunkDir = path.join(path.dirname(localPath), 'chunks');
  fs.mkdirSync(chunkDir, { recursive: true });

  // Extract ONE AT A TIME to avoid EAGAIN
  for (const chunk of chunks) {
    if (chunk.label === 'Full video') continue;
    const chunkFile = path.join(chunkDir, `chunk_${chunk.index}.mp4`);

    if (!fs.existsSync(chunkFile)) {
      await execFileAsync('ffmpeg', [
        '-ss', String(chunk.startSec),
        '-i', localPath,
        '-t', String(chunk.endSec - chunk.startSec),
        '-vf', 'scale=-2:480',
        '-c:v', 'libx264', '-preset', 'fast', '-crf', '28', '-b:v', '500k',
        '-c:a', 'aac', '-b:a', '64k',
        '-y', chunkFile,
      ], { timeout: 120000 });
    }

    result.set(chunk.index, chunkFile);
    onProgress?.(result.size, chunks.length);
  }

  return result;
}

/**
 * Analyze a specific time range of a video via the Gemini Files API.
 * For local files, expects chunks to be pre-extracted via extractChunks().
 */
export async function analyzeVideoChunk(
  fileUrl: string,
  apiKey: string,
  chunk: AnalysisChunk,
  extractedChunks?: Map<number, string>,
): Promise<GeminiFilesResponse> {
  // For "Full video" chunk (short videos), send the whole file
  if (chunk.label === 'Full video') {
    return callGeminiFiles(fileUrl, apiKey, VIDEO_ANALYSIS_PROMPT);
  }

  const prompt = makeChunkPrompt(chunk.startSec, chunk.endSec);

  // Use pre-extracted chunk file if available
  const extractedPath = extractedChunks?.get(chunk.index);
  if (extractedPath) {
    return callGeminiFiles(`file://${extractedPath}`, apiKey, prompt);
  }

  // For remote URLs, send the full video with chunk prompt
  return callGeminiFiles(fileUrl, apiKey, prompt);
}

/**
 * Merge multiple chunk results into a single unified analysis.
 */
export function mergeChunkResults(results: GeminiFilesResponse[]): GeminiFilesResponse {
  if (results.length === 1) return results[0];

  const allSegments: VideoSegment[] = [];
  let totalTokensIn = 0;
  let totalTokensOut = 0;
  let totalDurationMs = 0;
  let maxVideoEnd = 0;
  const rawParts: string[] = [];

  for (const r of results) {
    allSegments.push(...r.analysis.segments);
    totalTokensIn += r.tokens_in;
    totalTokensOut += r.tokens_out;
    totalDurationMs += r.duration_ms;
    rawParts.push(r.raw_response);
    const lastSeg = r.analysis.segments[r.analysis.segments.length - 1];
    if (lastSeg && lastSeg.end > maxVideoEnd) {
      maxVideoEnd = lastSeg.end;
    }
  }

  // Sort by start time and deduplicate overlapping segments
  allSegments.sort((a, b) => a.start - b.start);

  return {
    analysis: {
      video_duration_seconds: maxVideoEnd,
      total_segments: allSegments.length,
      segments: allSegments,
    },
    raw_response: rawParts.join('\n\n---CHUNK_BOUNDARY---\n\n'),
    tokens_in: totalTokensIn,
    tokens_out: totalTokensOut,
    duration_ms: totalDurationMs,
  };
}

/** Global concurrency limiter — max 10 parallel API calls across all users */
const MAX_CONCURRENT = 20;
let activeCount = 0;
const waitQueue: (() => void)[] = [];

async function acquireSlot(): Promise<void> {
  if (activeCount < MAX_CONCURRENT) {
    activeCount++;
    return;
  }
  // Wait for a slot to open
  return new Promise<void>((resolve) => {
    waitQueue.push(() => {
      activeCount++;
      resolve();
    });
  });
}

function releaseSlot(): void {
  activeCount--;
  const next = waitQueue.shift();
  if (next) next();
}

/** Get current concurrency stats (for debug endpoints) */
export function getConcurrencyStats() {
  return { active: activeCount, queued: waitQueue.length, max: MAX_CONCURRENT };
}

/** Default retry config */
const MAX_RETRIES = 3;
const RETRY_DELAYS = [0, 0, 0]; // Retry immediately

/**
 * Low-level call to PapaiAPI Gemini Files endpoint with retry logic.
 * Supports file_url (string URL) — for multipart file upload use the
 * test script directly.
 */
async function callGeminiFiles(
  fileUrl: string,
  apiKey: string,
  prompt: string,
): Promise<GeminiFilesResponse> {
  await acquireSlot();
  try {
    return await callGeminiFilesInner(fileUrl, apiKey, prompt);
  } finally {
    releaseSlot();
  }
}

async function callGeminiFilesInner(
  fileUrl: string,
  apiKey: string,
  prompt: string,
): Promise<GeminiFilesResponse> {
  let lastError: Error | null = null;
  const isLocalFile = fileUrl.startsWith('file://');
  const localPath = isLocalFile ? fileUrl.replace('file://', '') : '';

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = RETRY_DELAYS[attempt - 1] || 20000;
      console.log(`[gemini-files] Retry ${attempt + 1}/${MAX_RETRIES} after ${delay / 1000}s...`);
      await new Promise(r => setTimeout(r, delay));
    }

    try {
      const startTime = Date.now();
      let response: Response;

      if (isLocalFile) {
        // Multipart upload for local files
        const fs = await import('fs');
        const path = await import('path');
        const fileBuffer = fs.readFileSync(localPath);
        const fileName = path.basename(localPath);
        const boundary = '----FormBoundary' + Math.random().toString(36).slice(2);

        const parts: (string | Buffer)[] = [];
        parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: video/mp4\r\n\r\n`);
        parts.push(fileBuffer);
        parts.push(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="prompt"\r\n\r\n${prompt}\r\n`);
        parts.push(`--${boundary}--\r\n`);

        const body = Buffer.concat(parts.map(p => typeof p === 'string' ? Buffer.from(p) : p));

        response = await fetch('https://papaiapi.com/v1/files/chat', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
          },
          body,
        });
      } else {
        // URL-based request for remote files
        response = await fetch('https://papaiapi.com/v1/files/chat', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            prompt,
            file_url: fileUrl,
          }),
        });
      }

      if (!response.ok) {
        const errorText = await response.text();
        const error = new Error(`Gemini Files API error ${response.status}: ${errorText}`);
        // Retry on 504 timeout or 5xx server errors
        if (response.status >= 500) {
          lastError = error;
          continue;
        }
        throw error; // Don't retry 4xx client errors
      }

      const data = await response.json();
      const durationMs = Date.now() - startTime;

      const content = data.choices?.[0]?.message?.content;
      if (!content) {
        throw new Error('No content in Gemini Files response');
      }

      const analysis = parseAnalysisJson(content);

      return {
        analysis,
        raw_response: content,
        tokens_in: data.usage?.prompt_tokens || 0,
        tokens_out: data.usage?.completion_tokens || 0,
        duration_ms: durationMs,
      };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      // Only retry on network/timeout errors, not parse errors
      if (lastError.message.includes('parse') || lastError.message.includes('Missing segments')) {
        throw lastError;
      }
    }
  }

  throw lastError || new Error('All retries exhausted');
}

/**
 * Parse the JSON analysis from Gemini response text.
 */
function parseAnalysisJson(text: string): VideoAnalysisResult {
  let jsonStr = text
    .replace(/```(?:json)?\s*/gi, '')
    .replace(/```/g, '')
    .replace(/[\u201C\u201D\u201E\u201F\u2033\u2036]/g, '"')
    .replace(/[\u2018\u2019\u201A\u201B\u2032\u2035]/g, "'")
    .trim();

  const start = jsonStr.indexOf('{');
  const end = jsonStr.lastIndexOf('}');
  if (start !== -1 && end > start) {
    jsonStr = jsonStr.substring(start, end + 1);
  }

  let parsed: VideoAnalysisResult;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    throw new Error(`Failed to parse analysis JSON: ${jsonStr.substring(0, 500)}`);
  }

  if (!parsed.segments || !Array.isArray(parsed.segments)) {
    throw new Error('Missing segments array in analysis result');
  }

  return {
    video_duration_seconds: parsed.video_duration_seconds || 0,
    total_segments: parsed.total_segments || parsed.segments.length,
    segments: parsed.segments,
  };
}

export { VIDEO_ANALYSIS_PROMPT, CHUNK_DURATION_SECONDS };
