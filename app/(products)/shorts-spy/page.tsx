'use client';

import React, { useState, useCallback, useEffect } from 'react';

export default function ShortSpyOverview() {
  // Feed Spy State
  const [spyData, setSpyData] = useState<{
    videos: Array<{
      video_id: string; video_url: string; title: string | null; duration_seconds: number;
      upload_date: string | null; view_count: number | null; like_count: number | null;
      comment_count: number | null; collected_at: string;
      channel_id: string; channel_name: string; channel_url: string;
      channel_creation_date: string | null; sighting_count: number; avatar_url: string | null;
    }>;
    total: number;
    stats: { total_videos: string; total_channels: string; total_sightings: string; total_collections: string };
    risingStars: Array<{
      channel_id: string; channel_name: string; channel_url: string;
      channel_creation_date: string; sighting_count: number; avatar_url: string | null;
      first_seen_at: string; last_seen_at: string; subscriber_count: string | null;
      total_video_count: string | null; max_views: string; video_count: string; total_views: string;
    }>;
    risingStarsCount: { total: number; addedToday: number };
  } | null>(null);
  const [spyLoading, setSpyLoading] = useState(false);
  const [spySort, setSpySort] = useState('view_count');
  const [spyMinViews, setSpyMinViews] = useState('0');
  const [spyMaxAge, setSpyMaxAge] = useState('');

  // Rising Stars settings
  const [rsMaxChannels, setRsMaxChannels] = useState('12');
  const [rsMaxAge, setRsMaxAge] = useState('180');
  const [rsMinViews, setRsMinViews] = useState('0');

  const fetchSpyData = useCallback(async () => {
    setSpyLoading(true);
    try {
      const params = new URLSearchParams({ sort: spySort, limit: '200', minViews: spyMinViews, rsMaxChannels, rsMaxAge, rsMinViews });
      if (spyMaxAge) params.set('maxChannelAge', spyMaxAge);
      const response = await fetch(`/api/feed-spy?${params}`);
      const data = await response.json();
      if (data.success) {
        setSpyData(data);
      }
    } catch (err) {
      console.error('Error fetching spy data:', err);
    } finally {
      setSpyLoading(false);
    }
  }, [spySort, spyMinViews, spyMaxAge, rsMaxChannels, rsMaxAge, rsMinViews]);

  // Fetch on mount
  useEffect(() => { fetchSpyData(); }, [fetchSpyData]);

  return (
    <div className="px-8 py-8 max-w-7xl mx-auto">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-white mb-1">Feed Spy</h1>
        <p className="text-sm text-[#888]">YouTube Shorts intelligence — discover trending niches and rising channels</p>
      </div>

      {/* Stats Bar */}
      {spyData?.stats && (
        <div className="grid grid-cols-4 gap-4 mb-8">
          {[
            { label: 'Videos Tracked', value: parseInt(spyData.stats.total_videos).toLocaleString(), color: 'text-blue-400' },
            { label: 'Channels', value: parseInt(spyData.stats.total_channels).toLocaleString(), color: 'text-purple-400' },
            { label: 'Data Points', value: parseInt(spyData.stats.total_sightings).toLocaleString(), color: 'text-orange-400' },
            { label: 'Collections', value: parseInt(spyData.stats.total_collections).toLocaleString(), color: 'text-green-400' },
          ].map((stat, i) => (
            <div key={i} className="bg-[#141414] rounded-xl border border-[#1f1f1f] p-4">
              <div className={`text-2xl font-bold ${stat.color}`}>{stat.value}</div>
              <div className="text-xs text-[#888] mt-1">{stat.label}</div>
            </div>
          ))}
        </div>
      )}

      {/* Rising Stars */}
      {spyData?.risingStars && spyData.risingStars.length > 0 && (
        <div className="mb-8">
          <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
            <h2 className="text-lg font-bold text-white flex items-center gap-2">
              Rising Stars
              {spyData.risingStarsCount && (
                <span className="text-sm font-normal text-[#888]">
                  {spyData.risingStarsCount.total} total
                  {spyData.risingStarsCount.addedToday > 0 && (
                    <span className="text-green-400 ml-1">(+{spyData.risingStarsCount.addedToday} today)</span>
                  )}
                </span>
              )}
            </h2>
            <div className="flex items-center gap-3 flex-wrap">
              <div className="flex items-center gap-1.5">
                <label className="text-xs text-[#666]">Show</label>
                <select value={rsMaxChannels} onChange={(e) => setRsMaxChannels(e.target.value)} className="bg-[#141414] border border-[#1f1f1f] rounded-lg px-2 py-1 text-white text-xs">
                  <option value="4">4</option>
                  <option value="8">8</option>
                  <option value="12">12</option>
                  <option value="20">20</option>
                  <option value="50">50</option>
                </select>
              </div>
              <div className="flex items-center gap-1.5">
                <label className="text-xs text-[#666]">Max age</label>
                <select value={rsMaxAge} onChange={(e) => setRsMaxAge(e.target.value)} className="bg-[#141414] border border-[#1f1f1f] rounded-lg px-2 py-1 text-white text-xs">
                  <option value="30">30 days</option>
                  <option value="90">90 days</option>
                  <option value="180">6 months</option>
                  <option value="365">1 year</option>
                  <option value="730">2 years</option>
                </select>
              </div>
              <div className="flex items-center gap-1.5">
                <label className="text-xs text-[#666]">Min views</label>
                <select value={rsMinViews} onChange={(e) => setRsMinViews(e.target.value)} className="bg-[#141414] border border-[#1f1f1f] rounded-lg px-2 py-1 text-white text-xs">
                  <option value="0">All</option>
                  <option value="1000">1K+</option>
                  <option value="10000">10K+</option>
                  <option value="100000">100K+</option>
                  <option value="1000000">1M+</option>
                </select>
              </div>
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            {[...spyData.risingStars].sort((a, b) => {
              const ageA = a.channel_creation_date ? Date.now() - new Date(a.channel_creation_date).getTime() : Infinity;
              const ageB = b.channel_creation_date ? Date.now() - new Date(b.channel_creation_date).getTime() : Infinity;
              return ageA - ageB;
            }).map((star) => {
              const ageDays = star.channel_creation_date
                ? Math.floor((Date.now() - new Date(star.channel_creation_date).getTime()) / 86400000)
                : null;
              const isNew = star.first_seen_at && new Date(star.first_seen_at).toDateString() === new Date().toDateString();
              return (
                <div key={star.channel_id} className={`bg-[#141414] rounded-xl border p-4 hover:border-orange-500/60 transition relative ${isNew ? 'border-green-500/50' : 'border-[#1f1f1f]'}`}>
                  {isNew && (
                    <span className="absolute -top-2 -right-2 bg-green-500 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full shadow-lg">NEW!</span>
                  )}
                  <div className="flex items-start gap-3 mb-2">
                    {star.avatar_url ? (
                      <img src={star.avatar_url} alt="" className="w-10 h-10 rounded-full flex-shrink-0" />
                    ) : (
                      <div className="w-10 h-10 rounded-full bg-[#1f1f1f] flex items-center justify-center text-[#888] text-sm font-bold flex-shrink-0">
                        {star.channel_name?.charAt(0)?.toUpperCase() || '?'}
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <a href={star.channel_url} target="_blank" rel="noopener noreferrer" className="text-white font-semibold hover:text-orange-400 transition truncate block text-sm">
                        {star.channel_name}
                      </a>
                      {ageDays !== null && (
                        <span className="text-xs text-orange-300/70">{ageDays}d old</span>
                      )}
                    </div>
                  </div>
                  <div className="text-2xl font-bold text-orange-400">{parseInt(star.total_views).toLocaleString()}</div>
                  <div className="text-xs text-[#888]">total views across {star.video_count} video{parseInt(star.video_count) !== 1 ? 's' : ''}</div>
                  {(star.subscriber_count || star.total_video_count) && (
                    <div className="text-xs text-[#666] mt-0.5 flex items-center gap-2">
                      {star.subscriber_count && (
                        <span>
                          {parseInt(star.subscriber_count) >= 1000000
                            ? `${(parseInt(star.subscriber_count) / 1000000).toFixed(1)}M subs`
                            : parseInt(star.subscriber_count) >= 1000
                              ? `${(parseInt(star.subscriber_count) / 1000).toFixed(1)}K subs`
                              : `${parseInt(star.subscriber_count)} subs`}
                        </span>
                      )}
                      {star.subscriber_count && star.total_video_count && <span className="text-[#444]">|</span>}
                      {star.total_video_count && <span>{parseInt(star.total_video_count).toLocaleString()} videos</span>}
                    </div>
                  )}
                  <div className="mt-2 flex items-center justify-between">
                    <div className="text-xs text-[#666]">
                      Best: {parseInt(star.max_views).toLocaleString()} views | Seen {star.sighting_count}x
                    </div>
                    <div className="relative group">
                      <svg className="w-4 h-4 text-[#444] hover:text-[#888] cursor-help transition" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                      <div className="absolute bottom-full right-0 mb-2 w-48 bg-[#1a1a1a] border border-[#333] rounded-lg p-2.5 text-xs hidden group-hover:block z-10 shadow-xl">
                        <div className="text-[#888] space-y-1">
                          <div>First seen: <span className="text-white">{new Date(star.first_seen_at).toLocaleDateString()}</span></div>
                          <div>Last updated: <span className="text-white">{new Date(star.last_seen_at).toLocaleDateString()}</span></div>
                          {star.channel_creation_date && (
                            <div>Created: <span className="text-white">{new Date(star.channel_creation_date).toLocaleDateString()}</span></div>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="bg-[#141414] rounded-xl border border-[#1f1f1f] p-4 mb-6">
        {/* Pill tabs for sort */}
        <div className="flex gap-2 flex-wrap mb-4">
          {[
            { value: 'view_count', label: 'Views' },
            { value: 'like_count', label: 'Likes' },
            { value: 'comment_count', label: 'Comments' },
            { value: 'duration_seconds', label: 'Duration' },
            { value: 'collected_at', label: 'Recently Collected' },
          ].map(opt => (
            <button
              key={opt.value}
              onClick={() => setSpySort(opt.value)}
              className={`px-4 py-1.5 rounded-full text-sm transition ${
                spySort === opt.value
                  ? 'bg-white text-black font-medium'
                  : 'text-[#888] border border-[#333] hover:border-[#555]'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
        {/* Sort row */}
        <div className="flex gap-4 items-center text-sm text-[#888]">
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-[#666]">Min Views:</span>
            <select value={spyMinViews} onChange={(e) => setSpyMinViews(e.target.value)} className="bg-[#0a0a0a] border border-[#1f1f1f] rounded-lg px-2 py-1 text-white text-xs">
              <option value="0">All</option>
              <option value="1000">1K+</option>
              <option value="10000">10K+</option>
              <option value="100000">100K+</option>
              <option value="1000000">1M+</option>
              <option value="10000000">10M+</option>
            </select>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-[#666]">Channel Age:</span>
            <select value={spyMaxAge} onChange={(e) => setSpyMaxAge(e.target.value)} className="bg-[#0a0a0a] border border-[#1f1f1f] rounded-lg px-2 py-1 text-white text-xs">
              <option value="">Any age</option>
              <option value="30">Under 30 days</option>
              <option value="90">Under 90 days</option>
              <option value="180">Under 6 months</option>
              <option value="365">Under 1 year</option>
            </select>
          </div>
          <button onClick={fetchSpyData} className="px-4 py-1.5 bg-white/10 text-white rounded-lg hover:bg-white/15 transition text-sm">
            Apply
          </button>
          {spyData && <span className="text-sm text-[#888] font-medium">{spyData.total} results</span>}
        </div>
      </div>

      {/* Video Table */}
      {spyLoading ? (
        <div className="flex items-center justify-center py-20">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-red-500" />
        </div>
      ) : !spyData || spyData.videos.length === 0 ? (
        <div className="text-center py-20">
          <div className="text-6xl mb-4">📡</div>
          <h3 className="text-xl font-semibold text-white mb-2">No data yet</h3>
          <p className="text-[#888] mb-6">Data will appear once the feed spy has collected videos</p>
        </div>
      ) : (
        <div className="bg-[#141414] rounded-xl border border-[#1f1f1f] overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-[#1f1f1f] text-left">
                  <th className="px-4 py-3 text-xs font-medium text-[#888] uppercase">Video</th>
                  <th className="px-4 py-3 text-xs font-medium text-[#888] uppercase">Channel</th>
                  <th className="px-4 py-3 text-xs font-medium text-[#888] uppercase text-right">Views</th>
                  <th className="px-4 py-3 text-xs font-medium text-[#888] uppercase text-right">Likes</th>
                  <th className="px-4 py-3 text-xs font-medium text-[#888] uppercase text-right">Comments</th>
                  <th className="px-4 py-3 text-xs font-medium text-[#888] uppercase text-right">Duration</th>
                  <th className="px-4 py-3 text-xs font-medium text-[#888] uppercase text-right">Ch. Age</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#1f1f1f]">
                {spyData.videos.map((video, idx) => {
                  const ageDays = video.channel_creation_date
                    ? Math.floor((Date.now() - new Date(video.channel_creation_date).getTime()) / 86400000)
                    : null;
                  const isNewChannel = ageDays !== null && ageDays < 180;
                  return (
                    <tr key={`${video.video_id}-${idx}`} className={`hover:bg-white/[0.03] transition ${isNewChannel ? 'bg-orange-500/5' : ''}`}>
                      <td className="px-4 py-3 max-w-xs">
                        <a href={video.video_url} target="_blank" rel="noopener noreferrer" className="text-sm text-white hover:text-blue-400 transition line-clamp-2">
                          {video.title || video.video_id}
                        </a>
                        {video.upload_date && <div className="text-xs text-[#666] mt-0.5">{video.upload_date}</div>}
                      </td>
                      <td className="px-4 py-3">
                        <a href={video.channel_url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 text-sm text-[#888] hover:text-white transition">
                          {video.avatar_url ? (
                            <img src={video.avatar_url} alt="" className="w-6 h-6 rounded-full flex-shrink-0" />
                          ) : (
                            <div className="w-6 h-6 rounded-full bg-[#1f1f1f] flex items-center justify-center text-[#888] text-[10px] font-bold flex-shrink-0">
                              {video.channel_name?.charAt(0)?.toUpperCase() || '?'}
                            </div>
                          )}
                          {video.channel_name}
                        </a>
                      </td>
                      <td className="px-4 py-3 text-right">
                        {video.view_count ? (
                          <span className={`text-sm font-medium ${video.view_count >= 10000000 ? 'text-orange-400' : video.view_count >= 1000000 ? 'text-yellow-400' : 'text-white'}`}>
                            {video.view_count >= 1000000
                              ? `${(video.view_count / 1000000).toFixed(1)}M`
                              : video.view_count >= 1000
                                ? `${(video.view_count / 1000).toFixed(1)}K`
                                : video.view_count.toLocaleString()
                            }
                          </span>
                        ) : <span className="text-[#444]">&mdash;</span>}
                      </td>
                      <td className="px-4 py-3 text-right text-sm text-[#888]">
                        {video.like_count ? `${(video.like_count / 1000).toFixed(1)}K` : '\u2014'}
                      </td>
                      <td className="px-4 py-3 text-right text-sm text-[#888]">
                        {video.comment_count ? video.comment_count.toLocaleString() : '\u2014'}
                      </td>
                      <td className="px-4 py-3 text-right text-sm text-[#888]">{video.duration_seconds}s</td>
                      <td className="px-4 py-3 text-right">
                        {ageDays !== null ? (
                          <span className={`text-sm ${isNewChannel ? 'text-orange-400 font-medium' : 'text-[#888]'}`}>
                            {ageDays < 30 ? `${ageDays}d` : ageDays < 365 ? `${Math.floor(ageDays / 30)}mo` : `${Math.floor(ageDays / 365)}y`}
                          </span>
                        ) : <span className="text-[#444]">&mdash;</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
