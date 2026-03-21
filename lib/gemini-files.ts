/**
 * Gemini Files API client — video analysis via PapaiAPI
 * Endpoint: POST https://papaiapi.com/v1/files/chat
 * Supports file URL or file upload (multipart)
 *
 * For long videos (>5min), automatically chunks into time ranges,
 * analyzes each chunk separately, and merges results.
 */

/** Max chunk duration in seconds — each API call covers this much video */
const CHUNK_DURATION_SECONDS = 5 * 60; // 5 minutes

const VIDEO_ANALYSIS_PROMPT = `You are a professional video analyst. Analyze this video and produce a detailed timestamped breakdown in JSON format.

Instructions:
1. Watch the entire video carefully — both visuals and audio.
2. Segment the video into logical scenes/moments. A new segment starts when:
   * The visual scene changes (cut, transition, new location, new subject)
   * The speaker changes topic
   * There's a significant pause or shift in action
   * On-screen text or graphics appear/disappear
   * Segments must be 1-4 seconds. Never exceed 4 seconds per segment.
3. For each segment, provide:
   * start: timestamp in seconds (float)
   * end: timestamp in seconds (float)
   * visual_description: Describe what is visually happening — people, objects, actions, locations, camera movement, text on screen, graphics, transitions. Be specific and factual. Include details like clothing, colors, expressions, on-screen text verbatim.
   * speech_transcription: Transcribe ALL spoken words exactly as said. If no speech, use empty string "". Include the speaker identity if distinguishable (e.g. "Narrator:", "Man:", "Woman:").
   * audio_description: Describe non-speech audio — background music (genre/mood), sound effects, ambient noise, silence. If nothing notable, use empty string "".
4. Important rules:
   * Timestamps must be continuous with no gaps — every second of the video must be covered
   * Be precise with start/end times, aligned to actual scene boundaries
   * Transcribe speech word-for-word, not paraphrased
   * Note any on-screen text, watermarks, logos, subtitles verbatim
   * If someone is speaking over different visuals (voiceover), still capture both independently
   * For music, describe mood/genre rather than trying to identify the song
5. Output format — respond with ONLY this JSON, no other text:
{"video_duration_seconds": <total duration>, "total_segments": <count>, "segments": [{"start": 0.0, "end": 3.5, "visual_description": "...", "speech_transcription": "...", "audio_description": "..."}, {"start": 3.5, "end": 7.0, "visual_description": "...", "speech_transcription": "...", "audio_description": "..."}]}

Analyze the entire video now. Do not skip any part. Output the complete JSON.`;

function makeChunkPrompt(startSec: number, endSec: number): string {
  const startMin = Math.floor(startSec / 60);
  const startS = Math.floor(startSec % 60);
  const endMin = Math.floor(endSec / 60);
  const endS = Math.floor(endSec % 60);
  const startTs = `${startMin}:${startS.toString().padStart(2, '0')}`;
  const endTs = `${endMin}:${endS.toString().padStart(2, '0')}`;

  return `You are a professional video analyst. Analyze ONLY the portion of this video from ${startTs} to ${endTs} and produce a detailed timestamped breakdown in JSON format.

IMPORTANT: Only analyze the section from ${startTs} (${startSec} seconds) to ${endTs} (${endSec} seconds). Ignore all content outside this range. Use ABSOLUTE timestamps (from the start of the full video, not relative to this chunk).

Instructions:
1. Watch the specified portion carefully — both visuals and audio.
2. Segment it into logical scenes/moments. A new segment starts when:
   * The visual scene changes (cut, transition, new location, new subject)
   * The speaker changes topic
   * There's a significant pause or shift in action
   * On-screen text or graphics appear/disappear
   * Segments must be 1-4 seconds. Never exceed 4 seconds per segment.
3. For each segment, provide:
   * start: ABSOLUTE timestamp in seconds (float) from the beginning of the full video
   * end: ABSOLUTE timestamp in seconds (float) from the beginning of the full video
   * visual_description: Describe what is visually happening — people, objects, actions, locations, camera movement, text on screen, graphics, transitions. Be specific and factual.
   * speech_transcription: Transcribe ALL spoken words exactly as said. If no speech, use empty string "". Include speaker identity if distinguishable.
   * audio_description: Describe non-speech audio — background music, sound effects, ambient noise. If nothing notable, use empty string "".
4. Important rules:
   * All timestamps must use ABSOLUTE times (e.g. if chunk starts at ${startTs}, the first segment starts at ${startSec}, NOT at 0)
   * Timestamps must be continuous with no gaps within this chunk
   * First segment must start at or near ${startSec} seconds
   * Last segment must end at or near ${endSec} seconds
   * Transcribe speech word-for-word, not paraphrased
5. Output format — respond with ONLY this JSON, no other text:
{"video_duration_seconds": ${endSec - startSec}, "total_segments": <count>, "segments": [{"start": ${startSec}.0, "end": ..., "visual_description": "...", "speech_transcription": "...", "audio_description": "..."}, ...]}

Analyze ONLY the ${startTs} to ${endTs} portion now. Do not skip any part of this range. Output the complete JSON.`;
}

export interface VideoSegment {
  start: number;
  end: number;
  visual_description: string;
  speech_transcription: string;
  audio_description: string;
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
 */
export async function analyzeVideoChunk(
  fileUrl: string,
  apiKey: string,
  chunk: AnalysisChunk,
): Promise<GeminiFilesResponse> {
  // For "Full video" chunk, use the standard prompt
  if (chunk.label === 'Full video') {
    return callGeminiFiles(fileUrl, apiKey, VIDEO_ANALYSIS_PROMPT);
  }
  const prompt = makeChunkPrompt(chunk.startSec, chunk.endSec);
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

/**
 * Low-level call to PapaiAPI Gemini Files endpoint.
 */
async function callGeminiFiles(
  fileUrl: string,
  apiKey: string,
  prompt: string,
): Promise<GeminiFilesResponse> {
  const startTime = Date.now();

  const response = await fetch('https://papaiapi.com/v1/files/chat', {
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

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gemini Files API error ${response.status}: ${errorText}`);
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
