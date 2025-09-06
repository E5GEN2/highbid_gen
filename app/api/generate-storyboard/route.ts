import { NextRequest, NextResponse } from 'next/server';

const STORYBOARD_PROMPT = `SYSTEM:
You are a storyboard generator.
You must output exactly 5 lines of JSON (JSONL format) for the requested scene range. 
Each line must be a valid JSON object conforming to the schema below.
No prose, no explanations, no comments, no markdown formatting, no code blocks.

REQUIRED FIELDS:
{
  "scene_id": int (specific scene number),
  "start_ms": int (2000*(scene_id-1)),
  "end_ms": int (start_ms+2000),
  "beat": one of ["hook","setup","inciting","rise","midpoint","complication","climax","resolution","cta"],
  "vo_text": string (≤18 words, no line breaks),
  "vo_emphasis": one of ["none","slight","strong"],
  "read_speed_wps": float between 1.8 and 3.2,
  "visual_prompt": {
    "setting": string,
    "characters": string,
    "action": string,
    "props": string,
    "mood": string,
    "lighting": one of ["soft","hard","noir","neon","golden_hour","overcast","practical"],
    "color_palette": one of ["warm","cool","monochrome","teal_orange","pastel"],
    "camera": string,
    "composition": one of ["rule_of_thirds","center","symmetry","leading_lines"],
    "aspect_ratio": "9:16",
    "style_tags": string,
    "negative_tags": "blurry, extra fingers, watermark",
    "model_hint": one of ["sdxl","flux","juggernaut","midjourney","dalle","kling"],
    "seed": int
  },
  "text_overlay": {
    "content": string,
    "position": one of ["top","center","bottom","caption"],
    "weight": one of ["none","subtle","bold"]
  },
  "transition_in": one of ["cut","fade","dolly_in","whip"],
  "transition_out": one of ["cut","fade","dolly_out","whip"],
  "music_cue": one of ["low","medium","high","drop","silence"]
}

RULES:
- Output 5 lines for the requested scene range, one JSON object per line.
- Each scene covers 2000 ms (2 seconds).
- Maintain continuity: reuse seeds within the same beat, change on beat transitions.
- Keep vo_text ≤18 words, natural and concise.
- Use consistent characters wording to avoid identity drift.
- Scene 30 should have beat="cta" if a call_to_action exists.
- IMPORTANT: Do not wrap output in code blocks or markdown formatting.
- NOTE: Visual style consistency will be applied at the image generation level using the story's visual_style.`;

export async function POST(request: NextRequest) {
  try {
    const { storyBulb, apiKey } = await request.json();

    if (!storyBulb || !apiKey) {
      return NextResponse.json(
        { error: 'Story bulb and API key are required' },
        { status: 400 }
      );
    }

    // Helper function to create compressed context from previous scenes
    const createCompressedContext = (scenes: any[]) => {
      if (scenes.length === 0) return '';
      
      const context = scenes.map(scene => ({
        scene_id: scene.scene_id,
        beat: scene.beat,
        vo_text: scene.vo_text,
        setting: scene.visual_prompt?.setting,
        characters: scene.visual_prompt?.characters,
        seed: scene.visual_prompt?.seed
      }));
      
      return `\nPrevious scenes context for continuity:\n${JSON.stringify(context, null, 2)}`;
    };

    // Generate storyboard in batches of 5 with context
    const generateBatch = async (startScene: number, endScene: number, previousScenes: any[] = []) => {
      const contextPrompt = createCompressedContext(previousScenes);
      const batchPrompt = `${STORYBOARD_PROMPT}\n\nUSER:\nHere is the Story Bulb JSON:\n${JSON.stringify(storyBulb, null, 2)}${contextPrompt}\n\nGenerate scenes ${startScene} to ${endScene} (inclusive) of a 30-scene storyboard in JSONL format. Start with scene_id=${startScene}.`;
      
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            contents: [{
              parts: [{
                text: batchPrompt
              }]
            }],
            generationConfig: {
              temperature: 0.8,
              topK: 40,
              topP: 0.95,
              maxOutputTokens: 4096,
              responseMimeType: "text/plain"
            }
          })
        }
      );
      
      return response;
    };
    
    // Generate all scenes progressively with context
    const allScenes: any[] = [];
    const batchSize = 5;
    const totalBatches = Math.ceil(30 / batchSize); // 6 batches of 5 scenes each
    
    for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
      const startScene = batchIndex * batchSize + 1;
      const endScene = Math.min(startScene + batchSize - 1, 30);
      
      console.log(`Generating batch ${batchIndex + 1}/${totalBatches}: scenes ${startScene}-${endScene}`);
      
      const batchResponse = await generateBatch(startScene, endScene, allScenes);
      
      if (!batchResponse.ok) {
        const errorText = await batchResponse.text();
        console.error(`Gemini API Error in batch ${batchIndex + 1}:`, errorText);
        return NextResponse.json(
          { error: `Gemini API error in batch ${batchIndex + 1}: ${batchResponse.status} - ${errorText}` },
          { status: batchResponse.status }
        );
      }
      
      const batchData = await batchResponse.json();
      const batchText = batchData.candidates?.[0]?.content?.parts?.[0]?.text || '';
      
      if (!batchText) {
        console.warn(`No content generated for batch ${batchIndex + 1}`);
        continue;
      }
      
      // Parse this batch's scenes
      try {
        let cleanedText = batchText.trim();
        if (cleanedText.startsWith('```json') || cleanedText.startsWith('```')) {
          cleanedText = cleanedText.replace(/^```(json)?\n?/, '').replace(/\n?```$/, '');
        }
        
        const lines = cleanedText.trim().split('\n').filter((line: string) => line.trim());
        
        for (const line of lines) {
          if (!line.trim()) continue;
          
          try {
            const scene = JSON.parse(line.trim());
            allScenes.push(scene);
          } catch (parseError) {
            console.error(`Failed to parse scene in batch ${batchIndex + 1}:`, line.trim());
          }
        }
      } catch (parseError) {
        console.error(`Failed to process batch ${batchIndex + 1}:`, parseError);
      }
      
      console.log(`Batch ${batchIndex + 1} complete. Total scenes so far: ${allScenes.length}`);
    }
    
    const generatedText = allScenes.map(scene => JSON.stringify(scene)).join('\n');
    
    if (allScenes.length === 0) {
      return NextResponse.json(
        { error: 'No storyboard generated' },
        { status: 500 }
      );
    }

    // Log scene generation results
    console.log(`Storyboard generation complete: ${allScenes.length} scenes generated`);
    
    // If we have fewer than 30 scenes, include warning in response
    if (allScenes.length < 30) {
      console.warn(`Generated ${allScenes.length} scenes instead of 30`);
      return NextResponse.json({
        success: true,
        storyboard: allScenes,
        storyBulb: storyBulb,
        warning: `Only ${allScenes.length} of 30 scenes were generated. This may be due to API limitations.`
      });
    }
    
    return NextResponse.json({
      success: true,
      storyboard: allScenes,
      storyBulb: storyBulb
    });

  } catch (error) {
    console.error('Server error:', error);
    return NextResponse.json(
      { error: 'Internal server error', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}