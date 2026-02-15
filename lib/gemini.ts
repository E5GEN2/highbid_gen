export interface AnalysisResult {
  niche: string;
  sub_niche: string;
  content_style: string;
  is_ai_generated: boolean;
  channel_summary: string;
  tags: string[];
}

interface VideoInfo {
  video_id: string;
  title: string;
  view_count: number;
}

export async function analyzeChannel(
  channelName: string,
  channelUrl: string,
  videos: VideoInfo[],
  apiKey: string
): Promise<AnalysisResult> {
  const top3 = videos.slice(0, 3);
  const videoUrls = top3
    .map((v, i) => `${i + 1}. https://www.youtube.com/shorts/${v.video_id} — "${v.title}" (${(v.view_count || 0).toLocaleString()} views)`)
    .join('\n');

  const prompt = `Analyze this YouTube Shorts channel and its videos.

Channel: ${channelName}
Channel URL: ${channelUrl}

Top videos:
${videoUrls}

Please watch/analyze these Shorts and respond with a JSON object (no markdown, no code fences, just raw JSON) with these fields:

- "niche": The primary niche/category (e.g. Comedy, Fitness, Gaming, Beauty, Music/Dance, Food, Education, Lifestyle, Pets, Sports, Fashion, Motivation, Tech, Finance, True Crime, Horror, Satisfying, ASMR, Travel, DIY, Art, or other appropriate niche)
- "sub_niche": A more specific sub-niche within the main niche (e.g. "gym motivation clips", "React tutorials", "cat compilations")
- "content_style": One of: faceless, talking_head, compilation, slideshow, animation, screen_recording, mixed
- "is_ai_generated": boolean — whether the content appears to be AI-generated (AI voiceover, AI images, AI video)
- "channel_summary": A 1-2 sentence summary of what this channel does and what makes it notable
- "tags": An array of 3-6 descriptive tags (e.g. ["faceless", "motivational", "ai-voiceover", "fast-growth"])

Respond ONLY with the JSON object, no other text.`;

  const response = await fetch(
    'https://papaiapi.com/v1beta/models/gemini-flash:generateContent',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: 1024,
        },
      }),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gemini API error ${response.status}: ${errorText}`);
  }

  const data = await response.json();

  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new Error('No text in Gemini response');
  }

  // Strip markdown code fences if present
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();

  let parsed: AnalysisResult;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error(`Failed to parse Gemini response as JSON: ${cleaned.substring(0, 200)}`);
  }

  // Validate required fields
  if (!parsed.niche || !parsed.content_style || !parsed.channel_summary) {
    throw new Error(`Missing required fields in analysis: ${JSON.stringify(parsed)}`);
  }

  return {
    niche: parsed.niche,
    sub_niche: parsed.sub_niche || '',
    content_style: parsed.content_style,
    is_ai_generated: Boolean(parsed.is_ai_generated),
    channel_summary: parsed.channel_summary,
    tags: Array.isArray(parsed.tags) ? parsed.tags : [],
  };
}
