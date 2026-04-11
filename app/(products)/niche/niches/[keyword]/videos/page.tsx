'use client';

import React, { useState, useCallback, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
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
  const router = useRouter();
  const { setSelectedKeyword, filter, setFilter } = useNiche();

  const [videos, setVideos] = useState<NicheVideo[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [offset, setOffset] = useState(0);
  const [stats, setStats] = useState<{ total_videos: string; total_keywords: string; total_channels: string; avg_score: string } | null>(null);
  const [keywords, setKeywords] = useState<Array<{ keyword: string; cnt: string }>>([]);

  // Enrich state
  const [enriching, setEnriching] = useState(false);
  const [enrichResult, setEnrichResult] = useState<{ message: string; enriched: number; errors: number } | null>(null);

  // Sync state
  const [syncing, setSyncing] = useState(false);
  const [syncProgress, setSyncProgress] = useState<{
    message: string; batches: number; totalInserted: number; totalUpdated: number;
    totalLocal: number; totalKeywords: number;
    keywordBreakdown?: Array<{ keyword: string; total: number; new: number }>;
    saturation?: Array<{ keyword: string; runSatPct: number; globalSatPct: number; A: number; B: number }>;
    done?: boolean;
  } | null>(null);

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
      if (filter.from) params.set('from', filter.from);
      if (filter.to) params.set('to', filter.to);
      const res = await fetch(`/api/niche-spy?${params}`);
      const data = await res.json();
      if (off === 0) setVideos(data.videos);
      else setVideos(prev => [...prev, ...data.videos]);
      setTotal(data.total);
      setKeywords(data.keywords || []);
      setStats(data.stats || null);
      setOffset(off + data.videos.length);
    } catch (err) { console.error('Video fetch error:', err); }
    setLoading(false);
  }, [keyword, filter]);

  useEffect(() => { fetchVideos(0); }, [fetchVideos]);

  // Enrich Data — SSE streaming
  const enrichData = async () => {
    setEnriching(true);
    setEnrichResult(null);
    let totalEnrichedV = 0, totalEnrichedC = 0, totalErrors = 0, round = 0;
    try {
      const checkRes = await fetch(`/api/niche-spy/enrich?keyword=${encodeURIComponent(keyword)}`);
      const checkData = await checkRes.json();
      const totalNeeded = parseInt(checkData.need_enrichment) || 0;
      const totalRounds = Math.ceil(totalNeeded / 200);
      if (totalNeeded === 0) {
        setEnrichResult({ message: 'All videos already enriched.', enriched: 0, errors: 0 });
        setEnriching(false);
        setTimeout(() => setEnrichResult(null), 3000);
        return;
      }
      setEnrichResult({ message: `${totalNeeded.toLocaleString()} videos need enrichment (~${totalRounds} rounds)...`, enriched: 0, errors: 0 });
      while (true) {
        round++;
        const remaining = totalNeeded - totalEnrichedV;
        const pct = totalNeeded > 0 ? Math.round((totalEnrichedV / totalNeeded) * 100) : 0;
        setEnrichResult({ message: `Round ${round}/${totalRounds}: enriching... (${pct}%, ${remaining.toLocaleString()} remaining)`, enriched: totalEnrichedV, errors: totalErrors });
        const res = await fetch('/api/niche-spy/enrich', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ keyword, limit: 200 }),
        });
        const reader = res.body?.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        let roundVideos = 0, roundChannels = 0;
        if (reader) {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            const lines = buf.split('\n');
            buf = lines.pop() || '';
            for (const line of lines) {
              if (!line.startsWith('data: ')) continue;
              try {
                const d = JSON.parse(line.slice(6));
                if (d.step === 'videos' && !d.done && !d.error) {
                  const rpct = totalNeeded > 0 ? Math.round(((totalEnrichedV + (d.batch || 0) * 50) / totalNeeded) * 100) : 0;
                  setEnrichResult({ message: `Round ${round}/${totalRounds}: video stats... (${rpct}%)`, enriched: totalEnrichedV, errors: totalErrors });
                } else if (d.step === 'videos' && d.done) {
                  roundVideos = d.enriched || 0;
                } else if (d.step === 'channels' && !d.done && !d.error) {
                  setEnrichResult({ message: `Round ${round}/${totalRounds}: fetching subscriber counts...`, enriched: totalEnrichedV + roundVideos, errors: totalErrors });
                } else if (d.step === 'complete') {
                  roundVideos = d.enrichedVideos || 0;
                  roundChannels = d.enrichedChannels || 0;
                  totalErrors += d.errors || 0;
                }
              } catch { /* skip */ }
            }
          }
        }
        totalEnrichedV += roundVideos;
        totalEnrichedC += roundChannels;
        if (roundVideos === 0) break;
        await new Promise(r => setTimeout(r, 500));
      }
      setEnrichResult({ message: `All done! ${totalEnrichedV} videos, ${totalEnrichedC} channels enriched across ${round} rounds.`, enriched: totalEnrichedV, errors: totalErrors });
      fetchVideos(0);
    } catch (err) {
      setEnrichResult({ message: `Error: ${err instanceof Error ? err.message : 'Failed'}`, enriched: totalEnrichedV, errors: totalErrors + 1 });
    }
    setEnriching(false);
    setTimeout(() => setEnrichResult(null), 8000);
  };

  // Sync/Refresh
  const syncData = async () => {
    setSyncing(true);
    setSyncProgress({ message: 'Fetching tasks from xgodo...', batches: 0, totalInserted: 0, totalUpdated: 0, totalLocal: 0, totalKeywords: 0 });
    let totalInserted = 0, totalUpdated = 0, batches = 0;
    try {
      while (true) {
        const res = await fetch('/api/niche-spy/sync', { method: 'POST' });
        const data = await res.json();
        if (data.error) { setSyncProgress(prev => prev ? { ...prev, message: `Error: ${data.error}` } : null); break; }
        batches++;
        totalInserted += data.videosInserted || 0;
        totalUpdated += data.videosUpdated || 0;
        if (data.status === 'idle' || data.tasksProcessed === 0) {
          setSyncProgress({
            message: totalInserted > 0 ? `Done! ${totalInserted} new, ${totalUpdated} updated across ${batches} batches.` : 'All caught up — no new tasks.',
            batches, totalInserted, totalUpdated,
            totalLocal: data.totalLocal || 0, totalKeywords: data.totalKeywords || 0,
            keywordBreakdown: data.keywordBreakdown, saturation: data.saturation, done: true,
          });
          break;
        }
        setSyncProgress({
          message: `Batch ${batches}: ${data.tasksProcessed} tasks → ${data.videosInserted} new, ${data.videosUpdated} updated`,
          batches, totalInserted, totalUpdated,
          totalLocal: data.totalLocal || 0, totalKeywords: data.totalKeywords || 0,
          keywordBreakdown: data.keywordBreakdown,
        });
        if (data.tasksProcessed < 100) break;
        await new Promise(r => setTimeout(r, 500));
      }
      fetchVideos(0);
    } catch (err) {
      setSyncProgress(prev => prev ? { ...prev, message: `Error: ${err instanceof Error ? err.message : 'Sync failed'}` } : null);
    }
    setTimeout(() => { setSyncing(false); setSyncProgress(null); }, 5000);
  };

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
      {/* Stats header with Enrich + Refresh */}
      <div className="bg-[#141414] border border-[#1f1f1f] rounded-xl px-6 py-4 mb-4">
        <div className="flex items-center justify-between mb-3">
          <div>
            <span className="text-2xl font-bold text-white">{stats ? parseInt(stats.total_videos).toLocaleString() : '...'}</span>
            <span className="text-[#888] ml-2">stored videos</span>
          </div>
          <div className="flex gap-2">
            <button onClick={enrichData} disabled={enriching}
              className="px-4 py-2 bg-purple-600 hover:bg-purple-700 disabled:bg-[#333] text-white rounded-lg text-sm font-medium transition">
              {enriching ? 'Enriching...' : 'Enrich Data'}
            </button>
            <button onClick={syncData} disabled={syncing}
              className="px-4 py-2 bg-red-600 hover:bg-red-700 disabled:bg-[#333] text-white rounded-lg text-sm font-medium transition">
              {syncing ? 'Syncing...' : 'Refresh'}
            </button>
          </div>
        </div>

        {/* Enrich progress */}
        {enrichResult && (
          <div className={`border rounded-lg px-4 py-2.5 mb-3 ${enrichResult.errors ? 'bg-yellow-900/20 border-yellow-600/40' : 'bg-purple-900/20 border-purple-600/40'}`}>
            <div className="flex items-center gap-2">
              {enriching ? (
                <div className="w-4 h-4 border-2 border-purple-400 border-t-transparent rounded-full animate-spin flex-shrink-0" />
              ) : (
                <svg className="w-4 h-4 text-purple-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                </svg>
              )}
              <span className="text-sm text-purple-200">{enrichResult.message}</span>
            </div>
          </div>
        )}

        {/* Sync progress with keyword breakdown + saturation */}
        {syncProgress && (
          <div className={`border rounded-lg px-4 py-3 mb-3 ${syncProgress.done ? 'bg-green-900/20 border-green-600/40' : 'bg-blue-900/20 border-blue-600/40'}`}>
            <div className="flex items-center gap-3">
              {syncing && !syncProgress.done && (
                <div className="w-5 h-5 border-2 border-blue-400 border-t-transparent rounded-full animate-spin flex-shrink-0" />
              )}
              {(syncProgress.done || !syncing) && (
                <svg className="w-5 h-5 text-green-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
              )}
              <div className="flex-1 min-w-0">
                <p className="text-sm text-blue-200 font-medium">{syncProgress.message}</p>
                {syncProgress.batches > 0 && (
                  <div className="flex items-center gap-4 mt-1.5 text-xs text-[#888] flex-wrap">
                    <span className="text-green-400">+{syncProgress.totalInserted} new</span>
                    <span className="text-yellow-400">{syncProgress.totalUpdated} updated</span>
                    <span>{syncProgress.totalLocal.toLocaleString()} total</span>
                    <span>{syncProgress.totalKeywords} keywords</span>
                  </div>
                )}
                {syncProgress.keywordBreakdown && syncProgress.keywordBreakdown.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {syncProgress.keywordBreakdown.slice(0, 8).map(k => (
                      <span key={k.keyword} className="text-[10px] bg-[#1a1a1a] text-[#ccc] px-2 py-0.5 rounded-full">
                        {k.keyword} <span className="text-green-400">+{k.new}</span>/{k.total}
                      </span>
                    ))}
                    {syncProgress.keywordBreakdown.length > 8 && (
                      <span className="text-[10px] text-[#666]">+{syncProgress.keywordBreakdown.length - 8} more</span>
                    )}
                  </div>
                )}
                {syncProgress.saturation && syncProgress.saturation.length > 0 && (
                  <div className="mt-2 space-y-1">
                    <span className="text-[10px] text-[#666] uppercase tracking-wider">Saturation</span>
                    {syncProgress.saturation.slice(0, 6).map(s => (
                      <div key={s.keyword} className="flex items-center gap-2">
                        <span className="text-[10px] text-[#888] w-28 truncate">{s.keyword}</span>
                        <div className="flex-1 h-1.5 bg-[#1f1f1f] rounded-full overflow-hidden">
                          <div className={`h-full rounded-full ${s.runSatPct >= 90 ? 'bg-red-500' : s.runSatPct >= 60 ? 'bg-yellow-500' : 'bg-green-500'}`}
                            style={{ width: `${Math.min(s.runSatPct, 100)}%` }} />
                        </div>
                        <span className={`text-[10px] font-mono w-10 text-right ${s.runSatPct >= 90 ? 'text-red-400' : s.runSatPct >= 60 ? 'text-yellow-400' : 'text-green-400'}`}>
                          {s.runSatPct}%
                        </span>
                        <span className="text-[10px] text-[#666]">+{s.A} new</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Keyword filter dropdown */}
        <div className="flex items-center gap-4 flex-wrap">
          <div className="flex items-center gap-2">
            <span className="text-xs text-[#666] uppercase tracking-wider">Keyword</span>
            <select
              value={keyword}
              onChange={e => {
                const newKw = e.target.value;
                if (newKw === 'all') {
                  router.push('/niche/niches');
                } else {
                  router.push(`/niche/niches/${encodeURIComponent(newKw)}/videos`);
                }
              }}
              className="bg-[#0a0a0a] border border-[#1f1f1f] text-white text-sm rounded-lg px-3 py-1.5 focus:outline-none"
            >
              <option value="all">All keywords</option>
              {keywords.map(k => (
                <option key={k.keyword} value={k.keyword}>{k.keyword} ({k.cnt})</option>
              ))}
            </select>
          </div>
        </div>
      </div>

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
