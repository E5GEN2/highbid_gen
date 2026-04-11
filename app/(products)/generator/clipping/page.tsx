'use client';

import React, { useState, useEffect, useCallback } from 'react';

export default function ClippingPage() {
  // Clipping State
  const [clippingProjects, setClippingProjects] = useState<{
    id: string;
    title: string;
    status: string;
    thumbnail_url: string | null;
    video_duration: number | null;
    created_at: string;
    updated_at: string;
  }[]>([]);
  const [clippingLoading, setClippingLoading] = useState(false);
  const [showNewProjectModal, setShowNewProjectModal] = useState(false);
  const [newProjectTitle, setNewProjectTitle] = useState('');
  const [clippingStep, setClippingStep] = useState<'upload' | 'configure' | 'processing' | 'clips'>('upload');
  const [clippingProcessSteps, setClippingProcessSteps] = useState<{
    label: string;
    status: 'pending' | 'active' | 'done';
    progress?: number;
    detail?: string;
  }[]>([]);
  const [clippingFile, setClippingFile] = useState<{ name: string; size: number; type: string; rawFile?: File } | null>(null);
  const [clippingVideoDuration, setClippingVideoDuration] = useState<number | undefined>(undefined);
  const [clippingUploadProgress, setClippingUploadProgress] = useState(0);
  const [clippingRatio, setClippingRatio] = useState('9:16');
  const [clippingClipLength, setClippingClipLength] = useState('60s-90s');
  const [clippingAddEmoji, setClippingAddEmoji] = useState(true);
  const [clippingHighlightKeywords, setClippingHighlightKeywords] = useState(true);
  const [clippingRemoveSilences, setClippingRemoveSilences] = useState(false);
  const [clippingAddBrolls, setClippingAddBrolls] = useState(false);
  const [clippingFindMoment, setClippingFindMoment] = useState('');
  const [clippingCurrentProjectId, setClippingCurrentProjectId] = useState<string | null>(null);
  const [clippingGeneratedClips, setClippingGeneratedClips] = useState<{
    id: string;
    title: string;
    description: string;
    score: number;
    start_sec: number;
    end_sec: number;
    duration_sec: number;
    transcript: string;
    status: string;
    file_size_bytes: number | null;
  }[]>([]);
  const [clippingSelectedClipIdx, setClippingSelectedClipIdx] = useState(0);

  // Fetch projects on mount
  const fetchClippingProjects = useCallback(async () => {
    setClippingLoading(true);
    try {
      const response = await fetch('/api/clipping/projects');
      const data = await response.json();
      if (data.projects) {
        setClippingProjects(data.projects);
      }
    } catch (err) {
      console.error('Error fetching clipping projects:', err);
    } finally {
      setClippingLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchClippingProjects();
  }, [fetchClippingProjects]);

  const createClippingProject = async () => {
    try {
      const response = await fetch('/api/clipping/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: newProjectTitle || 'Untitled' }),
      });
      const data = await response.json();
      if (data.project) {
        setClippingProjects(prev => [data.project, ...prev]);
      }
    } catch (err) {
      console.error('Error creating clipping project:', err);
    }
  };

  const startClippingAnalysis = async (projectId: string, videoUrl: string, videoDuration?: number) => {
    try {
      console.log('[clipping] Starting analysis:', { projectId, videoUrl: videoUrl?.substring(0, 50), videoDuration });
      const response = await fetch('/api/clipping/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId, videoUrl, videoDuration }),
      });

      console.log('[clipping] Analyze response:', response.status, response.statusText);
      if (!response.ok || !response.body) {
        const errText = await response.text().catch(() => '');
        throw new Error(`Failed to start analysis: ${response.status} ${errText}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        let eventType = '';
        for (const line of lines) {
          if (line.startsWith('event: ')) {
            eventType = line.slice(7);
          } else if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));
              if (eventType === 'progress') {
                setClippingProcessSteps(prev =>
                  prev.map(s => {
                    if (s.label === data.step) {
                      const pct = data.progress || 0;
                      return { ...s, status: data.status, progress: pct };
                    }
                    return s;
                  })
                );
              } else if (eventType === 'complete') {
                // Analysis done — now generate clips
                startClipGeneration(projectId);
              } else if (eventType === 'error') {
                console.error('Analysis error:', data.error);
                setClippingProcessSteps(prev =>
                  prev.map(s => s.status === 'active' ? { ...s, status: 'pending' } : s)
                );
              }
            } catch { /* skip malformed */ }
          }
        }
      }
    } catch (err) {
      console.error('Error in clipping analysis:', err);
      const msg = err instanceof Error ? err.message : 'Unknown error';
      setClippingProcessSteps(prev =>
        prev.map(s => s.status === 'active' ? { ...s, detail: `Error: ${msg}` } : s)
      );
    }
  };

  const startClipGeneration = async (projectId: string) => {
    setClippingProcessSteps(prev => [
      ...prev.map(s => ({ ...s, status: 'done' as const })),
      { label: 'Selecting clips', status: 'active' as const },
      { label: 'Cutting clips', status: 'pending' as const },
    ]);

    try {
      const response = await fetch('/api/clipping/generate-clips', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId, clipLength: clippingClipLength }),
      });

      if (!response.ok || !response.body) {
        throw new Error('Failed to start clip generation');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        let eventType = '';
        for (const line of lines) {
          if (line.startsWith('event: ')) {
            eventType = line.slice(7);
          } else if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));
              if (eventType === 'progress') {
                setClippingProcessSteps(prev =>
                  prev.map(s => {
                    if (s.label === data.step) {
                      const detail = data.total
                        ? `${data.completed || 0}/${data.total} clips`
                        : undefined;
                      return { ...s, status: data.status, progress: data.progress, detail };
                    }
                    return s;
                  })
                );
              } else if (eventType === 'complete') {
                // Fetch generated clips and show clips view
                const clipsRes = await fetch(`/api/clipping/clips?projectId=${projectId}`);
                const clipsData = await clipsRes.json();
                if (clipsData.clips) {
                  setClippingGeneratedClips(clipsData.clips);
                  setClippingSelectedClipIdx(0);
                  setClippingStep('clips');
                }
              } else if (eventType === 'error') {
                console.error('Clip generation error:', data.error);
              }
            } catch { /* skip malformed */ }
          }
        }
      }
    } catch (err) {
      console.error('Error in clip generation:', err);
    }
  };

  const deleteClippingProject = async (id: string) => {
    try {
      await fetch(`/api/clipping/projects/${id}`, { method: 'DELETE' });
      setClippingProjects(prev => prev.filter(p => p.id !== id));
    } catch (err) {
      console.error('Error deleting clipping project:', err);
    }
  };

  // Render
  return showNewProjectModal ? (
    /* New Project Flow */
    <div className="flex flex-col items-center min-h-screen px-4">
      {/* Back button */}
      <div className="fixed top-4 left-20 z-10">
        <button
          onClick={() => {
            if (clippingStep === 'configure' || clippingStep === 'processing') {
              setClippingStep(clippingStep === 'processing' ? 'configure' : 'upload');
            } else {
              setShowNewProjectModal(false);
              setClippingStep('upload');
              setClippingFile(null);
              setClippingUploadProgress(0);
            }
          }}
          className="flex items-center gap-2 text-[#888] hover:text-white transition"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          <span className="text-sm font-medium">{clippingStep === 'upload' ? 'Back to projects' : 'Back'}</span>
        </button>
      </div>

      {clippingStep === 'upload' ? (
        /* Step 1: Upload */
        <div className="w-full max-w-2xl space-y-6 mt-32">
          {/* Video link input */}
          <div className="flex items-center bg-[#141414] border border-[#1f1f1f] rounded-xl px-4 py-3 gap-3 focus-within:border-blue-500 transition">
            <svg className="w-5 h-5 text-[#555] flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
            </svg>
            <input
              type="text"
              value={newProjectTitle}
              onChange={e => setNewProjectTitle(e.target.value)}
              placeholder="Drop a video link"
              className="flex-1 bg-transparent text-white placeholder-[#555] focus:outline-none text-sm"
              onKeyDown={e => {
                if (e.key === 'Enter' && newProjectTitle) {
                  setClippingFile({ name: newProjectTitle, size: 0, type: 'link' });
                  setClippingUploadProgress(100);
                  setClippingStep('configure');
                }
              }}
            />
            <button
              onClick={() => {
                if (newProjectTitle) {
                  setClippingFile({ name: newProjectTitle, size: 0, type: 'link' });
                  setClippingUploadProgress(100);
                  setClippingStep('configure');
                }
              }}
              className="px-5 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 transition font-medium flex-shrink-0"
            >
              Continue
            </button>
          </div>

          {/* Upload area */}
          <label
            className="block border-2 border-dashed border-[#1f1f1f] rounded-2xl py-20 cursor-pointer hover:border-blue-500/50 transition-colors group"
            onDragOver={e => { e.preventDefault(); e.currentTarget.classList.add('border-blue-500', 'bg-blue-500/5'); }}
            onDragLeave={e => { e.currentTarget.classList.remove('border-blue-500', 'bg-blue-500/5'); }}
            onDrop={e => {
              e.preventDefault();
              e.currentTarget.classList.remove('border-blue-500', 'bg-blue-500/5');
              const file = e.dataTransfer.files?.[0];
              if (file && (file.type.startsWith('video/') || file.type.startsWith('audio/'))) {
                const name = file.name.replace(/\.[^.]+$/, '');
                setNewProjectTitle(name);
                setClippingFile({ name: file.name, size: file.size, type: file.type, rawFile: file });
                // Get video duration
                const el = document.createElement('video');
                el.preload = 'metadata';
                el.onloadedmetadata = () => { setClippingVideoDuration(el.duration); URL.revokeObjectURL(el.src); };
                el.src = URL.createObjectURL(file);
                // Simulate upload progress
                setClippingUploadProgress(0);
                let p = 0;
                const iv = setInterval(() => { p += Math.random() * 30 + 10; if (p >= 100) { p = 100; clearInterval(iv); setTimeout(() => setClippingStep('configure'), 300); } setClippingUploadProgress(Math.min(p, 100)); }, 200);
              }
            }}
          >
            <input
              type="file"
              accept="video/*,audio/*"
              className="hidden"
              onChange={e => {
                const file = e.target.files?.[0];
                if (file) {
                  const name = file.name.replace(/\.[^.]+$/, '');
                  setNewProjectTitle(name);
                  setClippingFile({ name: file.name, size: file.size, type: file.type, rawFile: file });
                  // Get video duration
                  const el = document.createElement('video');
                  el.preload = 'metadata';
                  el.onloadedmetadata = () => { setClippingVideoDuration(el.duration); URL.revokeObjectURL(el.src); };
                  el.src = URL.createObjectURL(file);
                  setClippingUploadProgress(0);
                  let p = 0;
                  const iv = setInterval(() => { p += Math.random() * 30 + 10; if (p >= 100) { p = 100; clearInterval(iv); setTimeout(() => setClippingStep('configure'), 300); } setClippingUploadProgress(Math.min(p, 100)); }, 200);
                }
              }}
            />
            <div className="flex flex-col items-center gap-4">
              <div className="w-16 h-14 bg-blue-600/20 rounded-xl flex items-center justify-center">
                <svg className="w-8 h-8 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                </svg>
              </div>
              <div className="text-center">
                <p className="text-gray-300">
                  <span className="text-blue-400 font-medium group-hover:text-blue-300 transition">Click to browse</span>
                  {' '}or drag & drop
                </p>
                <p className="text-[#555] text-sm mt-1">
                  Supported file type: video, audio
                </p>
              </div>
            </div>
          </label>

          {/* Upload progress (shown when uploading) */}
          {clippingFile && clippingUploadProgress > 0 && clippingUploadProgress < 100 && (
            <div className="bg-[#141414] border border-[#1f1f1f] rounded-xl px-4 py-3">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-[#1a1a1a] rounded-lg flex items-center justify-center flex-shrink-0">
                  <svg className="w-5 h-5 text-[#888]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                  </svg>
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-white truncate">{clippingFile.name}</p>
                  <div className="w-full bg-[#1a1a1a] rounded-full h-1.5 mt-1.5">
                    <div className="bg-blue-500 h-1.5 rounded-full transition-all" style={{ width: `${clippingUploadProgress}%` }} />
                  </div>
                  <p className="text-xs text-[#555] mt-1">Uploading...{Math.round(clippingUploadProgress)}%</p>
                </div>
              </div>
            </div>
          )}
        </div>
      ) : clippingStep === 'configure' ? (
        /* Step 2: Configure */
        <div className="w-full max-w-3xl mt-16 space-y-6">
          {/* Upload status bar */}
          {clippingFile && (
            <div className="flex items-center justify-center">
              <div className="bg-[#141414] border border-[#1f1f1f] rounded-xl px-4 py-3 flex items-center gap-3 max-w-lg w-full">
                <div className="w-12 h-9 bg-[#1a1a1a] rounded-lg flex items-center justify-center flex-shrink-0 overflow-hidden">
                  <svg className="w-5 h-5 text-[#888]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                  </svg>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm text-white truncate">{clippingFile.name}</p>
                    {clippingFile.type !== 'link' && (
                      <span className="text-xs bg-[#1a1a1a] text-gray-300 px-1.5 py-0.5 rounded flex-shrink-0">1080p</span>
                    )}
                  </div>
                  <div className="w-full bg-[#1a1a1a] rounded-full h-1 mt-1.5">
                    <div className="bg-green-500 h-1 rounded-full" style={{ width: '100%' }} />
                  </div>
                </div>
                <button
                  onClick={() => { setClippingStep('upload'); setClippingFile(null); setClippingUploadProgress(0); }}
                  className="text-[#555] hover:text-gray-300 transition flex-shrink-0"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            </div>
          )}

          {/* Ratio & Clip Length */}
          <div className="flex gap-4">
            <div className="flex-1 bg-[#141414] border border-[#1f1f1f] rounded-xl px-4 py-3 flex items-center justify-between">
              <span className="text-sm text-[#888]">Ratio</span>
              <select
                value={clippingRatio}
                onChange={e => setClippingRatio(e.target.value)}
                className="bg-transparent text-white text-sm font-medium focus:outline-none cursor-pointer"
              >
                <option value="9:16" className="bg-[#141414]">9:16</option>
                <option value="16:9" className="bg-[#141414]">16:9</option>
                <option value="1:1" className="bg-[#141414]">1:1</option>
              </select>
            </div>
            <div className="flex-1 bg-[#141414] border border-[#1f1f1f] rounded-xl px-4 py-3 flex items-center justify-between">
              <span className="text-sm text-[#888]">Clip length</span>
              <select
                value={clippingClipLength}
                onChange={e => setClippingClipLength(e.target.value)}
                className="bg-transparent text-white text-sm font-medium focus:outline-none cursor-pointer"
              >
                <option value="15s-30s" className="bg-[#141414]">15s-30s</option>
                <option value="30s-60s" className="bg-[#141414]">30s-60s</option>
                <option value="60s-90s" className="bg-[#141414]">60s-90s</option>
                <option value="90s-180s" className="bg-[#141414]">90s-3min</option>
              </select>
            </div>
          </div>

          {/* Template Section */}
          <div className="bg-[#111] border border-[#1f1f1f] rounded-2xl p-6">
            <div className="flex items-center gap-6 mb-5 border-b border-[#1f1f1f] pb-3">
              <span className="text-sm font-medium text-blue-400 border-b-2 border-blue-400 pb-3 -mb-3.5">9:16 template</span>
            </div>

            {/* Template cards */}
            <div className="flex gap-4 overflow-x-auto pb-2">
              <div className="flex flex-col items-center gap-2 flex-shrink-0">
                <div className="w-32 h-56 bg-gradient-to-br from-[#1a1a1a] to-[#111] rounded-xl border-2 border-blue-500 flex items-center justify-center relative overflow-hidden">
                  <div className="absolute top-2 right-2 w-5 h-5 bg-blue-500 rounded-full flex items-center justify-center">
                    <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                    </svg>
                  </div>
                  <div className="text-center px-3">
                    <div className="text-[10px] text-gray-300 bg-black/60 rounded px-2 py-1 mb-8">Your video title is here</div>
                    <div className="text-[10px] text-blue-300 bg-blue-900/40 rounded px-2 py-1">Here is my subtitle</div>
                  </div>
                </div>
                <span className="text-sm text-blue-400 font-medium">Default</span>
              </div>
            </div>
          </div>

          {/* Options checkboxes */}
          <div className="bg-[#111] border border-[#1f1f1f] rounded-2xl px-6 py-4">
            <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
              <label className="flex items-center gap-2 cursor-pointer group">
                <input type="checkbox" checked={clippingAddEmoji} onChange={e => setClippingAddEmoji(e.target.checked)}
                  className="w-4 h-4 rounded border-[#333] bg-[#1a1a1a] text-blue-500 focus:ring-blue-500 focus:ring-offset-0 cursor-pointer" />
                <span className="text-sm text-gray-300 group-hover:text-white transition">Add emoji</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer group">
                <input type="checkbox" checked={clippingHighlightKeywords} onChange={e => setClippingHighlightKeywords(e.target.checked)}
                  className="w-4 h-4 rounded border-[#333] bg-[#1a1a1a] text-blue-500 focus:ring-blue-500 focus:ring-offset-0 cursor-pointer" />
                <span className="text-sm text-gray-300 group-hover:text-white transition">Highlight keywords</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer group">
                <input type="checkbox" checked={clippingRemoveSilences} onChange={e => setClippingRemoveSilences(e.target.checked)}
                  className="w-4 h-4 rounded border-[#333] bg-[#1a1a1a] text-blue-500 focus:ring-blue-500 focus:ring-offset-0 cursor-pointer" />
                <span className="text-sm text-gray-300 group-hover:text-white transition">Remove silences</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer group">
                <input type="checkbox" checked={clippingAddBrolls} onChange={e => setClippingAddBrolls(e.target.checked)}
                  className="w-4 h-4 rounded border-[#333] bg-[#1a1a1a] text-blue-500 focus:ring-blue-500 focus:ring-offset-0 cursor-pointer" />
                <span className="text-sm text-gray-300 group-hover:text-white transition">Add B-rolls</span>
              </label>
            </div>
          </div>

          {/* Find clip moment */}
          <div className="bg-[#111] border border-[#1f1f1f] rounded-2xl px-6 py-4">
            <p className="text-sm text-[#888] mb-2">Find clip moment (optional)</p>
            <input
              type="text"
              value={clippingFindMoment}
              onChange={e => setClippingFindMoment(e.target.value)}
              placeholder="Only want specific parts? Type for example: when Sam talks about GPT-5."
              className="w-full bg-transparent text-white placeholder-[#444] text-sm focus:outline-none"
            />
          </div>

          {/* Generate button */}
          <button
            onClick={async () => {
              setClippingProcessSteps([
                { label: 'Upload', status: clippingFile?.rawFile ? 'active' : 'done' },
                { label: 'Create project', status: clippingFile?.rawFile ? 'pending' : 'active' },
                { label: 'Process video', status: 'pending' },
                { label: 'Finding best parts', status: 'pending' },
                { label: 'Edit clips', status: 'pending' },
                { label: 'Finalize', status: 'pending' },
              ]);
              setClippingStep('processing');

              try {
                // Step 1: Upload file first (if local file)
                let videoUrl: string;
                const tempId = crypto.randomUUID();

                if (clippingFile?.rawFile) {
                  const formData = new FormData();
                  formData.append('file', clippingFile.rawFile);
                  formData.append('projectId', tempId);

                  const uploadData = await new Promise<{ url: string }>((resolve, reject) => {
                    const xhr = new XMLHttpRequest();
                    xhr.open('POST', '/api/clipping/upload');
                    xhr.upload.onprogress = (e) => {
                      if (e.lengthComputable) {
                        const pct = Math.round((e.loaded / e.total) * 100);
                        setClippingProcessSteps(prev =>
                          prev.map(s => s.label === 'Upload' ? { ...s, detail: `${pct}%`, progress: pct } : s)
                        );
                      }
                    };
                    xhr.onload = () => {
                      if (xhr.status >= 200 && xhr.status < 300) {
                        resolve(JSON.parse(xhr.responseText));
                      } else {
                        reject(new Error(`Upload failed: ${xhr.status} ${xhr.responseText}`));
                      }
                    };
                    xhr.onerror = () => reject(new Error('Upload network error'));
                    xhr.send(formData);
                  });

                  videoUrl = uploadData.url;
                  setClippingProcessSteps(prev =>
                    prev.map(s => {
                      if (s.label === 'Upload') return { ...s, status: 'done', detail: undefined };
                      if (s.label === 'Create project') return { ...s, status: 'active' };
                      return s;
                    })
                  );
                } else if (newProjectTitle.match(/(?:youtube\.com|youtu\.be)/i)) {
                  // YouTube URL — download via yt-dlp with SSE progress
                  setClippingProcessSteps(prev =>
                    prev.map(s => s.label === 'Upload' ? { ...s, status: 'active', detail: 'Fetching video info...' } : s)
                  );
                  const ytTempId = crypto.randomUUID();
                  const ytRes = await fetch('/api/clipping/download-yt', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ projectId: ytTempId, url: newProjectTitle }),
                  });

                  if (!ytRes.ok || !ytRes.body) {
                    const errData = await ytRes.json().catch(() => ({}));
                    throw new Error(errData.error || 'YouTube download failed');
                  }

                  // Read SSE stream for progress
                  const ytResult = await new Promise<{ url: string; title?: string; duration?: number }>((resolve, reject) => {
                    const reader = ytRes.body!.getReader();
                    const decoder = new TextDecoder();
                    let buf = '';

                    const read = async () => {
                      while (true) {
                        const { done, value } = await reader.read();
                        if (done) { reject(new Error('Stream ended without result')); return; }
                        buf += decoder.decode(value, { stream: true });
                        const lines = buf.split('\n');
                        buf = lines.pop() || '';
                        let evtType = '';
                        for (const line of lines) {
                          if (line.startsWith('event: ')) evtType = line.slice(7);
                          else if (line.startsWith('data: ')) {
                            try {
                              const d = JSON.parse(line.slice(6));
                              if (evtType === 'progress') {
                                setClippingProcessSteps(prev =>
                                  prev.map(s => s.label === 'Upload' ? {
                                    ...s, status: 'active',
                                    detail: d.message || 'Downloading...',
                                    progress: d.percent,
                                  } : s)
                                );
                                if (d.title) setNewProjectTitle(d.title);
                                if (d.duration) setClippingVideoDuration(d.duration);
                              } else if (evtType === 'complete') {
                                resolve(d);
                                return;
                              } else if (evtType === 'error') {
                                reject(new Error(d.error || 'Download failed'));
                                return;
                              }
                            } catch { /* skip */ }
                          }
                        }
                      }
                    };
                    read();
                  });

                  videoUrl = ytResult.url;
                  if (ytResult.duration) setClippingVideoDuration(ytResult.duration);
                  if (ytResult.title) setNewProjectTitle(ytResult.title);
                } else {
                  videoUrl = newProjectTitle;
                }

                // Step 2: Create project (only after upload succeeds)
                const res = await fetch('/api/clipping/projects', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ title: newProjectTitle || 'Untitled' }),
                });
                const data = await res.json();
                if (!data.project) throw new Error('Failed to create project');

                const projectId = data.project.id;
                setClippingProjects(prev => [data.project, ...prev]);
                setClippingCurrentProjectId(projectId);
                setClippingProcessSteps(prev =>
                  prev.map(s => {
                    if (s.label === 'Create project') return { ...s, status: 'done' };
                    if (s.label === 'Process video') return { ...s, status: 'active' };
                    return s;
                  })
                );

                // Step 3: Start analysis via SSE
                console.log('[clipping] Starting analysis:', { projectId, videoUrl: videoUrl?.substring(0, 80), duration: clippingVideoDuration });
                setClippingProcessSteps(prev =>
                  prev.map(s => s.label === 'Process video' ? { ...s, detail: `Analyzing ${Math.round(clippingVideoDuration || 0)}s video...` } : s)
                );
                await startClippingAnalysis(projectId, videoUrl, clippingVideoDuration);

              } catch (err) {
                console.error('Error in clipping pipeline:', err);
                const msg = err instanceof Error ? err.message : 'Unknown error';
                setClippingProcessSteps(prev =>
                  prev.map(s => s.status === 'active'
                    ? { ...s, status: 'pending', detail: `Error: ${msg}` }
                    : s)
                );
              }
            }}
            className="w-full py-3.5 bg-gradient-to-r from-blue-600 to-blue-500 text-white rounded-xl hover:from-blue-700 hover:to-blue-600 transition font-semibold text-base"
          >
            Generate Clips
          </button>
        </div>
      ) : clippingStep === 'processing' ? (
        /* Step 3: Processing */
        <div className="w-full max-w-4xl mt-16 flex gap-8">
          {/* Left: Progress */}
          <div className="flex-1 space-y-8">
            {/* Upload status bar */}
            {clippingFile && (
              <div className="bg-[#141414] border border-[#1f1f1f] rounded-xl px-4 py-3 flex items-center gap-3 max-w-lg">
                <div className="w-12 h-9 bg-[#1a1a1a] rounded-lg flex items-center justify-center flex-shrink-0">
                  <svg className="w-5 h-5 text-[#888]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                  </svg>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm text-white truncate">{clippingFile.name}</p>
                    {clippingFile.type !== 'link' && (
                      <span className="text-xs bg-[#1a1a1a] text-gray-300 px-1.5 py-0.5 rounded flex-shrink-0">1080p</span>
                    )}
                  </div>
                  <p className="text-xs text-[#555] mt-1 flex items-center gap-1.5">
                    Upload successful
                    <svg className="w-4 h-4 text-green-500" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                    </svg>
                  </p>
                </div>
              </div>
            )}

            {/* Analysis status */}
            <div>
              <div className="text-2xl mb-1">&#x2728;</div>
              <h2 className="text-xl font-bold text-white mb-1">Analyzing content and finding clips</h2>
              <p className="text-sm text-[#888]">
                You can safely leave this page. We&apos;ll notify you when clips are ready.
              </p>
            </div>

            {/* Progress steps */}
            <div className="space-y-3">
              {clippingProcessSteps.map((step, i) => (
                <div key={i} className="flex items-center gap-3">
                  {step.status === 'done' ? (
                    <svg className="w-5 h-5 text-green-500 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                    </svg>
                  ) : step.status === 'active' ? (
                    <div className="w-5 h-5 flex-shrink-0 flex items-center justify-center">
                      <div className="w-4 h-4 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
                    </div>
                  ) : (
                    <div className="w-5 h-5 rounded-full border-2 border-[#333] flex-shrink-0" />
                  )}
                  <div className="flex flex-col">
                    <span className={`text-sm ${
                      step.status === 'done' ? 'text-white' :
                      step.status === 'active' ? 'text-white font-medium' :
                      'text-[#444]'
                    }`}>
                      {step.label}{step.status === 'active' && step.progress != null ? `...${step.progress}%` : ''}
                    </span>
                    {step.detail && (
                      <span className={`text-xs mt-0.5 ${step.detail.startsWith('Error') ? 'text-red-400' : 'text-[#555]'}`}>{step.detail}</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Right: Info panel */}
          <div className="hidden lg:block w-80 flex-shrink-0">
            <div className="bg-[#111] border border-[#1f1f1f] rounded-2xl p-6">
              <p className="text-xs text-[#555] uppercase tracking-wider mb-1">How it works</p>
              <h3 className="text-lg font-bold text-white mb-4">Turn long videos into shorts in a click</h3>
              <div className="bg-[#0a0a0a] rounded-xl h-48 flex items-center justify-center mb-4">
                <svg className="w-12 h-12 text-[#333]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
              <p className="text-sm text-[#888]">
                Our AI will transcribe and analyze your video to find the best parts and create professional-looking clips, ready to share.
              </p>
            </div>
          </div>
        </div>
      ) : clippingStep === 'clips' ? (
        /* Step 4: Clips Results */
        <div className="w-full max-w-6xl mt-8 flex gap-0 h-[calc(100vh-8rem)]">
          {/* Left sidebar: clip list */}
          <div className="w-56 flex-shrink-0 border-r border-[#1a1a1a] overflow-y-auto pr-2 space-y-1">
            <div className="flex items-center justify-between px-2 mb-3">
              <button
                onClick={() => { setShowNewProjectModal(false); setClippingStep('upload'); setClippingFile(null); }}
                className="text-sm text-[#888] hover:text-white flex items-center gap-1"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                </svg>
                Back
              </button>
              <span className="text-xs text-[#555]">{clippingGeneratedClips.length} clips</span>
            </div>
            {clippingGeneratedClips.map((clip, i) => (
              <button
                key={clip.id}
                onClick={() => setClippingSelectedClipIdx(i)}
                className={`w-full flex items-center gap-2.5 px-2 py-2 rounded-lg text-left transition-all ${
                  i === clippingSelectedClipIdx
                    ? 'bg-blue-600/20 border border-blue-500/40'
                    : 'hover:bg-[#141414] border border-transparent'
                }`}
              >
                <div className="relative w-14 h-10 bg-[#111] rounded-md overflow-hidden flex-shrink-0">
                  <img
                    src={`/api/clipping/serve?clipId=${clip.id}&type=thumbnail`}
                    alt=""
                    className="w-full h-full object-cover"
                    onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }}
                  />
                  <span className="absolute bottom-0 right-0 text-[9px] bg-black/70 text-gray-300 px-1 rounded-tl">
                    {Math.floor(clip.duration_sec / 60)}:{String(Math.floor(clip.duration_sec % 60)).padStart(2, '0')}
                  </span>
                </div>
                <div className="flex-1 min-w-0">
                  <p className={`text-xs truncate ${i === clippingSelectedClipIdx ? 'text-white' : 'text-gray-300'}`}>
                    {clip.title}
                  </p>
                  <div className="flex items-center gap-1 mt-0.5">
                    <span className="text-[10px] text-yellow-400 font-medium">{clip.score}/10</span>
                  </div>
                </div>
                <span className="text-xs text-[#444] font-mono flex-shrink-0">#{i + 1}</span>
              </button>
            ))}
          </div>

          {/* Main: selected clip detail */}
          {clippingGeneratedClips[clippingSelectedClipIdx] && (() => {
            const clip = clippingGeneratedClips[clippingSelectedClipIdx];
            return (
              <div className="flex-1 overflow-y-auto pl-6">
                {/* Header */}
                <div className="flex items-start justify-between mb-4">
                  <div>
                    <h2 className="text-xl font-bold text-white">{clip.title}</h2>
                    <div className="flex items-center gap-3 mt-1">
                      <span className="text-sm text-[#888]">
                        #{clippingSelectedClipIdx + 1}
                      </span>
                      <span className="text-sm text-[#555]">&bull;</span>
                      <span className="text-sm text-[#888]">
                        {Math.floor(clip.start_sec / 60)}:{String(Math.floor(clip.start_sec % 60)).padStart(2, '0')} &ndash; {Math.floor(clip.end_sec / 60)}:{String(Math.floor(clip.end_sec % 60)).padStart(2, '0')}
                      </span>
                    </div>
                  </div>
                  <div className="text-center">
                    <div className="text-3xl font-black text-white">{clip.score.toFixed(1)}</div>
                    <div className="text-xs text-[#555]">/10</div>
                  </div>
                </div>

                {/* Video preview */}
                <div className="relative bg-black rounded-xl overflow-hidden mb-4" style={{ aspectRatio: '16/9', maxHeight: '360px' }}>
                  {clip.status === 'done' ? (
                    <video
                      key={clip.id}
                      controls
                      className="w-full h-full object-contain"
                      src={`/api/clipping/serve?clipId=${clip.id}&type=video`}
                      poster={`/api/clipping/serve?clipId=${clip.id}&type=thumbnail`}
                    />
                  ) : (
                    <div className="absolute inset-0 flex items-center justify-center text-[#555]">
                      {clip.status === 'cutting' ? 'Cutting...' : clip.status === 'error' ? 'Error' : 'Pending'}
                    </div>
                  )}
                </div>

                {/* Action buttons */}
                <div className="flex items-center gap-3 mb-6">
                  {clip.status === 'done' && (
                    <a
                      href={`/api/clipping/serve?clipId=${clip.id}&type=video`}
                      download
                      className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition text-sm font-medium"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                      </svg>
                      Download
                    </a>
                  )}
                  {clip.file_size_bytes && (
                    <span className="text-xs text-[#555]">
                      {(clip.file_size_bytes / 1e6).toFixed(1)} MB
                    </span>
                  )}
                </div>

                {/* Description */}
                {clip.description && (
                  <div className="bg-[#111] border border-[#1f1f1f] rounded-xl px-5 py-4 mb-4">
                    <p className="text-sm text-gray-300">{clip.description}</p>
                  </div>
                )}

                {/* Transcript */}
                {clip.transcript && (
                  <div className="mb-6">
                    <h3 className="text-sm font-medium text-[#888] mb-2">Transcript</h3>
                    <p className="text-sm text-gray-300 leading-relaxed whitespace-pre-wrap">
                      {clip.transcript}
                    </p>
                  </div>
                )}
              </div>
            );
          })()}
        </div>
      ) : null}
    </div>
  ) : (
    /* Projects List */
    <div className="container mx-auto px-4 py-8 max-w-7xl">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-4xl font-bold text-white mb-2 bg-gradient-to-r from-blue-400 to-cyan-400 bg-clip-text text-transparent">
            Clipping
          </h1>
          <p className="text-[#888]">
            Upload videos and let AI create clips for you
          </p>
        </div>
        <div className="flex gap-3">
          <button
            className="px-4 py-2.5 bg-[#141414] text-gray-300 rounded-xl border border-[#1f1f1f] hover:bg-[#1a1a1a] hover:text-white transition-all flex items-center gap-2"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
            </svg>
            New folder
          </button>
          <button
            onClick={() => { setNewProjectTitle(''); setShowNewProjectModal(true); }}
            className="px-4 py-2.5 bg-blue-600 text-white rounded-xl hover:bg-blue-700 transition-all flex items-center gap-2 font-medium"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            New project
          </button>
        </div>
      </div>

      {/* Folders Section */}
      <div className="mb-8">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-white">Folders</h2>
          <span className="text-sm text-[#555]">0 folders</span>
        </div>
        <div className="text-[#444] text-sm py-4 border border-dashed border-[#1f1f1f] rounded-xl text-center">
          No folders yet
        </div>
      </div>

      {/* Projects Section */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-white">Projects</h2>
          <div className="flex items-center gap-4">
            <span className="text-sm text-[#555]">{clippingProjects.length} project{clippingProjects.length !== 1 ? 's' : ''}</span>
            <span className="text-sm text-[#444]">Last modified</span>
          </div>
        </div>

        {clippingLoading ? (
          <div className="flex items-center justify-center py-20">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500" />
          </div>
        ) : clippingProjects.length === 0 ? (
          <div className="text-center py-20">
            <div className="text-6xl mb-4">&#x2702;&#xFE0F;</div>
            <h3 className="text-xl font-semibold text-white mb-2">No projects yet</h3>
            <p className="text-[#888] mb-6">Create your first clipping project to get started</p>
            <button
              onClick={() => { setNewProjectTitle(''); setShowNewProjectModal(true); }}
              className="px-6 py-3 bg-blue-600 text-white rounded-xl hover:bg-blue-700 transition font-medium"
            >
              New project
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
            {clippingProjects.map((project) => (
              <div
                key={project.id}
                className="bg-[#141414] rounded-xl border border-[#1f1f1f] overflow-hidden hover:border-blue-500 transition-all group"
              >
                {/* Thumbnail */}
                <div className="aspect-video bg-[#0a0a0a] flex items-center justify-center relative cursor-pointer">
                  {project.thumbnail_url ? (
                    <img
                      src={project.thumbnail_url}
                      alt={project.title}
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <div className="text-4xl text-[#333]">&#x1F3AC;</div>
                  )}
                  {/* Duration badge */}
                  {project.video_duration && (
                    <span className="absolute bottom-2 right-2 bg-black/80 text-white text-xs px-1.5 py-0.5 rounded font-medium">
                      {Math.floor(project.video_duration / 60)}:{String(Math.floor(project.video_duration % 60)).padStart(2, '0')}
                    </span>
                  )}
                  {/* Status badge */}
                  <span className={`absolute top-2 right-2 text-xs px-2 py-0.5 rounded font-medium ${
                    project.status === 'done' ? 'bg-green-600/80 text-white' :
                    project.status === 'processing' ? 'bg-yellow-600/80 text-white' :
                    'bg-[#1a1a1a]/80 text-gray-300'
                  }`}>
                    {project.status === 'done' ? 'Done' : project.status === 'processing' ? 'Processing' : 'Draft'}
                  </span>
                </div>

                {/* Info */}
                <div className="p-4">
                  <p className="text-sm text-[#888]">
                    {new Date(project.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })} {new Date(project.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </p>
                  <h3 className="font-semibold text-white mt-1 truncate">
                    {project.title}
                  </h3>

                  {/* Actions */}
                  <div className="flex gap-2 mt-3 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button
                      onClick={async () => {
                        setClippingCurrentProjectId(project.id);
                        setClippingStep('clips');
                        setShowNewProjectModal(true);
                        try {
                          const res = await fetch(`/api/clipping/clips?projectId=${project.id}`);
                          const data = await res.json();
                          if (data.clips) setClippingGeneratedClips(data.clips);
                        } catch (err) {
                          console.error('Failed to load clips:', err);
                        }
                      }}
                      className="flex-1 px-3 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 transition"
                    >
                      Open
                    </button>
                    <button
                      onClick={() => deleteClippingProject(project.id)}
                      className="px-3 py-2 bg-red-600/20 text-red-400 text-sm rounded-lg hover:bg-red-600/40 transition"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
