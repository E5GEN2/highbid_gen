'use client';

import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';

/**
 * SimilarProvider — fetches the similar-video set once per videoId and shares
 * it with both the Videos tab and the Insights tab at /niche/similar/[videoId].
 * Keeping the fetch + the minSimilarity filter in one place means the two tabs
 * always see the same data and the min-match dropdown lives in the layout header.
 */

export interface SimilarVideo {
  id: number;
  title: string;
  url: string;
  viewCount: number;
  channelName: string;
  postedAt: string | null;
  postedDate: string | null;
  score: number;
  subscriberCount: number;
  likeCount: number;
  commentCount: number;
  topComment: string | null;
  thumbnail: string | null;
  keyword: string | null;
  channelCreatedAt: string | null;
  similarity: number;
}

export interface SimilarSource { id: number; title: string; keyword: string; }

interface SimilarContextType {
  videoId: number;
  source: SimilarSource | null;
  all: SimilarVideo[];            // every candidate (any similarity)
  filtered: SimilarVideo[];       // all where similarity >= minSimilarity
  minSimilarity: number;
  setMinSimilarity: (v: number) => void;
  loading: boolean;
  error: string | null;
}

const Ctx = createContext<SimilarContextType | null>(null);

export function useSimilar() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useSimilar must be used within SimilarProvider');
  return ctx;
}

export function SimilarProvider({ videoId, children }: { videoId: number; children: React.ReactNode }) {
  const [source, setSource] = useState<SimilarSource | null>(null);
  const [all, setAll] = useState<SimilarVideo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [minSimilarity, setMinSimilarity] = useState(0.7);

  useEffect(() => {
    if (!videoId) return;
    setLoading(true);
    setError(null);
    fetch(`/api/niche-spy/similar?videoId=${videoId}&limit=500&minSimilarity=0`)
      .then(r => r.json())
      .then((d: { source?: SimilarSource; similar?: SimilarVideo[]; error?: string }) => {
        if (d.error) throw new Error(d.error);
        setSource(d.source || null);
        setAll(d.similar || []);
      })
      .catch(err => setError((err as Error).message))
      .finally(() => setLoading(false));
  }, [videoId]);

  const filtered = useMemo(
    () => all.filter(v => v.similarity >= minSimilarity),
    [all, minSimilarity]
  );

  const value = useMemo(() => ({
    videoId, source, all, filtered, minSimilarity, setMinSimilarity, loading, error,
  }), [videoId, source, all, filtered, minSimilarity, loading, error]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
