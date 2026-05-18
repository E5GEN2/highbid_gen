'use client';

import React, { useEffect, useState } from 'react';
import { fmtYT } from '@/lib/format';
import { useSimilarModal } from '@/components/SimilarModal';
import { ChannelAgeChip } from '@/components/ChannelAgeChip';
import { StarButton, useFavourites } from '@/components/FavouritesProvider';
import { NicheClusterCard, type ClusterCardData } from '@/components/NicheClusterCard';
import { SimilarNichesModal } from '@/components/SimilarNichesModal';

interface FavVideo {
  id: number; keyword: string; url: string; title: string; view_count: number;
  channel_name: string; posted_date: string; posted_at: string; score: number;
  channel_created_at: string;
  // Per-target embedding flags so the Similar button can check the
  // right one for the active similarity source.
  embedded_at: string | null;                  // v1 legacy
  title_embedded_v2_at?: string | null;        // v2 title
  thumbnail_embedded_v2_at?: string | null;    // v2 thumbnail
  combined_embedded_v2_at?: string | null;     // v2 combined (joint title+thumb)
  subscriber_count: number; like_count: number; comment_count: number;
  thumbnail: string; first_upload_at?: string | null; dormancy_days?: number | null;
  added_at: string;
}

interface FavNiche extends ClusterCardData {
  addedAt: string;
}

type SimilaritySource = 'title_v1' | 'title_v2' | 'thumbnail_v2' | 'combined_v2';
function favHasSimilarEmbedding(v: FavVideo, source: SimilaritySource): boolean {
  switch (source) {
    case 'title_v2':     return !!v.title_embedded_v2_at;
    case 'thumbnail_v2': return !!v.thumbnail_embedded_v2_at;
    case 'combined_v2':  return !!v.combined_embedded_v2_at;
    default:             return !!v.embedded_at;
  }
}

type Tab = 'niches' | 'videos';

export default function FavouritesPage() {
  const { openSimilar } = useSimilarModal();
  // Read both video + niche favourite sets. The video set drives the
  // Videos tab refetch; the niche set drives the Niches tab refetch.
  const { count, nicheCount, ids, nicheIds } = useFavourites();
  const [tab, setTab] = useState<Tab>('niches');

  // Niches state
  const [niches, setNiches] = useState<FavNiche[]>([]);
  const [nichesLoading, setNichesLoading] = useState(true);
  const [similarSource, setSimilarSource] = useState<ClusterCardData | null>(null);

  // Videos state (unchanged from before)
  const [videos, setVideos] = useState<FavVideo[]>([]);
  const [videosLoading, setVideosLoading] = useState(true);
  const [similaritySource, setSimilaritySource] = useState<SimilaritySource>('combined_v2');

  // Re-fetch full niche rows whenever the global niche-favourites set
  // changes. We key the dep on `nicheIds` (the Set itself) so swaps
  // refresh too, not just count changes.
  useEffect(() => {
    let cancelled = false;
    setNichesLoading(true);
    fetch('/api/niche-spy/favourite-niches')
      .then(r => r.json())
      .then(d => {
        if (cancelled) return;
        setNiches(d.niches || []);
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setNichesLoading(false); });
    return () => { cancelled = true; };
  }, [nicheIds]);

  // Re-fetch full video rows whenever the global video-favourites set
  // changes.
  useEffect(() => {
    let cancelled = false;
    setVideosLoading(true);
    fetch('/api/niche-spy/favourites')
      .then(r => r.json())
      .then(d => {
        if (cancelled) return;
        setVideos(d.videos || []);
        if (d.similaritySource) setSimilaritySource(d.similaritySource);
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setVideosLoading(false); });
    return () => { cancelled = true; };
  }, [ids]);

  const timeAgo = (dateStr: string) => {
    const d = new Date(dateStr);
    const days = Math.floor((Date.now() - d.getTime()) / 86400000);
    if (days < 1) return 'Just now';
    if (days < 7) return `${days} days ago`;
    if (days < 30) return `${Math.floor(days / 7)} weeks ago`;
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  };

  const getThumb = (url: string | null | undefined, fallback: string) => {
    if (!fallback || fallback.includes('ytimg.com')) {
      const m = url?.match(/(?:youtu\.be\/|[?&]v=|\/shorts\/)([a-zA-Z0-9_-]{11})/);
      if (m) return `https://img.youtube.com/vi/${m[1]}/hqdefault.jpg`;
    }
    return fallback || '';
  };

  return (
    <div className="px-8 py-8 max-w-7xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white mb-1">Favourites</h1>
        <p className="text-sm text-[#888]">
          Niches and videos you&apos;ve starred. Tap the ⭐ on any niche card or video card to add or remove.
        </p>
      </div>

      {/* Tab switcher — niches first because niches are the bigger
          editorial surface. Counts are pulled from the provider so
          they update optimistically when the user stars/unstars. */}
      <div className="flex items-center gap-2 mb-6 border-b border-[#1f1f1f]">
        <TabPill
          active={tab === 'niches'}
          onClick={() => setTab('niches')}
          label="Niches"
          count={nicheCount}
        />
        <TabPill
          active={tab === 'videos'}
          onClick={() => setTab('videos')}
          label="Videos"
          count={count}
        />
      </div>

      {tab === 'niches' && (
        <NichesPanel
          niches={niches}
          loading={nichesLoading}
          openSimilar={(c) => setSimilarSource(c)}
        />
      )}

      {tab === 'videos' && (
        <VideosPanel
          videos={videos}
          loading={videosLoading}
          openSimilar={openSimilar}
          similaritySource={similaritySource}
          favHasSimilar={favHasSimilarEmbedding}
          getThumb={getThumb}
          timeAgo={timeAgo}
        />
      )}

      {/* Mounted at root so the similar-niches popup covers the
          whole page regardless of which tab spawned it. */}
      <SimilarNichesModal
        sourceCluster={similarSource}
        onClose={() => setSimilarSource(null)}
      />
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────
 *  Tab pill
 * ──────────────────────────────────────────────────────────────── */

function TabPill({ active, onClick, label, count }: {
  active: boolean; onClick: () => void; label: string; count: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`relative px-4 py-2.5 text-sm font-medium transition ${
        active
          ? 'text-white'
          : 'text-[#888] hover:text-white'
      }`}
    >
      <span className="flex items-center gap-2">
        {label}
        <span className={`text-[11px] px-1.5 py-0.5 rounded-full font-mono ${
          active ? 'bg-amber-500/20 text-amber-300' : 'bg-[#1f1f1f] text-[#888]'
        }`}>
          {count}
        </span>
      </span>
      {active && (
        <span className="absolute -bottom-px left-0 right-0 h-0.5 bg-amber-400 rounded-full" />
      )}
    </button>
  );
}

/* ─────────────────────────────────────────────────────────────────
 *  Niches tab
 * ──────────────────────────────────────────────────────────────── */

function NichesPanel({
  niches, loading, openSimilar,
}: {
  niches: FavNiche[]; loading: boolean;
  openSimilar: (c: ClusterCardData) => void;
}) {
  if (loading && niches.length === 0) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="bg-[#141414] border border-[#1f1f1f] rounded-xl p-4 animate-pulse">
            <div className="h-4 w-1/3 bg-[#1f1f1f] rounded mb-3" />
            <div className="grid grid-cols-4 gap-3">
              {[0,1,2,3].map(j => (
                <div key={j}>
                  <div className="aspect-video bg-[#1a1a1a] rounded-md" />
                  <div className="h-3 w-3/4 bg-[#1f1f1f] rounded mt-2" />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (!loading && niches.length === 0) {
    return (
      <div className="bg-[#141414] border border-dashed border-[#1f1f1f] rounded-xl px-6 py-16 text-center">
        <div className="text-5xl mb-3">⭐</div>
        <h3 className="text-base font-medium text-white mb-1">No niches starred yet</h3>
        <p className="text-sm text-[#666]">Browse the niches grid and tap the ⭐ next to the Similar button on any niche card.</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {niches.map(c => (
        <NicheClusterCard
          key={c.id}
          cluster={c}
          onFindSimilar={() => openSimilar(c)}
        />
      ))}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────
 *  Videos tab (extracted from the previous flat implementation)
 * ──────────────────────────────────────────────────────────────── */

function VideosPanel({
  videos, loading, openSimilar, similaritySource, favHasSimilar, getThumb, timeAgo,
}: {
  videos: FavVideo[];
  loading: boolean;
  openSimilar: (id: number) => void;
  similaritySource: SimilaritySource;
  favHasSimilar: (v: FavVideo, source: SimilaritySource) => boolean;
  getThumb: (url: string | null | undefined, fallback: string) => string;
  timeAgo: (s: string) => string;
}) {
  if (loading && videos.length === 0) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="bg-[#141414] border border-[#1f1f1f] rounded-xl overflow-hidden animate-pulse">
            <div className="aspect-video bg-[#1f1f1f]" />
            <div className="p-3 space-y-2">
              <div className="h-4 w-3/4 bg-[#1f1f1f] rounded" />
              <div className="h-3 w-1/2 bg-[#1f1f1f] rounded" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (!loading && videos.length === 0) {
    return (
      <div className="bg-[#141414] border border-dashed border-[#1f1f1f] rounded-xl px-6 py-16 text-center">
        <div className="text-5xl mb-3">⭐</div>
        <h3 className="text-base font-medium text-white mb-1">No videos starred yet</h3>
        <p className="text-sm text-[#666]">Browse any niche and tap the star icon on a video card to save it here.</p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {videos.map(v => (
        <div key={v.id} className="bg-[#141414] border border-[#1f1f1f] rounded-xl overflow-hidden hover:border-[#333] transition">
          <div className="relative aspect-video bg-[#0a0a0a]">
            {(() => {
              const t = getThumb(v.url, v.thumbnail);
              // eslint-disable-next-line @next/next/no-img-element
              return t ? <img src={t} alt="" className="w-full h-full object-cover" loading="lazy" /> : null;
            })()}
            <div className={`absolute top-2 right-2 px-2 py-0.5 rounded-full text-xs font-bold ${
              v.score >= 80 ? 'bg-green-500 text-white' : v.score >= 50 ? 'bg-yellow-500 text-black' : 'bg-red-500 text-white'
            }`}>⚡ {v.score}</div>
          </div>
          <div className="p-3">
            <div className="flex items-center justify-between mb-2 gap-2">
              {v.keyword && (
                <span className="text-xs bg-purple-600/30 text-purple-300 border border-purple-600/50 rounded-full px-2 py-0.5">
                  {v.keyword}
                </span>
              )}
              <div className="flex items-center gap-1.5 ml-auto">
                <StarButton videoId={v.id} />
                {favHasSimilar(v, similaritySource) && (
                  <button
                    onClick={() => openSimilar(v.id)}
                    className="flex items-center gap-1 text-xs bg-green-600/20 text-green-400 border border-green-600/40 px-2.5 py-1 rounded-full hover:bg-green-600/30 transition flex-shrink-0 font-medium"
                  >
                    Similar
                  </button>
                )}
              </div>
            </div>
            <h3 className="text-sm font-medium text-white line-clamp-2 mb-2">{v.title}</h3>
            <div className="flex items-center gap-2 text-xs text-[#888] mb-1.5 flex-wrap">
              <span className="text-green-400 font-medium">{v.view_count ? fmtYT(v.view_count) + ' views' : ''}</span>
              {v.channel_name && <span>· {v.channel_name}</span>}
              {(v.posted_at || v.posted_date) && <span>· {v.posted_at ? timeAgo(v.posted_at) : v.posted_date}</span>}
            </div>
            <div className="flex items-center gap-3 text-xs text-[#666] flex-wrap mb-2">
              {v.like_count > 0 && <span>👍 {fmtYT(v.like_count)}</span>}
              {v.comment_count > 0 && <span>💬 {fmtYT(v.comment_count)}</span>}
              {v.subscriber_count > 0 && <span>👥 {fmtYT(v.subscriber_count)} subscribers</span>}
              <ChannelAgeChip
                createdAt={v.channel_created_at}
                firstUploadAt={v.first_upload_at}
                dormancyDays={v.dormancy_days}
              />
            </div>
            {v.url && (
              <a href={v.url} target="_blank" rel="noopener noreferrer" className="text-xs text-blue-400 hover:text-blue-300 truncate block">
                {v.url}
              </a>
            )}
            <div className="text-[10px] text-[#555] mt-2">Starred {timeAgo(v.added_at)}</div>
          </div>
        </div>
      ))}
    </div>
  );
}
