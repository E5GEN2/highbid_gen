'use client';

import React, { useState, useCallback, useEffect } from 'react';
import { useParams } from 'next/navigation';
import { useNiche } from '@/components/NicheProvider';
import { fmtYT } from '@/lib/format';

interface NicheVideo {
  id: number; keyword: string; url: string; title: string; view_count: number;
  channel_name: string; posted_date: string; posted_at: string; score: number;
  channel_created_at: string; embedded_at: string | null;
  subscriber_count: number; like_count: number; comment_count: number;
  top_comment: string; thumbnail: string; fetched_at: string;
  _similarity?: number;
}

export default function NicheVideos() {
  const { keyword: rawKeyword } = useParams<{ keyword: string }>();
  const keyword = decodeURIComponent(rawKeyword);
  const { setSelectedKeyword, filter, setFilter } = useNiche();

  const [videos, setVideos] = useState<NicheVideo[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [offset, setOffset] = useState(0);

  // Similar modal state
  const [similarSource, setSimilarSource] = useState<{ id: number; title: string } | null>(null);
  const [similarVideos, setSimilarVideos] = useState<NicheVideo[]>([]);
  const [similarLoading, setSimilarLoading] = useState(false);
  const [similarMinScore, setSimilarMinScore] = useState(0.7);

  // Set keyword in context on mount
  useEffect(() => { setSelectedKeyword(keyword); }, [keyword, setSelectedKeyword]);

  const fetchVideos = useCallback(async (off = 0) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        keyword,
        minScore: String(filter.minScore),
        maxScore: String(filter.maxScore),
        sort: filter.sort,
        limit: '60',
        offset: String(off),
      });
      const res = await fetch(`/api/niche-spy?${params}`);
      const data = await res.json();
      if (off === 0) setVideos(data.videos);
      else setVideos(prev => [...prev, ...data.videos]);
      setTotal(data.total);
      setOffset(off + data.videos.length);
    } catch (err) { console.error('Video fetch error:', err); }
    setLoading(false);
  }, [keyword, filter]);

  useEffect(() => { fetchVideos(0); }, [fetchVideos]);

  const fetchSimilar = async (videoId: number, title: string) => {
    setSimilarSource({ id: videoId, title });
    setSimilarLoading(true);
    try {
      const res = await fetch(`/api/niche-spy/similar?videoId=${videoId}&limit=200&minSimilarity=${similarMinScore}`);
      const data = await res.json();
      setSimilarVideos((data.similar || []).map((v: Record<string, unknown>) => ({
        id: v.id as number, keyword: v.keyword as string, url: v.url as string, title: v.title as string,
        view_count: v.viewCount as number, channel_name: v.channelName as string,
        posted_date: v.postedDate as string, posted_at: v.postedAt as string,
        score: v.score as number, subscriber_count: v.subscriberCount as number,
        like_count: v.likeCount as number, comment_count: v.commentCount as number,
        top_comment: v.topComment as string, thumbnail: v.thumbnail as string,
        fetched_at: '', channel_created_at: '', embedded_at: null,
        _similarity: v.similarity as number,
      })));
    } catch (err) { console.error('Similar fetch error:', err); }
    setSimilarLoading(false);
  };

  const timeAgo = (dateStr: string) => {
    const d = new Date(dateStr);
    const diffMs = Date.now() - d.getTime();
    const hours = Math.floor(diffMs / 3600000);
    const days = Math.floor(diffMs / 86400000);
    if (hours < 1) return 'Just now';
    if (hours < 24) return `${hours} hours ago`;
    if (days < 7) return `${days} days ago`;
    if (days < 30) return `${Math.floor(days / 7)} weeks ago`;
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  };

  const getThumb = (url: string, thumb: string) => {
    const m = url?.match(/(?:youtu\.be\/|[?&]v=|\/shorts\/)([a-zA-Z0-9_-]{11})/);
    return m ? `https://img.youtube.com/vi/${m[1]}/hqdefault.jpg` : thumb;
  };

  return (
    <div className="px-8 py-8 max-w-7xl mx-auto">
      {/* Filters */}
      <div className="bg-[#141414] border border-[#1f1f1f] rounded-xl p-4 mb-6">
        {/* Sort pills */}
        <div className="flex gap-2 flex-wrap mb-3">
          {[
            { value: 'score', label: 'Score' },
            { value: 'views', label: 'Views' },
            { value: 'date', label: 'Newest' },
            { value: 'oldest', label: 'Oldest' },
            { value: 'likes', label: 'Likes' },
          ].map(opt => (
            <button
              key={opt.value}
              onClick={() => setFilter(prev => ({ ...prev, sort: opt.value }))}
              className={`px-4 py-1.5 rounded-full text-sm transition ${
                filter.sort === opt.value
                  ? 'bg-white text-black font-medium'
                  : 'text-[#888] border border-[#333] hover:border-[#555]'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
        {/* Score range */}
        <div className="flex gap-4 items-center text-sm text-[#888]">
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-[#666]">Min Score:</span>
            <input type="number" min={0} max={100} value={filter.minScore}
              onChange={e => setFilter(prev => ({ ...prev, minScore: parseInt(e.target.value) || 0 }))}
              className="w-16 bg-[#0a0a0a] border border-[#1f1f1f] rounded-lg px-2 py-1 text-white text-xs"
            />
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-[#666]">Max Score:</span>
            <input type="number" min={0} max={100} value={filter.maxScore}
              onChange={e => setFilter(prev => ({ ...prev, maxScore: parseInt(e.target.value) || 100 }))}
              className="w-16 bg-[#0a0a0a] border border-[#1f1f1f] rounded-lg px-2 py-1 text-white text-xs"
            />
          </div>
          <span className="text-sm font-medium text-white ml-auto">{total} videos</span>
        </div>
      </div>

      {/* Video grid */}
      {loading && videos.length === 0 ? (
        <div className="flex items-center justify-center py-20">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-amber-500" />
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {videos.map(v => (
              <div key={v.id} className="bg-[#141414] border border-[#1f1f1f] rounded-xl overflow-hidden hover:border-[#333] transition">
                {/* Thumbnail */}
                <div className="relative aspect-video bg-[#0a0a0a]">
                  {(() => {
                    const thumbUrl = getThumb(v.url, v.thumbnail);
                    return thumbUrl ? (
                      <img src={thumbUrl} alt="" className="w-full h-full object-cover" loading="lazy" />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-[#333]">
                        <svg className="w-12 h-12" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                        </svg>
                      </div>
                    );
                  })()}
                  <div className={`absolute top-2 right-2 px-2 py-0.5 rounded-full text-xs font-bold ${
                    v.score >= 80 ? 'bg-green-500 text-white' : v.score >= 50 ? 'bg-yellow-500 text-black' : 'bg-red-500 text-white'
                  }`}>
                    {v.score}
                  </div>
                </div>

                <div className="p-3">
                  {v.keyword && (
                    <span className="inline-block text-xs bg-amber-600/20 text-amber-300 border border-amber-600/30 rounded-full px-2 py-0.5 mb-2">
                      {v.keyword}
                    </span>
                  )}
                  <h3 className="text-sm font-medium text-white line-clamp-2 mb-2">{v.title}</h3>
                  <div className="flex items-center gap-2 text-xs text-[#888] mb-1.5">
                    <span className="text-green-400 font-medium">{v.view_count ? fmtYT(v.view_count) + ' views' : ''}</span>
                    {v.channel_name && <span>· {v.channel_name}</span>}
                    {(v.posted_at || v.posted_date) && <span>· {v.posted_at ? timeAgo(v.posted_at) : v.posted_date}</span>}
                  </div>
                  <div className="flex items-center gap-3 text-xs text-[#666] mb-2">
                    {v.like_count > 0 && <span>{fmtYT(v.like_count)} likes</span>}
                    {v.comment_count > 0 && <span>{fmtYT(v.comment_count)} comments</span>}
                    {v.subscriber_count > 0 && <span>{fmtYT(v.subscriber_count)} subs</span>}
                  </div>
                  {v.top_comment && (
                    <p className="text-xs text-[#666] italic line-clamp-2 border-l-2 border-[#333] pl-2 mb-2">
                      &ldquo;{v.top_comment}&rdquo;
                    </p>
                  )}
                  <div className="flex items-center justify-between gap-2">
                    {v.url && (
                      <a href={v.url} target="_blank" rel="noopener noreferrer" className="text-xs text-blue-400 hover:text-blue-300 truncate">
                        {v.url}
                      </a>
                    )}
                    {v.embedded_at && (
                      <button
                        onClick={() => fetchSimilar(v.id, v.title)}
                        className="text-[10px] bg-purple-600/20 text-purple-300 border border-purple-600/30 px-2 py-0.5 rounded-full hover:bg-purple-600/40 transition flex-shrink-0"
                      >
                        Similar
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* Load more */}
          {videos.length < total && (
            <div className="text-center mt-6">
              <button onClick={() => fetchVideos(offset)} disabled={loading}
                className="px-6 py-2 bg-white/10 hover:bg-white/15 text-white rounded-xl text-sm transition">
                {loading ? 'Loading...' : `Load More (${videos.length}/${total})`}
              </button>
            </div>
          )}
        </>
      )}

      {/* Similar Videos Modal */}
      {similarSource && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-[60] flex items-start justify-center pt-10 px-4 overflow-y-auto" onClick={() => { setSimilarSource(null); setSimilarVideos([]); }}>
          <div className="bg-[#111] border border-[#1f1f1f] rounded-2xl w-full max-w-6xl mb-10" onClick={e => e.stopPropagation()}>
            <div className="px-6 py-4 border-b border-[#1f1f1f] flex items-center justify-between">
              <div>
                <h3 className="text-lg font-bold text-white">Similar to: <span className="text-purple-400">{similarSource.title}</span></h3>
                <div className="flex items-center gap-3 mt-1">
                  <span className="text-xs text-[#888]">{similarVideos.length} results</span>
                  <label className="text-xs text-[#888]">Min match:</label>
                  <select value={similarMinScore}
                    onChange={e => { setSimilarMinScore(parseFloat(e.target.value)); if (similarSource) fetchSimilar(similarSource.id, similarSource.title); }}
                    className="bg-[#141414] border border-[#1f1f1f] text-white text-xs rounded px-2 py-0.5">
                    <option value={0}>All</option>
                    <option value={0.5}>50%+</option>
                    <option value={0.6}>60%+</option>
                    <option value={0.7}>70%+</option>
                    <option value={0.8}>80%+</option>
                    <option value={0.9}>90%+</option>
                    <option value={0.95}>95%+</option>
                  </select>
                </div>
              </div>
              <button onClick={() => { setSimilarSource(null); setSimilarVideos([]); }} className="text-[#888] hover:text-white">
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>
            <div className="p-6">
              {similarLoading ? (
                <div className="text-center py-12 text-[#888]">Finding similar videos...</div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {similarVideos.map(v => (
                    <div key={v.id} className="bg-[#141414] border border-[#1f1f1f] rounded-xl overflow-hidden">
                      <div className="relative aspect-video bg-[#0a0a0a]">
                        {(() => {
                          const thumbUrl = getThumb(v.url, v.thumbnail);
                          return thumbUrl ? <img src={thumbUrl} alt="" className="w-full h-full object-cover" loading="lazy" /> : null;
                        })()}
                        <div className={`absolute top-2 right-2 px-2 py-0.5 rounded-full text-xs font-bold ${v.score >= 80 ? 'bg-green-500 text-white' : v.score >= 50 ? 'bg-yellow-500 text-black' : 'bg-red-500 text-white'}`}>
                          {v.score}
                        </div>
                        <div className="absolute top-2 left-2 px-2 py-0.5 rounded-full text-xs font-bold bg-purple-600 text-white">
                          {Math.round((v._similarity || 0) * 100)}% match
                        </div>
                      </div>
                      <div className="p-3">
                        <h3 className="text-sm font-medium text-white line-clamp-2 mb-2">{v.title}</h3>
                        <div className="flex items-center gap-2 text-xs text-[#888] mb-1">
                          <span className="text-green-400">{fmtYT(v.view_count)} views</span>
                          {v.channel_name && <span>· {v.channel_name}</span>}
                        </div>
                        <div className="flex items-center gap-3 text-xs text-[#666]">
                          {v.like_count > 0 && <span>{fmtYT(v.like_count)} likes</span>}
                          {v.subscriber_count > 0 && <span>{fmtYT(v.subscriber_count)} subs</span>}
                        </div>
                        {v.url && <a href={v.url} target="_blank" rel="noopener noreferrer" className="text-[10px] text-blue-400 mt-1 block truncate">{v.url}</a>}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
