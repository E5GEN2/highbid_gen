import { NextRequest, NextResponse } from 'next/server';

// Function to map beats based on total scene count
function getBeatDistribution(totalScenes: number): { [beat: string]: number[] } {
  if (totalScenes === 30) {
    // Original distribution
    return {
      "hook": [1, 2],
      "setup": [3, 4, 5, 6],
      "inciting": [7, 8, 9],
      "rise": [10, 11, 12, 13, 14],
      "midpoint": [15, 16, 17],
      "complication": [18, 19, 20, 21, 22],
      "climax": [23, 24, 25, 26],
      "resolution": [27, 28, 29],
      "cta": [30]
    };
  }
  
  // Dynamic distribution for other counts
  const distribution: { [beat: string]: number[] } = {};
  const beats = ["hook", "setup", "inciting", "rise", "midpoint", "complication", "climax", "resolution", "cta"];
  
  if (totalScenes <= 5) {
    // Ultra-short: only essential beats
    distribution["hook"] = [1];
    distribution["setup"] = [];
    distribution["inciting"] = [];
    distribution["rise"] = [2];
    distribution["midpoint"] = [];
    distribution["complication"] = [];
    distribution["climax"] = [3, 4];
    distribution["resolution"] = [5];
    distribution["cta"] = [];
  } else if (totalScenes <= 10) {
    // Short: core beats only
    distribution["hook"] = [1];
    distribution["setup"] = [2];
    distribution["inciting"] = totalScenes > 6 ? [3] : [];
    distribution["rise"] = totalScenes > 7 ? [4, 5] : [3, 4];
    distribution["midpoint"] = totalScenes > 8 ? [6] : [];
    distribution["complication"] = totalScenes > 9 ? [7] : [];
    distribution["climax"] = totalScenes > 8 ? [totalScenes - 2, totalScenes - 1] : [totalScenes - 1];
    distribution["resolution"] = [totalScenes];
    distribution["cta"] = [];
  } else {
    // Proportional distribution for 11-29 scenes
    const scenesPerBeat = totalScenes / 9; // 9 beats total
    let currentScene = 1;
    
    beats.forEach((beat, index) => {
      const beatScenes = Math.round(scenesPerBeat * (index === beats.length - 1 ? 0.5 : 1));
      if (beatScenes > 0 && currentScene <= totalScenes) {
        distribution[beat] = [];
        for (let i = 0; i < beatScenes && currentScene <= totalScenes; i++) {
          distribution[beat].push(currentScene++);
        }
      } else {
        distribution[beat] = [];
      }
    });
    
    // Ensure CTA is always last scene if we have call_to_action
    if (currentScene - 1 === totalScenes && distribution["cta"].length === 0) {
      distribution["cta"] = [totalScenes];
      if (distribution["resolution"].includes(totalScenes)) {
        distribution["resolution"] = distribution["resolution"].filter(s => s !== totalScenes);
      }
    }
  }
  
  return distribution;
}

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
You must output JSON lines (JSONL format) for the requested scene range. 
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
- Output one JSON object per line for the requested scene range.
- Each scene covers 2000 ms (2 seconds).
- CRITICAL: vo_text must be ≤7 words maximum to fit 2-second timing.
- CRITICAL: Every scene must be a DIRECT CONSEQUENCE of previous events.
- CRITICAL: Use "therefore/but/however" logic between ALL scenes, never "and then".
- CRITICAL: For shorter storyboards, compress the ENTIRE story arc into the available scenes.
- caused_by must reference a SPECIFIC action from a previous scene that triggers this one
- leads_to must create a concrete problem/opportunity that the next scene MUST address
- callback_to should reference earlier setups when paying them off (weapons, allies, information)
- Each scene_twist must be CAUSED BY previous actions, not random events
- Example causality: "Scene 3: Hero destroys bridge" → "Scene 4: Enemy forced to airborne assault" → "Scene 5: Hero hijacks enemy aircraft"
- Avoid generic actions: specify WHO does WHAT causing WHAT CONSEQUENCE
- Use the story's domino_sequences and plot_threads to maintain causality
- CRITICAL: Fit ALL story elements (goal, stakes, twist, resolution) into the target scene count.
- IMPORTANT: Do not wrap output in code blocks or markdown formatting.`;

export async function POST(request: NextRequest) {
  try {
    const { storyBulb, apiKey, startScene, endScene, targetSceneCount, previousScenes, model = 'gemini-2.0-flash-exp' } = await request.json();

    if (!storyBulb || !apiKey) {
      return NextResponse.json(
        { error: 'Story bulb and API key are required' },
        { status: 400 }
      );
    }

    // Use targetSceneCount from request, or from storyBulb, or default to 30
    const totalScenes = targetSceneCount || storyBulb.target_scene_count || 30;
    
    // Handle single batch generation
    const actualStartScene = startScene || 1;
    const actualEndScene = endScene || totalScenes;
    
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
    
    // Get beat distribution for total scenes
    const beatDistribution = getBeatDistribution(totalScenes);
    
    // Create beat mapping guidance for the current batch
    const beatGuidance = Object.entries(beatDistribution)
      .filter(([, scenes]) => scenes.some(s => s >= actualStartScene && s <= actualEndScene))
      .map(([beat, scenes]) => {
        const batchScenes = scenes.filter(s => s >= actualStartScene && s <= actualEndScene);
        return batchScenes.length > 0 ? `Scenes ${batchScenes.join(', ')}: beat="${beat}"` : '';
      })
      .filter(g => g !== '')
      .join('\n');
    
    // Add story compression guidance for shorter videos
    const compressionGuidance = totalScenes < 20 ? 
      `\n\nCRITICAL STORY COMPRESSION FOR ${totalScenes} SCENES:\n- You MUST fit the protagonist's entire journey (goal + stakes + twist + resolution) into ${totalScenes} scenes\n- Every story element from the Story Bulb MUST appear: premise, goal, stakes, constraint, twist, call_to_action\n- Compress multiple story beats into single scenes if necessary\n- Scene 1 should establish the premise and protagonist goal\n- Final scene should deliver the twist and resolution\n- NO story elements can be omitted - compress, don't cut` : '';
    
    const batchPrompt = `${STORYBOARD_PROMPT}\n\nUSER:\nHere is the Story Bulb JSON:\n${JSON.stringify(storyBulb, null, 2)}${contextPrompt}${causalityGuidance}${compressionGuidance}\n\nBEAT DISTRIBUTION FOR THIS BATCH:\n${beatGuidance}\n\nGenerate scenes ${actualStartScene} to ${actualEndScene} (inclusive) of a ${totalScenes}-scene storyboard in JSONL format. Start with scene_id=${actualStartScene}. REMEMBER: Each scene MUST be caused by previous events, creating a domino effect.`;
    
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
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
            maxOutputTokens: 8192,
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
    console.log('Gemini response structure:', JSON.stringify(data, null, 2));
    
    const generatedText = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    console.log('Generated text length:', generatedText.length);
    console.log('Generated text preview:', generatedText.substring(0, 200));
    
    if (!generatedText) {
      console.error('Empty generated text from Gemini');
      return NextResponse.json(
        { error: 'No storyboard generated' },
        { status: 500 }
      );
    }

    // Parse the generated scenes
    const allScenes: StoryboardScene[] = [];
    let cleanedText = generatedText.trim();
    
    try {
      
      // More aggressive markdown cleaning
      if (cleanedText.includes('```')) {
        // Remove all markdown code blocks
        cleanedText = cleanedText.replace(/```jsonl?\s*/gi, '').replace(/```\s*/g, '');
        cleanedText = cleanedText.trim();
      }
      
      // Split into lines and filter out empty ones
      const lines = cleanedText.split('\n').filter((line: string) => {
        const trimmed = line.trim();
        return trimmed && trimmed.startsWith('{') && trimmed.endsWith('}');
      });
      
      console.log(`Found ${lines.length} potential JSON lines`);
      
      for (const line of lines) {
        if (!line.trim()) continue;
        
        try {
          const scene = JSON.parse(line.trim());
          allScenes.push(scene);
          console.log(`Successfully parsed scene ${scene.scene_id}`);
        } catch (err) {
          console.error(`Failed to parse scene:`, line.substring(0, 100), 'Error:', err);
        }
      }
    } catch (parseError) {
      console.error(`Failed to process batch:`, parseError);
      console.error(`Cleaned text length:`, cleanedText?.length);
      console.error(`Cleaned text preview:`, cleanedText?.substring(0, 300));
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