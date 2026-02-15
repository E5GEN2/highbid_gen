export interface AnalysisResult {
  category: string;
  niche: string;
  sub_niche: string;
  content_style: string;
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
  videos: VideoInfo[],
  apiKey: string
): Promise<AnalysisResult> {
  // Pick the video with the most views
  const topVideo = [...videos].sort((a, b) => (Number(b.view_count) || 0) - (Number(a.view_count) || 0))[0];
  if (!topVideo) {
    throw new Error('No videos available for analysis');
  }

  const videoUrl = `https://www.youtube.com/shorts/${topVideo.video_id}`;

  const prompt = `Watch this YouTube Short and analyze the channel "${channelName}" based on it.

${videoUrl}

Respond with a JSON object (no markdown, no code fences, just raw JSON) with these fields:

- "category": The broad content category (e.g. Entertainment, Education, Sports, Music, Technology, Lifestyle, News, Science, Business, Health, Comedy, Gaming, Art, Nature)
- "niche": A more specific niche within the category (e.g. Fitness, K9 Training, React Development, Cat Videos, True Crime, ASMR, Makeup Tutorials)
- "sub_niche": The most specific sub-niche (e.g. "gym motivation clips", "police K9 action compilations", "React hook tutorials")
- "content_style": One of: faceless, talking_head, compilation, slideshow, animation, screen_recording, mixed
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

  // Extract JSON from response — handle code fences, extra text, smart quotes
  let jsonStr = text
    .replace(/```(?:json)?\s*/gi, '')
    .replace(/```/g, '')
    .replace(/[\u201C\u201D\u201E\u201F\u2033\u2036]/g, '"')
    .replace(/[\u2018\u2019\u201A\u201B\u2032\u2035]/g, "'")
    .trim();

  // Extract just the JSON object between first { and last }
  const start = jsonStr.indexOf('{');
  const end = jsonStr.lastIndexOf('}');
  if (start !== -1 && end > start) {
    jsonStr = jsonStr.substring(start, end + 1);
  }

  let parsed: AnalysisResult;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    throw new Error(`Failed to parse Gemini response as JSON: ${jsonStr.substring(0, 300)}`);
  }

  // Validate required fields
  if (!parsed.category || !parsed.niche || !parsed.content_style || !parsed.channel_summary) {
    throw new Error(`Missing required fields in analysis: ${JSON.stringify(parsed)}`);
  }

  return {
    category: parsed.category,
    niche: parsed.niche,
    sub_niche: parsed.sub_niche || '',
    content_style: parsed.content_style,
    channel_summary: parsed.channel_summary,
    tags: Array.isArray(parsed.tags) ? parsed.tags : [],
  };
}
