'use client';

import React, { useState } from 'react';
import Image from 'next/image';
import JSZip from 'jszip';

// Helper function to check if URL is a video
const isVideoFile = (url: string): boolean => {
  const videoExtensions = ['.mp4', '.webm', '.mov', '.avi', '.mkv', '.m4v'];
  const lowerUrl = url.toLowerCase();
  return videoExtensions.some(ext => lowerUrl.includes(ext));
};

// Helper function to calculate number of image columns needed based on audio duration
const calculateImageColumns = (durationSeconds: number): number => {
  if (!durationSeconds) return 1; // Default to 1 column if no duration
  return Math.max(1, Math.ceil(durationSeconds / 2)); // One column per 2 seconds, minimum 1
};

export default function Home() {
  const [apiKey, setApiKey] = useState('');
  const [elevenLabsKey, setElevenLabsKey] = useState('');
  const [googleTtsKey, setGoogleTtsKey] = useState('');
  const [highbidApiUrl, setHighbidApiUrl] = useState('');
  const [kokoroUrl, setKokoroUrl] = useState('');
  const [activeTab, setActiveTab] = useState('scripts');
  const [showApiKey, setShowApiKey] = useState(false);
  const [showElevenLabsKey, setShowElevenLabsKey] = useState(false);
  const [showGoogleTtsKey, setShowGoogleTtsKey] = useState(false);
  const [showHighbidUrl, setShowHighbidUrl] = useState(false);
  const [showKokoroUrl, setShowKokoroUrl] = useState(false);
  
  // Script Generation State
  const [scriptTitles, setScriptTitles] = useState<string[]>(['']);
  const [targetSceneCount, setTargetSceneCount] = useState(30); // Default 30 scenes
  
  interface StoryBulb {
    title: string;
    runtime_sec: number;
    tone: string;
    narration_pov: string;
    target_viewer: string;
    premise: string;
    protagonist: string;
    goal: string;
    stakes: string;
    setting: string;
    constraint: string;
    twist: string;
    call_to_action: string;
    visual_style: string;
    action_emphasis: string;
    domino_sequences: string[];
    setups_payoffs: { setup: string; payoff: string }[];
    escalation_points: string[];
    plot_threads: {
      act1: { turning_point: string; consequence: string };
      act2: { turning_point: string; consequence: string };
      act3: { turning_point: string; consequence: string };
    };
    target_scene_count: number; // Added for variable scenes
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
  
  const [generatedStories, setGeneratedStories] = useState<StoryBulb[]>([]);
  const [scriptsLoading, setScriptsLoading] = useState(false);
  const [showStoryBulbPrompt, setShowStoryBulbPrompt] = useState(false);
  const [showStoryboardPrompt, setShowStoryboardPrompt] = useState(false);
  const [geminiModel, setGeminiModel] = useState('gemini-2.0-flash-exp');
  
  // Storyboard State
  const [selectedStory, setSelectedStory] = useState<StoryBulb | null>(null);
  const [generatedStoryboard, setGeneratedStoryboard] = useState<StoryboardScene[]>([]);
  const [storyboardsLoading, setStoryboardsLoading] = useState(false);
  const [storyboardProgress, setStoryboardProgress] = useState({
    currentBatch: 0,
    totalBatches: 6,
    currentScene: 0,
    totalScenes: 30,
    status: ''
  });
  
  // Voice-over State
  const [voiceoverTexts, setVoiceoverTexts] = useState<string[]>(['']);
  const [generatedVoiceovers, setGeneratedVoiceovers] = useState<{text: string, audio: string, provider?: string}[]>([]);
  const [voiceoversLoading, setVoiceoversLoading] = useState(false);
  const [availableVoices, setAvailableVoices] = useState<{
    voice_id: string;
    name: string;
    description: string;
    preview_url?: string;
    labels?: {
      gender?: string;
      age?: string;
      style?: string;
      type?: string;
    };
  }[]>([]);
  const [selectedVoiceId, setSelectedVoiceId] = useState('Kore');
  const [voicesLoaded, setVoicesLoaded] = useState(false);
  const [ttsProvider, setTtsProvider] = useState<'elevenlabs' | 'google' | 'kokoro'>('google');
  const [googleVoicesLoaded, setGoogleVoicesLoaded] = useState(false);
  
  // Load voices function (memoized with useCallback)
  const loadVoices = React.useCallback(async (provider: 'elevenlabs' | 'google' | 'kokoro' = ttsProvider) => {
    if (provider === 'elevenlabs') {
      if (!elevenLabsKey || voicesLoaded) return;
      
      try {
        const response = await fetch(`/api/generate-voiceover?apiKey=${elevenLabsKey}`);
        const data = await response.json();
        
        if (data.success && data.voices) {
          setAvailableVoices(data.voices);
          setVoicesLoaded(true);
          setSelectedVoiceId('21m00Tcm4TlvDq8ikWAM');
        }
      } catch (err) {
        console.error('Failed to load ElevenLabs voices:', err);
      }
    } else if (provider === 'google') {
      if (!googleTtsKey || googleVoicesLoaded) return;
      
      try {
        const response = await fetch(`/api/generate-google-tts?apiKey=${googleTtsKey}`);
        const data = await response.json();
        
        if (data.success && data.voices) {
          setAvailableVoices(data.voices);
          setGoogleVoicesLoaded(true);
          setSelectedVoiceId('Kore');
        }
      } catch (err) {
        console.error('Failed to load Google voices:', err);
      }
    }
  }, [ttsProvider, elevenLabsKey, googleTtsKey, voicesLoaded, googleVoicesLoaded]);

  // Helper function to update story bulb
  const updateStoryBulb = (storyIndex: number, field: keyof StoryBulb, value: string | number | string[] | object[]) => {
    setGeneratedStories(prev => prev.map((story, index) => {
      if (index === storyIndex) {
        const updated = { ...story, [field]: value };
        // Update selectedStory if it matches
        if (selectedStory === story) {
          setSelectedStory(updated);
        }
        return updated;
      }
      return story;
    }));
  };

  // Auto-load voices when API keys are available
  React.useEffect(() => {
    if (ttsProvider === 'elevenlabs' && elevenLabsKey && !voicesLoaded) {
      loadVoices('elevenlabs');
    } else if (ttsProvider === 'google' && googleTtsKey && !googleVoicesLoaded) {
      loadVoices('google');
    }
  }, [ttsProvider, elevenLabsKey, googleTtsKey, voicesLoaded, googleVoicesLoaded, loadVoices]);

  // Image Generation State
  const [imagePrompts, setImagePrompts] = useState<string[]>(['']);
  const [generatedImages, setGeneratedImages] = useState<string[]>([]);
  const [imagesLoading, setImagesLoading] = useState(false);
  const [imageProvider, setImageProvider] = useState<'openrouter' | 'highbid' | 'gemini'>('openrouter');
  const [imageWidth, setImageWidth] = useState(1024);
  const [imageHeight, setImageHeight] = useState(1024);
  
  // Effects State and Video Rendering
  const [finalVideos, setFinalVideos] = useState<string[]>([]);
  const [renderingVideo, setRenderingVideo] = useState(false);
  const [renderProgress, setRenderProgress] = useState({
    step: '',
    progress: 0,
    total: 100
  });
  
  const [error, setError] = useState<string | null>(null);

  // Storyboard Images State
  const [storyboardImages, setStoryboardImages] = useState<{[key: string]: string}>({});
  const [uploadedFileTypes, setUploadedFileTypes] = useState<{[sceneId: number]: 'video' | 'image'}>({});
  const [imageGenerationLoading, setImageGenerationLoading] = useState<{[key: string]: boolean}>({});
  const [batchImageLoading, setBatchImageLoading] = useState(false);
  const [batchImageProgress, setBatchImageProgress] = useState({
    current: 0,
    total: 0,
    currentScene: 0,
    status: '',
    failed: 0,
    retries: 0
  });

  // Storyboard Voiceovers State
  const [storyboardVoiceovers, setStoryboardVoiceovers] = useState<{[sceneId: number]: string}>({});
  const [voiceoverDurations, setVoiceoverDurations] = useState<{[sceneId: number]: number}>({});
  const [voiceoverGenerationLoading, setVoiceoverGenerationLoading] = useState<{[sceneId: number]: boolean}>({});
  const [batchVoiceoverLoading, setBatchVoiceoverLoading] = useState(false);
  const [batchVoiceoverProgress, setBatchVoiceoverProgress] = useState({
    current: 0,
    total: 0,
    currentScene: 0,
    status: '',
    failed: 0,
    retries: 0
  });

  // Create Flux prompt from storyboard scene
  const createFluxPrompt = (scene: StoryboardScene, storyVisualStyle?: string) => {
    const vp = scene.visual_prompt;
    
    // Convert lighting enum to descriptive text
    const lightingMap: {[key: string]: string} = {
      'soft': 'soft lighting',
      'hard': 'hard lighting', 
      'noir': 'noir dramatic lighting',
      'neon': 'neon lighting',
      'golden_hour': 'golden hour lighting',
      'overcast': 'overcast lighting',
      'practical': 'practical lighting'
    };
    
    // Convert color palette enum to descriptive text
    const colorMap: {[key: string]: string} = {
      'warm': 'warm tones',
      'cool': 'cool tones',
      'monochrome': 'monochrome tones',
      'teal_orange': 'teal orange tones',
      'pastel': 'pastel tones'
    };
    
    // Build prompt components - use story-level visual style for consistency
    const components = [
      storyVisualStyle || vp.style_tags, // Use story-level visual style if available
      `${vp.mood} mood`,
      vp.setting,
      vp.characters,
      vp.action,
      vp.props,
      lightingMap[vp.lighting] || vp.lighting,
      colorMap[vp.color_palette] || vp.color_palette,
      `${vp.camera} camera`,
      `${vp.composition} composition`,
      'cinematic shot',
      `aspect ratio ${vp.aspect_ratio}`,
      `seed ${vp.seed}`
    ].filter(Boolean);
    
    return {
      prompt: components.join(', '),
      negative: vp.negative_tags
    };
  };

  const tabs = [
    { id: 'scripts', name: '1. Scripts', icon: '📝' },
    { id: 'storyboard', name: '2. Storyboard', icon: '🎨' },
    { id: 'voiceovers', name: '3. Voice-overs', icon: '🎤' },
    { id: 'images', name: '4. Images', icon: '🖼️' },
    { id: 'effects', name: '5. Final Video', icon: '🎬' }
  ];

  const handleVoiceoverGeneration = async () => {
    const apiKeyRequired = ttsProvider === 'elevenlabs' ? elevenLabsKey : googleTtsKey;
    const providerName = ttsProvider === 'elevenlabs' ? 'ElevenLabs' : 'Google TTS';
    
    if (!apiKeyRequired || voiceoverTexts.filter(t => t.trim()).length === 0) {
      setError(`Please provide ${providerName} API key and at least one text`);
      return;
    }

    setVoiceoversLoading(true);
    setError(null);

    try {
      const results: {text: string, audio: string, provider?: string}[] = [];
      
      for (const text of voiceoverTexts) {
        if (!text.trim()) continue;
        
        const endpoint = ttsProvider === 'elevenlabs' 
          ? '/api/generate-voiceover' 
          : ttsProvider === 'kokoro' 
            ? '/api/generate-voiceover-kokoro'
            : '/api/generate-google-tts';
        
        const requestBody = ttsProvider === 'elevenlabs' 
          ? { text, apiKey: elevenLabsKey, voiceId: selectedVoiceId }
          : ttsProvider === 'kokoro'
            ? { text, voice: selectedVoiceId, speed: 1.0, kokoroUrl }
            : { text, apiKey: googleTtsKey, voiceName: selectedVoiceId };
        
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
        });

        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.error || `Failed to generate voice-over with ${providerName}`);
        }

        if (data.audio) {
          results.push({ text, audio: data.audio, provider: data.provider || ttsProvider });
        }
      }
      
      setGeneratedVoiceovers(results);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setVoiceoversLoading(false);
    }
  };

  const handleScriptGeneration = async () => {
    if (!googleTtsKey || scriptTitles.filter(t => t.trim()).length === 0) {
      setError('Please provide Google API key and at least one title');
      return;
    }
    
    setScriptsLoading(true);
    setError(null);
    
    try {
      const results = [];
      
      for (const title of scriptTitles) {
        if (!title.trim()) continue;
        
        const response = await fetch('/api/generate-story', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            title,
            apiKey: googleTtsKey,
            model: geminiModel,
            targetSceneCount,
          }),
        });

        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.error || 'Failed to generate story');
        }

        if (data.storyBulb) {
          // Ensure target_scene_count is set
          data.storyBulb.target_scene_count = targetSceneCount;
          results.push(data.storyBulb);
        }
      }
      
      setGeneratedStories(results);
      if (results.length > 0) {
        setSelectedStory(results[0]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate scripts');
    } finally {
      setScriptsLoading(false);
    }
  };
  
  const handleStoryboardGeneration = async (resumeFromScene = 1) => {
    if (!googleTtsKey || !selectedStory) {
      setError('Please provide Google API key and select a story');
      return;
    }
    
    setStoryboardsLoading(true);
    setError(null);
    
    // Get target scene count from selected story, default to 30 if not set
    const targetScenes = selectedStory.target_scene_count || 30;
    
    // Calculate starting point for resume functionality
    const batchSize = 5;
    const totalBatches = Math.ceil(targetScenes / batchSize);
    const startingBatch = Math.floor((resumeFromScene - 1) / batchSize);
    const existingScenes = resumeFromScene === 1 ? [] : generatedStoryboard.slice(0, resumeFromScene - 1);
    
    // Reset storyboard if starting fresh, otherwise keep existing scenes
    if (resumeFromScene === 1) {
      setGeneratedStoryboard([]);
    }
    
    setStoryboardProgress({ 
      currentBatch: startingBatch, 
      totalBatches, 
      currentScene: existingScenes.length, 
      totalScenes: targetScenes, 
      status: resumeFromScene === 1 ? 'Starting storyboard generation...' : `Resuming from scene ${resumeFromScene}...` 
    });
    
    try {
      const allScenes: StoryboardScene[] = [...existingScenes];
      
      for (let batchIndex = startingBatch; batchIndex < totalBatches; batchIndex++) {
        const startScene = batchIndex * batchSize + 1;
        const endScene = Math.min(startScene + batchSize - 1, targetScenes);
        
        setStoryboardProgress({
          currentBatch: batchIndex + 1,
          totalBatches,
          currentScene: startScene - 1,
          totalScenes: targetScenes,
          status: `Generating scenes ${startScene}-${endScene}...`
        });
        
        const response = await fetch('/api/generate-storyboard', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            storyBulb: selectedStory,
            apiKey: googleTtsKey,
            startScene,
            endScene,
            targetSceneCount: targetScenes,
            previousScenes: allScenes.slice(-10), // Send last 10 scenes for context
            model: geminiModel
          }),
        });
        
        if (!response.ok) {
          const errorData = await response.json();
          throw new Error(errorData.error || `Failed to generate batch ${batchIndex + 1}`);
        }
        
        const data = await response.json();
        if (data.storyboard && Array.isArray(data.storyboard)) {
          allScenes.push(...data.storyboard);
          
          // Update storyboard in real-time as scenes are generated
          setGeneratedStoryboard(prev => [...prev, ...data.storyboard]);
          
          setStoryboardProgress({
            currentBatch: batchIndex + 1,
            totalBatches,
            currentScene: allScenes.length,
            totalScenes: targetScenes,
            status: `Generated ${allScenes.length}/${targetScenes} scenes - Populating UI...`
          });
          
          // Auto-switch to storyboard tab after first batch for immediate feedback
          if (batchIndex === 0) {
            setActiveTab('storyboard');
          }
        }
        
        // Small delay between batches to show progress
        if (batchIndex < totalBatches - 1) {
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }
      
      if (allScenes.length > 0) {
        setStoryboardProgress({
          currentBatch: totalBatches,
          totalBatches,
          currentScene: allScenes.length,
          totalScenes: 30,
          status: 'Storyboard generation complete!'
        });
        setActiveTab('storyboard');
      } else {
        throw new Error('No scenes were generated');
      }
      
    } catch (err) {
      const currentScenes = generatedStoryboard.length;
      const failedAtScene = currentScenes + 1;
      const errorMsg = err instanceof Error ? err.message : 'Failed to generate storyboard';
      
      if (currentScenes > 0) {
        setError(`${errorMsg}. Generated ${currentScenes} scenes successfully. You can resume from scene ${failedAtScene}.`);
        setStoryboardProgress({ 
          currentBatch: Math.ceil(currentScenes / batchSize), 
          totalBatches, 
          currentScene: currentScenes, 
          totalScenes: 30, 
          status: `Stopped at scene ${currentScenes}. Click Resume to continue.` 
        });
      } else {
        setError(errorMsg);
        setStoryboardProgress({ currentBatch: 0, totalBatches, currentScene: 0, totalScenes: 30, status: '' });
      }
    } finally {
      setStoryboardsLoading(false);
      // Clear progress after a delay
      setTimeout(() => {
        setStoryboardProgress({ currentBatch: 0, totalBatches: 6, currentScene: 0, totalScenes: 30, status: '' });
      }, 3000);
    }
  };

  const handleImageGeneration = async () => {
    const requiredKey = imageProvider === 'openrouter' ? apiKey : 
                        imageProvider === 'gemini' ? googleTtsKey : highbidApiUrl;
    const providerName = imageProvider === 'openrouter' ? 'OpenRouter API key' : 
                         imageProvider === 'gemini' ? 'Gemini API key' : 'Highbid API URL';
    
    if (!requiredKey || imagePrompts.filter(p => p.trim()).length === 0) {
      setError(`Please provide ${providerName} and at least one image prompt`);
      return;
    }

    setImagesLoading(true);
    setError(null);

    try {
      const results: string[] = [];
      
      for (const prompt of imagePrompts) {
        if (!prompt.trim()) continue;
        
        const endpoint = imageProvider === 'openrouter' ? '/api/generate-image' : 
                        imageProvider === 'gemini' ? '/api/generate-gemini-image' : '/api/generate-highbid-image';
        const requestBody = imageProvider === 'openrouter' 
          ? { prompt, apiKey }
          : imageProvider === 'gemini'
            ? { prompt, apiKey: googleTtsKey }
            : { prompt, apiUrl: highbidApiUrl, width: imageWidth, height: imageHeight };
        
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
        });

        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.error || `Failed to generate image with ${imageProvider}`);
        }

        if (data.image) {
          results.push(data.image);
        }
      }
      
      setGeneratedImages(results);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setImagesLoading(false);
    }
  };

  // Generate image for a specific column of a storyboard scene
  const generateStoryboardImageColumn = async (scene: StoryboardScene, colIndex: number) => {
    const requiredKey = imageProvider === 'openrouter' ? apiKey : 
                        imageProvider === 'gemini' ? googleTtsKey : highbidApiUrl;
    const providerName = imageProvider === 'openrouter' ? 'OpenRouter API key' : 
                         imageProvider === 'gemini' ? 'Gemini API key' : 'Highbid API URL';

    if (!requiredKey) {
      setError(`${providerName} is required for storyboard image generation`);
      return;
    }

    const numColumns = calculateImageColumns(voiceoverDurations[scene.scene_id]);
    const imageKey = `${scene.scene_id}_${colIndex}`;
    
    console.log(`Generating image for scene ${scene.scene_id}, column ${colIndex + 1}/${numColumns} using ${imageProvider}`);

    setImageGenerationLoading(prev => ({ ...prev, [imageKey]: true }));
    setError(null);

    try {
      const basePrompt = createFluxPrompt(scene, selectedStory?.visual_style).prompt;
      
      // Add temporal context for multi-column images
      const timeStart = colIndex * 2;
      const timeEnd = (colIndex + 1) * 2;
      const enhancedPrompt = numColumns > 1 
        ? `${basePrompt}, temporal context: action moment at ${timeStart}-${timeEnd} seconds`
        : basePrompt;
      
      // Get dimensions from aspect ratio (only needed for Highbid)
      let width, height;
      switch (scene.visual_prompt.aspect_ratio) {
        case '16:9':
          width = 1024; height = 576;
          break;
        case '9:16':
          width = 576; height = 1024;
          break;
        case '1:1':
        default:
          width = 1024; height = 1024;
          break;
      }

      const endpoint = imageProvider === 'openrouter' ? '/api/generate-image' : 
                      imageProvider === 'gemini' ? '/api/generate-gemini-image' : '/api/generate-highbid-image';
      const requestBody = imageProvider === 'openrouter' 
        ? { prompt: enhancedPrompt, apiKey }
        : imageProvider === 'gemini'
          ? { prompt: enhancedPrompt, apiKey: googleTtsKey }
          : { prompt: enhancedPrompt, apiUrl: highbidApiUrl, width, height };

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      });
      
      const data = await response.json();
      
      if (!response.ok) {
        throw new Error(data.error || `Failed to generate image for scene ${scene.scene_id}, column ${colIndex + 1}`);
      }
      
      // Handle different response formats
      const imageUrl = data.image || data.imageUrl || data.audioUrl;
      if (imageUrl) {
        // Store the image with the appropriate key
        const finalImageKey = numColumns === 1 ? scene.scene_id.toString() : imageKey;
        setStoryboardImages(prev => ({ ...prev, [finalImageKey]: imageUrl }));
      } else {
        throw new Error('No image data received from API');
      }
      
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred generating storyboard image');
    } finally {
      setImageGenerationLoading(prev => ({ ...prev, [imageKey]: false }));
    }
  };

  // Generate image for a specific storyboard scene (legacy function - now generates all columns)
  const generateStoryboardImage = async (scene: StoryboardScene) => {
    if (!highbidApiUrl) {
      setError('Highbid API URL is required for storyboard image generation');
      return;
    }

    // Calculate how many images we need based on audio duration
    const numColumns = calculateImageColumns(voiceoverDurations[scene.scene_id]);
    console.log(`Generating ${numColumns} images for scene ${scene.scene_id} (${voiceoverDurations[scene.scene_id]}s audio)`);

    setImageGenerationLoading(prev => ({ ...prev, [scene.scene_id]: true }));
    setError(null);

    try {
      const basePrompt = createFluxPrompt(scene, selectedStory?.visual_style).prompt;
      
      // Get dimensions from aspect ratio
      let width, height;
      switch (scene.visual_prompt.aspect_ratio) {
        case '16:9':
          width = 1024; height = 576;
          break;
        case '9:16':
          width = 576; height = 1024;
          break;
        case '1:1':
        default:
          width = 1024; height = 1024;
          break;
      }
      
      // Generate images for each column (time segment)
      const imagePromises = [];
      for (let colIndex = 0; colIndex < numColumns; colIndex++) {
        const startTime = colIndex * 2;
        const endTime = (colIndex + 1) * 2;
        
        // Enhance prompt with temporal context
        const timePrompt = `${basePrompt}, at ${startTime}-${endTime} seconds into the scene, progressive sequence ${colIndex + 1} of ${numColumns}`;
        
        const promise = fetch('/api/generate-highbid-image', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            prompt: timePrompt,
            apiUrl: highbidApiUrl,
            width,
            height
          }),
        }).then(async response => {
          const data = await response.json();
          return { colIndex, data, ok: response.ok };
        });
        
        imagePromises.push(promise);
      }

      // Wait for all images to generate
      const results = await Promise.all(imagePromises);
      
      // Process results and update state
      const newImages: { [key: string]: string } = {};
      let successCount = 0;
      
      for (const result of results) {
        if (result.ok && result.data.image) {
          const key = result.colIndex === 0 ? scene.scene_id.toString() : `${scene.scene_id}_${result.colIndex}`;
          newImages[key] = result.data.image;
          successCount++;
        }
      }
      
      if (successCount > 0) {
        setStoryboardImages(prev => ({ ...prev, ...newImages }));
        console.log(`Successfully generated ${successCount}/${numColumns} images for scene ${scene.scene_id}`);
      }
      
      if (successCount < numColumns) {
        setError(`Generated ${successCount}/${numColumns} images. Some failed to generate.`);
      }
      
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred generating storyboard images');
    } finally {
      setImageGenerationLoading(prev => ({ ...prev, [scene.scene_id]: false }));
    }
  };

  // Generate all storyboard images in batch with retry logic and progress
  const generateAllStoryboardImages = async () => {
    const requiredKey = imageProvider === 'openrouter' ? apiKey : 
                        imageProvider === 'gemini' ? googleTtsKey : highbidApiUrl;
    const providerName = imageProvider === 'openrouter' ? 'OpenRouter API key' : 
                         imageProvider === 'gemini' ? 'Gemini API key' : 'Highbid API URL';

    if (!requiredKey) {
      setError(`${providerName} is required for batch storyboard image generation`);
      return;
    }

    if (generatedStoryboard.length === 0) {
      setError('No storyboard generated yet');
      return;
    }

    setBatchImageLoading(true);
    setError(null);
    
    // Calculate total images needed across all scenes
    const totalImages = generatedStoryboard.reduce((sum, scene) => {
      const numColumns = calculateImageColumns(voiceoverDurations[scene.scene_id]);
      return sum + numColumns;
    }, 0);
    
    setBatchImageProgress({
      current: 0,
      total: totalImages,
      currentScene: 0,
      status: 'Starting batch image generation...',
      failed: 0,
      retries: 0
    });

    try {
      const maxRetries = 3;
      let totalGenerated = 0;
      
      for (let i = 0; i < generatedStoryboard.length; i++) {
        const scene = generatedStoryboard[i];
        const numColumns = calculateImageColumns(voiceoverDurations[scene.scene_id]);
        
        console.log(`Generating ${numColumns} images for scene ${scene.scene_id} (${voiceoverDurations[scene.scene_id]}s audio)`);
        
        setBatchImageProgress(prev => ({
          ...prev,
          currentScene: scene.scene_id,
          status: `Generating ${numColumns} ${numColumns === 1 ? 'image' : 'images'} for scene ${scene.scene_id}...`
        }));

        const basePrompt = createFluxPrompt(scene, selectedStory?.visual_style).prompt;
        
        // Get dimensions from aspect ratio
        let width, height;
        switch (scene.visual_prompt.aspect_ratio) {
          case '16:9':
            width = 1024; height = 576;
            break;
          case '9:16':
            width = 576; height = 1024;
            break;
          case '1:1':
          default:
            width = 1024; height = 1024;
            break;
        }

        // Generate multiple images sequentially for this scene
        const sceneImages: { [key: string]: string } = {};
        
        for (let colIndex = 0; colIndex < numColumns; colIndex++) {
          const timeStart = colIndex * 2;
          const timeEnd = (colIndex + 1) * 2;
          const timeRange = numColumns > 1 ? ` (${timeStart}-${timeEnd}s)` : '';
          
          const enhancedPrompt = numColumns > 1 
            ? `${basePrompt}, temporal context: action moment at ${timeStart}-${timeEnd} seconds${timeRange}`
            : basePrompt;

          let attempts = 0;
          let success = false;
          let imageData = null;

          while (attempts < maxRetries && !success) {
            try {
              if (attempts > 0) {
                setBatchImageProgress(prev => ({
                  ...prev,
                  status: `Retrying scene ${scene.scene_id} image ${colIndex + 1}/${numColumns} (attempt ${attempts + 1}/${maxRetries})...`,
                  retries: prev.retries + 1
                }));
                // Wait a bit before retry
                await new Promise(resolve => setTimeout(resolve, 2000));
              }
              
              const endpoint = imageProvider === 'openrouter' ? '/api/generate-image' : 
                              imageProvider === 'gemini' ? '/api/generate-gemini-image' : '/api/generate-highbid-image';
              const requestBody = imageProvider === 'openrouter' 
                ? { prompt: enhancedPrompt, apiKey }
                : imageProvider === 'gemini'
                  ? { prompt: enhancedPrompt, apiKey: googleTtsKey }
                  : { prompt: enhancedPrompt, apiUrl: highbidApiUrl, width, height };

              const response = await fetch(endpoint, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify(requestBody),
              });
              
              const data = await response.json();
              
              if (!response.ok) {
                throw new Error(data.error || `Failed to generate image ${colIndex + 1} for scene ${scene.scene_id}`);
              }
              
              const imageUrl = data.image || data.imageUrl || data.audioUrl;
              if (imageUrl) {
                imageData = imageUrl;
                success = true;
                totalGenerated++;
                
                setBatchImageProgress(prev => ({
                  ...prev,
                  current: totalGenerated,
                  status: `Generated image ${colIndex + 1}/${numColumns} for scene ${scene.scene_id} ✓`
                }));
                
                // Store the image immediately
                const imageKey = numColumns === 1 ? scene.scene_id.toString() : `${scene.scene_id}_${colIndex + 1}`;
                sceneImages[imageKey] = data.image;
              } else {
                throw new Error('No image data received from API');
              }
              
            } catch (err) {
              attempts++;
              console.error(`Attempt ${attempts} failed for scene ${scene.scene_id} image ${colIndex + 1}:`, err);
              
              if (attempts >= maxRetries) {
                setBatchImageProgress(prev => ({
                  ...prev,
                  failed: prev.failed + 1,
                  current: totalGenerated,
                  status: `Failed to generate image ${colIndex + 1} for scene ${scene.scene_id} after ${maxRetries} attempts ✗`
                }));
                break; // Stop trying this image and move to next
              }
            }
          }
        }
        
        setStoryboardImages(prev => ({
          ...prev,
          ...sceneImages
        }));
        
        // Small delay to show the progress update
        await new Promise(resolve => setTimeout(resolve, 500));
      }

      setBatchImageProgress(prev => ({
        ...prev,
        status: `Batch generation complete! Generated: ${totalGenerated}, Failed: ${prev.failed}`
      }));
      
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred during batch generation');
    } finally {
      setBatchImageLoading(false);
      // Clear progress after 5 seconds
      setTimeout(() => {
        setBatchImageProgress({ current: 0, total: 0, currentScene: 0, status: '', failed: 0, retries: 0 });
      }, 5000);
    }
  };

  // Generate voiceover for a specific storyboard scene
  const generateStoryboardVoiceover = async (scene: StoryboardScene) => {
    const currentProvider = ttsProvider;
    const currentApiKey = currentProvider === 'elevenlabs' 
      ? elevenLabsKey 
      : currentProvider === 'kokoro' 
        ? kokoroUrl 
        : googleTtsKey;
    
    console.log('🎤 Voiceover Debug:', {
      provider: currentProvider,
      hasApiKey: !!currentApiKey,
      selectedVoiceId,
      sceneText: scene.scene_twist || scene.vo_text,
      availableVoicesCount: availableVoices.length
    });
    
    if (!currentApiKey) {
      setError(`${currentProvider === 'elevenlabs' ? 'ElevenLabs' : 'Google TTS'} API key is required for voiceover generation`);
      return;
    }

    if (!selectedVoiceId) {
      setError(`Please select a voice first. Go to Voice-overs tab to load and select voices.`);
      return;
    }

    setVoiceoverGenerationLoading(prev => ({ ...prev, [scene.scene_id]: true }));
    setError(null);

    try {
      const endpoint = currentProvider === 'elevenlabs' 
        ? '/api/generate-voiceover' 
        : currentProvider === 'kokoro'
          ? '/api/generate-voiceover-kokoro'
          : '/api/generate-google-tts';
      
      // Use scene_twist for more engaging voiceover text
      const voiceoverText = scene.scene_twist || scene.vo_text;
      
      const requestBody = currentProvider === 'elevenlabs' 
        ? { text: voiceoverText, apiKey: currentApiKey, voiceId: selectedVoiceId }
        : currentProvider === 'kokoro'
          ? { text: voiceoverText, voice: selectedVoiceId, speed: scene.read_speed_wps ? scene.read_speed_wps / 2.5 : 1.0, kokoroUrl }
          : { text: voiceoverText, apiKey: currentApiKey, voiceName: selectedVoiceId };

      console.log('🎤 Making request:', { endpoint, requestBody: { ...requestBody, apiKey: '***' } });

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      });

      const data = await response.json();
      console.log('🎤 Response:', { ok: response.ok, status: response.status, hasAudio: !!data.audio });

      if (!response.ok) {
        throw new Error(data.error || 'Failed to generate storyboard voiceover');
      }

      const audioUrl = data.audioUrl || data.audio;
      if (audioUrl) {
        setStoryboardVoiceovers(prev => ({
          ...prev,
          [scene.scene_id]: audioUrl
        }));
        console.log('🎤 Voiceover saved for scene:', scene.scene_id);
      } else {
        throw new Error('No audio data received from API');
      }
    } catch (err) {
      console.error('🎤 Voiceover error:', err);
      setError(err instanceof Error ? err.message : 'An error occurred generating storyboard voiceover');
    } finally {
      setVoiceoverGenerationLoading(prev => ({ ...prev, [scene.scene_id]: false }));
    }
  };

  // Generate all storyboard voiceovers in batch with retry logic and progress
  const generateAllStoryboardVoiceovers = async () => {
    const currentProvider = ttsProvider;
    const currentApiKey = currentProvider === 'elevenlabs' 
      ? elevenLabsKey 
      : currentProvider === 'kokoro' 
        ? kokoroUrl 
        : googleTtsKey;
    
    if (!currentApiKey) {
      setError(`${currentProvider === 'elevenlabs' ? 'ElevenLabs' : 'Google TTS'} API key is required for batch voiceover generation`);
      return;
    }

    if (generatedStoryboard.length === 0) {
      setError('No storyboard generated yet');
      return;
    }

    setBatchVoiceoverLoading(true);
    setError(null);
    
    const totalScenes = generatedStoryboard.length;
    setBatchVoiceoverProgress({
      current: 0,
      total: totalScenes,
      currentScene: 0,
      status: 'Starting batch voiceover generation...',
      failed: 0,
      retries: 0
    });

    try {
      const maxRetries = 3;
      
      for (let i = 0; i < generatedStoryboard.length; i++) {
        const scene = generatedStoryboard[i];
        let attempts = 0;
        let success = false;

        setBatchVoiceoverProgress(prev => ({
          ...prev,
          currentScene: scene.scene_id,
          status: `Generating voiceover for scene ${scene.scene_id}...`
        }));

        while (attempts < maxRetries && !success) {
          try {
            if (attempts > 0) {
              setBatchVoiceoverProgress(prev => ({
                ...prev,
                status: `Retrying scene ${scene.scene_id} (attempt ${attempts + 1}/${maxRetries})...`,
                retries: prev.retries + 1
              }));
              // Wait a bit before retry
              await new Promise(resolve => setTimeout(resolve, 2000));
            }

            const endpoint = currentProvider === 'elevenlabs' 
              ? '/api/generate-voiceover' 
              : currentProvider === 'kokoro'
                ? '/api/generate-voiceover-kokoro'
                : '/api/generate-google-tts';
            
            // Use scene_twist for more engaging voiceover text
            const voiceoverText = scene.scene_twist || scene.vo_text;
            
            const requestBody = currentProvider === 'elevenlabs' 
              ? { text: voiceoverText, apiKey: currentApiKey, voiceId: selectedVoiceId }
              : currentProvider === 'kokoro'
                ? { text: voiceoverText, voice: selectedVoiceId, speed: scene.read_speed_wps ? scene.read_speed_wps / 2.5 : 1.0, kokoroUrl }
                : { text: voiceoverText, apiKey: currentApiKey, voiceName: selectedVoiceId };

            const response = await fetch(endpoint, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
              },
              body: JSON.stringify(requestBody),
            });

            const data = await response.json();

            if (!response.ok) {
              throw new Error(data.error || `Failed to generate voiceover for scene ${scene.scene_id}`);
            }

            const audioUrl = data.audioUrl || data.audio;
            if (audioUrl) {
              // Update the storyboard voiceovers immediately to show progress
              setStoryboardVoiceovers(prev => ({
                ...prev,
                [scene.scene_id]: audioUrl
              }));
              success = true;
              
              setBatchVoiceoverProgress(prev => ({
                ...prev,
                current: prev.current + 1,
                status: `Generated voiceover for scene ${scene.scene_id} ✓`
              }));
              
              // Small delay to show the progress update
              await new Promise(resolve => setTimeout(resolve, 500));
            } else {
              throw new Error('No audio data received from API');
            }
            
          } catch (err) {
            attempts++;
            console.error(`Attempt ${attempts} failed for scene ${scene.scene_id}:`, err);
            
            if (attempts >= maxRetries) {
              setBatchVoiceoverProgress(prev => ({
                ...prev,
                failed: prev.failed + 1,
                current: prev.current + 1,
                status: `Failed to generate voiceover for scene ${scene.scene_id} after ${maxRetries} attempts ✗`
              }));
              await new Promise(resolve => setTimeout(resolve, 1000));
            }
          }
        }
      }

      setBatchVoiceoverProgress(prev => ({
        ...prev,
        status: `Batch generation complete! Generated: ${prev.current - prev.failed}, Failed: ${prev.failed}`
      }));
      
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred during batch voiceover generation');
    } finally {
      setBatchVoiceoverLoading(false);
      // Clear progress after 5 seconds
      setTimeout(() => {
        setBatchVoiceoverProgress({ current: 0, total: 0, currentScene: 0, status: '', failed: 0, retries: 0 });
      }, 5000);
    }
  };

  // Handle video rendering
  const handleVideoRender = async () => {
    if (!selectedStory || generatedStoryboard.length === 0) {
      setError('Please generate a storyboard first');
      return;
    }

    setRenderingVideo(true);
    setError(null);
    setRenderProgress({ step: 'Preparing video data...', progress: 0, total: 100 });

    try {
      // Collect all the generated content
      const videoData = {
        story: selectedStory,
        storyboard: generatedStoryboard,
        images: storyboardImages,
        voiceovers: storyboardVoiceovers,
        metadata: {
          totalScenes: generatedStoryboard.length,
          imagesGenerated: Object.keys(storyboardImages).length,
          voiceoversGenerated: Object.keys(storyboardVoiceovers).length,
          aspectRatio: '9:16', // Vertical format for social media
          duration: generatedStoryboard.length * 2 // 2 seconds per scene
        }
      };

      setRenderProgress({ step: 'Collecting content...', progress: 20, total: 100 });

      // Simulate video rendering process (replace with actual video generation API later)
      const steps = [
        'Processing storyboard...',
        'Combining images...',
        'Syncing voiceovers...',
        'Adding transitions...',
        'Finalizing video...'
      ];

      for (let i = 0; i < steps.length; i++) {
        setRenderProgress({ 
          step: steps[i], 
          progress: 20 + (i + 1) * 15, 
          total: 100 
        });
        await new Promise(resolve => setTimeout(resolve, 2000)); // Simulate processing time
      }

      setRenderProgress({ step: 'Rendering complete!', progress: 100, total: 100 });

      // For now, we'll just navigate to the Final Video tab
      // Later this will include the actual rendered video
      setActiveTab('effects');

      // Store the video data for the Final Video tab
      console.log('Video render data:', videoData);

      // Add a placeholder final video (replace with actual video URL later)
      // Properly encode Unicode characters for base64
      const jsonString = JSON.stringify(videoData);
      const encodedString = encodeURIComponent(jsonString);
      const placeholderVideo = `data:application/json;charset=utf-8,${encodedString}`;
      setFinalVideos([placeholderVideo]);

    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to render video');
    } finally {
      setRenderingVideo(false);
      // Clear progress after a delay
      setTimeout(() => {
        setRenderProgress({ step: '', progress: 0, total: 100 });
      }, 3000);
    }
  };

  const addPrompt = (type: 'script' | 'image' | 'voiceover') => {
    if (type === 'script') {
      setScriptTitles([...scriptTitles, '']);
    } else if (type === 'image') {
      setImagePrompts([...imagePrompts, '']);
    } else {
      setVoiceoverTexts([...voiceoverTexts, '']);
    }
  };

  const removePrompt = (type: 'script' | 'image' | 'voiceover', index: number) => {
    if (type === 'script') {
      setScriptTitles(scriptTitles.filter((_, i) => i !== index));
    } else if (type === 'image') {
      setImagePrompts(imagePrompts.filter((_, i) => i !== index));
    } else {
      setVoiceoverTexts(voiceoverTexts.filter((_, i) => i !== index));
    }
  };

  const updatePrompt = (type: 'script' | 'image' | 'voiceover', index: number, value: string) => {
    if (type === 'script') {
      const updated = [...scriptTitles];
      updated[index] = value;
      setScriptTitles(updated);
    } else if (type === 'image') {
      const updated = [...imagePrompts];
      updated[index] = value;
      setImagePrompts(updated);
    } else {
      const updated = [...voiceoverTexts];
      updated[index] = value;
      setVoiceoverTexts(updated);
    }
  };

  // Download all generated content as ZIP
  const downloadProjectAsZip = async () => {
    if (!selectedStory || generatedStoryboard.length === 0) {
      setError('No content to download. Generate a storyboard first.');
      return;
    }

    try {
      const zip = new JSZip();
      
      // Create project metadata
      const projectData = {
        projectName: selectedStory.title,
        createdAt: new Date().toISOString(),
        targetSceneCount: selectedStory.target_scene_count || generatedStoryboard.length,
        storyBulb: selectedStory,
        storyboard: generatedStoryboard,
        contentCounts: {
          scenes: generatedStoryboard.length,
          images: Object.keys(storyboardImages).length,
          voiceovers: Object.keys(storyboardVoiceovers).length
        }
      };
      
      // Add project metadata
      zip.file('project-metadata.json', JSON.stringify(projectData, null, 2));
      
      // Add storyboard data
      zip.file('storyboard.json', JSON.stringify(generatedStoryboard, null, 2));
      
      // Add images folder
      const imagesFolder = zip.folder('images');
      for (const [sceneId, imageUrl] of Object.entries(storyboardImages)) {
        if (imageUrl && typeof imageUrl === 'string') {
          try {
            // Convert base64 to binary for images
            if (imageUrl.startsWith('data:image/')) {
              const base64Data = imageUrl.split(',')[1];
              const binaryData = atob(base64Data);
              const bytes = new Uint8Array(binaryData.length);
              for (let i = 0; i < binaryData.length; i++) {
                bytes[i] = binaryData.charCodeAt(i);
              }
              const extension = imageUrl.includes('data:image/png') ? 'png' : 'jpg';
              imagesFolder?.file(`scene-${sceneId}.${extension}`, bytes);
            }
          } catch (err) {
            console.warn(`Failed to process image for scene ${sceneId}:`, err);
          }
        }
      }
      
      // Add voiceovers folder
      const voicesFolder = zip.folder('voiceovers');
      for (const [sceneId, audioUrl] of Object.entries(storyboardVoiceovers)) {
        if (audioUrl && typeof audioUrl === 'string') {
          try {
            // Convert base64 to binary for audio
            if (audioUrl.startsWith('data:audio/')) {
              const base64Data = audioUrl.split(',')[1];
              const binaryData = atob(base64Data);
              const bytes = new Uint8Array(binaryData.length);
              for (let i = 0; i < binaryData.length; i++) {
                bytes[i] = binaryData.charCodeAt(i);
              }
              const extension = audioUrl.includes('data:audio/wav') ? 'wav' : 'mp3';
              voicesFolder?.file(`scene-${sceneId}.${extension}`, bytes);
            }
          } catch (err) {
            console.warn(`Failed to process audio for scene ${sceneId}:`, err);
          }
        }
      }
      
      // Generate and download ZIP
      const content = await zip.generateAsync({type: 'blob'});
      const url = window.URL.createObjectURL(content);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${selectedStory.title.replace(/[^a-z0-9]/gi, '-')}-project.zip`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(url);
      
      console.log('Project downloaded successfully as ZIP');
    } catch (error) {
      console.error('Failed to create ZIP:', error);
      setError('Failed to create download. Please try again.');
    }
  };

  // Upload and restore project from ZIP
  const uploadProjectFromZip = async (file: File) => {
    try {
      const zip = await JSZip.loadAsync(file);
      
      // Read project metadata
      const metadataFile = zip.file('project-metadata.json');
      if (!metadataFile) {
        throw new Error('Invalid project file: missing metadata');
      }
      
      const metadata = JSON.parse(await metadataFile.async('string'));
      const storyboardFile = zip.file('storyboard.json');
      if (!storyboardFile) {
        throw new Error('Invalid project file: missing storyboard data');
      }
      
      const storyboardData = JSON.parse(await storyboardFile.async('string'));
      
      // Restore story bulb and storyboard
      setSelectedStory(metadata.storyBulb);
      setGeneratedStoryboard(storyboardData);
      setTargetSceneCount(metadata.targetSceneCount || 30);
      
      // Restore images
      const images: { [key: string]: string } = {};
      const imagesFolder = zip.folder('images');
      if (imagesFolder) {
        for (const [filename, file] of Object.entries(imagesFolder.files)) {
          if (!file.dir && filename.startsWith('scene-')) {
            const sceneId = filename.match(/scene-(\d+)/)?.[1];
            if (sceneId) {
              const bytes = await file.async('uint8array');
              const base64 = btoa(String.fromCharCode.apply(null, Array.from(bytes)));
              const extension = filename.endsWith('.png') ? 'png' : 'jpeg';
              images[sceneId] = `data:image/${extension};base64,${base64}`;
            }
          }
        }
      }
      setStoryboardImages(images);
      
      // Restore voiceovers
      const voiceovers: { [key: string]: string } = {};
      const voicesFolder = zip.folder('voiceovers');
      if (voicesFolder) {
        for (const [filename, file] of Object.entries(voicesFolder.files)) {
          if (!file.dir && filename.startsWith('scene-')) {
            const sceneId = filename.match(/scene-(\d+)/)?.[1];
            if (sceneId) {
              const bytes = await file.async('uint8array');
              const base64 = btoa(String.fromCharCode.apply(null, Array.from(bytes)));
              const extension = filename.endsWith('.wav') ? 'wav' : 'mpeg';
              voiceovers[sceneId] = `data:audio/${extension};base64,${base64}`;
            }
          }
        }
      }
      setStoryboardVoiceovers(voiceovers);
      
      // Switch to storyboard tab to show loaded content
      setActiveTab('storyboard');
      
      console.log('Project loaded successfully from ZIP');
    } catch (error) {
      console.error('Failed to load ZIP:', error);
      setError('Failed to load project file. Please check the file format.');
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-900 via-black to-gray-900">
      <div className="container mx-auto px-4 py-8 max-w-7xl">
        <div className="text-center mb-8">
          <h1 className="text-4xl font-bold text-white mb-4 bg-gradient-to-r from-blue-400 to-purple-600 bg-clip-text text-transparent">
            AI Video Production Pipeline
          </h1>
          <p className="text-gray-400 text-lg">
            Batch generate short story videos with AI - Scripts, Storyboards, Voice-overs, Images & Effects
          </p>
        </div>

        {/* API Keys Section */}
        <div className="bg-gray-800/50 backdrop-blur-xl rounded-2xl p-6 border border-gray-700 mb-8">
          <div className="grid md:grid-cols-3 gap-6">
            <div>
              <label className="block text-white text-sm font-semibold mb-3">
                OpenRouter API Key (for Images & Scripts)
              </label>
              <div className="relative">
                <input
                  type={showApiKey ? 'text' : 'password'}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="Enter your OpenRouter API key"
                  className="w-full px-4 py-3 pr-12 bg-gray-900/50 border border-gray-600 rounded-xl text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition"
                />
                <button
                  onClick={() => setShowApiKey(!showApiKey)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-white transition"
                >
                  {showApiKey ? '👁️' : '👁️‍🗨️'}
                </button>
              </div>
            </div>
            
            <div>
              <label className="block text-white text-sm font-semibold mb-3">
                ElevenLabs API Key (for Voice-overs)
              </label>
              <div className="relative">
                <input
                  type={showElevenLabsKey ? 'text' : 'password'}
                  value={elevenLabsKey}
                  onChange={(e) => {
                    setElevenLabsKey(e.target.value);
                    setVoicesLoaded(false);
                  }}
                  placeholder="Enter your ElevenLabs API key"
                  className="w-full px-4 py-3 pr-12 bg-gray-900/50 border border-gray-600 rounded-xl text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition"
                />
                <button
                  onClick={() => setShowElevenLabsKey(!showElevenLabsKey)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-white transition"
                >
                  {showElevenLabsKey ? '👁️' : '👁️‍🗨️'}
                </button>
              </div>
            </div>
            
            <div>
              <label className="block text-white text-sm font-semibold mb-3">
                Google Gemini TTS API Key (Alternative Voice)
              </label>
              <div className="relative">
                <input
                  type={showGoogleTtsKey ? 'text' : 'password'}
                  value={googleTtsKey}
                  onChange={(e) => {
                    setGoogleTtsKey(e.target.value);
                    setGoogleVoicesLoaded(false);
                  }}
                  placeholder="Enter your Google API key"
                  className="w-full px-4 py-3 pr-12 bg-gray-900/50 border border-gray-600 rounded-xl text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition"
                />
                <button
                  onClick={() => setShowGoogleTtsKey(!showGoogleTtsKey)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-white transition"
                >
                  {showGoogleTtsKey ? '👁️' : '👁️‍🗨️'}
                </button>
              </div>
            </div>
            
            <div>
              <label className="block text-white text-sm font-semibold mb-3">
                🤖 Gemini Model Selection
              </label>
              <select
                value={geminiModel}
                onChange={(e) => setGeminiModel(e.target.value)}
                className="w-full px-4 py-3 bg-gray-900/50 border border-gray-600 rounded-xl text-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition"
              >
                <option value="gemini-2.0-flash-exp">Gemini 2.0 Flash Experimental (Recommended)</option>
                <option value="gemini-2.5-flash">Gemini 2.5 Flash</option>
                <option value="gemini-1.5-flash">Gemini 1.5 Flash</option>
                <option value="gemini-1.5-flash-8b">Gemini 1.5 Flash 8B</option>
                <option value="gemini-1.5-pro">Gemini 1.5 Pro</option>
                <option value="gemini-exp-1206">Gemini Experimental 1206</option>
              </select>
              <p className="text-xs text-gray-400 mt-2">
                Different models have varying capabilities. Experimental models may provide better causality but could be less stable.
              </p>
            </div>
          </div>
          
          {/* Highbid API URL - Full width row */}
          <div className="mt-6">
            <label className="block text-white text-sm font-semibold mb-3">
              Highbid API URL (for High-Quality Image Generation)
            </label>
            <div className="relative">
              <input
                type={showHighbidUrl ? 'text' : 'password'}
                value={highbidApiUrl}
                onChange={(e) => setHighbidApiUrl(e.target.value)}
                placeholder="Enter your Highbid/ngrok API URL (e.g., https://xxxx.ngrok-free.app)"
                className="w-full px-4 py-3 pr-12 bg-gray-900/50 border border-gray-600 rounded-xl text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent transition"
              />
              <button
                onClick={() => setShowHighbidUrl(!showHighbidUrl)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-white transition"
              >
                {showHighbidUrl ? '👁️' : '👁️‍🗨️'}
              </button>
            </div>
          </div>

          {/* Kokoro TTS URL */}
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-2">
              Kokoro TTS URL (optional)
            </label>
            <div className="relative">
              <input
                type={showKokoroUrl ? 'text' : 'password'}
                value={kokoroUrl}
                onChange={(e) => setKokoroUrl(e.target.value)}
                placeholder="Enter your Kokoro/ngrok URL (e.g., https://xxxx.ngrok-free.app)"
                className="w-full px-4 py-3 pr-12 bg-gray-900/50 border border-gray-600 rounded-xl text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent transition"
              />
              <button
                onClick={() => setShowKokoroUrl(!showKokoroUrl)}
                className="absolute right-3 top-1/2 transform -translate-y-1/2 text-gray-400 hover:text-white transition"
              >
                {showKokoroUrl ? '👁️' : '👁️‍🗨️'}
              </button>
            </div>
          </div>
        </div>

        {/* Tab Navigation */}
        <div className="bg-gray-800/50 backdrop-blur-xl rounded-2xl border border-gray-700 overflow-hidden">
          <div className="flex border-b border-gray-700 overflow-x-auto">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex items-center space-x-2 px-6 py-4 font-medium transition-all min-w-fit ${
                  activeTab === tab.id
                    ? 'bg-blue-600 text-white border-b-2 border-blue-400'
                    : 'text-gray-400 hover:text-white hover:bg-gray-700/50'
                }`}
              >
                <span className="text-xl">{tab.icon}</span>
                <span>{tab.name}</span>
              </button>
            ))}
          </div>

          {/* Tab Content */}
          <div className="p-8">
            {/* Scripts Tab */}
            {activeTab === 'scripts' && (
              <div className="space-y-6">
                <div>
                  <h3 className="text-2xl font-bold text-white mb-4">Story Generation</h3>
                  <p className="text-gray-400 mb-6">Enter viral titles to generate complete story structures</p>
                </div>

                <div className="space-y-4">
                  {scriptTitles.map((title, index) => (
                    <div key={index} className="flex gap-3">
                      <input
                        type="text"
                        value={title}
                        onChange={(e) => updatePrompt('script', index, e.target.value)}
                        placeholder={`Enter viral title ${index + 1} (e.g., "The Secret That Changed Everything")`}
                        className="flex-1 px-4 py-3 bg-gray-900/50 border border-gray-600 rounded-xl text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition"
                      />
                      <button
                        onClick={() => removePrompt('script', index)}
                        disabled={scriptTitles.length === 1}
                        className="px-4 py-2 bg-red-600/20 text-red-400 rounded-xl hover:bg-red-600/30 disabled:opacity-50 disabled:cursor-not-allowed transition"
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>

                {/* Scene Count Slider */}
                <div className="bg-gray-900/30 p-4 rounded-xl border border-gray-700">
                  <div className="flex items-center justify-between mb-3">
                    <label className="text-white font-semibold">Number of Scenes</label>
                    <div className="text-white font-mono text-xl">{targetSceneCount}</div>
                  </div>
                  <input
                    type="range"
                    min="5"
                    max="30"
                    step="1"
                    value={targetSceneCount}
                    onChange={(e) => setTargetSceneCount(parseInt(e.target.value))}
                    className="w-full h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-blue-600"
                  />
                  <div className="flex justify-between text-sm text-gray-400 mt-2">
                    <span>5 scenes</span>
                    <span className="text-center">
                      Duration: {targetSceneCount * 2} seconds ({Math.floor((targetSceneCount * 2) / 60)}:{String((targetSceneCount * 2) % 60).padStart(2, '0')})
                    </span>
                    <span>30 scenes</span>
                  </div>
                  <div className="mt-3 text-xs text-gray-500">
                    {targetSceneCount <= 10 ? "🎯 Quick & Punchy - Perfect for TikTok/Reels" :
                     targetSceneCount <= 20 ? "📱 Standard Length - Great for Instagram/YouTube Shorts" :
                     "🎬 Full Story - Ideal for YouTube/Facebook"}
                  </div>
                </div>

                <div className="flex gap-4">
                  <button
                    onClick={() => addPrompt('script')}
                    className="px-6 py-3 bg-gray-700 text-white rounded-xl hover:bg-gray-600 transition"
                  >
                    + Add Title
                  </button>
                  <button
                    onClick={handleScriptGeneration}
                    disabled={scriptsLoading || !googleTtsKey}
                    className="px-8 py-3 bg-gradient-to-r from-green-500 to-blue-600 text-white font-semibold rounded-xl hover:from-green-600 hover:to-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition"
                  >
                    {scriptsLoading ? 'Generating Stories...' : 'Generate Stories with Gemini'}
                  </button>
                </div>

                {/* Prompt Inspection Section */}
                <div className="bg-gray-900/30 p-6 rounded-xl border border-gray-700">
                  <h4 className="text-lg font-bold text-white mb-4">🔍 Inspect AI Prompts</h4>
                  <p className="text-gray-400 mb-4">View the exact prompts sent to AI models for story generation</p>
                  <div className="flex gap-4">
                    <button
                      onClick={() => setShowStoryBulbPrompt(true)}
                      className="px-6 py-3 bg-blue-600/20 border border-blue-500/30 text-blue-300 rounded-xl hover:bg-blue-600/30 transition"
                    >
                      📄 View Story Bulb Prompt
                    </button>
                    <button
                      onClick={() => setShowStoryboardPrompt(true)}
                      className="px-6 py-3 bg-purple-600/20 border border-purple-500/30 text-purple-300 rounded-xl hover:bg-purple-600/30 transition"
                    >
                      🎬 View Storyboard Prompt
                    </button>
                  </div>
                </div>

                {generatedStories.length > 0 && (
                  <div className="space-y-4">
                    <div className="flex justify-between items-center mb-2">
                      <h4 className="text-xl font-bold text-white">Generated Story Bulbs</h4>
                      <div className="text-sm text-gray-400 bg-green-600/20 px-3 py-1 rounded-lg">
                        ✏️ All story parameters are editable below
                      </div>
                    </div>
                    <div className="grid gap-4">
                      {generatedStories.map((story, index) => (
                        <div 
                          key={index} 
                          className={`bg-gray-900/50 p-6 rounded-xl border-2 transition ${
                            selectedStory === story ? 'border-green-500 bg-gray-900/70' : 'border-gray-700'
                          }`}
                        >
                          <div className="flex justify-between items-start mb-4">
                            <div className="flex-1 mr-4">
                              <label className="block text-xs text-gray-400 mb-1">Title</label>
                              <input
                                type="text"
                                value={story.title}
                                onChange={(e) => updateStoryBulb(index, 'title', e.target.value)}
                                className="w-full bg-gray-800/50 border border-gray-600 rounded-lg px-3 py-2 text-white text-lg font-bold"
                              />
                            </div>
                            <div>
                              <label className="block text-xs text-gray-400 mb-1">Tone</label>
                              <select
                                value={story.tone}
                                onChange={(e) => updateStoryBulb(index, 'tone', e.target.value)}
                                className="bg-gray-800/50 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm"
                              >
                                <option value="inspiring">Inspiring</option>
                                <option value="dramatic">Dramatic</option>
                                <option value="cozy">Cozy</option>
                                <option value="creepy">Creepy</option>
                                <option value="comedic">Comedic</option>
                                <option value="educational">Educational</option>
                              </select>
                            </div>
                          </div>
                          
                          <div className="grid grid-cols-2 gap-4 mb-4">
                            <div>
                              <label className="block text-xs text-gray-400 mb-1">Protagonist</label>
                              <input
                                type="text"
                                value={story.protagonist}
                                onChange={(e) => updateStoryBulb(index, 'protagonist', e.target.value)}
                                className="w-full bg-gray-800/50 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm"
                              />
                            </div>
                            <div>
                              <label className="block text-xs text-gray-400 mb-1">Setting</label>
                              <input
                                type="text"
                                value={story.setting}
                                onChange={(e) => updateStoryBulb(index, 'setting', e.target.value)}
                                className="w-full bg-gray-800/50 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm"
                              />
                            </div>
                            <div>
                              <label className="block text-xs text-gray-400 mb-1">Target Viewer</label>
                              <input
                                type="text"
                                value={story.target_viewer}
                                onChange={(e) => updateStoryBulb(index, 'target_viewer', e.target.value)}
                                className="w-full bg-gray-800/50 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm"
                              />
                            </div>
                            <div>
                              <label className="block text-xs text-gray-400 mb-1">Visual Style</label>
                              <input
                                type="text"
                                value={story.visual_style}
                                onChange={(e) => updateStoryBulb(index, 'visual_style', e.target.value)}
                                placeholder="e.g., cinematic photoreal, anime style, oil painting, cyberpunk neon..."
                                className="w-full bg-gray-800/50 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm placeholder-gray-500"
                              />
                            </div>
                          </div>
                          
                          <div className="mb-4">
                            <label className="block text-xs text-gray-400 mb-1">Premise</label>
                            <textarea
                              value={story.premise}
                              onChange={(e) => updateStoryBulb(index, 'premise', e.target.value)}
                              rows={2}
                              className="w-full bg-gray-800/50 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm resize-none"
                            />
                          </div>
                          
                          <div className="grid grid-cols-2 gap-4 mb-4">
                            <div>
                              <label className="block text-xs text-gray-400 mb-1">Goal</label>
                              <textarea
                                value={story.goal}
                                onChange={(e) => updateStoryBulb(index, 'goal', e.target.value)}
                                rows={2}
                                className="w-full bg-gray-800/50 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm resize-none"
                              />
                            </div>
                            <div>
                              <label className="block text-xs text-gray-400 mb-1">Stakes</label>
                              <textarea
                                value={story.stakes}
                                onChange={(e) => updateStoryBulb(index, 'stakes', e.target.value)}
                                rows={2}
                                className="w-full bg-gray-800/50 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm resize-none"
                              />
                            </div>
                          </div>
                          
                          <div className="mb-4">
                            <label className="block text-xs text-gray-400 mb-1">Twist</label>
                            <textarea
                              value={story.twist}
                              onChange={(e) => updateStoryBulb(index, 'twist', e.target.value)}
                              rows={2}
                              className="w-full bg-gray-800/50 border border-gray-600 rounded-lg px-3 py-2 text-yellow-400 text-sm resize-none italic"
                            />
                          </div>

                          <div className="mb-4">
                            <label className="block text-xs text-gray-400 mb-1">Action Emphasis</label>
                            <textarea
                              value={story.action_emphasis}
                              onChange={(e) => updateStoryBulb(index, 'action_emphasis', e.target.value)}
                              rows={2}
                              placeholder="How actions cause reactions and consequences..."
                              className="w-full bg-gray-800/50 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm resize-none"
                            />
                          </div>

                          {/* Causality Fields */}
                          <div className="mb-4 border-t border-gray-700 pt-4">
                            <h5 className="text-sm font-semibold text-blue-300 mb-3">🔗 Causality Structure</h5>
                            
                            <div className="mb-4">
                              <label className="block text-xs text-gray-400 mb-1">Domino Sequences</label>
                              <div className="space-y-2">
                                {(story.domino_sequences || []).map((sequence, seqIndex) => (
                                  <div key={seqIndex} className="flex gap-2">
                                    <textarea
                                      value={sequence}
                                      onChange={(e) => {
                                        const newSequences = [...(story.domino_sequences || [])];
                                        newSequences[seqIndex] = e.target.value;
                                        updateStoryBulb(index, 'domino_sequences', newSequences);
                                      }}
                                      rows={1}
                                      placeholder="Cause → Effect → Consequence chain..."
                                      className="flex-1 bg-gray-800/50 border border-gray-600 rounded-lg px-3 py-2 text-white text-xs resize-none"
                                    />
                                    <button
                                      onClick={() => {
                                        const newSequences = (story.domino_sequences || []).filter((_, i) => i !== seqIndex);
                                        updateStoryBulb(index, 'domino_sequences', newSequences);
                                      }}
                                      className="px-2 py-2 bg-red-600/20 text-red-400 rounded-lg hover:bg-red-600/30 text-xs"
                                    >
                                      ✕
                                    </button>
                                  </div>
                                ))}
                                <button
                                  onClick={() => {
                                    const newSequences = [...(story.domino_sequences || []), ''];
                                    updateStoryBulb(index, 'domino_sequences', newSequences);
                                  }}
                                  className="text-xs text-blue-400 hover:text-blue-300"
                                >
                                  + Add Domino Sequence
                                </button>
                              </div>
                            </div>

                            <div className="mb-4">
                              <label className="block text-xs text-gray-400 mb-1">Setup/Payoff Pairs</label>
                              <div className="space-y-2">
                                {(story.setups_payoffs || []).map((pair, pairIndex) => (
                                  <div key={pairIndex} className="grid grid-cols-2 gap-2">
                                    <input
                                      type="text"
                                      value={pair.setup || ''}
                                      onChange={(e) => {
                                        const newPairs = [...(story.setups_payoffs || [])];
                                        newPairs[pairIndex] = { ...newPairs[pairIndex], setup: e.target.value };
                                        updateStoryBulb(index, 'setups_payoffs', newPairs);
                                      }}
                                      placeholder="Setup (early element)..."
                                      className="bg-gray-800/50 border border-gray-600 rounded-lg px-3 py-2 text-white text-xs"
                                    />
                                    <div className="flex gap-2">
                                      <input
                                        type="text"
                                        value={pair.payoff || ''}
                                        onChange={(e) => {
                                          const newPairs = [...(story.setups_payoffs || [])];
                                          newPairs[pairIndex] = { ...newPairs[pairIndex], payoff: e.target.value };
                                          updateStoryBulb(index, 'setups_payoffs', newPairs);
                                        }}
                                        placeholder="Payoff (later consequence)..."
                                        className="flex-1 bg-gray-800/50 border border-gray-600 rounded-lg px-3 py-2 text-white text-xs"
                                      />
                                      <button
                                        onClick={() => {
                                          const newPairs = (story.setups_payoffs || []).filter((_, i) => i !== pairIndex);
                                          updateStoryBulb(index, 'setups_payoffs', newPairs);
                                        }}
                                        className="px-2 py-2 bg-red-600/20 text-red-400 rounded-lg hover:bg-red-600/30 text-xs"
                                      >
                                        ✕
                                      </button>
                                    </div>
                                  </div>
                                ))}
                                <button
                                  onClick={() => {
                                    const newPairs = [...(story.setups_payoffs || []), { setup: '', payoff: '' }];
                                    updateStoryBulb(index, 'setups_payoffs', newPairs);
                                  }}
                                  className="text-xs text-blue-400 hover:text-blue-300"
                                >
                                  + Add Setup/Payoff Pair
                                </button>
                              </div>
                            </div>

                            <div className="mb-4">
                              <label className="block text-xs text-gray-400 mb-1">Escalation Points</label>
                              <div className="space-y-2">
                                {(story.escalation_points || []).map((point, pointIndex) => (
                                  <div key={pointIndex} className="flex gap-2">
                                    <textarea
                                      value={point}
                                      onChange={(e) => {
                                        const newPoints = [...(story.escalation_points || [])];
                                        newPoints[pointIndex] = e.target.value;
                                        updateStoryBulb(index, 'escalation_points', newPoints);
                                      }}
                                      rows={1}
                                      placeholder="Stakes increase BECAUSE of protagonist action..."
                                      className="flex-1 bg-gray-800/50 border border-gray-600 rounded-lg px-3 py-2 text-white text-xs resize-none"
                                    />
                                    <button
                                      onClick={() => {
                                        const newPoints = (story.escalation_points || []).filter((_, i) => i !== pointIndex);
                                        updateStoryBulb(index, 'escalation_points', newPoints);
                                      }}
                                      className="px-2 py-2 bg-red-600/20 text-red-400 rounded-lg hover:bg-red-600/30 text-xs"
                                    >
                                      ✕
                                    </button>
                                  </div>
                                ))}
                                <button
                                  onClick={() => {
                                    const newPoints = [...(story.escalation_points || []), ''];
                                    updateStoryBulb(index, 'escalation_points', newPoints);
                                  }}
                                  className="text-xs text-blue-400 hover:text-blue-300"
                                >
                                  + Add Escalation Point
                                </button>
                              </div>
                            </div>
                          </div>

                          <div className="grid grid-cols-2 gap-4 mb-4">
                            <div>
                              <label className="block text-xs text-gray-400 mb-1">Call to Action</label>
                              <input
                                type="text"
                                value={story.call_to_action}
                                onChange={(e) => updateStoryBulb(index, 'call_to_action', e.target.value)}
                                className="w-full bg-gray-800/50 border border-gray-600 rounded-lg px-3 py-2 text-blue-400 text-sm"
                                placeholder="Optional call to action"
                              />
                            </div>
                            <div>
                              <label className="block text-xs text-gray-400 mb-1">Constraint</label>
                              <input
                                type="text"
                                value={story.constraint}
                                onChange={(e) => updateStoryBulb(index, 'constraint', e.target.value)}
                                className="w-full bg-gray-800/50 border border-gray-600 rounded-lg px-3 py-2 text-orange-400 text-sm"
                                placeholder="Story constraint"
                              />
                            </div>
                          </div>
                          
                          <div className="grid grid-cols-2 gap-4 mb-4">
                            <div>
                              <label className="block text-xs text-gray-400 mb-1">Runtime (seconds)</label>
                              <input
                                type="number"
                                value={story.runtime_sec}
                                onChange={(e) => updateStoryBulb(index, 'runtime_sec', parseInt(e.target.value) || 60)}
                                min="30"
                                max="180"
                                className="w-full bg-gray-800/50 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm"
                              />
                            </div>
                            <div>
                              <label className="block text-xs text-gray-400 mb-1">Narration POV</label>
                              <select
                                value={story.narration_pov}
                                onChange={(e) => updateStoryBulb(index, 'narration_pov', e.target.value)}
                                className="w-full bg-gray-800/50 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm"
                              >
                                <option value="first_person">First Person</option>
                                <option value="third_person">Third Person</option>
                              </select>
                            </div>
                          </div>
                          
                          <div className="flex justify-between items-center mt-4">
                            {selectedStory === story && (
                              <button
                                onClick={() => handleStoryboardGeneration()}
                                disabled={storyboardsLoading}
                                className="px-4 py-2 bg-gradient-to-r from-green-500 to-blue-600 text-white text-sm font-semibold rounded-lg hover:from-green-600 hover:to-blue-700 disabled:opacity-50 transition"
                              >
                                {storyboardsLoading ? (
                                  storyboardProgress.status ? `${storyboardProgress.currentScene}/${storyboardProgress.totalScenes}...` : 'Generating...'
                                ) : 'Generate Storyboard →'}
                              </button>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Images Tab */}
            {activeTab === 'images' && (
              <div className="space-y-6">
                <div>
                  <h3 className="text-2xl font-bold text-white mb-4">Batch Image Generation</h3>
                  <p className="text-gray-400 mb-6">Generate multiple images for your video scenes</p>
                </div>

                {/* Image Provider Selection */}
                <div className="bg-gray-900/50 p-4 rounded-xl">
                  <label className="block text-white text-sm font-semibold mb-3">
                    Image Generation Provider
                  </label>
                  <div className="flex gap-4 mb-4 flex-wrap">
                    <button
                      onClick={() => setImageProvider('openrouter')}
                      className={`px-4 py-2 rounded-xl transition ${
                        imageProvider === 'openrouter'
                          ? 'bg-blue-600 text-white'
                          : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                      }`}
                    >
                      OpenRouter
                    </button>
                    <button
                      onClick={() => setImageProvider('gemini')}
                      className={`px-4 py-2 rounded-xl transition ${
                        imageProvider === 'gemini'
                          ? 'bg-green-600 text-white'
                          : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                      }`}
                    >
                      Gemini 2.5 (Requires Billing)
                    </button>
                    <button
                      onClick={() => setImageProvider('highbid')}
                      className={`px-4 py-2 rounded-xl transition ${
                        imageProvider === 'highbid'
                          ? 'bg-purple-600 text-white'
                          : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                      }`}
                    >
                      Highbid (Flux)
                    </button>
                  </div>
                  
                  {/* Dimension controls for Highbid */}
                  {imageProvider === 'highbid' && (
                    <div className="mt-4">
                      <label className="block text-gray-400 text-xs mb-2">Quick Presets</label>
                      
                      {/* 16:9 Landscape Resolutions */}
                      <div className="mb-2">
                        <span className="text-xs text-gray-500 block mb-1">16:9 Landscape (Video)</span>
                        <div className="grid grid-cols-3 gap-2">
                          <button
                            onClick={() => { setImageWidth(1920); setImageHeight(1080); }}
                            className={`px-3 py-2 text-xs rounded-lg transition ${
                              imageWidth === 1920 && imageHeight === 1080
                                ? 'bg-purple-600 text-white'
                                : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
                            }`}
                          >
                            1920×1080
                          </button>
                          <button
                            onClick={() => { setImageWidth(1280); setImageHeight(720); }}
                            className={`px-3 py-2 text-xs rounded-lg transition ${
                              imageWidth === 1280 && imageHeight === 720
                                ? 'bg-purple-600 text-white'
                                : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
                            }`}
                          >
                            1280×720
                          </button>
                          <button
                            onClick={() => { setImageWidth(1024); setImageHeight(576); }}
                            className={`px-3 py-2 text-xs rounded-lg transition ${
                              imageWidth === 1024 && imageHeight === 576
                                ? 'bg-purple-600 text-white'
                                : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
                            }`}
                          >
                            1024×576
                          </button>
                        </div>
                      </div>
                      
                      {/* 9:16 Portrait Resolutions */}
                      <div className="mb-2">
                        <span className="text-xs text-gray-500 block mb-1">9:16 Portrait (Stories/Reels)</span>
                        <div className="grid grid-cols-3 gap-2">
                          <button
                            onClick={() => { setImageWidth(1080); setImageHeight(1920); }}
                            className={`px-3 py-2 text-xs rounded-lg transition ${
                              imageWidth === 1080 && imageHeight === 1920
                                ? 'bg-purple-600 text-white'
                                : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
                            }`}
                          >
                            1080×1920
                          </button>
                          <button
                            onClick={() => { setImageWidth(720); setImageHeight(1280); }}
                            className={`px-3 py-2 text-xs rounded-lg transition ${
                              imageWidth === 720 && imageHeight === 1280
                                ? 'bg-purple-600 text-white'
                                : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
                            }`}
                          >
                            720×1280
                          </button>
                          <button
                            onClick={() => { setImageWidth(576); setImageHeight(1024); }}
                            className={`px-3 py-2 text-xs rounded-lg transition ${
                              imageWidth === 576 && imageHeight === 1024
                                ? 'bg-purple-600 text-white'
                                : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
                            }`}
                          >
                            576×1024
                          </button>
                        </div>
                      </div>
                      
                      {/* Square Resolution */}
                      <div className="mb-3">
                        <span className="text-xs text-gray-500 block mb-1">1:1 Square (Instagram)</span>
                        <div className="grid grid-cols-3 gap-2">
                          <button
                            onClick={() => { setImageWidth(1024); setImageHeight(1024); }}
                            className={`px-3 py-2 text-xs rounded-lg transition ${
                              imageWidth === 1024 && imageHeight === 1024
                                ? 'bg-purple-600 text-white'
                                : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
                            }`}
                          >
                            1024×1024
                          </button>
                          <button
                            onClick={() => { setImageWidth(768); setImageHeight(768); }}
                            className={`px-3 py-2 text-xs rounded-lg transition ${
                              imageWidth === 768 && imageHeight === 768
                                ? 'bg-purple-600 text-white'
                                : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
                            }`}
                          >
                            768×768
                          </button>
                          <button
                            onClick={() => { setImageWidth(512); setImageHeight(512); }}
                            className={`px-3 py-2 text-xs rounded-lg transition ${
                              imageWidth === 512 && imageHeight === 512
                                ? 'bg-purple-600 text-white'
                                : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
                            }`}
                          >
                            512×512
                          </button>
                        </div>
                      </div>
                      
                      {/* Custom dimension inputs */}
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <label className="block text-gray-400 text-xs mb-1">Custom Width</label>
                          <select
                            value={imageWidth}
                            onChange={(e) => setImageWidth(Number(e.target.value))}
                            className="w-full px-3 py-2 bg-gray-800 border border-gray-600 rounded-lg text-white text-sm"
                          >
                            <option value={512}>512px</option>
                            <option value={576}>576px</option>
                            <option value={640}>640px</option>
                            <option value={720}>720px</option>
                            <option value={768}>768px</option>
                            <option value={896}>896px</option>
                            <option value={1024}>1024px</option>
                            <option value={1280}>1280px</option>
                            <option value={1536}>1536px</option>
                            <option value={1920}>1920px</option>
                            <option value={2048}>2048px</option>
                          </select>
                        </div>
                        <div>
                          <label className="block text-gray-400 text-xs mb-1">Custom Height</label>
                          <select
                            value={imageHeight}
                            onChange={(e) => setImageHeight(Number(e.target.value))}
                            className="w-full px-3 py-2 bg-gray-800 border border-gray-600 rounded-lg text-white text-sm"
                          >
                            <option value={360}>360px</option>
                            <option value={480}>480px</option>
                            <option value={512}>512px</option>
                            <option value={576}>576px</option>
                            <option value={720}>720px</option>
                            <option value={768}>768px</option>
                            <option value={1024}>1024px</option>
                            <option value={1080}>1080px</option>
                            <option value={1536}>1536px</option>
                            <option value={2048}>2048px</option>
                          </select>
                        </div>
                      </div>
                      <div className="mt-2 text-xs text-gray-500">
                        Aspect Ratio: {(imageWidth / imageHeight).toFixed(2)}:1 ({imageWidth}×{imageHeight})
                      </div>
                    </div>
                  )}
                  
                  {imageProvider === 'highbid' && !highbidApiUrl && (
                    <div className="mt-3 text-yellow-400 text-sm">
                      Please enter your Highbid API URL above to generate images
                    </div>
                  )}
                  {imageProvider === 'openrouter' && !apiKey && (
                    <div className="mt-3 text-yellow-400 text-sm">
                      Please enter your OpenRouter API key above to generate images
                    </div>
                  )}
                  {imageProvider === 'gemini' && !googleTtsKey && (
                    <div className="mt-3 text-yellow-400 text-sm">
                      Please enter your Gemini API key above (Requires billing enabled for image generation)
                    </div>
                  )}
                </div>

                <div className="space-y-4">
                  {imagePrompts.map((prompt, index) => (
                    <div key={index} className="flex gap-3">
                      <textarea
                        value={prompt}
                        onChange={(e) => updatePrompt('image', index, e.target.value)}
                        placeholder={`Image prompt ${index + 1}...`}
                        rows={3}
                        className="flex-1 px-4 py-3 bg-gray-900/50 border border-gray-600 rounded-xl text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition resize-none"
                      />
                      <button
                        onClick={() => removePrompt('image', index)}
                        disabled={imagePrompts.length === 1}
                        className="px-4 py-2 bg-red-600/20 text-red-400 rounded-xl hover:bg-red-600/30 disabled:opacity-50 disabled:cursor-not-allowed transition"
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>

                <div className="flex gap-4">
                  <button
                    onClick={() => addPrompt('image')}
                    className="px-6 py-3 bg-gray-700 text-white rounded-xl hover:bg-gray-600 transition"
                  >
                    + Add Image Prompt
                  </button>
                  <button
                    onClick={handleImageGeneration}
                    disabled={imagesLoading || (imageProvider === 'openrouter' ? !apiKey : imageProvider === 'gemini' ? !googleTtsKey : !highbidApiUrl)}
                    className={`px-8 py-3 text-white font-semibold rounded-xl disabled:opacity-50 disabled:cursor-not-allowed transition ${
                      imageProvider === 'highbid' 
                        ? 'bg-gradient-to-r from-purple-500 to-pink-600 hover:from-purple-600 hover:to-pink-700'
                        : imageProvider === 'gemini'
                          ? 'bg-gradient-to-r from-green-500 to-teal-600 hover:from-green-600 hover:to-teal-700'
                          : 'bg-gradient-to-r from-blue-500 to-purple-600 hover:from-blue-600 hover:to-purple-700'
                    }`}
                  >
                    {imagesLoading 
                      ? `Generating with ${imageProvider === 'highbid' ? 'Highbid' : imageProvider === 'gemini' ? 'Gemini' : 'OpenRouter'}...` 
                      : `Generate with ${imageProvider === 'highbid' ? `Highbid (${imageWidth}x${imageHeight})` : imageProvider === 'gemini' ? 'Gemini' : 'OpenRouter'}`}
                  </button>
                </div>

                {generatedImages.length > 0 && (
                  <div className="space-y-4">
                    <h4 className="text-xl font-bold text-white">Generated Images</h4>
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                      {generatedImages.map((image, index) => (
                        <div key={index} className="bg-gray-900/50 p-4 rounded-xl">
                          <div className="relative w-full h-48 mb-3">
                            <Image
                              src={image}
                              alt={`Generated ${index + 1}`}
                              fill
                              className="object-cover rounded-xl"
                              unoptimized
                            />
                          </div>
                          <button
                            onClick={() => {
                              const link = document.createElement('a');
                              link.href = image;
                              link.download = `generated-image-${index + 1}.png`;
                              link.click();
                            }}
                            className="w-full py-2 bg-gray-700 hover:bg-gray-600 text-white rounded-xl transition"
                          >
                            Download
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Storyboard Tab */}
            {activeTab === 'storyboard' && (
              <div className="space-y-6">
                <div>
                  <h3 className="text-2xl font-bold text-white mb-4">Visual Storyboard</h3>
                  <p className="text-gray-400 mb-6">Dynamic storyboard with complete visual and audio direction</p>
                  
                  {/* Project Import/Export Controls */}
                  <div className="bg-gray-900/30 p-4 rounded-xl border border-gray-700 mb-6">
                    <h4 className="text-lg font-bold text-white mb-3">📦 Project Management</h4>
                    <div className="flex gap-4">
                      <button
                        onClick={downloadProjectAsZip}
                        disabled={!selectedStory || generatedStoryboard.length === 0}
                        className="px-4 py-2 bg-green-600/20 border border-green-500/30 text-green-300 rounded-xl hover:bg-green-600/30 disabled:opacity-50 disabled:cursor-not-allowed transition"
                      >
                        📥 Download Project ZIP
                      </button>
                      
                      <label className="px-4 py-2 bg-blue-600/20 border border-blue-500/30 text-blue-300 rounded-xl hover:bg-blue-600/30 cursor-pointer transition">
                        📤 Upload Project ZIP
                        <input
                          type="file"
                          accept=".zip"
                          onChange={(e) => {
                            const file = e.target.files?.[0];
                            if (file) {
                              uploadProjectFromZip(file);
                            }
                          }}
                          className="hidden"
                        />
                      </label>
                    </div>
                    <p className="text-xs text-gray-500 mt-2">
                      Download preserves all generated content (scenes, images, voiceovers) with metadata for later restoration
                    </p>
                  </div>
                </div>

                {!selectedStory && !generatedStoryboard.length && (
                  <div className="text-center py-12 bg-gray-900/30 rounded-xl">
                    <div className="text-6xl mb-4">🎬</div>
                    <p className="text-gray-400 mb-4">No story selected</p>
                    <button
                      onClick={() => setActiveTab('scripts')}
                      className="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition"
                    >
                      Go to Scripts Tab
                    </button>
                  </div>
                )}

                {selectedStory && !generatedStoryboard.length && (
                  <div className="bg-gray-900/50 p-6 rounded-xl border border-gray-700">
                    <h4 className="text-lg font-bold text-white mb-3">Selected Story: {selectedStory.title}</h4>
                    <button
                      onClick={() => handleStoryboardGeneration(1)}
                      disabled={storyboardsLoading}
                      className="px-8 py-3 bg-gradient-to-r from-green-500 to-blue-600 text-white font-semibold rounded-xl hover:from-green-600 hover:to-blue-700 disabled:opacity-50 transition"
                    >
                      {storyboardsLoading ? 'Generating Storyboard...' : 'Generate 30-Scene Storyboard'}
                    </button>
                  </div>
                )}

                {/* Resume Generation Section - Show when there are partial scenes */}
                {selectedStory && generatedStoryboard.length > 0 && generatedStoryboard.length < (selectedStory.target_scene_count || 30) && (
                  <div className="bg-yellow-900/20 p-6 rounded-xl border border-yellow-700">
                    <h4 className="text-lg font-bold text-yellow-200 mb-3">
                      Partial Storyboard ({generatedStoryboard.length}/{selectedStory.target_scene_count || 30} scenes)
                    </h4>
                    <p className="text-yellow-300 mb-4">
                      Generation stopped at scene {generatedStoryboard.length}. You can resume or start over.
                    </p>
                    <div className="flex gap-3">
                      <button
                        onClick={() => handleStoryboardGeneration(generatedStoryboard.length + 1)}
                        disabled={storyboardsLoading}
                        className="px-6 py-2 bg-gradient-to-r from-yellow-500 to-orange-600 text-white font-semibold rounded-xl hover:from-yellow-600 hover:to-orange-700 disabled:opacity-50 transition"
                      >
                        {storyboardsLoading ? 'Resuming...' : `Resume from Scene ${generatedStoryboard.length + 1}`}
                      </button>
                      <button
                        onClick={() => handleStoryboardGeneration(1)}
                        disabled={storyboardsLoading}
                        className="px-6 py-2 bg-gradient-to-r from-green-500 to-blue-600 text-white font-semibold rounded-xl hover:from-green-600 hover:to-blue-700 disabled:opacity-50 transition"
                      >
                        {storyboardsLoading ? 'Restarting...' : 'Start Over'}
                      </button>
                    </div>
                  </div>
                )}
                    
                    {/* Progress Display */}
                    {storyboardsLoading && storyboardProgress.status && (
                      <div className="mt-6 bg-gray-900/50 p-4 rounded-xl border border-gray-700">
                        <div className="flex justify-between items-center mb-3">
                          <div className="text-white font-medium">Storyboard Generation Progress</div>
                          <div className="text-sm text-gray-400">
                            {storyboardProgress.currentScene}/{storyboardProgress.totalScenes} scenes
                          </div>
                        </div>
                        
                        {/* Progress Bar */}
                        <div className="mb-3">
                          <div className="flex justify-between text-xs text-gray-500 mb-1">
                            <span>Batch {storyboardProgress.currentBatch}/{storyboardProgress.totalBatches}</span>
                            <span>{Math.round((storyboardProgress.currentScene / storyboardProgress.totalScenes) * 100)}%</span>
                          </div>
                          <div className="w-full bg-gray-800 rounded-full h-2">
                            <div 
                              className="bg-gradient-to-r from-green-500 to-blue-600 h-2 rounded-full transition-all duration-500"
                              style={{ width: `${(storyboardProgress.currentScene / storyboardProgress.totalScenes) * 100}%` }}
                            ></div>
                          </div>
                        </div>
                        
                        {/* Status Text */}
                        <div className="text-sm text-gray-300 flex items-center">
                          <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-green-500 mr-2"></div>
                          {storyboardProgress.status}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {generatedStoryboard.length > 0 && (
                  <div className="space-y-6">
                    {/* TTS Provider Selection */}
                    <div className="bg-gray-900/50 p-4 rounded-xl border border-gray-700">
                      <label className="block text-white text-sm font-semibold mb-3">
                        🎤 TTS Provider for Voice Generation
                      </label>
                      <div className="flex flex-wrap gap-3 mb-4">
                        <button
                          onClick={() => {
                            setTtsProvider('elevenlabs');
                            setVoicesLoaded(false);
                            setGoogleVoicesLoaded(false);
                            setAvailableVoices([]);
                            setSelectedVoiceId('21m00Tcm4TlvDq8ikWAM');
                          }}
                          className={`px-4 py-2 rounded-xl transition text-sm font-medium ${
                            ttsProvider === 'elevenlabs'
                              ? 'bg-blue-600 text-white shadow-lg'
                              : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                          }`}
                        >
                          ElevenLabs
                        </button>
                        <button
                          onClick={() => {
                            setTtsProvider('google');
                            setVoicesLoaded(false);
                            setGoogleVoicesLoaded(false);
                            setAvailableVoices([]);
                            setSelectedVoiceId('Kore');
                          }}
                          className={`px-4 py-2 rounded-xl transition text-sm font-medium ${
                            ttsProvider === 'google'
                              ? 'bg-green-600 text-white shadow-lg'
                              : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                          }`}
                        >
                          Google Gemini TTS
                        </button>
                        <button
                          onClick={() => {
                            setTtsProvider('kokoro');
                            setVoicesLoaded(false);
                            setGoogleVoicesLoaded(false);
                            setAvailableVoices([]);
                            setSelectedVoiceId('af_heart');
                          }}
                          className={`px-4 py-2 rounded-xl transition text-sm font-medium ${
                            ttsProvider === 'kokoro'
                              ? 'bg-purple-600 text-white shadow-lg'
                              : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                          }`}
                        >
                          Kokoro TTS
                        </button>
                      </div>
                      <div className="text-xs text-gray-400">
                        Selected: <span className="text-white font-medium">{
                          ttsProvider === 'elevenlabs' ? 'ElevenLabs' :
                          ttsProvider === 'google' ? 'Google Gemini TTS' :
                          'Kokoro TTS'
                        }</span>
                      </div>
                    </div>

                    {/* Story Summary - Editable */}
                    {selectedStory && (
                      <div className="bg-gradient-to-r from-green-900/30 to-blue-900/30 p-6 rounded-xl border border-gray-700">
                        <div className="text-center mb-4">
                          <div className="inline-block bg-blue-600/20 text-blue-300 px-4 py-2 rounded-lg text-sm">
                            ✏️ <strong>Story Editing Mode</strong> - All fields below are editable. Changes apply immediately.
                          </div>
                        </div>
                        <div className="grid md:grid-cols-2 gap-4 mb-4">
                          {/* Title */}
                          <div>
                            <label className="block text-xs text-gray-400 mb-1">Title</label>
                            <input
                              type="text"
                              value={selectedStory.title}
                              onChange={(e) => {
                                const updated = { ...selectedStory, title: e.target.value };
                                setSelectedStory(updated);
                                // Update in generatedStories array
                                setGeneratedStories(prev => prev.map(story => 
                                  story === selectedStory ? updated : story
                                ));
                              }}
                              className="w-full bg-gray-800/50 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm"
                            />
                          </div>
                          
                          {/* Visual Style */}
                          <div>
                            <label className="block text-xs text-gray-400 mb-1">Visual Style</label>
                            <input
                              type="text"
                              value={selectedStory.visual_style}
                              onChange={(e) => {
                                const updated = { ...selectedStory, visual_style: e.target.value };
                                setSelectedStory(updated);
                                setGeneratedStories(prev => prev.map(story => 
                                  story === selectedStory ? updated : story
                                ));
                              }}
                              placeholder="e.g., cinematic photoreal, anime style, oil painting, cyberpunk neon..."
                              className="w-full bg-gray-800/50 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm placeholder-gray-500"
                            />
                          </div>
                        </div>
                        
                        {/* Premise */}
                        <div className="mb-4">
                          <label className="block text-xs text-gray-400 mb-1">Premise</label>
                          <textarea
                            value={selectedStory.premise}
                            onChange={(e) => {
                              const updated = { ...selectedStory, premise: e.target.value };
                              setSelectedStory(updated);
                              setGeneratedStories(prev => prev.map(story => 
                                story === selectedStory ? updated : story
                              ));
                            }}
                            rows={2}
                            className="w-full bg-gray-800/50 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm"
                          />
                        </div>
                        
                        {/* Quick Settings Row */}
                        <div className="grid grid-cols-3 gap-4 mb-4">
                          <div>
                            <label className="block text-xs text-gray-400 mb-1">Tone</label>
                            <select
                              value={selectedStory.tone}
                              onChange={(e) => {
                                const updated = { ...selectedStory, tone: e.target.value };
                                setSelectedStory(updated);
                                setGeneratedStories(prev => prev.map(story => 
                                  story === selectedStory ? updated : story
                                ));
                              }}
                              className="w-full bg-gray-800/50 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm"
                            >
                              <option value="inspiring">Inspiring</option>
                              <option value="dramatic">Dramatic</option>
                              <option value="cozy">Cozy</option>
                              <option value="creepy">Creepy</option>
                              <option value="comedic">Comedic</option>
                              <option value="educational">Educational</option>
                            </select>
                          </div>
                          
                          <div>
                            <label className="block text-xs text-gray-400 mb-1">POV</label>
                            <select
                              value={selectedStory.narration_pov}
                              onChange={(e) => {
                                const updated = { ...selectedStory, narration_pov: e.target.value };
                                setSelectedStory(updated);
                                setGeneratedStories(prev => prev.map(story => 
                                  story === selectedStory ? updated : story
                                ));
                              }}
                              className="w-full bg-gray-800/50 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm"
                            >
                              <option value="first_person">First Person</option>
                              <option value="third_person">Third Person</option>
                            </select>
                          </div>
                          
                          <div>
                            <label className="block text-xs text-gray-400 mb-1">Runtime (seconds)</label>
                            <input
                              type="number"
                              value={selectedStory.runtime_sec}
                              onChange={(e) => {
                                const updated = { ...selectedStory, runtime_sec: parseInt(e.target.value) || 60 };
                                setSelectedStory(updated);
                                setGeneratedStories(prev => prev.map(story => 
                                  story === selectedStory ? updated : story
                                ));
                              }}
                              min="30"
                              max="180"
                              className="w-full bg-gray-800/50 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm"
                            />
                          </div>
                        </div>
                        
                        {/* Expandable Advanced Settings */}
                        <details className="cursor-pointer">
                          <summary className="text-sm text-gray-400 hover:text-gray-300 mb-3">Advanced Story Parameters</summary>
                          <div className="grid md:grid-cols-2 gap-4">
                            <div>
                              <label className="block text-xs text-gray-400 mb-1">Target Viewer</label>
                              <input
                                type="text"
                                value={selectedStory.target_viewer}
                                onChange={(e) => {
                                  const updated = { ...selectedStory, target_viewer: e.target.value };
                                  setSelectedStory(updated);
                                  setGeneratedStories(prev => prev.map(story => 
                                    story === selectedStory ? updated : story
                                  ));
                                }}
                                className="w-full bg-gray-800/50 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm"
                              />
                            </div>
                            
                            <div>
                              <label className="block text-xs text-gray-400 mb-1">Protagonist</label>
                              <input
                                type="text"
                                value={selectedStory.protagonist}
                                onChange={(e) => {
                                  const updated = { ...selectedStory, protagonist: e.target.value };
                                  setSelectedStory(updated);
                                  setGeneratedStories(prev => prev.map(story => 
                                    story === selectedStory ? updated : story
                                  ));
                                }}
                                className="w-full bg-gray-800/50 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm"
                              />
                            </div>
                            
                            <div>
                              <label className="block text-xs text-gray-400 mb-1">Goal</label>
                              <textarea
                                value={selectedStory.goal}
                                onChange={(e) => {
                                  const updated = { ...selectedStory, goal: e.target.value };
                                  setSelectedStory(updated);
                                  setGeneratedStories(prev => prev.map(story => 
                                    story === selectedStory ? updated : story
                                  ));
                                }}
                                rows={2}
                                className="w-full bg-gray-800/50 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm"
                              />
                            </div>
                            
                            <div>
                              <label className="block text-xs text-gray-400 mb-1">Stakes</label>
                              <textarea
                                value={selectedStory.stakes}
                                onChange={(e) => {
                                  const updated = { ...selectedStory, stakes: e.target.value };
                                  setSelectedStory(updated);
                                  setGeneratedStories(prev => prev.map(story => 
                                    story === selectedStory ? updated : story
                                  ));
                                }}
                                rows={2}
                                className="w-full bg-gray-800/50 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm"
                              />
                            </div>
                            
                            <div>
                              <label className="block text-xs text-gray-400 mb-1">Setting</label>
                              <input
                                type="text"
                                value={selectedStory.setting}
                                onChange={(e) => {
                                  const updated = { ...selectedStory, setting: e.target.value };
                                  setSelectedStory(updated);
                                  setGeneratedStories(prev => prev.map(story => 
                                    story === selectedStory ? updated : story
                                  ));
                                }}
                                className="w-full bg-gray-800/50 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm"
                              />
                            </div>
                            
                            <div>
                              <label className="block text-xs text-gray-400 mb-1">Constraint</label>
                              <input
                                type="text"
                                value={selectedStory.constraint}
                                onChange={(e) => {
                                  const updated = { ...selectedStory, constraint: e.target.value };
                                  setSelectedStory(updated);
                                  setGeneratedStories(prev => prev.map(story => 
                                    story === selectedStory ? updated : story
                                  ));
                                }}
                                className="w-full bg-gray-800/50 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm"
                              />
                            </div>
                            
                            <div className="md:col-span-2">
                              <label className="block text-xs text-gray-400 mb-1">Twist</label>
                              <textarea
                                value={selectedStory.twist}
                                onChange={(e) => {
                                  const updated = { ...selectedStory, twist: e.target.value };
                                  setSelectedStory(updated);
                                  setGeneratedStories(prev => prev.map(story => 
                                    story === selectedStory ? updated : story
                                  ));
                                }}
                                rows={2}
                                className="w-full bg-gray-800/50 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm"
                              />
                            </div>
                            
                            <div className="md:col-span-2">
                              <label className="block text-xs text-gray-400 mb-1">Call to Action</label>
                              <input
                                type="text"
                                value={selectedStory.call_to_action}
                                onChange={(e) => {
                                  const updated = { ...selectedStory, call_to_action: e.target.value };
                                  setSelectedStory(updated);
                                  setGeneratedStories(prev => prev.map(story => 
                                    story === selectedStory ? updated : story
                                  ));
                                }}
                                className="w-full bg-gray-800/50 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm"
                              />
                            </div>
                          </div>
                        </details>
                      </div>
                    )}

                    {/* Batch Generation Buttons */}
                    <div className="grid md:grid-cols-2 gap-4 mb-4">
                      {/* Batch Images */}
                      <div className="bg-gray-900/50 p-4 rounded-xl border border-gray-700">
                        <div className="flex justify-between items-center">
                          <div>
                            <h4 className="text-lg font-bold text-white mb-2">Generate Images</h4>
                            <p className="text-gray-400 text-sm">Generate images for all scenes</p>
                          </div>
                          <button
                            onClick={generateAllStoryboardImages}
                            disabled={batchImageLoading || (imageProvider === 'openrouter' ? !apiKey : imageProvider === 'gemini' ? !googleTtsKey : !highbidApiUrl)}
                            className="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition disabled:opacity-50 disabled:cursor-not-allowed text-sm"
                          >
                            {batchImageLoading ? 'Generating...' : 'Generate All'}
                          </button>
                        </div>
                        
                        {/* Batch Image Progress */}
                        {batchImageLoading && batchImageProgress.status && (
                          <div className="mt-4 p-4 bg-gray-800/50 rounded-lg border border-purple-500/30">
                            <div className="flex justify-between items-center mb-2">
                              <span className="text-sm text-white font-medium">Batch Image Generation</span>
                              <span className="text-xs text-gray-400">
                                {batchImageProgress.current}/{batchImageProgress.total} • Scene #{batchImageProgress.currentScene}
                              </span>
                            </div>
                            
                            <div className="w-full bg-gray-700 rounded-full h-2 mb-2">
                              <div 
                                className="bg-gradient-to-r from-purple-500 to-pink-500 h-2 rounded-full transition-all duration-500"
                                style={{ width: `${(batchImageProgress.current / batchImageProgress.total) * 100}%` }}
                              ></div>
                            </div>
                            
                            <div className="flex justify-between text-xs">
                              <span className="text-gray-300">{batchImageProgress.status}</span>
                              <span className="text-gray-400">
                                {batchImageProgress.failed > 0 && `${batchImageProgress.failed} failed • `}
                                {batchImageProgress.retries > 0 && `${batchImageProgress.retries} retries`}
                              </span>
                            </div>
                          </div>
                        )}
                      </div>
                      
                      {/* Batch Voiceovers */}
                      <div className="bg-gray-900/50 p-4 rounded-xl border border-gray-700">
                        <div className="flex justify-between items-center">
                          <div>
                            <h4 className="text-lg font-bold text-white mb-2">Generate Voiceovers</h4>
                            <p className="text-gray-400 text-sm">Generate voiceovers for all scenes</p>
                          </div>
                          <button
                            onClick={generateAllStoryboardVoiceovers}
                            disabled={batchVoiceoverLoading || (
                              ttsProvider === 'elevenlabs' ? !elevenLabsKey :
                              ttsProvider === 'kokoro' ? !kokoroUrl :
                              !googleTtsKey
                            ) || !selectedVoiceId}
                            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition disabled:opacity-50 disabled:cursor-not-allowed text-sm"
                            title={!selectedVoiceId ? 'Loading voices...' : ''}
                          >
                            {batchVoiceoverLoading ? 'Generating...' : !selectedVoiceId ? 'Loading Voices...' : 'Generate All'}
                          </button>
                        </div>
                        
                        {/* Batch Voiceover Progress */}
                        {batchVoiceoverLoading && batchVoiceoverProgress.status && (
                          <div className="mt-4 p-4 bg-gray-800/50 rounded-lg border border-blue-500/30">
                            <div className="flex justify-between items-center mb-2">
                              <span className="text-sm text-white font-medium">Batch Voiceover Generation</span>
                              <span className="text-xs text-gray-400">
                                {batchVoiceoverProgress.current}/{batchVoiceoverProgress.total} • Scene #{batchVoiceoverProgress.currentScene}
                              </span>
                            </div>
                            
                            <div className="w-full bg-gray-700 rounded-full h-2 mb-2">
                              <div 
                                className="bg-gradient-to-r from-blue-500 to-cyan-500 h-2 rounded-full transition-all duration-500"
                                style={{ width: `${(batchVoiceoverProgress.current / batchVoiceoverProgress.total) * 100}%` }}
                              ></div>
                            </div>
                            
                            <div className="flex justify-between text-xs">
                              <span className="text-gray-300">{batchVoiceoverProgress.status}</span>
                              <span className="text-gray-400">
                                {batchVoiceoverProgress.failed > 0 && `${batchVoiceoverProgress.failed} failed • `}
                                {batchVoiceoverProgress.retries > 0 && `${batchVoiceoverProgress.retries} retries`}
                              </span>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Storyboard Grid */}
                    <div className="grid gap-4">
                      {generatedStoryboard.map((scene, index) => (
                        <div key={index} className="bg-gray-900/50 rounded-xl border border-gray-700 overflow-hidden">
                          <div className="flex">
                            {/* Scene Info Panel */}
                            <div className="w-1/5 p-4 border-r border-gray-700">
                              <div className="flex justify-between items-start mb-3">
                                <div>
                                  <span className="text-2xl font-bold text-white">#{scene.scene_id}</span>
                                  <span className={`ml-3 px-2 py-1 text-xs rounded-full ${
                                    scene.beat === 'hook' ? 'bg-red-600/20 text-red-400' :
                                    scene.beat === 'climax' ? 'bg-yellow-600/20 text-yellow-400' :
                                    scene.beat === 'resolution' ? 'bg-green-600/20 text-green-400' :
                                    scene.beat === 'cta' ? 'bg-blue-600/20 text-blue-400' :
                                    'bg-gray-600/20 text-gray-400'
                                  }`}>
                                    {scene.beat}
                                  </span>
                                </div>
                                <span className="text-xs text-gray-500">
                                  {(scene.start_ms / 1000).toFixed(1)}s - {(scene.end_ms / 1000).toFixed(1)}s
                                </span>
                              </div>
                              
                              {/* Voice Over */}
                              <div className="mb-4">
                                <label className="text-xs text-gray-500 block mb-1">Voice Over</label>
                                <p className={`text-sm text-white ${
                                  scene.vo_emphasis === 'strong' ? 'font-bold' :
                                  scene.vo_emphasis === 'slight' ? 'font-medium' : ''
                                }`}>
                                  &ldquo;{scene.vo_text}&rdquo;
                                </p>
                                <span className="text-xs text-gray-500">Speed: {scene.read_speed_wps} wps</span>
                              </div>

                              {/* Scene Twist */}
                              {scene.scene_twist && (
                                <div className="mb-4">
                                  <label className="text-xs text-gray-500 block mb-1">Scene Twist</label>
                                  <p className="text-sm text-orange-400 bg-orange-600/10 p-2 rounded italic">
                                    {scene.scene_twist}
                                  </p>
                                </div>
                              )}

                              {/* Causality Chain */}
                              {(scene.caused_by || scene.leads_to || scene.callback_to !== 'none') && (
                                <div className="mb-4 border-l-2 border-blue-500/30 pl-3">
                                  <label className="text-xs text-blue-400 block mb-2">🔗 Causality Chain</label>
                                  
                                  {scene.caused_by && (
                                    <div className="mb-2">
                                      <span className="text-xs text-gray-500">Caused by:</span>
                                      <p className="text-xs text-gray-300 bg-gray-800/50 p-1 rounded">
                                        {scene.caused_by}
                                      </p>
                                    </div>
                                  )}
                                  
                                  {scene.leads_to && (
                                    <div className="mb-2">
                                      <span className="text-xs text-gray-500">Leads to:</span>
                                      <p className="text-xs text-gray-300 bg-gray-800/50 p-1 rounded">
                                        {scene.leads_to}
                                      </p>
                                    </div>
                                  )}
                                  
                                  {scene.callback_to && scene.callback_to !== 'none' && (
                                    <div className="mb-2">
                                      <span className="text-xs text-gray-500">Callback to:</span>
                                      <p className="text-xs text-yellow-300 bg-yellow-800/20 p-1 rounded">
                                        {scene.callback_to}
                                      </p>
                                    </div>
                                  )}
                                </div>
                              )}

                              {/* Text Overlay */}
                              {scene.text_overlay?.content && (
                                <div className="mb-4">
                                  <label className="text-xs text-gray-500 block mb-1">Text Overlay</label>
                                  <p className={`text-sm ${
                                    scene.text_overlay.weight === 'bold' ? 'text-yellow-400 font-bold' :
                                    scene.text_overlay.weight === 'subtle' ? 'text-gray-400' :
                                    'text-gray-500'
                                  }`}>
                                    {scene.text_overlay.content}
                                  </p>
                                  <span className="text-xs text-gray-500">Position: {scene.text_overlay.position}</span>
                                </div>
                              )}

                              {/* Transitions & Music */}
                              <div className="grid grid-cols-2 gap-2 text-xs">
                                <div>
                                  <span className="text-gray-500">In:</span>
                                  <span className="text-gray-400 ml-1">{scene.transition_in}</span>
                                </div>
                                <div>
                                  <span className="text-gray-500">Out:</span>
                                  <span className="text-gray-400 ml-1">{scene.transition_out}</span>
                                </div>
                                <div>
                                  <span className="text-gray-500">Music:</span>
                                  <span className="text-gray-400 ml-1">{scene.music_cue}</span>
                                </div>
                              </div>
                            </div>

                            {/* Visual Prompt Panel */}
                            <div className="w-1/4 p-4 border-r border-gray-700">
                              <label className="text-xs text-gray-500 block mb-2">Visual Direction</label>
                              
                              <div className="grid grid-cols-2 gap-3 mb-3">
                                <div>
                                  <span className="text-xs text-gray-500">Setting</span>
                                  <p className="text-sm text-gray-300">{scene.visual_prompt.setting}</p>
                                </div>
                                <div>
                                  <span className="text-xs text-gray-500">Characters</span>
                                  <p className="text-sm text-gray-300">{scene.visual_prompt.characters}</p>
                                </div>
                                <div>
                                  <span className="text-xs text-gray-500">Action</span>
                                  <p className="text-sm text-gray-300">{scene.visual_prompt.action}</p>
                                </div>
                                <div>
                                  <span className="text-xs text-gray-500">Props</span>
                                  <p className="text-sm text-gray-300">{scene.visual_prompt.props}</p>
                                </div>
                              </div>

                              <div className="flex flex-wrap gap-2 mb-3">
                                <span className="px-2 py-1 text-xs bg-purple-600/20 text-purple-400 rounded">
                                  {scene.visual_prompt.mood}
                                </span>
                                <span className="px-2 py-1 text-xs bg-orange-600/20 text-orange-400 rounded">
                                  {scene.visual_prompt.lighting}
                                </span>
                                <span className="px-2 py-1 text-xs bg-blue-600/20 text-blue-400 rounded">
                                  {scene.visual_prompt.color_palette}
                                </span>
                                <span className="px-2 py-1 text-xs bg-green-600/20 text-green-400 rounded">
                                  {scene.visual_prompt.composition}
                                </span>
                              </div>

                              <div className="text-xs">
                                <p className="text-gray-500 mb-1">Camera: <span className="text-gray-400">{scene.visual_prompt.camera}</span></p>
                                <p className="text-gray-500 mb-1">Style: <span className="text-gray-400">{scene.visual_prompt.style_tags}</span></p>
                                <p className="text-gray-500">Model: <span className="text-gray-400">{scene.visual_prompt.model_hint}</span> | Seed: <span className="text-gray-400">{scene.visual_prompt.seed}</span></p>
                              </div>
                            </div>

                            {/* Voiceover Generation Panel */}
                            <div className="w-1/4 p-4 border-r border-gray-700">
                              <div className="flex justify-between items-center mb-2">
                                <label className="text-xs text-gray-500">Generated Audio</label>
                                <button
                                  onClick={() => generateStoryboardVoiceover(scene)}
                                  disabled={voiceoverGenerationLoading[scene.scene_id] || (
                                    ttsProvider === 'elevenlabs' ? !elevenLabsKey :
                                    ttsProvider === 'kokoro' ? !kokoroUrl :
                                    !googleTtsKey
                                  ) || !selectedVoiceId}
                                  className="px-3 py-1 text-xs bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition disabled:opacity-50 disabled:cursor-not-allowed"
                                  title={!selectedVoiceId ? 'Loading voices...' : ''}
                                >
                                  {voiceoverGenerationLoading[scene.scene_id] ? 'Gen...' : !selectedVoiceId ? '⏳' : 'Generate'}
                                </button>
                              </div>
                              
                              {/* Audio Display */}
                              <div className="bg-gray-800/50 rounded-lg p-4 mb-3">
                                {storyboardVoiceovers[scene.scene_id] ? (
                                  <div>
                                    <audio 
                                      controls 
                                      src={storyboardVoiceovers[scene.scene_id]}
                                      className="w-full mb-2"
                                      style={{ height: '32px' }}
                                      onLoadedMetadata={(e) => {
                                        const duration = (e.target as HTMLAudioElement).duration;
                                        setVoiceoverDurations(prev => ({ ...prev, [scene.scene_id]: duration }));
                                      }}
                                    />
                                    <div className="flex justify-between">
                                      <p className="text-xs text-gray-400">
                                        Voice: {storyboardVoiceovers[scene.scene_id].startsWith('blob:') ? 'Uploaded' : (ttsProvider === 'elevenlabs' ? 'ElevenLabs' : ttsProvider === 'kokoro' ? 'Kokoro TTS' : 'Google TTS')}
                                      </p>
                                      {voiceoverDurations[scene.scene_id] && (
                                        <p className="text-xs text-gray-400">
                                          {voiceoverDurations[scene.scene_id].toFixed(1)}s
                                        </p>
                                      )}
                                    </div>
                                  </div>
                                ) : voiceoverGenerationLoading[scene.scene_id] ? (
                                  <div className="text-gray-400 text-center">
                                    <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-600 mx-auto mb-2"></div>
                                    <p className="text-xs">Generating...</p>
                                  </div>
                                ) : (
                                  <div className="text-gray-500 text-center">
                                    <div className="text-xl mb-2">🎤</div>
                                    <p className="text-xs">Click Generate for voiceover</p>
                                    <p className="text-xs mt-1 text-gray-600">
                                      {ttsProvider === 'elevenlabs' ? 'ElevenLabs' : 'Google TTS'}
                                    </p>
                                    <label className="block mt-2">
                                      <span className="px-2 py-1 text-xs bg-gray-700 text-gray-300 rounded cursor-pointer hover:bg-gray-600">
                                        Or Upload Audio
                                      </span>
                                      <input
                                        type="file"
                                        accept="audio/*"
                                        className="hidden"
                                        onChange={(e) => {
                                          const file = e.target.files?.[0];
                                          if (file) {
                                            const url = URL.createObjectURL(file);
                                            setStoryboardVoiceovers(prev => ({ ...prev, [scene.scene_id]: url }));
                                          }
                                        }}
                                      />
                                    </label>
                                  </div>
                                )}
                              </div>
                              
                              {/* Voice Text Preview */}
                              <div className="text-xs">
                                <label className="text-gray-500 block mb-1">Voice Text:</label>
                                <p className="text-gray-300 bg-gray-800/50 p-2 rounded text-xs leading-relaxed">
                                  &ldquo;{scene.vo_text}&rdquo;
                                </p>
                                <div className="flex justify-between mt-1 text-gray-500">
                                  <span>Emphasis: {scene.vo_emphasis}</span>
                                  <span>Speed: {scene.read_speed_wps} wps</span>
                                </div>
                              </div>
                            </div>

                            {/* Image Generation Panels - Multiple based on audio duration */}
                            {(() => {
                              const numColumns = calculateImageColumns(voiceoverDurations[scene.scene_id]);
                              const columnWidth = numColumns === 1 ? 'w-1/4' : numColumns === 2 ? 'w-1/2' : 'w-3/4';
                              
                              return (
                                <div className={`${columnWidth} p-4`}>
                                  <div className="mb-2">
                                    <label className="text-xs text-gray-500 block mb-2">
                                      Generated Images ({numColumns} {numColumns === 1 ? 'image' : 'images'})
                                      {voiceoverDurations[scene.scene_id] && (
                                        <span className="text-gray-600"> • {voiceoverDurations[scene.scene_id].toFixed(1)}s audio</span>
                                      )}
                                    </label>
                                  </div>
                                  
                                  {/* Multiple Image Columns */}
                                  <div className={`grid gap-2 ${numColumns === 1 ? 'grid-cols-1' : numColumns === 2 ? 'grid-cols-2' : numColumns === 3 ? 'grid-cols-3' : 'grid-cols-4'}`}>
                                    {Array.from({ length: numColumns }, (_, colIndex) => (
                                      <div key={colIndex} className={`bg-gray-800/50 rounded-lg flex items-center justify-center overflow-hidden ${
                                        scene.visual_prompt.aspect_ratio === '9:16' ? 'aspect-[9/16]' :
                                        scene.visual_prompt.aspect_ratio === '16:9' ? 'aspect-[16/9]' :
                                        'aspect-square'
                                      }`}>
                                        {/* Individual image content for each column */}
                                        {storyboardImages[`${scene.scene_id}_${colIndex}`] || (colIndex === 0 && storyboardImages[scene.scene_id]) ? (
                                          (() => {
                                            const imageUrl = storyboardImages[`${scene.scene_id}_${colIndex}`] || storyboardImages[scene.scene_id];
                                            return (isVideoFile(imageUrl) || uploadedFileTypes[scene.scene_id] === 'video') ? (
                                              <video
                                                src={imageUrl}
                                                className="w-full h-full object-cover"
                                                controls
                                                loop
                                                muted
                                              />
                                            ) : (
                                              <img 
                                                src={imageUrl} 
                                                alt={`Scene ${scene.scene_id} - ${colIndex + 1}`}
                                                className="w-full h-full object-cover"
                                              />
                                            );
                                          })()
                                        ) : imageGenerationLoading[`${scene.scene_id}_${colIndex}`] ? (
                                          <div className="text-gray-400 text-center p-2">
                                            <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-purple-600 mx-auto mb-1"></div>
                                            <p className="text-xs">Gen...</p>
                                          </div>
                                        ) : (
                                          <div className="text-gray-500 text-center p-2">
                                            <div className="text-lg mb-1">🖼️</div>
                                            <p className="text-xs">Image {colIndex + 1}</p>
                                            <p className="text-xs text-gray-600 mt-1">
                                              {Math.round(colIndex * 2)}-{Math.round((colIndex + 1) * 2)}s
                                            </p>
                                            <button
                                              onClick={() => generateStoryboardImageColumn(scene, colIndex)}
                                              disabled={imageGenerationLoading[`${scene.scene_id}_${colIndex}`] || (imageProvider === 'openrouter' ? !apiKey : imageProvider === 'gemini' ? !googleTtsKey : !highbidApiUrl)}
                                              className="px-2 py-1 mt-2 text-xs bg-purple-600 text-white rounded hover:bg-purple-700 transition disabled:opacity-50 disabled:cursor-not-allowed"
                                            >
                                              Generate
                                            </button>
                                            <label className="block mt-1">
                                              <span className="px-1 py-1 text-xs bg-gray-700 text-gray-300 rounded cursor-pointer hover:bg-gray-600">
                                                Upload
                                              </span>
                                              <input
                                                type="file"
                                                accept="image/*,video/*"
                                                className="hidden"
                                                onChange={(e) => {
                                                  const file = e.target.files?.[0];
                                                  if (file) {
                                                    const url = URL.createObjectURL(file);
                                                    const key = colIndex === 0 ? scene.scene_id : `${scene.scene_id}_${colIndex}`;
                                                    setStoryboardImages(prev => ({ ...prev, [key]: url }));
                                                    const isVideo = file.type.startsWith('video/');
                                                    setUploadedFileTypes(prev => ({ ...prev, [scene.scene_id]: isVideo ? 'video' : 'image' }));
                                                  }
                                                }}
                                              />
                                            </label>
                                          </div>
                                        )}
                                      </div>
                                    ))}
                                  </div>
                                  
                                  {/* Flux Prompt Preview */}
                                  <div className="mt-3">
                                    <details className="cursor-pointer">
                                      <summary className="text-xs text-gray-500 hover:text-gray-400">View Flux Prompt</summary>
                                      <div className="mt-2 p-2 bg-gray-800/50 rounded text-xs">
                                        <p className="text-gray-300 mb-2">
                                          <strong>Prompt:</strong> {createFluxPrompt(scene, selectedStory?.visual_style).prompt}
                                        </p>
                                        <p className="text-gray-400">
                                          <strong>Negative:</strong> {createFluxPrompt(scene, selectedStory?.visual_style).negative}
                                        </p>
                                      </div>
                                    </details>
                                  </div>
                                </div>
                              );
                            })()}
                          </div>
                        </div>
                      ))}
                    </div>

                    {/* Export Options */}
                    <div className="bg-gray-900/50 p-6 rounded-xl border border-gray-700">
                      <h4 className="text-lg font-bold text-white mb-4">Export Storyboard</h4>
                      <div className="flex gap-4">
                        <button
                          onClick={() => {
                            const dataStr = JSON.stringify({ story: selectedStory, storyboard: generatedStoryboard }, null, 2);
                            const dataUri = 'data:application/json;charset=utf-8,'+ encodeURIComponent(dataStr);
                            const exportFileDefaultName = `storyboard-${selectedStory?.title?.replace(/\s+/g, '-').toLowerCase()}.json`;
                            const linkElement = document.createElement('a');
                            linkElement.setAttribute('href', dataUri);
                            linkElement.setAttribute('download', exportFileDefaultName);
                            linkElement.click();
                          }}
                          className="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition"
                        >
                          Export as JSON
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>

            {/* Final Video Tab */}
            {activeTab === 'final-video' && (
              <div className="space-y-6">
                <div>
                  <h3 className="text-2xl font-bold text-white mb-4">Final Video Rendering</h3>
                  <p className="text-gray-400 mb-6">Combine your storyboard, images, and voiceovers into a final video</p>
                </div>

                {/* Video Render Section */}
                {finalVideos.length === 0 ? (
                    <div className="bg-gradient-to-r from-purple-900/30 to-pink-900/30 p-8 rounded-xl border-2 border-purple-500/50">
                      <div className="text-center">
                        <div className="text-6xl mb-4">🎬</div>
                        <h3 className="text-3xl font-bold text-white mb-4">Ready to Render Your Video?</h3>
                        <p className="text-gray-300 mb-6 max-w-2xl mx-auto">
                          Combine all your generated content - storyboard, images, and voiceovers - into a professional video ready for social media.
                        </p>
                        
                        {/* Content Status */}
                        <div className="grid grid-cols-3 gap-4 mb-8">
                          <div className="bg-gray-800/50 p-4 rounded-xl">
                            <div className="text-2xl mb-2">📝</div>
                            <div className="text-white font-semibold">Storyboard</div>
                            <div className="text-sm text-gray-400">{generatedStoryboard.length}/{selectedStory?.target_scene_count || 30} scenes</div>
                            <div className={`text-xs mt-1 ${generatedStoryboard.length === (selectedStory?.target_scene_count || 30) ? 'text-green-400' : 'text-yellow-400'}`}>
                              {generatedStoryboard.length === (selectedStory?.target_scene_count || 30) ? '✓ Complete' : '⚠ Incomplete'}
                            </div>
                          </div>
                          
                          <div className="bg-gray-800/50 p-4 rounded-xl">
                            <div className="text-2xl mb-2">🖼️</div>
                            <div className="text-white font-semibold">Images</div>
                            <div className="text-sm text-gray-400">{Object.keys(storyboardImages).length}/{selectedStory?.target_scene_count || 30} images</div>
                            <div className={`text-xs mt-1 ${Object.keys(storyboardImages).length === (selectedStory?.target_scene_count || 30) ? 'text-green-400' : Object.keys(storyboardImages).length > 0 ? 'text-yellow-400' : 'text-red-400'}`}>
                              {Object.keys(storyboardImages).length === (selectedStory?.target_scene_count || 30) ? '✓ Complete' : Object.keys(storyboardImages).length > 0 ? '⚠ Partial' : '✗ Missing'}
                            </div>
                          </div>
                          
                          <div className="bg-gray-800/50 p-4 rounded-xl">
                            <div className="text-2xl mb-2">🎤</div>
                            <div className="text-white font-semibold">Voiceovers</div>
                            <div className="text-sm text-gray-400">{Object.keys(storyboardVoiceovers).length}/{selectedStory?.target_scene_count || 30} audio</div>
                            <div className={`text-xs mt-1 ${Object.keys(storyboardVoiceovers).length === (selectedStory?.target_scene_count || 30) ? 'text-green-400' : Object.keys(storyboardVoiceovers).length > 0 ? 'text-yellow-400' : 'text-red-400'}`}>
                              {Object.keys(storyboardVoiceovers).length === (selectedStory?.target_scene_count || 30) ? '✓ Complete' : Object.keys(storyboardVoiceovers).length > 0 ? '⚠ Partial' : '✗ Missing'}
                            </div>
                          </div>
                        </div>
                        
                        <button
                          onClick={handleVideoRender}
                          disabled={renderingVideo || generatedStoryboard.length === 0}
                          className="px-12 py-4 bg-gradient-to-r from-purple-600 to-pink-600 text-white text-xl font-bold rounded-xl hover:from-purple-700 hover:to-pink-700 disabled:opacity-50 disabled:cursor-not-allowed transition-all transform hover:scale-105"
                        >
                          {renderingVideo ? (
                            <div className="flex items-center">
                              <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-white mr-3"></div>
                              Rendering Video...
                            </div>
                          ) : (
                            '🎬 RENDER FINAL VIDEO'
                          )}
                        </button>
                        
                        {/* Rendering Progress */}
                        {renderingVideo && renderProgress.step && (
                          <div className="mt-6 bg-gray-900/50 p-6 rounded-xl border border-gray-700">
                            <div className="text-center mb-4">
                              <div className="text-white font-semibold mb-2">Video Rendering Progress</div>
                              <div className="text-sm text-gray-300 mb-4">{renderProgress.step}</div>
                            </div>
                            
                            {/* Progress Bar */}
                            <div className="w-full bg-gray-800 rounded-full h-3 mb-2">
                              <div 
                                className="bg-gradient-to-r from-purple-500 to-pink-500 h-3 rounded-full transition-all duration-1000"
                                style={{ width: `${renderProgress.progress}%` }}
                              ></div>
                            </div>
                            <div className="text-center text-sm text-gray-400">
                              {renderProgress.progress}% Complete
                            </div>
                          </div>
                        )}
                        
                        {generatedStoryboard.length === 0 && (
                          <p className="text-yellow-400 text-sm mt-4">
                            ⚠️ Generate a storyboard first to enable video rendering
                          </p>
                        )}
                      </div>
                    </div>
                ) : (
                  <div className="text-center py-16">
                    <div className="text-6xl mb-4">✅</div>
                    <h3 className="text-2xl font-bold text-white mb-4">Video Rendered Successfully!</h3>
                    <p className="text-gray-400 mb-6">Your video has been created. Go to the Final Video tab to view and export it.</p>
                    <button
                      onClick={() => setActiveTab('effects')}
                      className="px-6 py-3 bg-green-600 text-white rounded-xl hover:bg-green-700 transition"
                    >
                      View Final Video
                    </button>
                  </div>
                )}
              </div>
            )}

            {activeTab === 'voiceovers' && (
              <div className="space-y-6">
                <div>
                  <h3 className="text-2xl font-bold text-white mb-4">Batch Voice-over Generation</h3>
                  <p className="text-gray-400 mb-6">Convert your scripts to professional audio narration</p>
                </div>

                {/* TTS Provider Selection */}
                <div className="bg-gray-900/50 p-4 rounded-xl">
                  <label className="block text-white text-sm font-semibold mb-3">
                    TTS Provider
                  </label>
                  <div className="flex gap-4 mb-4">
                    <button
                      onClick={() => {
                        setTtsProvider('elevenlabs');
                        setVoicesLoaded(false);
                        setGoogleVoicesLoaded(false);
                        setAvailableVoices([]);
                        setSelectedVoiceId('21m00Tcm4TlvDq8ikWAM');
                      }}
                      className={`px-4 py-2 rounded-xl transition ${
                        ttsProvider === 'elevenlabs'
                          ? 'bg-blue-600 text-white'
                          : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                      }`}
                    >
                      ElevenLabs
                    </button>
                    <button
                      onClick={() => {
                        setTtsProvider('google');
                        setVoicesLoaded(false);
                        setGoogleVoicesLoaded(false);
                        setAvailableVoices([]);
                        setSelectedVoiceId('Kore');
                      }}
                      className={`px-4 py-2 rounded-xl transition ${
                        ttsProvider === 'google'
                          ? 'bg-green-600 text-white'
                          : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                      }`}
                    >
                      Google Gemini TTS
                    </button>
                    <button
                      onClick={() => {
                        setTtsProvider('kokoro');
                        setVoicesLoaded(false);
                        setGoogleVoicesLoaded(false);
                        setAvailableVoices([]);
                        setSelectedVoiceId('af_heart');
                      }}
                      className={`px-4 py-2 rounded-xl transition ${
                        ttsProvider === 'kokoro'
                          ? 'bg-purple-600 text-white'
                          : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                      }`}
                    >
                      Kokoro TTS
                    </button>
                  </div>
                </div>

                {/* Voice Selection */}
                <div className="bg-gray-900/50 p-4 rounded-xl">
                  <label className="block text-white text-sm font-semibold mb-3">
                    Select Voice {ttsProvider === 'google' && '(Google Gemini)'} {ttsProvider === 'kokoro' && '(Kokoro TTS)'}
                  </label>
                  <div className="flex gap-4 items-center">
                    <select
                      value={selectedVoiceId}
                      onChange={(e) => setSelectedVoiceId(e.target.value)}
                      onFocus={() => loadVoices(ttsProvider)}
                      className="flex-1 px-4 py-3 bg-gray-800 border border-gray-600 rounded-xl text-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition"
                    >
                      {ttsProvider === 'elevenlabs' ? (
                        <>
                          <option value="21m00Tcm4TlvDq8ikWAM">Rachel - Young Female (Default)</option>
                          {availableVoices.map((voice) => (
                            voice.voice_id !== '21m00Tcm4TlvDq8ikWAM' && (
                              <option key={voice.voice_id} value={voice.voice_id}>
                                {voice.name} - {voice.labels?.gender || 'Unknown'} {voice.labels?.age || ''}
                              </option>
                            )
                          ))}
                        </>
                      ) : ttsProvider === 'kokoro' ? (
                        <>
                          <option value="af_heart">Heart - Young Female (Default)</option>
                          <option value="af_alloy">Alloy - Female</option>
                          <option value="af_ember">Ember - Female</option>
                          <option value="am_adam">Adam - Male</option>
                          <option value="bf_emma">Emma - British Female</option>
                          <option value="bf_sarah">Sarah - British Female</option>
                          <option value="bm_george">George - British Male</option>
                        </>
                      ) : (
                        <>
                          <option value="Kore">Kore - Firm, reliable (Default)</option>
                          {availableVoices.map((voice) => (
                            voice.voice_id !== 'Kore' && (
                              <option key={voice.voice_id} value={voice.voice_id}>
                                {voice.name} - {voice.labels?.style || 'Natural'} ({voice.labels?.type || 'Standard'})
                              </option>
                            )
                          ))}
                        </>
                      )}
                    </select>
                    {selectedVoiceId && availableVoices.length > 0 && (
                      <div className="text-sm text-gray-400">
                        {availableVoices.find(v => v.voice_id === selectedVoiceId)?.description || 'Default voice'}
                      </div>
                    )}
                  </div>
                  {ttsProvider === 'google' && !googleTtsKey && (
                    <div className="mt-3 text-yellow-400 text-sm">
                      Please enter your Google Gemini TTS API key above to load voices
                    </div>
                  )}
                  {ttsProvider === 'elevenlabs' && !elevenLabsKey && (
                    <div className="mt-3 text-yellow-400 text-sm">
                      Please enter your ElevenLabs API key above to load voices
                    </div>
                  )}
                </div>

                {/* Text Input */}
                <div className="space-y-4">
                  {voiceoverTexts.map((text, index) => (
                    <div key={index} className="flex gap-3">
                      <textarea
                        value={text}
                        onChange={(e) => updatePrompt('voiceover', index, e.target.value)}
                        placeholder={`Voice-over text ${index + 1}...`}
                        rows={4}
                        className="flex-1 px-4 py-3 bg-gray-900/50 border border-gray-600 rounded-xl text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition resize-none"
                      />
                      <button
                        onClick={() => removePrompt('voiceover', index)}
                        disabled={voiceoverTexts.length === 1}
                        className="px-4 py-2 bg-red-600/20 text-red-400 rounded-xl hover:bg-red-600/30 disabled:opacity-50 disabled:cursor-not-allowed transition"
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>

                <div className="flex gap-4">
                  <button
                    onClick={() => addPrompt('voiceover')}
                    className="px-6 py-3 bg-gray-700 text-white rounded-xl hover:bg-gray-600 transition"
                  >
                    + Add Voice-over Text
                  </button>
                  <button
                    onClick={handleVoiceoverGeneration}
                    disabled={voiceoversLoading || (
                      ttsProvider === 'elevenlabs' ? !elevenLabsKey :
                      ttsProvider === 'kokoro' ? !kokoroUrl :
                      !googleTtsKey
                    )}
                    className="px-8 py-3 bg-gradient-to-r from-blue-500 to-purple-600 text-white font-semibold rounded-xl hover:from-blue-600 hover:to-purple-700 disabled:opacity-50 disabled:cursor-not-allowed transition"
                  >
                    {voiceoversLoading ? `Generating with ${
                      ttsProvider === 'elevenlabs' ? 'ElevenLabs' :
                      ttsProvider === 'kokoro' ? 'Kokoro TTS' :
                      'Google TTS'
                    }...` : `Generate with ${
                      ttsProvider === 'elevenlabs' ? 'ElevenLabs' :
                      ttsProvider === 'kokoro' ? 'Kokoro TTS' :
                      'Google TTS'
                    }`}
                  </button>
                </div>

                {/* Generated Audio */}
                {generatedVoiceovers.length > 0 && (
                  <div className="space-y-4">
                    <h4 className="text-xl font-bold text-white">Generated Voice-overs</h4>
                    <div className="grid gap-4">
                      {generatedVoiceovers.map((voiceover, index) => (
                        <div key={index} className="bg-gray-900/50 p-4 rounded-xl">
                          <div className="mb-3">
                            <div className="flex justify-between items-start mb-2">
                              <h5 className="text-lg font-semibold text-white">Voice-over {index + 1}</h5>
                              {voiceover.provider && (
                                <span className={`px-2 py-1 text-xs rounded-full ${
                                  voiceover.provider === 'google-gemini' ? 'bg-green-600/20 text-green-400' : 'bg-blue-600/20 text-blue-400'
                                }`}>
                                  {voiceover.provider === 'google-gemini' ? 'Google TTS' : 'ElevenLabs'}
                                </span>
                              )}
                            </div>
                            <p className="text-gray-400 text-sm mb-3">{voiceover.text}</p>
                          </div>
                          <audio 
                            controls 
                            className="w-full mb-3"
                            src={voiceover.audio}
                          >
                            Your browser does not support the audio element.
                          </audio>
                          <button
                            onClick={() => {
                              const link = document.createElement('a');
                              link.href = voiceover.audio;
                              link.download = `voiceover-${index + 1}.mp3`;
                              link.click();
                            }}
                            className="w-full py-2 bg-gray-700 hover:bg-gray-600 text-white rounded-xl transition"
                          >
                            Download Audio
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {activeTab === 'effects' && (
              <div className="space-y-6">
                <div>
                  <h3 className="text-2xl font-bold text-white mb-4">Final Video</h3>
                  <p className="text-gray-400 mb-6">Your rendered video combining all generated content</p>
                </div>

                {finalVideos.length === 0 ? (
                  <div className="text-center py-16">
                    <div className="text-6xl mb-4">🎬</div>
                    <h3 className="text-2xl font-bold text-white mb-4">No Video Rendered Yet</h3>
                    <p className="text-gray-400 mb-6">Go to the Storyboard tab and click &quot;RENDER FINAL VIDEO&quot; to create your video</p>
                    <button
                      onClick={() => setActiveTab('storyboard')}
                      className="px-6 py-3 bg-purple-600 text-white rounded-xl hover:bg-purple-700 transition"
                    >
                      Go to Storyboard Tab
                    </button>
                  </div>
                ) : (
                  <div className="space-y-6">
                    {/* Video Preview Section */}
                    <div className="bg-gray-900/50 p-8 rounded-xl border border-gray-700">
                      <div className="text-center mb-6">
                        <h4 className="text-xl font-bold text-white mb-2">Rendered Video Preview</h4>
                        <p className="text-gray-400">60-second vertical video optimized for social media</p>
                      </div>
                      
                      {/* Video Player Placeholder */}
                      <div className="max-w-sm mx-auto">
                        <div className="bg-gray-800 rounded-xl p-8 aspect-[9/16] flex items-center justify-center">
                          <div className="text-center">
                            <div className="text-4xl mb-4">🎥</div>
                            <div className="text-white font-semibold mb-2">Video Preview</div>
                            <div className="text-sm text-gray-400">
                              {selectedStory?.title || 'Untitled Story'}
                            </div>
                            <div className="text-xs text-gray-500 mt-2">
                              {generatedStoryboard.length} scenes • 9:16 aspect ratio
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Video Stats */}
                    <div className="grid grid-cols-4 gap-4">
                      <div className="bg-gray-900/50 p-4 rounded-xl text-center">
                        <div className="text-2xl mb-2">⏱️</div>
                        <div className="text-white font-semibold">{generatedStoryboard.length * 2}s</div>
                        <div className="text-xs text-gray-400">Duration</div>
                      </div>
                      <div className="bg-gray-900/50 p-4 rounded-xl text-center">
                        <div className="text-2xl mb-2">📐</div>
                        <div className="text-white font-semibold">9:16</div>
                        <div className="text-xs text-gray-400">Aspect Ratio</div>
                      </div>
                      <div className="bg-gray-900/50 p-4 rounded-xl text-center">
                        <div className="text-2xl mb-2">🎞️</div>
                        <div className="text-white font-semibold">{generatedStoryboard.length}</div>
                        <div className="text-xs text-gray-400">Scenes</div>
                      </div>
                      <div className="bg-gray-900/50 p-4 rounded-xl text-center">
                        <div className="text-2xl mb-2">🎨</div>
                        <div className="text-white font-semibold">{selectedStory?.visual_style}</div>
                        <div className="text-xs text-gray-400">Style</div>
                      </div>
                    </div>

                    {/* Content Summary */}
                    <div className="bg-gray-900/50 p-6 rounded-xl border border-gray-700">
                      <h4 className="text-lg font-bold text-white mb-4">Video Content Summary</h4>
                      <div className="grid grid-cols-3 gap-6">
                        <div>
                          <div className="text-sm text-gray-400 mb-2">Images Generated</div>
                          <div className="text-white font-semibold">{Object.keys(storyboardImages).length}/{selectedStory?.target_scene_count || 30}</div>
                          <div className="w-full bg-gray-800 rounded-full h-2 mt-2">
                            <div 
                              className="bg-green-500 h-2 rounded-full transition-all"
                              style={{ width: `${(Object.keys(storyboardImages).length / (selectedStory?.target_scene_count || 30)) * 100}%` }}
                            ></div>
                          </div>
                        </div>
                        <div>
                          <div className="text-sm text-gray-400 mb-2">Voiceovers Generated</div>
                          <div className="text-white font-semibold">{Object.keys(storyboardVoiceovers).length}/{selectedStory?.target_scene_count || 30}</div>
                          <div className="w-full bg-gray-800 rounded-full h-2 mt-2">
                            <div 
                              className="bg-blue-500 h-2 rounded-full transition-all"
                              style={{ width: `${(Object.keys(storyboardVoiceovers).length / (selectedStory?.target_scene_count || 30)) * 100}%` }}
                            ></div>
                          </div>
                        </div>
                        <div>
                          <div className="text-sm text-gray-400 mb-2">Story Completion</div>
                          <div className="text-white font-semibold">{Math.round(((Object.keys(storyboardImages).length + Object.keys(storyboardVoiceovers).length) / 60) * 100)}%</div>
                          <div className="w-full bg-gray-800 rounded-full h-2 mt-2">
                            <div 
                              className="bg-purple-500 h-2 rounded-full transition-all"
                              style={{ width: `${((Object.keys(storyboardImages).length + Object.keys(storyboardVoiceovers).length) / 60) * 100}%` }}
                            ></div>
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Export Options */}
                    <div className="bg-gray-900/50 p-6 rounded-xl border border-gray-700">
                      <h4 className="text-lg font-bold text-white mb-4">Export & Share</h4>
                      <div className="flex gap-4">
                        <button 
                          onClick={() => {
                            if (finalVideos.length > 0) {
                              const videoData = JSON.parse(atob(finalVideos[0].split(',')[1]));
                              const exportData = {
                                ...videoData,
                                exportFormat: 'mobile',
                                aspectRatio: '9:16',
                                resolution: '1080x1920'
                              };
                              const dataStr = JSON.stringify(exportData, null, 2);
                              const dataUri = 'data:application/json;charset=utf-8,'+ encodeURIComponent(dataStr);
                              const exportFileDefaultName = `${selectedStory?.title?.replace(/\s+/g, '-').toLowerCase() || 'video'}-mobile.json`;
                              const linkElement = document.createElement('a');
                              linkElement.setAttribute('href', dataUri);
                              linkElement.setAttribute('download', exportFileDefaultName);
                              linkElement.click();
                            }
                          }}
                          className="px-6 py-3 bg-green-600 text-white rounded-xl hover:bg-green-700 transition"
                        >
                          📱 Download for Mobile
                        </button>
                        <button 
                          onClick={() => {
                            if (finalVideos.length > 0) {
                              const videoData = JSON.parse(atob(finalVideos[0].split(',')[1]));
                              const exportData = {
                                ...videoData,
                                exportFormat: 'desktop',
                                aspectRatio: '16:9',
                                resolution: '1920x1080'
                              };
                              const dataStr = JSON.stringify(exportData, null, 2);
                              const dataUri = 'data:application/json;charset=utf-8,'+ encodeURIComponent(dataStr);
                              const exportFileDefaultName = `${selectedStory?.title?.replace(/\s+/g, '-').toLowerCase() || 'video'}-desktop.json`;
                              const linkElement = document.createElement('a');
                              linkElement.setAttribute('href', dataUri);
                              linkElement.setAttribute('download', exportFileDefaultName);
                              linkElement.click();
                            }
                          }}
                          className="px-6 py-3 bg-blue-600 text-white rounded-xl hover:bg-blue-700 transition"
                        >
                          💻 Download for Desktop
                        </button>
                        <button 
                          onClick={() => {
                            if (finalVideos.length > 0) {
                              const videoData = JSON.parse(atob(finalVideos[0].split(',')[1]));
                              const shareData = {
                                title: selectedStory?.title,
                                premise: selectedStory?.premise,
                                duration: `${generatedStoryboard.length * 2}s`,
                                scenes: generatedStoryboard.length,
                                style: selectedStory?.visual_style,
                                timestamp: new Date().toISOString()
                              };
                              navigator.clipboard.writeText(JSON.stringify(shareData, null, 2)).then(() => {
                                alert('Share data copied to clipboard!');
                              }).catch(() => {
                                const dataStr = JSON.stringify(shareData, null, 2);
                                const dataUri = 'data:application/json;charset=utf-8,'+ encodeURIComponent(dataStr);
                                const exportFileDefaultName = `${selectedStory?.title?.replace(/\s+/g, '-').toLowerCase() || 'video'}-share.json`;
                                const linkElement = document.createElement('a');
                                linkElement.setAttribute('href', dataUri);
                                linkElement.setAttribute('download', exportFileDefaultName);
                                linkElement.click();
                              });
                            }
                          }}
                          className="px-6 py-3 bg-purple-600 text-white rounded-xl hover:bg-purple-700 transition"
                        >
                          🔗 Generate Share Link
                        </button>
                      </div>
                    </div>

                    {/* Re-render Button */}
                    <div className="text-center pt-6 border-t border-gray-700">
                      <button
                        onClick={() => setActiveTab('storyboard')}
                        className="px-8 py-3 bg-gray-700 text-white rounded-xl hover:bg-gray-600 transition"
                      >
                        ← Back to Storyboard to Re-render
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Prompt Inspection Modals */}
            {showStoryBulbPrompt && (
              <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
                <div className="bg-gray-900 rounded-xl border border-gray-700 max-w-4xl w-full max-h-[80vh] overflow-hidden">
                  <div className="p-6 border-b border-gray-700 flex justify-between items-center">
                    <h3 className="text-xl font-bold text-white">📄 Story Bulb Generation Prompt</h3>
                    <button
                      onClick={() => setShowStoryBulbPrompt(false)}
                      className="text-gray-400 hover:text-white transition"
                    >
                      ✕
                    </button>
                  </div>
                  <div className="p-6 overflow-y-auto max-h-[60vh]">
                    <div className="bg-gray-800/50 rounded-lg p-4 font-mono text-sm">
                      <pre className="text-gray-300 whitespace-pre-wrap">{`SYSTEM:
You are a story generator. 
You must output valid JSON only, with no explanations, no prose, no comments.

The JSON object must have the following keys:
{
  "title": string,
  "runtime_sec": 60,
  "tone": one of ["inspiring","dramatic","cozy","creepy","comedic","educational"],
  "narration_pov": one of ["first_person","third_person"],
  "target_viewer": string,
  "premise": string (≤22 words),
  "protagonist": string,
  "goal": string,
  "stakes": string,
  "setting": string,
  "constraint": string,
  "twist": string (≤22 words),
  "call_to_action": string or "",
  "visual_style": string (free-form description),
  "action_emphasis": string (guidance for creating action-packed scenes),
  "domino_sequences": array of 3-5 cause-effect chains,
  "setups_payoffs": array of setup/payoff pairs,
  "escalation_points": array of 3 moments where stakes increase,
  "plot_threads": object with three acts and their turning points
}

RULES:
- All values must be single-line strings (no line breaks).
- runtime_sec is always 60 unless explicitly told otherwise.
- Keep premise and twist short, max 22 words.
- visual_style can be any creative description (e.g., "cinematic photoreal", "anime style", "oil painting")
- CRITICAL: Focus on ACTION-DRIVEN narratives. Avoid passive observation.
- Every story element should lead to dynamic, visual scenes with conflict/movement.
- action_emphasis should guide how each scene will show action, not passive states.
- Examples of good action_emphasis: "constant movement and revelations", "each scene shows character making discoveries", "fast-paced confrontations and escapes".
- Do not output anything except the JSON object.

USER:
Generate a Story Bulb JSON for this viral title: "<TITLE>"`}</pre>
                    </div>
                    <div className="mt-4 text-sm text-gray-400">
                      <p><strong>Note:</strong> The &lt;TITLE&gt; placeholder gets replaced with your actual title when sent to the AI model.</p>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {showStoryboardPrompt && (
              <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
                <div className="bg-gray-900 rounded-xl border border-gray-700 max-w-4xl w-full max-h-[80vh] overflow-hidden">
                  <div className="p-6 border-b border-gray-700 flex justify-between items-center">
                    <h3 className="text-xl font-bold text-white">🎬 Storyboard Generation Prompt</h3>
                    <button
                      onClick={() => setShowStoryboardPrompt(false)}
                      className="text-gray-400 hover:text-white transition"
                    >
                      ✕
                    </button>
                  </div>
                  <div className="p-6 overflow-y-auto max-h-[60vh]">
                    <div className="bg-gray-800/50 rounded-lg p-4 font-mono text-sm">
                      <pre className="text-gray-300 whitespace-pre-wrap">{`SYSTEM:
You are a storyboard generator.
You must output exactly 30 lines of JSON (JSONL format). 
Each line must be a valid JSON object conforming to the schema below.
No prose, no explanations, no comments.

REQUIRED FIELDS:
{
  "scene_id": int (1..30),
  "start_ms": int (2000*(scene_id-1)),
  "end_ms": int (start_ms+2000),
  "beat": one of ["hook","setup","inciting","rise","midpoint","complication","climax","resolution","cta"],
  "vo_text": string (≤7 words, no line breaks, action-focused),
  "scene_twist": string (the specific action/conflict/revelation in this scene),
  "caused_by": string (what previous event directly triggers THIS scene),
  "leads_to": string (what immediate consequence this scene creates),
  "callback_to": string (reference to earlier setup if payoff, or "none"),
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
- Output 30 lines, one JSON object per line, no extra text.
- Each scene covers 2000 ms (2 seconds).
- CRITICAL: vo_text must be ≤7 words maximum to fit 2-second timing.
- CRITICAL: Every scene must be a DIRECT CONSEQUENCE of previous events.
- CRITICAL: Use "therefore/but/however" logic between ALL scenes.
- caused_by must reference SPECIFIC actions from previous scenes
- leads_to must create concrete problems that next scene MUST address
- callback_to should reference earlier setups when paying them off
- Each scene_twist must be CAUSED BY previous actions, not random
- Example: Scene 3 hero action → Scene 4 enemy reaction → Scene 5 consequence
- Avoid generic actions: specify WHO does WHAT causing WHAT
- Ensure final scene (#30) has beat="cta" if a call_to_action exists.

USER:
Here is the Story Bulb JSON:
<PASTE STORY BULB JSON HERE>

Expand this into a 30-scene storyboard in JSONL format.`}</pre>
                    </div>
                    <div className="mt-4 text-sm text-gray-400">
                      <p><strong>Note:</strong> The &lt;PASTE STORY BULB JSON HERE&gt; placeholder gets replaced with the actual story bulb JSON when sent to the AI model.</p>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Global Error Display */}
            {error && (
              <div className="mt-6 bg-red-900/20 border border-red-500 text-red-400 px-4 py-3 rounded-xl">
                <p className="text-sm">{error}</p>
              </div>
            )}
        </div>
      </div>
    </div>
  );
}
