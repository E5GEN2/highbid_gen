import { NextRequest, NextResponse } from 'next/server';

interface StoryboardScene {
  scene_id: number;
  start_ms: number;
  end_ms: number;
  beat: string;
  vo_text: string;
  scene_twist: string;
  caused_by: string;
  leads_to: string;
  callback_to: string;
  vo_emphasis: string;
  read_speed_wps: number;
  visual_prompt: {
    setting: string;
    characters: string;
    action: string;
    props: string;
    mood: string;
    lighting: string;
    color_palette: string;
    camera: string;
    composition: string;
    aspect_ratio: string;
    style_tags: string;
    negative_tags: string;
    model_hint: string;
    seed: number;
  };
  text_overlay: {
    content: string;
    position: string;
    weight: string;
  };
  transition_in: string;
  transition_out: string;
  music_cue: string;
}

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
  "vo_text": string (≤7 words, no line breaks, action-focused),
  "scene_twist": string (the specific action/conflict/revelation in this scene),
  "caused_by": string (what previous event directly triggers THIS scene - use "scene X: [specific event]" format),
  "leads_to": string (what immediate consequence this scene creates for the next),
  "callback_to": string (reference to earlier setup if this is a payoff, or "none"),
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
- CRITICAL: vo_text must be ≤7 words maximum to fit 2-second timing.
- CRITICAL: Every scene must be a DIRECT CONSEQUENCE of previous events.
- CRITICAL: Use "therefore/but/however" logic between ALL scenes, never "and then".
- caused_by must reference a SPECIFIC action from a previous scene that triggers this one
- leads_to must create a concrete problem/opportunity that the next scene MUST address
- callback_to should reference earlier setups when paying them off (weapons, allies, information)
- Each scene_twist must be CAUSED BY previous actions, not random events
- Example causality: "Scene 3: Hero destroys bridge" → "Scene 4: Enemy forced to airborne assault" → "Scene 5: Hero hijacks enemy aircraft"
- Avoid generic actions: specify WHO does WHAT causing WHAT CONSEQUENCE
- Use the story's domino_sequences and plot_threads to maintain causality
- Scene 30 should have beat="cta" if a call_to_action exists.
- IMPORTANT: Do not wrap output in code blocks or markdown formatting.`;

export async function POST(request: NextRequest) {
  try {
    const { storyBulb, apiKey, startScene, endScene, previousScenes } = await request.json();

    if (!storyBulb || !apiKey) {
      return NextResponse.json(
        { error: 'Story bulb and API key are required' },
        { status: 400 }
      );
    }

    // Handle single batch generation
    const actualStartScene = startScene || 1;
    const actualEndScene = endScene || 30;
    
    // Helper function to create compressed context from previous scenes with causality
    const createCompressedContext = (scenes: StoryboardScene[]) => {
      if (!scenes || scenes.length === 0) return '';
      
      const context = scenes.map(scene => ({
        scene_id: scene.scene_id,
        beat: scene.beat,
        vo_text: scene.vo_text,
        scene_twist: scene.scene_twist,
        leads_to: scene.leads_to,
        caused_by: scene.caused_by,
        callback_to: scene.callback_to,
        setting: scene.visual_prompt?.setting,
        characters: scene.visual_prompt?.characters,
        seed: scene.visual_prompt?.seed
      }));
      
      // Get the last 3 scenes' consequences for immediate context
      const recentConsequences = scenes.slice(-3).map(s => 
        `Scene ${s.scene_id}: ${s.scene_twist} → LEADS TO: ${s.leads_to}`
      ).join('\n');
      
      return `\nPrevious scenes with CAUSALITY CHAIN:\n${JSON.stringify(context, null, 2)}\n\nIMPORTANT - Recent consequences that MUST influence next scenes:\n${recentConsequences}`;
    };

    const contextPrompt = createCompressedContext(previousScenes || []);
    
    // Add story's causality guidance
    const causalityGuidance = storyBulb.domino_sequences ? 
      `\n\nCRITICAL CAUSALITY CHAINS TO FOLLOW:\n${storyBulb.domino_sequences.join('\n')}\n\nSETUPS TO PAY OFF:\n${JSON.stringify(storyBulb.setups_payoffs || [])}` : '';
    
    const batchPrompt = `${STORYBOARD_PROMPT}\n\nUSER:\nHere is the Story Bulb JSON:\n${JSON.stringify(storyBulb, null, 2)}${contextPrompt}${causalityGuidance}\n\nGenerate scenes ${actualStartScene} to ${actualEndScene} (inclusive) of a 30-scene storyboard in JSONL format. Start with scene_id=${actualStartScene}. REMEMBER: Each scene MUST be caused by previous events, creating a domino effect.`;
    
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
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Gemini API Error:`, errorText);
      return NextResponse.json(
        { error: `Gemini API error: ${response.status} - ${errorText}` },
        { status: response.status }
      );
    }
    
    const data = await response.json();
    const generatedText = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    
    if (!generatedText) {
      return NextResponse.json(
        { error: 'No storyboard generated' },
        { status: 500 }
      );
    }

    // Parse the generated scenes
    const allScenes: StoryboardScene[] = [];
    
    try {
      let cleanedText = generatedText.trim();
      if (cleanedText.startsWith('```json') || cleanedText.startsWith('```')) {
        cleanedText = cleanedText.replace(/^```(json)?\n?/, '').replace(/\n?```$/, '');
      }
      
      const lines = cleanedText.trim().split('\n').filter((line: string) => line.trim());
      
      for (const line of lines) {
        if (!line.trim()) continue;
        
        try {
          const scene = JSON.parse(line.trim());
          allScenes.push(scene);
        } catch {
          console.error(`Failed to parse scene:`, line.trim());
        }
      }
    } catch (parseError) {
      console.error(`Failed to process batch:`, parseError);
    }
    
    console.log(`Generated ${allScenes.length} scenes for range ${actualStartScene}-${actualEndScene}`);

    if (allScenes.length === 0) {
      return NextResponse.json(
        { error: 'No valid scenes were generated' },
        { status: 500 }
      );
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