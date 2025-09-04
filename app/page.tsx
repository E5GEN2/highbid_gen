'use client';

import { useState } from 'react';

export default function Home() {
  const [apiKey, setApiKey] = useState('');
  const [activeTab, setActiveTab] = useState('scripts');
  const [showApiKey, setShowApiKey] = useState(false);
  
  // Script Generation State
  const [scriptPrompts, setScriptPrompts] = useState<string[]>(['']);
  const [generatedScripts, setGeneratedScripts] = useState<string[]>([]);
  const [scriptsLoading, setScriptsLoading] = useState(false);
  
  // Storyboard State
  const [storyboards, setStoryboards] = useState<string[]>([]);
  const [storyboardsLoading, setStoryboardsLoading] = useState(false);
  
  // Voice-over State
  const [voiceovers, setVoiceovers] = useState<string[]>([]);
  const [voiceoversLoading, setVoiceoversLoading] = useState(false);
  
  // Image Generation State
  const [imagePrompts, setImagePrompts] = useState<string[]>(['']);
  const [generatedImages, setGeneratedImages] = useState<string[]>([]);
  const [imagesLoading, setImagesLoading] = useState(false);
  
  // Effects State
  const [finalVideos, setFinalVideos] = useState<string[]>([]);
  const [effectsLoading, setEffectsLoading] = useState(false);
  
  const [error, setError] = useState<string | null>(null);

  const tabs = [
    { id: 'scripts', name: '1. Scripts', icon: '📝' },
    { id: 'storyboard', name: '2. Storyboard', icon: '🎨' },
    { id: 'voiceovers', name: '3. Voice-overs', icon: '🎤' },
    { id: 'images', name: '4. Images', icon: '🖼️' },
    { id: 'effects', name: '5. Final Video', icon: '🎬' }
  ];

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
    if (!apiKey || imagePrompts.filter(p => p.trim()).length === 0) {
      setError('Please provide API key and at least one image prompt');
      return;
    }

    setImagesLoading(true);
    setError(null);

    try {
      const results: string[] = [];
      
      for (const prompt of imagePrompts) {
        if (!prompt.trim()) continue;
        
        const response = await fetch('/api/generate-image', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            prompt,
            apiKey,
          }),
        });

        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.error || 'Failed to generate image');
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

  const addPrompt = (type: 'script' | 'image') => {
    if (type === 'script') {
      setScriptPrompts([...scriptPrompts, '']);
    } else {
      setImagePrompts([...imagePrompts, '']);
    }
  };

  const removePrompt = (type: 'script' | 'image', index: number) => {
    if (type === 'script') {
      setScriptPrompts(scriptPrompts.filter((_, i) => i !== index));
    } else {
      setImagePrompts(imagePrompts.filter((_, i) => i !== index));
    }
  };

  const updatePrompt = (type: 'script' | 'image', index: number, value: string) => {
    if (type === 'script') {
      const updated = [...scriptPrompts];
      updated[index] = value;
      setScriptPrompts(updated);
    } else {
      const updated = [...imagePrompts];
      updated[index] = value;
      setImagePrompts(updated);
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

        {/* API Key Section */}
        <div className="bg-gray-800/50 backdrop-blur-xl rounded-2xl p-6 border border-gray-700 mb-8">
          <label className="block text-white text-sm font-semibold mb-3">
            OpenRouter API Key
          </label>
          <div className="relative max-w-md">
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
                    disabled={imagesLoading || !apiKey}
                    className="px-8 py-3 bg-gradient-to-r from-blue-500 to-purple-600 text-white font-semibold rounded-xl hover:from-blue-600 hover:to-purple-700 disabled:opacity-50 disabled:cursor-not-allowed transition"
                  >
                    {imagesLoading ? 'Generating Images...' : 'Generate Images'}
                  </button>
                </div>

                {generatedImages.length > 0 && (
                  <div className="space-y-4">
                    <h4 className="text-xl font-bold text-white">Generated Images</h4>
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                      {generatedImages.map((image, index) => (
                        <div key={index} className="bg-gray-900/50 p-4 rounded-xl">
                          <img
                            src={image}
                            alt={`Generated ${index + 1}`}
                            className="w-full h-48 object-cover rounded-xl mb-3"
                          />
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
              <div className="text-center py-12">
                <div className="text-6xl mb-4">🎤</div>
                <h3 className="text-2xl font-bold text-white mb-4">Voice-over Generation</h3>
                <p className="text-gray-400 mb-6">Convert your scripts to audio narration</p>
                <div className="bg-yellow-900/20 border border-yellow-500 text-yellow-400 px-4 py-3 rounded-xl max-w-md mx-auto">
                  Coming Soon - Text-to-speech voice generation
                </div>
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
