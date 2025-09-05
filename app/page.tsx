'use client';

import { useState } from 'react';
import Image from 'next/image';

export default function Home() {
  const [apiKey, setApiKey] = useState('');
  const [elevenLabsKey, setElevenLabsKey] = useState('');
  const [googleTtsKey, setGoogleTtsKey] = useState('');
  const [highbidApiUrl, setHighbidApiUrl] = useState('');
  const [activeTab, setActiveTab] = useState('scripts');
  const [showApiKey, setShowApiKey] = useState(false);
  const [showElevenLabsKey, setShowElevenLabsKey] = useState(false);
  const [showGoogleTtsKey, setShowGoogleTtsKey] = useState(false);
  const [showHighbidUrl, setShowHighbidUrl] = useState(false);
  
  // Script Generation State
  const [scriptPrompts, setScriptPrompts] = useState<string[]>(['']);
  const [generatedScripts, _setGeneratedScripts] = useState<string[]>([]);
  const [scriptsLoading, setScriptsLoading] = useState(false);
  
  // Storyboard State
  const [_storyboards, _setStoryboards] = useState<string[]>([]);
  const [_storyboardsLoading, _setStoryboardsLoading] = useState(false);
  
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
  const [selectedVoiceId, setSelectedVoiceId] = useState('21m00Tcm4TlvDq8ikWAM');
  const [voicesLoaded, setVoicesLoaded] = useState(false);
  const [ttsProvider, setTtsProvider] = useState<'elevenlabs' | 'google'>('elevenlabs');
  const [googleVoicesLoaded, setGoogleVoicesLoaded] = useState(false);
  
  // Image Generation State
  const [imagePrompts, setImagePrompts] = useState<string[]>(['']);
  const [generatedImages, setGeneratedImages] = useState<string[]>([]);
  const [imagesLoading, setImagesLoading] = useState(false);
  const [imageProvider, setImageProvider] = useState<'openrouter' | 'highbid'>('openrouter');
  const [imageWidth, setImageWidth] = useState(1024);
  const [imageHeight, setImageHeight] = useState(1024);
  
  // Effects State
  const [_finalVideos, _setFinalVideos] = useState<string[]>([]);
  const [_effectsLoading, _setEffectsLoading] = useState(false);
  
  const [error, setError] = useState<string | null>(null);

  const tabs = [
    { id: 'scripts', name: '1. Scripts', icon: '📝' },
    { id: 'storyboard', name: '2. Storyboard', icon: '🎨' },
    { id: 'voiceovers', name: '3. Voice-overs', icon: '🎤' },
    { id: 'images', name: '4. Images', icon: '🖼️' },
    { id: 'effects', name: '5. Final Video', icon: '🎬' }
  ];

  const loadVoices = async (provider: 'elevenlabs' | 'google' = ttsProvider) => {
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
        const response = await fetch(`/api/generate-google-tts`);
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
  };

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
        
        const endpoint = ttsProvider === 'elevenlabs' ? '/api/generate-voiceover' : '/api/generate-google-tts';
        const requestBody = ttsProvider === 'elevenlabs' 
          ? { text, apiKey: elevenLabsKey, voiceId: selectedVoiceId }
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
    if (!apiKey || scriptPrompts.filter(p => p.trim()).length === 0) {
      setError('Please provide API key and at least one script prompt');
      return;
    }
    
    setScriptsLoading(true);
    setError(null);
    
    try {
      // This will be implemented with script generation API
      setError('Script generation not yet implemented');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate scripts');
    } finally {
      setScriptsLoading(false);
    }
  };

  const handleImageGeneration = async () => {
    const requiredKey = imageProvider === 'openrouter' ? apiKey : highbidApiUrl;
    const providerName = imageProvider === 'openrouter' ? 'OpenRouter API key' : 'Highbid API URL';
    
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
        
        const endpoint = imageProvider === 'openrouter' ? '/api/generate-image' : '/api/generate-highbid-image';
        const requestBody = imageProvider === 'openrouter' 
          ? { prompt, apiKey }
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

  const addPrompt = (type: 'script' | 'image' | 'voiceover') => {
    if (type === 'script') {
      setScriptPrompts([...scriptPrompts, '']);
    } else if (type === 'image') {
      setImagePrompts([...imagePrompts, '']);
    } else {
      setVoiceoverTexts([...voiceoverTexts, '']);
    }
  };

  const removePrompt = (type: 'script' | 'image' | 'voiceover', index: number) => {
    if (type === 'script') {
      setScriptPrompts(scriptPrompts.filter((_, i) => i !== index));
    } else if (type === 'image') {
      setImagePrompts(imagePrompts.filter((_, i) => i !== index));
    } else {
      setVoiceoverTexts(voiceoverTexts.filter((_, i) => i !== index));
    }
  };

  const updatePrompt = (type: 'script' | 'image' | 'voiceover', index: number, value: string) => {
    if (type === 'script') {
      const updated = [...scriptPrompts];
      updated[index] = value;
      setScriptPrompts(updated);
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
                  <h3 className="text-2xl font-bold text-white mb-4">Batch Script Generation</h3>
                  <p className="text-gray-400 mb-6">Generate multiple short story scripts for your videos</p>
                </div>

                <div className="space-y-4">
                  {scriptPrompts.map((prompt, index) => (
                    <div key={index} className="flex gap-3">
                      <textarea
                        value={prompt}
                        onChange={(e) => updatePrompt('script', index, e.target.value)}
                        placeholder={`Script prompt ${index + 1}...`}
                        rows={3}
                        className="flex-1 px-4 py-3 bg-gray-900/50 border border-gray-600 rounded-xl text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition resize-none"
                      />
                      <button
                        onClick={() => removePrompt('script', index)}
                        disabled={scriptPrompts.length === 1}
                        className="px-4 py-2 bg-red-600/20 text-red-400 rounded-xl hover:bg-red-600/30 disabled:opacity-50 disabled:cursor-not-allowed transition"
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>

                <div className="flex gap-4">
                  <button
                    onClick={() => addPrompt('script')}
                    className="px-6 py-3 bg-gray-700 text-white rounded-xl hover:bg-gray-600 transition"
                  >
                    + Add Script Prompt
                  </button>
                  <button
                    onClick={handleScriptGeneration}
                    disabled={scriptsLoading || !apiKey}
                    className="px-8 py-3 bg-gradient-to-r from-blue-500 to-purple-600 text-white font-semibold rounded-xl hover:from-blue-600 hover:to-purple-700 disabled:opacity-50 disabled:cursor-not-allowed transition"
                  >
                    {scriptsLoading ? 'Generating Scripts...' : 'Generate Scripts'}
                  </button>
                </div>

                {generatedScripts.length > 0 && (
                  <div className="space-y-4">
                    <h4 className="text-xl font-bold text-white">Generated Scripts</h4>
                    {generatedScripts.map((script, index) => (
                      <div key={index} className="bg-gray-900/50 p-4 rounded-xl">
                        <h5 className="text-lg font-semibold text-white mb-2">Script {index + 1}</h5>
                        <p className="text-gray-300 whitespace-pre-wrap">{script}</p>
                      </div>
                    ))}
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
                  <div className="flex gap-4 mb-4">
                    <button
                      onClick={() => setImageProvider('openrouter')}
                      className={`px-4 py-2 rounded-xl transition ${
                        imageProvider === 'openrouter'
                          ? 'bg-blue-600 text-white'
                          : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                      }`}
                    >
                      OpenRouter (Gemini)
                    </button>
                    <button
                      onClick={() => setImageProvider('highbid')}
                      className={`px-4 py-2 rounded-xl transition ${
                        imageProvider === 'highbid'
                          ? 'bg-purple-600 text-white'
                          : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                      }`}
                    >
                      Highbid (Flux - High Quality)
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
                    disabled={imagesLoading || (imageProvider === 'openrouter' ? !apiKey : !highbidApiUrl)}
                    className={`px-8 py-3 text-white font-semibold rounded-xl disabled:opacity-50 disabled:cursor-not-allowed transition ${
                      imageProvider === 'highbid' 
                        ? 'bg-gradient-to-r from-purple-500 to-pink-600 hover:from-purple-600 hover:to-pink-700'
                        : 'bg-gradient-to-r from-blue-500 to-purple-600 hover:from-blue-600 hover:to-purple-700'
                    }`}
                  >
                    {imagesLoading 
                      ? `Generating with ${imageProvider === 'highbid' ? 'Highbid' : 'OpenRouter'}...` 
                      : `Generate with ${imageProvider === 'highbid' ? 'Highbid (${imageWidth}x${imageHeight})' : 'OpenRouter'}`}
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

            {/* Placeholder tabs */}
            {activeTab === 'storyboard' && (
              <div className="text-center py-12">
                <div className="text-6xl mb-4">🎨</div>
                <h3 className="text-2xl font-bold text-white mb-4">Storyboard Generation</h3>
                <p className="text-gray-400 mb-6">Turn your scripts into visual storyboards</p>
                <div className="bg-yellow-900/20 border border-yellow-500 text-yellow-400 px-4 py-3 rounded-xl max-w-md mx-auto">
                  Coming Soon - Storyboard generation from scripts
                </div>
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
                  </div>
                </div>

                {/* Voice Selection */}
                <div className="bg-gray-900/50 p-4 rounded-xl">
                  <label className="block text-white text-sm font-semibold mb-3">
                    Select Voice {ttsProvider === 'google' && '(Google Gemini)'}
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
                    disabled={voiceoversLoading || (ttsProvider === 'elevenlabs' ? !elevenLabsKey : !googleTtsKey)}
                    className="px-8 py-3 bg-gradient-to-r from-blue-500 to-purple-600 text-white font-semibold rounded-xl hover:from-blue-600 hover:to-purple-700 disabled:opacity-50 disabled:cursor-not-allowed transition"
                  >
                    {voiceoversLoading ? `Generating with ${ttsProvider === 'elevenlabs' ? 'ElevenLabs' : 'Google TTS'}...` : `Generate with ${ttsProvider === 'elevenlabs' ? 'ElevenLabs' : 'Google TTS'}`}
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
              <div className="text-center py-12">
                <div className="text-6xl mb-4">🎬</div>
                <h3 className="text-2xl font-bold text-white mb-4">Video Assembly & Effects</h3>
                <p className="text-gray-400 mb-6">Combine images, voice-overs, and effects into final videos</p>
                <div className="bg-yellow-900/20 border border-yellow-500 text-yellow-400 px-4 py-3 rounded-xl max-w-md mx-auto">
                  Coming Soon - Video editing and final assembly
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
    </div>
  );
}
