/**
 * Gemini Files API client — video analysis via PapaiAPI
 * Endpoint: POST https://papaiapi.com/v1/files/chat
 * Supports file URL or file upload (multipart)
 */

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

/**
 * Analyze a video via URL using the Gemini Files API
 */
export async function analyzeVideoByUrl(
  fileUrl: string,
  apiKey: string,
  customPrompt?: string,
): Promise<GeminiFilesResponse> {
  const prompt = customPrompt || VIDEO_ANALYSIS_PROMPT;
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
 * Parse the JSON analysis from Gemini response text
 */
function parseAnalysisJson(text: string): VideoAnalysisResult {
  // Clean up response — handle code fences, smart quotes
  let jsonStr = text
    .replace(/```(?:json)?\s*/gi, '')
    .replace(/```/g, '')
    .replace(/[\u201C\u201D\u201E\u201F\u2033\u2036]/g, '"')
    .replace(/[\u2018\u2019\u201A\u201B\u2032\u2035]/g, "'")
    .trim();

  // Extract JSON object
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

export { VIDEO_ANALYSIS_PROMPT };
