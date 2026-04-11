'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';

interface Project {
  id: string;
  title: string;
  thumbnail: string | null;
  updatedAt: string;
}

export default function LibraryPage() {
  const router = useRouter();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchProjects = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/projects');
      const data = await res.json();
      setProjects(data.projects || []);
    } catch (err) { console.error('Library fetch error:', err); }
    setLoading(false);
  }, []);

  useEffect(() => { fetchProjects(); }, [fetchProjects]);

  const openProject = (id: string) => {
    router.push(`/generator/create?project=${id}`);
  };

  const deleteProject = async (id: string) => {
    if (!confirm('Delete this project?')) return;
    try {
      await fetch(`/api/projects/${id}`, { method: 'DELETE' });
      setProjects(prev => prev.filter(p => p.id !== id));
    } catch (err) { console.error('Delete error:', err); }
  };

  return (
    <div className="px-8 py-8 max-w-7xl mx-auto">
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white mb-1">Project Library</h1>
          <p className="text-sm text-[#888]">Browse and manage your saved projects</p>
        </div>
        <button
          onClick={() => router.push('/generator/create')}
          className="px-5 py-2.5 bg-purple-600 text-white rounded-xl hover:bg-purple-700 transition text-sm font-medium"
        >
          New Project
        </button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-purple-500" />
        </div>
      ) : projects.length === 0 ? (
        <div className="text-center py-20">
          <div className="text-6xl mb-4">📁</div>
          <h3 className="text-xl font-semibold text-white mb-2">No projects yet</h3>
          <p className="text-[#888] mb-6">Create your first project to get started</p>
          <button
            onClick={() => router.push('/generator/create')}
            className="px-6 py-3 bg-purple-600 text-white rounded-xl hover:bg-purple-700 transition"
          >
            Create New Project
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
          {projects.map((project) => (
            <div
              key={project.id}
              className="bg-[#141414] rounded-xl border border-[#1f1f1f] overflow-hidden hover:border-purple-500/60 transition-all group"
            >
              {/* Thumbnail */}
              <div
                className="aspect-video bg-[#0a0a0a] flex items-center justify-center cursor-pointer"
                onClick={() => openProject(project.id)}
              >
                {project.thumbnail ? (
                  <img src={project.thumbnail} alt={project.title} className="w-full h-full object-cover" />
                ) : (
                  <div className="text-4xl text-[#333]">🎬</div>
                )}
              </div>

              {/* Info */}
              <div className="p-4">
                <h3
                  className="font-semibold text-white truncate cursor-pointer hover:text-purple-400 transition"
                  onClick={() => openProject(project.id)}
                >
                  {project.title}
                </h3>
                <p className="text-sm text-[#888] mt-1">
                  {new Date(project.updatedAt).toLocaleDateString()} {new Date(project.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </p>

                {/* Actions */}
                <div className="flex gap-2 mt-3 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    onClick={() => openProject(project.id)}
                    className="flex-1 px-3 py-2 bg-purple-600 text-white text-sm rounded-lg hover:bg-purple-700 transition"
                  >
                    Open
                  </button>
                  <button
                    onClick={() => deleteProject(project.id)}
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
  );
}
