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

type Basis = '' | 'title_v2' | 'thumbnail_v2' | 'combined';

interface SimilarContextType {
  videoId: number;
  source: SimilarSource | null;
  all: SimilarVideo[];            // every candidate (any similarity)
  filtered: SimilarVideo[];       // all where similarity >= minSimilarity
  minSimilarity: number;
  setMinSimilarity: (v: number) => void;
  basis: Basis;
  setBasis: (b: Basis) => void;
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
  const [basis, setBasis] = useState<Basis>('');

  useEffect(() => {
    if (!videoId) return;
    setLoading(true);
    setError(null);
    const qs = new URLSearchParams({ videoId: String(videoId), limit: '500', minSimilarity: '0' });
    if (basis) qs.set('source', basis);
    fetch(`/api/niche-spy/similar?${qs}`)
      .then(r => r.json())
      .then((d: { source?: SimilarSource; similar?: SimilarVideo[]; error?: string; message?: string }) => {
        if (d.error) throw new Error(d.error);
        setSource(d.source || null);
        setAll(d.similar || []);
        if ((d.similar || []).length === 0 && d.message) setError(d.message);
      })
      .catch(err => setError((err as Error).message))
      .finally(() => setLoading(false));
  }, [videoId, basis]);

  const filtered = useMemo(
    () => all.filter(v => v.similarity >= minSimilarity),
    [all, minSimilarity]
  );

  const value = useMemo(() => ({
    videoId, source, all, filtered, minSimilarity, setMinSimilarity, basis, setBasis, loading, error,
  }), [videoId, source, all, filtered, minSimilarity, basis, loading, error]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
