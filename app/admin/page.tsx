'use client';

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Markdown } from '@/components/Markdown';
import ContentGenTab from '@/components/ContentGenTab';
import ImageGenTab from '@/components/ImageGenTab';
import AudioGenTab from '@/components/AudioGenTab';
import ScreenCaptureTab from '@/components/ScreenCaptureTab';
import ProducerTab from '@/components/ProducerTab';

function timeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return date.toLocaleDateString();
}

export default function AdminPage() {
  const [authenticated, setAuthenticated] = useState(false);
  const [checking, setChecking] = useState(true);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loginError, setLoginError] = useState('');

  // Sync state
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<{ synced: number; videos: number; confirmed: number; skipped: number; empty: number; totalFetched: number; emptyTaskIds?: string[] } | null>(null);
  const [syncError, setSyncError] = useState('');
  const [syncLimit, setSyncLimit] = useState('50');
  const [syncProgress, setSyncProgress] = useState<{ phase: string; message: string; total?: number; processed?: number; synced?: number; skipped?: number; videos?: number; empty?: number; tasksFetched?: number } | null>(null);

  // Admin section tabs
  const [adminSection, setAdminSection] = useState<'general' | 'niche' | 'enrich' | 'tokens' | 'agents' | 'datacollection' | 'vizard' | 'novelty' | 'tree' | 'lifecycle' | 'seed' | 'docs' | 'tools' | 'vid-gen' | 'embed-reqs' | 'analyze-vids' | 'xg-vid-dl' | 'content-gen' | 'imagegen' | 'audiogen' | 'screencap' | 'producer'>('general');

  // Niche Tree tab state — global hierarchical clustering. Sandboxed
  // alongside the existing per-keyword clustering until validated.
  type TreeStage = 'starting' | 'gpu_queued' | 'gpu_running' | 'fetching' | 'umap_cluster' | 'hdbscan' | 'labeling' | 'writing' | 'stitching' | 'baking_l2' | 'done';
  interface TreeBakeL2Progress {
    total: number; completed: number; skipped: number; failed: number;
    currentParentId: number | null;
    currentParentLabel: string | null;
    currentSubrunId: number | null;
  }
  interface TreeProgress {
    stage: TreeStage;
    startedAt: string;
    stageStartedAt: string;
    stagesElapsedMs: Partial<Record<TreeStage, number>>;
    recentLogs: string[];
    numClusters?: number;
    numNoise?: number;
    l2?: TreeBakeL2Progress;
    /** RunPod job id when executionMode='gpu'. Surfaced in the stage
     *  stepper as a deep link to the RunPod console. */
    runpodJobId?: string;
    /** RunPod queue-time + in-container exec-time, set by the dispatcher
     *  when the global_bake job completes. Useful post-mortem stat. */
    runpodDelayMs?: number;
    runpodExecMs?: number;
  }
  interface TreeRun {
    id: number; status: 'running' | 'done' | 'error';
    source: string; numClusters: number; numNoise: number; totalVideos: number;
    /** Live count of videos still attached to a cluster (post-cleanup). */
    numAssigned?: number;
    errorMessage: string | null; startedAt: string; completedAt: string | null;
    params: Record<string, unknown>;
    progress?: TreeProgress | null;
  }
  interface TreePopularVideo {
    videoId: number;
    title: string | null;
    thumbnail: string | null;
    url: string | null;
    viewCount: number | null;
    channelName: string | null;
    postedAt: string | null;
    postedDate: string | null;
    score: number | null;
  }
  interface TreeCluster {
    id: number; clusterIndex: number; level: number;
    label: string | null; autoLabel: string | null; aiLabel: string | null;
    videoCount: number; avgScore: number | null; avgViews: number | null; totalViews: number | null;
    topChannels: string[]; representativeVideoId: number | null;
    repTitle: string | null; repThumbnail: string | null; repUrl: string | null;
    repViewCount: number | null; repChannelName: string | null;
    popularVideos: TreePopularVideo[];
    childrenCount: number;
    subdivideStatus: 'running' | 'done' | 'error' | null;
    subdivideError: string | null;
  }
  const [treeData, setTreeData] = useState<{ run: TreeRun | null; clusters: TreeCluster[] }>({ run: null, clusters: [] });
  const [treeLoading, setTreeLoading] = useState(false);
  const [treeStarting, setTreeStarting] = useState(false);
  const [treeError, setTreeError] = useState<string | null>(null);
  // Cluster controls — sensible defaults for a global L1 run on
  // ~thousands of videos. Bigger min_cluster_size = fewer, broader niches.
  const [treeParams, setTreeParams] = useState({
    source: 'combined_v2' as 'title_v1' | 'title_v2' | 'thumbnail_v2' | 'combined' | 'combined_v2',
    /** L1 default lowered from 80 → 40: more clusters survive, noise drops. */
    minClusterSize: 40,
    /** Lowered from 10 → 5: more permissive density floor, fewer points marked noise. */
    minSamples: 5,
    umapDims: 50,
    /** UMAP k-NN graph fan-out. Bumped from 5 → 15: bigger n_neighbors =
     *  more global structure, more robust density landscape. cuML's stricter
     *  k-NN search at n=5 created less-connected graphs than umap-learn
     *  (CPU), inflating HDBSCAN's noise to 64% on GPU. 15 recovers
     *  CPU-baseline-like noise rates. */
    nNeighbors: 15,
    /** Tukey-fence multiplier for per-cluster outlier cleanup. 0 disables;
     *  3.0 is lenient (catches obvious misclassifications without nuking
     *  legitimate cluster-edge members). */
    outlierIqrMult: 3.0,
    /** L1 cluster size that triggers an L2 subdivide. Smaller L1 clusters
     *  are skipped — saves wall time and avoids cuML crashes on tiny inputs. */
    minParentSize: 200,
    /** 'cpu' (default) runs the Python subprocess on the Railway worker.
     *  'gpu' dispatches a single combined L1+L2 bake to the RunPod cuML
     *  serverless endpoint. Same script, same I/O, ~10× faster. */
    executionMode: 'cpu' as 'cpu' | 'gpu',
  });

  const refetchTree = useCallback(async () => {
    setTreeLoading(true);
    try {
      const r = await fetch('/api/admin/niche-tree');
      const d = await r.json();
      setTreeData({ run: d.run || null, clusters: d.clusters || [] });
    } catch { /* swallow */ }
    finally { setTreeLoading(false); }
  }, []);

  // ── Drill-down state ──────────────────────────────────────────
  // When the user clicks a cluster card with children (or with a
  // running subdivide), we navigate "into" it. The viewed cluster id
  // pushes a pseudo-route — no URL routing for now, just state.
  interface TreeAncestor {
    id: number; level: number; label: string | null;
    autoLabel: string | null; clusterIndex: number;
  }
  interface TreeViewedData {
    parent: TreeCluster | null;
    ancestors: TreeAncestor[];
    children: TreeCluster[];
    subdivideRun: (TreeRun & { progress?: TreeProgress | null }) | null;
  }
  const [treeViewedClusterId, setTreeViewedClusterId] = useState<number | null>(null);
  const [treeViewedData, setTreeViewedData] = useState<TreeViewedData | null>(null);
  const [treeViewedLoading, setTreeViewedLoading] = useState(false);

  const refetchViewedCluster = useCallback(async (clusterId: number) => {
    setTreeViewedLoading(true);
    try {
      const r = await fetch(`/api/admin/niche-tree/cluster/${clusterId}`);
      const d = await r.json();
      if (r.ok) setTreeViewedData(d);
    } catch { /* swallow */ }
    finally { setTreeViewedLoading(false); }
  }, []);

  // ── Cluster videos grid state ─────────────────────────────────
  // When the user clicks the "videos" icon on a cluster card we load
  // the per-cluster video list and switch the right pane to grid mode.
  // treeVideosClusterId being non-null is the on/off signal — closing
  // it just resets back to the cluster grid (or whichever drill-down
  // level was active before, since treeViewedClusterId is preserved).
  type TreeVideoSort = 'centroid' | 'outlier' | 'score' | 'views' | 'date' | 'oldest' | 'likes';
  interface TreeVideoRow {
    videoId: number; url: string | null; title: string | null;
    thumbnail: string | null; channelName: string | null;
    viewCount: number | null; likeCount: number | null; commentCount: number | null;
    subscriberCount: number | null; channelCreatedAt: string | null;
    postedAt: string | null; postedDate: string | null;
    score: number | null; topComment: string | null; keyword: string | null;
    distanceToCentroid: number | null;
  }
  interface TreeVideosData {
    parent: TreeCluster | null;
    ancestors: TreeAncestor[];
    videos: TreeVideoRow[];
    total: number;
  }
  const [treeVideosClusterId, setTreeVideosClusterId] = useState<number | null>(null);
  const [treeVideosData, setTreeVideosData] = useState<TreeVideosData | null>(null);
  const [treeVideosLoading, setTreeVideosLoading] = useState(false);
  const [treeVideosOffset, setTreeVideosOffset] = useState(0);
  const [treeVideosSort, setTreeVideosSort] = useState<TreeVideoSort>('centroid');
  // Two-step search state — `treeVideosSearchInput` is what the user
  // types live; we debounce 300ms into `treeVideosSearch` (the committed
  // value used for fetches) so each keystroke doesn't fire a new query.
  const [treeVideosSearchInput, setTreeVideosSearchInput] = useState('');
  const [treeVideosSearch, setTreeVideosSearch] = useState('');

  const fetchClusterVideos = useCallback(async (clusterId: number, offset: number, sort: TreeVideoSort, q: string) => {
    setTreeVideosLoading(true);
    try {
      const params = new URLSearchParams({ sort, limit: '60', offset: String(offset) });
      if (q) params.set('q', q);
      const r = await fetch(`/api/admin/niche-tree/cluster/${clusterId}/videos?${params}`);
      const d = await r.json();
      if (r.ok) {
        if (offset === 0) {
          setTreeVideosData(d);
          setTreeVideosOffset(d.videos?.length ?? 0);
        } else {
          // Append: reuse the existing parent/ancestors, only extend videos.
          setTreeVideosData(prev => prev
            ? { ...prev, videos: [...prev.videos, ...(d.videos ?? [])], total: d.total ?? prev.total }
            : d);
          setTreeVideosOffset(prev => prev + (d.videos?.length ?? 0));
        }
      }
    } catch { /* swallow */ }
    finally { setTreeVideosLoading(false); }
  }, []);

  const openClusterVideos = useCallback((clusterId: number) => {
    setTreeVideosClusterId(clusterId);
    setTreeVideosOffset(0);
    setTreeVideosData(null);
    // Fresh cluster → reset search so the user isn't carrying an old
    // filter into a different niche.
    setTreeVideosSearchInput('');
    setTreeVideosSearch('');
    fetchClusterVideos(clusterId, 0, treeVideosSort, '');
  }, [fetchClusterVideos, treeVideosSort]);

  const closeClusterVideos = useCallback(() => {
    setTreeVideosClusterId(null);
    setTreeVideosData(null);
    setTreeVideosOffset(0);
    setTreeVideosSearchInput('');
    setTreeVideosSearch('');
  }, []);

  // Refetch from offset 0 when sort or committed search changes.
  useEffect(() => {
    if (treeVideosClusterId == null) return;
    fetchClusterVideos(treeVideosClusterId, 0, treeVideosSort, treeVideosSearch);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [treeVideosSort, treeVideosSearch]);

  // Debounce the search input → commit value → effect above refires.
  useEffect(() => {
    const h = setTimeout(() => {
      setTreeVideosSearch(prev => prev === treeVideosSearchInput ? prev : treeVideosSearchInput);
    }, 300);
    return () => clearTimeout(h);
  }, [treeVideosSearchInput]);

  // ── Infinite scroll for the videos grid ──────────────────────
  // Sentinel + IntersectionObserver. Refs hold the current state
  // so the observer callback always reads fresh values without
  // having to rebuild the observer on every offset/loading tick
  // (which would race with fetches in flight).
  const treeVideosLoadingRef = useRef(treeVideosLoading);
  const treeVideosOffsetRef  = useRef(treeVideosOffset);
  const treeVideosSortRef    = useRef(treeVideosSort);
  const treeVideosTotalRef   = useRef(treeVideosData?.total ?? 0);
  const treeVideosSearchRef  = useRef(treeVideosSearch);
  useEffect(() => { treeVideosLoadingRef.current = treeVideosLoading; }, [treeVideosLoading]);
  useEffect(() => { treeVideosOffsetRef.current  = treeVideosOffset;  }, [treeVideosOffset]);
  useEffect(() => { treeVideosSortRef.current    = treeVideosSort;    }, [treeVideosSort]);
  useEffect(() => { treeVideosTotalRef.current   = treeVideosData?.total ?? 0; }, [treeVideosData?.total]);
  useEffect(() => { treeVideosSearchRef.current  = treeVideosSearch;  }, [treeVideosSearch]);

  const treeVideosSentinelRef = useRef<HTMLDivElement | null>(null);
  // The sentinel only renders once treeVideosData has arrived AND there
  // are more pages to fetch. Track that flag in deps so the effect
  // re-runs when the sentinel actually appears in the DOM — otherwise
  // we'd attach the observer to a null ref on initial open and never
  // retry, leaving auto-load silently broken.
  const treeVideosHasMore = treeVideosData != null
    && treeVideosData.videos.length < treeVideosData.total;
  useEffect(() => {
    if (treeVideosClusterId == null) return;
    if (!treeVideosHasMore) return;
    const el = treeVideosSentinelRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(entries => {
      if (!entries[0]?.isIntersecting) return;
      if (treeVideosLoadingRef.current) return;
      const total  = treeVideosTotalRef.current;
      const offset = treeVideosOffsetRef.current;
      if (total === 0 || offset >= total) return;
      fetchClusterVideos(treeVideosClusterId, offset, treeVideosSortRef.current, treeVideosSearchRef.current);
    }, { rootMargin: '300px' });  // fire 300px before sentinel actually hits viewport
    obs.observe(el);
    return () => obs.disconnect();
  }, [treeVideosClusterId, treeVideosHasMore, fetchClusterVideos]);

  // Initial load + poll while a run is in progress
  useEffect(() => {
    if (adminSection !== 'tree') return;
    if (treeViewedClusterId == null) refetchTree();
    else refetchViewedCluster(treeViewedClusterId);
  }, [adminSection, treeViewedClusterId, refetchTree, refetchViewedCluster]);

  // Polling — different cadences depending on what's running:
  //   L1 grid view: 5s while a run is active, 30s otherwise (so a
  //     stale 'error' status line auto-heals if the run actually
  //     became 'running' via Resume L2 or a sibling tab)
  //   Drill-down view: poll while THIS cluster's subdivide is active OR
  //     while the global L2 baking is mid-flight on this parent
  useEffect(() => {
    if (adminSection !== 'tree') return;
    if (treeViewedClusterId == null) {
      const fast = treeData.run?.status === 'running';
      const iv = setInterval(refetchTree, fast ? 5_000 : 30_000);
      return () => clearInterval(iv);
    }
    // Drill-down: keep polling while children are being baked or the
    // active subdivide hasn't reached 'done'.
    const subRunning = treeViewedData?.subdivideRun?.status === 'running';
    if (!subRunning) return;
    const iv = setInterval(() => refetchViewedCluster(treeViewedClusterId), 5_000);
    return () => clearInterval(iv);
  }, [adminSection, treeViewedClusterId, treeData.run?.status, treeViewedData?.subdivideRun?.status, refetchTree, refetchViewedCluster]);

  const startTreeRun = async () => {
    setTreeStarting(true);
    setTreeError(null);
    try {
      const r = await fetch('/api/admin/niche-tree', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(treeParams),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) {
        setTreeError(d.error || `HTTP ${r.status}`);
      }
      // Always refetch so a 409 ("already running") shows the live
      // run instead of leaving the user on stale error data.
      await refetchTree();
    } catch (err) {
      setTreeError(err instanceof Error ? err.message : 'unknown');
    } finally {
      setTreeStarting(false);
    }
  };

  // Manual subdivide — used when an L1 card has no children yet (e.g.
  // baking failed or was never run for this cluster) or to re-bake.
  const subdivideCluster = async (clusterId: number) => {
    try {
      const r = await fetch(`/api/admin/niche-tree/cluster/${clusterId}/subdivide`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) {
        setTreeError(d.error || `HTTP ${r.status}`);
        return;
      }
      // Drill into the cluster — user will see the live progress
      setTreeViewedClusterId(clusterId);
    } catch (err) {
      setTreeError(err instanceof Error ? err.message : 'unknown');
    }
  };

  // Click on a cluster card — decides: drill into existing children,
  // or fire a subdivide if there are none yet.
  const onClusterCardClick = (c: TreeCluster) => {
    if (c.childrenCount > 0 || c.subdivideStatus === 'running') {
      setTreeViewedClusterId(c.id);
    } else if (c.videoCount >= 50) {
      // No children, big enough to subdivide → kick it off and drill in.
      subdivideCluster(c.id);
    } else {
      // Too small — nothing to do, but still let user open it (will show empty).
      setTreeViewedClusterId(c.id);
    }
  };

  // Agents tab state
  const [agentsData, setAgentsData] = useState<{
    totalActive: number;
    byKeyword: Array<{
      keyword: string; active: number; taskIds: string[];
      kind?: 'keyword' | 'seed' | 'unknown'; label?: string; seedUrls?: string[];
    }>;
    tasks: Array<{ id: string; keyword: string; startedAt: string | null }>;
  } | null>(null);
  const [agentsLoading, setAgentsLoading] = useState(false);
  const [agentsAutoRefresh, setAgentsAutoRefresh] = useState(true);
  const [agentsDeploy, setAgentsDeploy] = useState<DeployConfig>({
    keyword: '', threads: 2, apiKey: '', loopNumber: 30,
    maxSearchResults: 50, maxSuggestedResults: 50, rofeAPIKey: '',
    mode: 'keyword', seedUrl: '', nicheLabel: '', nicheId: '',
  });
  const [agentsDeployMsg, setAgentsDeployMsg] = useState<string | null>(null);

  // Admin tokens state
  const [adminTokens, setAdminTokens] = useState<Array<{ id: string; name: string; tokenPreview: string; lastUsedAt: string | null; createdAt: string }>>([]);
  const [newAdminToken, setNewAdminToken] = useState<string | null>(null);
  const [adminTokenCopied, setAdminTokenCopied] = useState(false);

  // Niche Explorer embedding state — API now reports all 3 targets separately
  type TargetStats = { totalVideos: number; embedded: number; notEmbedded: number };
  const [embeddingStats, setEmbeddingStats] = useState<{
    apiKeysConfigured: number; legacyModel: string; similaritySource?: 'title_v1' | 'title_v2' | 'thumbnail_v2';
    targets: { title_v1: TargetStats; title_v2: TargetStats; thumbnail_v2: TargetStats };
    job: { id: number; status: string; target?: string | null; total_needed: number; processed: number; errors: number; current_batch: number; total_batches: number; error_message: string | null; started_at: string; completed_at: string | null } | null;
    keys?: Array<{ key: string; proxy: string; banned: boolean; banExpiresIn: number | null }>;
    proxy?: { total: number; online: number; cached: boolean; cacheAge: number; current: { deviceId: string; networkType: string } | null };
    keywordCoverage?: Array<{
      keyword: string; total: number;
      title_v1: { embedded: number; pct: number };
      title_v2: { embedded: number; pct: number };
      thumbnail_v2: { embedded: number; pct: number };
    }>;
  } | null>(null);

  // Poll embedding progress
  useEffect(() => {
    // Both Niche Explorer + Enrich tabs render live-updating progress banners,
    // so poll when either is active.
    if (adminSection !== 'niche' && adminSection !== 'enrich') return;
    const fetchStats = () => {
      fetch('/api/niche-spy/embeddings').then(r => r.json()).then(setEmbeddingStats).catch(() => {});
      fetch('/api/niche-spy/enrich').then(r => r.json()).then(setNicheEnrichStats).catch(() => {});
      // Outlier enrichment counts — same cadence as the main enrich banner
      // so the admin sees the pipeline drain live.
      fetch('/api/admin/outliers/enrich-channels').then(r => r.json()).then(setOutlierStats).catch(() => {});
    };
    fetchStats();
    const iv = setInterval(fetchStats, 3000);
    return () => clearInterval(iv);
  }, [adminSection]);

  // DB stats
  const [stats, setStats] = useState<{
    total_videos: string; total_channels: string;
    total_sightings: string; total_collections: string;
  } | null>(null);

  // Visible tabs state
  const ALL_TABS = [
    { id: 'creator', label: 'Creator' },
    { id: 'library', label: 'Library' },
    { id: 'spy', label: 'Feed Spy' },
    { id: 'feed', label: 'Shorts Feed' },
    { id: 'clipping', label: 'Clipping' },
    { id: 'niche', label: 'Niche Explorer' },
  ];
  const [visibleTabs, setVisibleTabs] = useState<string[]>(['feed']);
  const [tabsSaving, setTabsSaving] = useState(false);
  const [tabsSaved, setTabsSaved] = useState(false);
  // Homepage override — when true, GET / 302s to /niche so end users
  // land on the niche grid instead of the product picker. Settled in
  // admin_config under `homepage_to_niche` ('true' | anything else).
  const [homepageToNiche, setHomepageToNiche] = useState(false);
  const [homepageSaving, setHomepageSaving] = useState(false);
  const [homepageSaved, setHomepageSaved] = useState(false);

  // Niche Explorer config
  const [nicheGoogleApiKeys, setNicheGoogleApiKeys] = useState('');
  const [nicheEmbeddingModel, setNicheEmbeddingModel] = useState('text-embedding-004');
  // Which embedding space all similarity searches read from.
  // title_v1 = legacy text (gemini-embedding-001), title_v2 = text (gemini-embedding-2-preview),
  // thumbnail_v2 = image embedding (gemini-embedding-2-preview).
  const [nicheSimilaritySource, setNicheSimilaritySource] = useState<'title_v1' | 'title_v2' | 'thumbnail_v2' | 'combined_v2'>('combined_v2');
  const [nicheBatchSize, setNicheBatchSize] = useState(50);
  const [nicheLimit, setNicheLimit] = useState(5000);
  const [nichePriorityKeywords, setNichePriorityKeywords] = useState('');
  const [nicheYtApiKeys, setNicheYtApiKeys] = useState('');
  const [nicheEnrichStats, setNicheEnrichStats] = useState<{
    need_enrichment: string; never_enriched: string; missing_likes: string; missing_subs: string;
    // New granular per-data-point breakdown. Each number ticks down live as the
    // enrichment walks Phase 1 (videos.list), Phase 2 (channels.list), Phase 3
    // (uploads playlist walk for first_upload_at).
    videos?: {
      total: number; neverEnriched: number; missingViews: number; missingLikes: number;
      missingComments: number; missingPostedAt: number; missingThumbnail: number; missingChannelId: number;
    };
    channels?: {
      total: number; missingRow: number; missingSubs: number; missingCreatedAt: number;
      missingPlaylistId: number; missingHandle: number; missingVideoCount: number;
      missingFirstUpload: number; tooBigForWalk: number; needMoreVideos: number;
    };
    proxyStats: { total: number; online: number };
    job: {
      id: number; status: string; keyword: string | null; threads: number;
      total_needed: number; processed: number; errors: number;
      current_batch: number; total_batches: number;
      enriched_videos: number; enriched_channels: number;
      error_message: string | null; started_at: string; completed_at: string | null;
    } | null;
    keys?: Array<{ key: string; proxy: string; banned: boolean; banExpiresIn: number | null }>;
  } | null>(null);
  const [enrichThreads, setEnrichThreads] = useState(2);

  // Outlier pipeline admin state — lives in the Enrich Data tab alongside
  // the existing bulk enrich controls.
  //   - outlierStats:  counts of channels enriched / pending for the
  //     recent-uploads walk. Populated from GET /api/admin/outliers/enrich-channels
  //   - outlierEnriching / outlierEnrichMsg: batch-run state
  //   - outlierRecomputing / outlierRecomputeMsg: score-compute state
  const [outlierStats, setOutlierStats] = useState<{ total: number; enriched: number; pending: number; stale: number } | null>(null);
  const [outlierEnriching, setOutlierEnriching] = useState(false);
  const [outlierEnrichMsg, setOutlierEnrichMsg] = useState<string | null>(null);
  const [outlierRecomputing, setOutlierRecomputing] = useState(false);
  const [outlierRecomputeMsg, setOutlierRecomputeMsg] = useState<string | null>(null);
  const [outlierLimit, setOutlierLimit] = useState(200);
  const [outlierThreads, setOutlierThreads] = useState(2);
  const [outlierMaxVideos, setOutlierMaxVideos] = useState(30);
  // Indefinite mode for the outlier-pipeline button. When true, the
  // server-side worker keeps re-fetching the pending queue and looping
  // batches until cancelled or the source table is fully enriched.
  const [outlierIndefinite, setOutlierIndefinite] = useState(false);
  const [enrichIndefinite, setEnrichIndefinite] = useState(false);

  // Novelty tab state. This is the "blue ocean" experiment — uses
  // combined title+thumbnail embeddings to find unique-and-viral videos.
  // Admin-only while we measure whether the signal is real.
  interface NoveltyVideo {
    id: number; url: string; title: string; viewCount: number;
    channelName: string | null; channelId: string | null;
    channelHandle: string | null; channelAvatar: string | null;
    subscriberCount: number | null; postedAt: string | null;
    likeCount: number; commentCount: number; thumbnail: string | null;
    keyword: string | null; noveltyScore: number | null;
    noveltyPercentile: number | null;
    peerOutlierScore: number | null; peerOutlierBucket: string | null;
    firstUploadAt: string | null; channelCreatedAt: string | null;
    dormancyDays: number | null; channelVideoCount: number | null;
    isShort: boolean;
  }
  const [noveltyVideos, setNoveltyVideos] = useState<NoveltyVideo[]>([]);
  const [noveltyTotal, setNoveltyTotal] = useState(0);
  const [noveltyLoading, setNoveltyLoading] = useState(false);
  const [noveltyDist, setNoveltyDist] = useState<{
    p50: number | null; p90: number | null; p99: number | null;
    min: number | null; max: number | null; total: number;
    lastUpdated: string | null;
  } | null>(null);
  const [noveltyRecomputing, setNoveltyRecomputing] = useState(false);
  const [noveltyRecomputeMsg, setNoveltyRecomputeMsg] = useState<string | null>(null);

  // Every filter is a standalone dial. Defaults are OFF so the admin gets
  // the raw unfiltered distribution first, then opts into each constraint
  // as they want to isolate a signal. 0 / 'any' / 'all' all mean "no filter."
  const [noveltyType, setNoveltyType] = useState<'any' | 'long' | 'short'>('any');
  const [noveltyMinPct, setNoveltyMinPct] = useState(0);
  const [noveltyMinViews, setNoveltyMinViews] = useState(0);
  const [noveltyMaxViews, setNoveltyMaxViews] = useState(0);
  const [noveltyMinOutlier, setNoveltyMinOutlier] = useState(0);
  const [noveltyMaxOutlier, setNoveltyMaxOutlier] = useState(0);
  const [noveltyMinSubs, setNoveltyMinSubs] = useState(0);
  const [noveltyMaxSubs, setNoveltyMaxSubs] = useState(0);
  const [noveltyPostedWithin, setNoveltyPostedWithin] = useState<'30' | '90' | '180' | '240' | '365' | 'all'>('all');
  const [noveltyChannelAge, setNoveltyChannelAge] =
    useState<'any' | 'brand_new' | '30' | '90' | '180' | '365' | 'established'>('any');
  // When true, hide videos whose channel has no computed peer_outlier_score.
  // Lets the admin inspect whether the outlier filter is actually improving
  // signal or just shrinking the set — compare `on` vs `off` side by side.
  const [noveltyRequireOutlier, setNoveltyRequireOutlier] = useState(false);
  // Sort mode — standalone knob so admin can rank by pure novelty, raw
  // views, outlier, recency, or the composite blue-ocean score.
  const [noveltySort, setNoveltySort] =
    useState<'blue_ocean' | 'novelty' | 'views' | 'outlier' | 'recency' | 'subs_asc' | 'channel_age_asc'>('blue_ocean');
  const [noveltyQ, setNoveltyQ] = useState('');
  const [noveltyQInput, setNoveltyQInput] = useState('');

  // ── Niche-discovery seed candidates ─────────────────────────────────
  // Live feed of videos that pass BOTH the novelty cutoff (top X%) AND
  // the content-gen channel-quality rules (A1-D2). Each row is a video
  // we'd seed xgodo bots from to auto-discover new niche territory.
  interface SeedCandidate {
    video_id: number;
    video_url: string;
    video_title: string | null;
    video_thumbnail: string | null;
    view_count: number;
    posted_at: string | null;
    novelty_score: number;
    novelty_percentile: number | null;
    channel: {
      channel_id: string;
      channel_name: string | null;
      channel_handle: string | null;
      channel_avatar: string | null;
      subscriber_count: number;
      channel_age_days: number;
      age_tier: 'mature' | 'mid_young' | 'young' | 'ultra_young';
      channel_top_views: number;
      views_to_subs_ratio: number;
      composite_score: number;
    };
    seed_score: number;
    components: { isolation: number; channel_quality: number; traction: number };
  }
  const [seedCandidates, setSeedCandidates] = useState<SeedCandidate[]>([]);
  const [seedLoading, setSeedLoading]       = useState(false);
  const [seedError, setSeedError]           = useState<string | null>(null);
  const [seedMinPct, setSeedMinPct]         = useState(80);
  const [seedTopK, setSeedTopK]             = useState(30);
  const [seedLongFormOnly, setSeedLongFormOnly] = useState(false);
  const [seedPool, setSeedPool] = useState<{
    total_videos_with_novelty: number;
    novelty_cutoff_used: number | null;
    videos_above_cutoff: number;
    seeds_after_channel_rules: number;
  } | null>(null);

  const fetchSeedCandidates = useCallback(async () => {
    setSeedLoading(true);
    setSeedError(null);
    try {
      const qs = new URLSearchParams({
        topK: String(seedTopK),
        minNoveltyPct: String(seedMinPct),
        ...(seedLongFormOnly ? { longFormOnly: 'true' } : {}),
      });
      const r = await fetch(`/api/admin/content-gen/seed-candidates?${qs}`).then(r => r.json());
      if (!r.ok) throw new Error(r.error || 'seed-candidates failed');
      setSeedCandidates(r.seeds || []);
      setSeedPool(r.pool ?? null);
    } catch (e) {
      setSeedError((e as Error).message);
    } finally {
      setSeedLoading(false);
    }
  }, [seedTopK, seedMinPct, seedLongFormOnly]);

  // Re-fetch when params change OR when the novelty tab activates
  useEffect(() => {
    if (adminSection !== 'novelty') return;
    void fetchSeedCandidates();
  }, [adminSection, fetchSeedCandidates]);

  // Debounce the text search
  useEffect(() => {
    const h = setTimeout(() => setNoveltyQ(noveltyQInput.trim()), 300);
    return () => clearTimeout(h);
  }, [noveltyQInput]);

  const fetchNoveltyVideos = useCallback(async () => {
    setNoveltyLoading(true);
    try {
      const params = new URLSearchParams({ limit: '60' });
      params.set('sort', noveltySort);
      params.set('type', noveltyType);
      if (noveltyMinPct     > 0) params.set('minNoveltyPct', String(noveltyMinPct));
      if (noveltyMinViews   > 0) params.set('minViews',      String(noveltyMinViews));
      if (noveltyMaxViews   > 0) params.set('maxViews',      String(noveltyMaxViews));
      if (noveltyMinOutlier > 0) params.set('minOutlier',    String(noveltyMinOutlier));
      if (noveltyMaxOutlier > 0) params.set('maxOutlier',    String(noveltyMaxOutlier));
      if (noveltyMinSubs    > 0) params.set('minSubs',       String(noveltyMinSubs));
      if (noveltyMaxSubs    > 0) params.set('maxSubs',       String(noveltyMaxSubs));
      if (noveltyRequireOutlier) params.set('requireOutlier', 'true');
      // Recency: 'all' sends empty string (server interprets as no filter).
      // Any other value passes through as a day count.
      if (noveltyPostedWithin === 'all') params.set('postedWithin', '');
      else params.set('postedWithin', noveltyPostedWithin);
      // Channel-age presets mapped to numeric bounds.
      switch (noveltyChannelAge) {
        case 'brand_new':   params.set('maxChannelAge', '30'); break;
        case '30':          params.set('maxChannelAge', '30'); break;
        case '90':          params.set('maxChannelAge', '90'); break;
        case '180':         params.set('maxChannelAge', '180'); break;
        case '365':         params.set('maxChannelAge', '365'); break;
        case 'established': params.set('minChannelAge', '365'); break;
      }
      if (noveltyQ) params.set('q', noveltyQ);
      const res = await fetch(`/api/admin/novelty/videos?${params}`);
      const data = await res.json();
      setNoveltyVideos(data.videos || []);
      setNoveltyTotal(data.total || 0);
    } catch (err) { console.error('[novelty] fetch err', err); }
    setNoveltyLoading(false);
  }, [
    noveltyMinPct, noveltyMinViews, noveltyMaxViews,
    noveltyMinOutlier, noveltyMaxOutlier,
    noveltyMinSubs, noveltyMaxSubs,
    noveltyType, noveltyPostedWithin, noveltyChannelAge,
    noveltyRequireOutlier, noveltySort, noveltyQ,
  ]);

  const fetchNoveltyDist = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/novelty/recompute');
      const data = await res.json();
      setNoveltyDist(data.distribution || null);
    } catch { /* swallow */ }
  }, []);

  // Refetch whenever the tab is open and any filter changes.
  useEffect(() => {
    if (adminSection !== 'novelty') return;
    fetchNoveltyDist();
    fetchNoveltyVideos();
  }, [adminSection, fetchNoveltyVideos, fetchNoveltyDist]);

  const runNoveltyRecompute = async () => {
    if (!confirm('Recompute novelty scores for every v2-embedded video? Can take a few minutes.')) return;
    setNoveltyRecomputing(true);
    setNoveltyRecomputeMsg(null);
    try {
      const res = await fetch('/api/admin/novelty/recompute', { method: 'POST' });
      const data = await res.json();
      if (data.ok) {
        setNoveltyRecomputeMsg(
          `Scored ${data.scored} in ${(data.durationMs / 1000).toFixed(1)}s · ` +
          `p50=${data.distribution?.p50?.toFixed(3) ?? '-'} · p90=${data.distribution?.p90?.toFixed(3) ?? '-'} · p99=${data.distribution?.p99?.toFixed(3) ?? '-'}`
        );
        setNoveltyDist(data.distribution || null);
        fetchNoveltyVideos();
      } else {
        setNoveltyRecomputeMsg(`Error: ${data.error || 'unknown'}`);
      }
    } catch (err) {
      setNoveltyRecomputeMsg(`Error: ${err instanceof Error ? err.message : 'network'}`);
    }
    setNoveltyRecomputing(false);
  };

  const runOutlierEnrich = async () => {
    setOutlierEnriching(true);
    setOutlierEnrichMsg(null);

    // Indef mode: hand off to the server-side agent endpoint and poll
    // its status until done/cancelled. Keeps the loop running even if
    // the operator closes the tab.
    if (outlierIndefinite) {
      try {
        const startRes = await fetch('/api/admin/outliers/enrich-channels/agent', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            limit: outlierLimit,
            threads: outlierThreads,
            maxVideos: outlierMaxVideos,
            indefinite: true,
            cancelExisting: true,
          }),
        });
        if (!startRes.ok) {
          const d = await startRes.json().catch(() => ({}));
          setOutlierEnrichMsg(`Error: ${d.error || `HTTP ${startRes.status}`}`);
          setOutlierEnriching(false);
          return;
        }
        // Poll until terminal state. Refresh both the agent status
        // (for live progress text) and the outlier counts box.
        for (;;) {
          await new Promise(r => setTimeout(r, 4000));
          const sRes = await fetch('/api/admin/outliers/enrich-channels/agent');
          const s = await sRes.json();
          if (s.status === 'done' || s.status === 'cancelled' || s.status === 'error') {
            setOutlierEnrichMsg(
              `${s.status === 'done' ? 'Done' : s.status === 'cancelled' ? 'Cancelled' : 'Error'}: ` +
              `${s.processed} processed · ${s.withStats} with stats · ${s.errors} errors · ${s.loops} loops`
            );
            break;
          }
          setOutlierEnrichMsg(
            `Loop ${s.loops + 1} · ${s.processed} processed · ${s.withStats} with stats · ` +
            `${s.errors} errors · ${s.percentComplete}%`
          );
          fetch('/api/admin/outliers/enrich-channels').then(r => r.json()).then(setOutlierStats).catch(() => {});
        }
        // Final recompute so new unbiased avgs feed the score.
        await runOutlierRecompute();
      } catch (err) {
        setOutlierEnrichMsg(`Error: ${err instanceof Error ? err.message : 'network'}`);
      }
      setOutlierEnriching(false);
      return;
    }

    let totalProcessed = 0, totalWithStats = 0, totalErrors = 0;
    try {
      // Loop batches of `limit` channels. Stops when the server returns
      // processed=0 (queue drained) or after 40 batches (safety cap).
      for (let batchIdx = 0; batchIdx < 40; batchIdx++) {
        const res = await fetch('/api/admin/outliers/enrich-channels', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            limit: outlierLimit,
            threads: outlierThreads,
            maxVideos: outlierMaxVideos,
          }),
        });
        const data = await res.json();
        if (!data.ok) { setOutlierEnrichMsg(`Error: ${data.error || 'unknown'}`); break; }
        totalProcessed += data.processed;
        totalWithStats += data.withStats;
        totalErrors    += data.errors;
        setOutlierEnrichMsg(`Batch ${batchIdx + 1}: ${totalProcessed} processed · ${totalWithStats} with stats · ${totalErrors} errors`);
        // Refresh stats so the live pending-count ticks down.
        fetch('/api/admin/outliers/enrich-channels').then(r => r.json()).then(setOutlierStats).catch(() => {});
        if (data.processed === 0) break;
      }
      setOutlierEnrichMsg(`Done: ${totalProcessed} processed · ${totalWithStats} with stats · ${totalErrors} errors`);
      // Auto-run recompute so the new unbiased avgs take effect immediately.
      await runOutlierRecompute();
    } catch (err) {
      setOutlierEnrichMsg(`Error: ${err instanceof Error ? err.message : 'network'}`);
    }
    setOutlierEnriching(false);
  };

  const runOutlierRecompute = async () => {
    setOutlierRecomputing(true);
    setOutlierRecomputeMsg(null);
    try {
      const res = await fetch('/api/admin/outliers/recompute', { method: 'POST' });
      const data = await res.json();
      if (data.ok) {
        const bucketSummary = (data.buckets || [])
          .map((b: { bucket: string; n: number; maxScore: number | null }) =>
            `${b.bucket}: ${b.n} (max ${b.maxScore ? b.maxScore.toFixed(1) : '-'}x)`
          ).join(' · ');
        setOutlierRecomputeMsg(
          `Scored ${data.channelsScored} channels in ${(data.durationMs / 1000).toFixed(1)}s — ${bucketSummary}`
        );
      } else {
        setOutlierRecomputeMsg(`Error: ${data.error || 'unknown'}`);
      }
    } catch (err) {
      setOutlierRecomputeMsg(`Error: ${err instanceof Error ? err.message : 'network'}`);
    }
    setOutlierRecomputing(false);
  };
  const [enrichBatchSize, setEnrichBatchSize] = useState(50);
  const [enrichLimit, setEnrichLimit] = useState(2000);
  // Legacy/compat — kept so other places that reference nicheThreads still compile
  const [nicheThreads, setNicheThreads] = useState(2);

  // Vizard tab state — API key lives in admin_config (vizard_api_key).
  // `projects` is the full list returned by GET /api/admin/vizard/projects
  // (newest first). While any project is processing, a 30s poll fires the
  // tick route + refetches the list so clip counts update live.
  const [vizardApiKey, setVizardApiKey] = useState('');
  const [vizardUrl, setVizardUrl] = useState('');
  const [vizardPreferLength, setVizardPreferLength] = useState<number[]>([0]);
  const [vizardLang, setVizardLang] = useState('auto');
  const [vizardSubmitting, setVizardSubmitting] = useState(false);
  const [vizardSubmitError, setVizardSubmitError] = useState('');
  interface VizardClipRow {
    id: number;
    vizardVideoId: string | null;
    videoUrl: string | null;
    durationMs: number | null;
    title: string | null;
    viralScore: string | null;
    viralReason: string | null;
    relatedTopic: string | null;
    clipEditorUrl: string | null;
    // YT-upload tracking (lightweight subset; full reporting on Uploads view).
    xgodoUploadStatus?: 'queued' | 'running' | 'uploaded' | 'confirmed' | 'failed' | 'declined' | null;
    xgodoUploadId?: string | null;
    xgodoDeviceName?: string | null;
    xgodoFinishedAt?: string | null;
    xgodoFailureComment?: string | null;
    xgodoFailureScreenshotUrl?: string | null;
    youtubeUrl?: string | null;
    youtubeViewCount?: number | null;
    youtubeLikeCount?: number | null;
    youtubeCommentCount?: number | null;
    youtubeViewsFetchedAt?: string | null;
  }
  interface VizardProjectRow {
    id: number;
    vizardProjectId: string | null;
    videoUrl: string;
    videoType: number;
    lang: string;
    preferLength: number[];
    status: 'pending' | 'processing' | 'done' | 'error';
    errorMessage: string | null;
    lastCode: number | null;
    clipCount: number;
    createdAt: string;
    lastPolledAt: string | null;
    completedAt: string | null;
    clips: VizardClipRow[];
  }
  const [vizardProjects, setVizardProjects] = useState<VizardProjectRow[]>([]);
  const [vizardLoading, setVizardLoading] = useState(false);
  // Which clip ids currently have their preview expanded. Collapsed rows show
  // title/score/duration only so 40+ clips don't all preload bytes at once.
  // A Set makes toggle O(1) and keeps React's diff cheap.
  const [expandedClipIds, setExpandedClipIds] = useState<Set<number>>(new Set());
  const toggleClipExpanded = (id: number) => {
    setExpandedClipIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  // YT-upload reporting view (sub-tab within Vizard).
  // 'projects' (the existing clip browser), 'uploads' (per-clip reporting),
  // or 'devices' (group every task under its xgodo worker so we can spot
  // devices that need attention — SMS verif, login lost, repeat failures).
  const [vizardView, setVizardView] = useState<'projects' | 'uploads' | 'devices'>('projects');
  interface VizardUploadRow {
    clipId: number;
    projectId: number;
    clipTitle: string | null;
    uploadTitle: string | null;
    uploadDescription: string | null;
    sourceVideoUrl: string | null;
    durationMs: number | null;
    viralScore: string | null;
    plannedTaskId: string | null;
    jobTaskId: string | null;
    status: 'queued' | 'running' | 'uploaded' | 'confirmed' | 'failed' | 'declined';
    deviceId: string | null;
    deviceName: string | null;
    workerId: string | null;
    workerName: string | null;
    submittedAt: string | null;
    startedAt: string | null;
    finishedAt: string | null;
    lastPolledAt: string | null;
    error: string | null;
    failureComment: string | null;
    failureScreenshotUrl: string | null;
    youtubeUrl: string | null;
    youtubeViewCount: number | null;
    youtubeLikeCount: number | null;
    youtubeCommentCount: number | null;
    youtubeViewsFetchedAt: string | null;
    projectUrl: string;
  }
  interface VizardUploadSummary {
    queued: number; running: number; uploaded: number;
    confirmed: number; failed: number; declined: number;
  }
  const [vizardUploads, setVizardUploads] = useState<VizardUploadRow[]>([]);
  const [vizardUploadSummary, setVizardUploadSummary] = useState<VizardUploadSummary | null>(null);
  const [vizardUploadFilter, setVizardUploadFilter] = useState<'' | VizardUploadRow['status']>('');
  const [vizardUploadsRefreshing, setVizardUploadsRefreshing] = useState(false);

  const refetchVizardUploads = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (vizardUploadFilter) params.set('status', vizardUploadFilter);
      const r = await fetch(`/api/admin/vizard/uploads?${params}`);
      const d = await r.json();
      setVizardUploads(d.uploads || []);
      setVizardUploadSummary(d.summary || null);
    } catch { /* swallow */ }
  }, [vizardUploadFilter]);

  // Devices view (sub-tab #3 within Vizard). Aggregates all xgodo
  // upload tasks by worker device so we can see per-device history,
  // health, and the per-(job, device) bucket xgodo holds (login state,
  // account info, etc.) — pulled via the new
  // GET /api/v2/bucket/:job_id endpoint.
  interface VizardDeviceTask {
    clipId: number; projectId: number; projectUrl: string | null;
    title: string | null; status: string | null;
    plannedTaskId: string | null; jobTaskId: string | null;
    submittedAt: string | null; startedAt: string | null; finishedAt: string | null;
    durationSec: number | null;
    failureComment: string | null; failureScreenshotUrl: string | null;
    error: string | null;
    youtubeUrl: string | null;
    viewCount: number | null; likeCount: number | null; commentCount: number | null;
    viralScore: string | null;
    accountEmail: string | null;
  }
  interface VizardDeviceAccount {
    email: string;
    channelId: string | null; channelTitle: string | null; customUrl: string | null;
    subscriberCount: number | null; channelViewCount: number | null;
    videoCount: number | null;
    fetchedAt: string | null;
    uploadsOnDevice: number;
  }
  interface VizardDeviceRecord {
    deviceId: string; deviceName: string | null;
    workerId: string | null; workerName: string | null;
    stats: {
      total: number;
      byStatus: { queued: number; running: number; uploaded: number; confirmed: number; failed: number; declined: number; other: number };
      succeeded: number; finalFailures: number; successRate: number;
      avgDurationSec: number | null;
      totalViews: number; totalLikes: number; totalComments: number;
      lastActivityAt: string | null;
      last24h: { total: number; succeeded: number; failed: number };
    };
    bucket: { data: Record<string, unknown> | null; updatedAt: string | null; missing: boolean };
    accounts: VizardDeviceAccount[];
    recentTasks: VizardDeviceTask[];
    needsAttention: boolean; attentionReason: string | null;
  }
  interface VizardDevicesOverall {
    devices: number; needsAttention: number;
    totalUploaded: number; totalFailed: number; totalViews: number;
  }
  const [vizardDevices, setVizardDevices] = useState<VizardDeviceRecord[]>([]);
  const [vizardDevicesOverall, setVizardDevicesOverall] = useState<VizardDevicesOverall | null>(null);
  const [vizardDevicesBucketError, setVizardDevicesBucketError] = useState<string | null>(null);
  const [vizardDevicesLoading, setVizardDevicesLoading] = useState(false);
  // Which device cards are expanded (showing the recent-tasks list).
  const [expandedDeviceIds, setExpandedDeviceIds] = useState<Set<string>>(new Set());

  const refetchVizardDevices = useCallback(async () => {
    setVizardDevicesLoading(true);
    try {
      const r = await fetch('/api/admin/vizard/devices');
      const d = await r.json();
      setVizardDevices(d.devices || []);
      setVizardDevicesOverall(d.overall || null);
      setVizardDevicesBucketError(d.bucketError || null);
    } catch { /* swallow */ }
    finally { setVizardDevicesLoading(false); }
  }, []);

  // Force-refresh per-account YT channel + subscriber data via Data API.
  // Calls /api/admin/vizard/accounts/refresh which uses the same key/proxy
  // pool as clip-view refresh — ~2 quota units per ~50 accounts.
  const [vizardAccountsRefreshing, setVizardAccountsRefreshing] = useState(false);
  const refreshVizardAccountsSubs = useCallback(async () => {
    setVizardAccountsRefreshing(true);
    try {
      const r = await fetch('/api/admin/vizard/accounts/refresh', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force: true }),
      });
      const d = await r.json();
      console.log('[accounts refresh]', d);
      await refetchVizardDevices();
    } catch (err) {
      console.error('accounts refresh err', err);
    } finally {
      setVizardAccountsRefreshing(false);
    }
  }, [refetchVizardDevices]);

  // Per-clip upload tracking — set of clip ids currently being submitted, so
  // the button shows "Sending..." and disables during the round trip.
  const [uploadingClipIds, setUploadingClipIds] = useState<Set<number>>(new Set());
  const [uploadDescription, setUploadDescription] = useState('');

  // Refresh YT view counts for uploaded clips. Hits videos.list?part=statistics
  // via /api/admin/vizard/clips/refresh-views — 1 quota unit per 50 clips.
  const [refreshingViews, setRefreshingViews] = useState(false);
  const refreshClipViews = async (clipIds?: number[]) => {
    setRefreshingViews(true);
    try {
      const res = await fetch('/api/admin/vizard/clips/refresh-views', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clipIds, force: !!clipIds }),
      });
      const data = await res.json();
      console.log('[refresh-views]', data);
      // Re-pull projects so the new view counts show up on the row.
      const r = await fetch('/api/admin/vizard/projects');
      const d = await r.json();
      if (d.projects) setVizardProjects(d.projects);
      refetchVizardUploads();
    } catch (err) {
      console.error('refresh-views err', err);
    } finally {
      setRefreshingViews(false);
    }
  };

  // Streaming "refresh ALL view counts" — drives a progress bar by reading
  // SSE events from /refresh-views/stream. force=true so the staleness
  // gate doesn't skip recently-fetched rows. Reuses the existing endpoint
  // pattern for per-project refreshes; this one just hits no clipIds so
  // every uploaded clip is in scope.
  const [refreshAllStatus, setRefreshAllStatus] = useState<{
    running: boolean;
    totalBatches: number;
    completedBatches: number;
    totalClips: number;
    updated: number;
    errors: number;
    calls: number;
    error: string | null;
    finishedAt: number | null;
  }>({ running: false, totalBatches: 0, completedBatches: 0, totalClips: 0, updated: 0, errors: 0, calls: 0, error: null, finishedAt: null });

  const refreshAllClipViews = async () => {
    if (refreshAllStatus.running) return;
    setRefreshAllStatus({
      running: true, totalBatches: 0, completedBatches: 0, totalClips: 0,
      updated: 0, errors: 0, calls: 0, error: null, finishedAt: null,
    });
    try {
      const res = await fetch('/api/admin/vizard/clips/refresh-views/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force: true }),  // ignore staleness; refresh everything
      });
      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => '');
        setRefreshAllStatus(s => ({ ...s, running: false, error: `HTTP ${res.status}: ${text.slice(0, 200)}`, finishedAt: Date.now() }));
        return;
      }

      // Parse SSE stream. Each event has shape:
      //   event: <name>\ndata: <json>\n\n
      // We accumulate bytes in `buffer`, split on the blank-line delimiter,
      // then route each event to the matching status update.
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split('\n\n');
        buffer = events.pop() ?? '';  // keep the trailing partial event
        for (const ev of events) {
          if (!ev.trim()) continue;
          const eventLine = ev.split('\n').find(l => l.startsWith('event:'));
          const dataLine  = ev.split('\n').find(l => l.startsWith('data:'));
          if (!eventLine || !dataLine) continue;
          const name = eventLine.slice('event:'.length).trim();
          const data = JSON.parse(dataLine.slice('data:'.length).trim());
          if (name === 'progress') {
            setRefreshAllStatus(s => ({ ...s, ...data }));
          } else if (name === 'done') {
            setRefreshAllStatus(s => ({ ...s, ...data, running: false, finishedAt: Date.now() }));
          } else if (name === 'error') {
            setRefreshAllStatus(s => ({ ...s, running: false, error: data.error || 'unknown', finishedAt: Date.now() }));
          }
        }
      }

      // Re-pull projects so the new view counts show up on the cards.
      const r = await fetch('/api/admin/vizard/projects');
      const d = await r.json();
      if (d.projects) setVizardProjects(d.projects);
      refetchVizardUploads();
    } catch (err) {
      setRefreshAllStatus(s => ({ ...s, running: false, error: (err as Error).message, finishedAt: Date.now() }));
    }
  };

  // Per-clip delete — used when Vizard returned a bad source clip (wrong
  // video, corrupted file, etc.) and we want to drop it from our DB so it
  // stops appearing in the project list and skewing reports. Local-only:
  // does not cancel/delete any xgodo task tied to this clip.
  const deleteClip = async (clipId: number, title: string | null) => {
    const confirmed = window.confirm(
      `Delete this clip from the project?\n\n"${title || '(no title)'}"\n\nThis only removes it from rofe.ai — any xgodo upload it triggered is left alone.`
    );
    if (!confirmed) return;
    try {
      const r = await fetch(`/api/admin/vizard/clips/${clipId}`, { method: 'DELETE' });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        alert(`Delete failed: ${d.error || r.status}`);
        return;
      }
      // Refresh project list so the row disappears.
      const pj = await fetch('/api/admin/vizard/projects');
      const pd = await pj.json();
      if (pd.projects) setVizardProjects(pd.projects);
      // If the Uploads view is also open, refetch that too so the row
      // disappears there as well.
      refetchVizardUploads();
    } catch (err) {
      alert(`Delete failed: ${err instanceof Error ? err.message : 'unknown'}`);
    }
  };

  const sendClipsToYouTube = async (clipIds: number[]) => {
    if (clipIds.length === 0) return;
    setUploadingClipIds(prev => {
      const next = new Set(prev);
      for (const id of clipIds) next.add(id);
      return next;
    });
    try {
      const res = await fetch('/api/admin/vizard/upload-to-yt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clipIds, description: uploadDescription }),
      });
      const data = await res.json();
      console.log('[upload-to-yt]', data);
      // Pull the project list so submitted clips show their new "queued" badge,
      // and the uploads list if we're already viewing it.
      const r = await fetch('/api/admin/vizard/projects');
      const d = await r.json();
      if (d.projects) setVizardProjects(d.projects);
      refetchVizardUploads();
    } catch (err) {
      console.error('upload err', err);
    } finally {
      setUploadingClipIds(prev => {
        const next = new Set(prev);
        for (const id of clipIds) next.delete(id);
        return next;
      });
    }
  };

  // Poll the uploads endpoint while the Uploads view is open. The cron is
  // the source of truth for status changes; this just surfaces them
  // promptly in the UI.
  useEffect(() => {
    if (adminSection !== 'vizard') return;
    if (vizardView !== 'uploads') return;
    refetchVizardUploads();
    const iv = setInterval(refetchVizardUploads, 15_000);
    return () => clearInterval(iv);
  }, [adminSection, vizardView, refetchVizardUploads]);

  // Same pattern for the Devices view. Slightly slower poll (30s) since
  // device-level aggregates change less often than per-clip status, and
  // each refresh also pulls all job-level buckets from xgodo.
  useEffect(() => {
    if (adminSection !== 'vizard') return;
    if (vizardView !== 'devices') return;
    refetchVizardDevices();
    const iv = setInterval(refetchVizardDevices, 30_000);
    return () => clearInterval(iv);
  }, [adminSection, vizardView, refetchVizardDevices]);

  // Vizard tab — UI refresh only. The actual Vizard polling is now done by
  // the server-side cron at /api/cron/vizard (every 60s), so projects make
  // progress whether or not this tab is open. This effect just refetches
  // the project list periodically so the UI shows up-to-date statuses
  // while the user is looking at it. No tick triggers from the client —
  // closing the tab no longer leaves projects stranded.
  useEffect(() => {
    if (adminSection !== 'vizard') return;
    let cancelled = false;
    const refetch = async () => {
      try {
        const r = await fetch('/api/admin/vizard/projects');
        const d = await r.json();
        if (!cancelled && d.projects) setVizardProjects(d.projects);
      } catch { /* swallow */ }
    };
    setVizardLoading(true);
    refetch().finally(() => { if (!cancelled) setVizardLoading(false); });

    const iv = setInterval(refetch, 15_000);
    return () => { cancelled = true; clearInterval(iv); };
  }, [adminSection]);

  const submitVizardUrl = async () => {
    setVizardSubmitError('');
    const url = vizardUrl.trim();
    if (!url) { setVizardSubmitError('Paste a video URL first'); return; }
    setVizardSubmitting(true);
    try {
      const res = await fetch('/api/admin/vizard/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ videoUrl: url, preferLength: vizardPreferLength, lang: vizardLang }),
      });
      const data = await res.json();
      if (!res.ok) {
        setVizardSubmitError(data.error || `HTTP ${res.status}`);
      } else {
        setVizardUrl('');
        // Refetch so the new "pending" row appears immediately.
        const r = await fetch('/api/admin/vizard/projects');
        const d = await r.json();
        if (d.projects) setVizardProjects(d.projects);
      }
    } catch (err) {
      setVizardSubmitError(err instanceof Error ? err.message : 'submission failed');
    } finally {
      setVizardSubmitting(false);
    }
  };

  const deleteVizardProject = async (id: number) => {
    if (!confirm('Delete this project and its clips? Vizard clips expire in 7 days anyway.')) return;
    await fetch(`/api/admin/vizard/projects?id=${id}`, { method: 'DELETE' });
    setVizardProjects(prev => prev.filter(p => p.id !== id));
  };

  // Config state
  const [xgodoToken, setXgodoToken] = useState('');
  const [nicheSpyToken, setNicheSpyToken] = useState('');
  const [xgodoJobId, setXgodoJobId] = useState('');
  const [xgodoProxyHost, setXgodoProxyHost] = useState('54.36.178.74');
  const [xgodoProxyPort, setXgodoProxyPort] = useState('1082');
  const [channelCheckApiKey, setChannelCheckApiKey] = useState('');
  const [configSaving, setConfigSaving] = useState(false);
  const [configSaved, setConfigSaved] = useState(false);

  // Schedule state
  const [schedNumVideos, setSchedNumVideos] = useState(20);
  const [schedFetchAge, setSchedFetchAge] = useState(true);
  const [schedYoutubeKey, setSchedYoutubeKey] = useState('');
  const [schedFetchVideoCount, setSchedFetchVideoCount] = useState(false);
  const [schedTaskCount, setSchedTaskCount] = useState(1);
  const [scheduling, setScheduling] = useState(false);
  const [scheduleResult, setScheduleResult] = useState<{ scheduled: number } | null>(null);
  const [scheduleError, setScheduleError] = useState('');

  // Auto-schedule state
  const [autoSchedEnabled, setAutoSchedEnabled] = useState(false);
  const [autoSchedInterval, setAutoSchedInterval] = useState('60');
  const [autoSchedTaskCount, setAutoSchedTaskCount] = useState('10');
  const [autoSchedNumVideos, setAutoSchedNumVideos] = useState('20');
  const [autoSchedFetchAge, setAutoSchedFetchAge] = useState(true);
  const [autoSchedFetchVideoCount, setAutoSchedFetchVideoCount] = useState(false);
  const [lastAutoSchedule, setLastAutoSchedule] = useState<{ at: string; result: { scheduled: number; error?: string } } | null>(null);

  // Users state
  interface UserRow {
    id: string;
    name: string | null;
    email: string;
    image: string | null;
    created_at: string;
    last_login: string;
    channels_seen: number;
    last_active: string | null;
  }
  const [users, setUsers] = useState<UserRow[]>([]);

  // Fetch avatars state
  const [fetchingAvatars, setFetchingAvatars] = useState(false);
  const [avatarResult, setAvatarResult] = useState<{ fetched: number; total: number; message?: string } | null>(null);
  const [avatarError, setAvatarError] = useState('');

  // Check auth on mount
  useEffect(() => {
    fetch('/api/admin/auth')
      .then(res => res.json())
      .then(data => {
        if (data.authenticated) setAuthenticated(true);
      })
      .finally(() => setChecking(false));
  }, []);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginError('');

    const res = await fetch('/api/admin/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();

    if (data.success) {
      setAuthenticated(true);
      fetchStats();
    } else {
      setLoginError('Invalid credentials');
    }
  };

  const fetchConfig = async () => {
    try {
      const res = await fetch('/api/admin/config');
      const data = await res.json();
      if (data.config) {
        setXgodoToken(data.config.xgodo_api_token || '');
        setNicheSpyToken(data.config.xgodo_niche_spy_token || '');
        setVizardApiKey(data.config.vizard_api_key || '');
        setNicheGoogleApiKeys(data.config.niche_google_api_keys || '');
        setNicheEmbeddingModel(data.config.niche_embedding_model || 'text-embedding-004');
        const src = data.config.niche_similarity_source;
        if (src === 'title_v1' || src === 'title_v2' || src === 'thumbnail_v2' || src === 'combined_v2') setNicheSimilaritySource(src);
        else setNicheSimilaritySource('combined_v2');
        setNichePriorityKeywords(data.config.niche_priority_keywords || '');
        setNicheYtApiKeys(data.config.niche_yt_api_keys || '');
        setXgodoJobId(data.config.xgodo_shorts_spy_job_id || '');
        setXgodoProxyHost(data.config.xgodo_proxy_host || '54.36.178.74');
        setXgodoProxyPort(data.config.xgodo_proxy_port || '1082');
        setChannelCheckApiKey(data.config.channel_check_api_key || '');
        setSchedYoutubeKey(data.config.youtube_api_key || '');
        // Auto-schedule config
        setAutoSchedEnabled(data.config.auto_schedule_enabled === 'true');
        setAutoSchedInterval(data.config.auto_schedule_interval_minutes || '60');
        setAutoSchedTaskCount(data.config.auto_schedule_task_count || '10');
        setAutoSchedNumVideos(data.config.auto_schedule_num_videos || '20');
        setAutoSchedFetchAge(data.config.auto_schedule_fetch_age !== 'false');
        setAutoSchedFetchVideoCount(data.config.auto_schedule_fetch_video_count === 'true');
        if (data.config.last_auto_schedule_at) {
          try {
            setLastAutoSchedule({
              at: data.config.last_auto_schedule_at,
              result: JSON.parse(data.config.last_auto_schedule_result || '{}'),
            });
          } catch { /* skip */ }
        }
        try {
          if (data.config.visible_tabs) setVisibleTabs(JSON.parse(data.config.visible_tabs));
        } catch {}
        setHomepageToNiche(data.config.homepage_to_niche === 'true');
      }
    } catch (err) {
      console.error('Failed to fetch config:', err);
    }
  };

  const handleSchedule = async () => {
    setScheduling(true);
    setScheduleResult(null);
    setScheduleError('');

    try {
      const res = await fetch('/api/admin/schedule', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          numVideos: schedNumVideos,
          fetchChannelAge: schedFetchAge,
          youtubeApiKey: schedYoutubeKey,
          fetchChannelVideoCount: schedFetchVideoCount,
          taskCount: schedTaskCount,
        }),
      });
      const data = await res.json();

      if (data.success) {
        setScheduleResult({ scheduled: data.scheduled });
      } else {
        setScheduleError(data.error || 'Failed to schedule');
      }
    } catch (err) {
      setScheduleError(err instanceof Error ? err.message : 'Failed to schedule');
    } finally {
      setScheduling(false);
    }
  };

  const saveAutoSchedConfig = async (overrides: Record<string, string>) => {
    await fetch('/api/admin/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: overrides }),
    });
  };

  const formatTimeAgo = (iso: string) => {
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  };

  const saveConfig = async () => {
    setConfigSaving(true);
    setConfigSaved(false);
    try {
      await fetch('/api/admin/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          config: {
            xgodo_api_token: xgodoToken,
            xgodo_niche_spy_token: nicheSpyToken,
            vizard_api_key: vizardApiKey,
            xgodo_proxy_host: xgodoProxyHost,
            xgodo_proxy_port: xgodoProxyPort,
            niche_google_api_keys: nicheGoogleApiKeys,
            niche_embedding_model: nicheEmbeddingModel,
            niche_similarity_source: nicheSimilaritySource,
            niche_priority_keywords: nichePriorityKeywords,
            niche_yt_api_keys: nicheYtApiKeys,
            xgodo_shorts_spy_job_id: xgodoJobId,
            channel_check_api_key: channelCheckApiKey,
            youtube_api_key: schedYoutubeKey,
          },
        }),
      });
      setConfigSaved(true);
      setTimeout(() => setConfigSaved(false), 3000);
    } catch (err) {
      console.error('Failed to save config:', err);
    } finally {
      setConfigSaving(false);
    }
  };

  const fetchStats = async () => {
    try {
      const res = await fetch('/api/feed-spy?limit=0');
      const data = await res.json();
      if (data.stats) setStats(data.stats);
    } catch (err) {
      console.error('Failed to fetch stats:', err);
    }
  };

  const handleSync = async () => {
    setSyncing(true);
    setSyncResult(null);
    setSyncError('');
    setSyncProgress(null);

    try {
      const limit = Math.max(1, parseInt(syncLimit) || 50);
      const res = await fetch('/api/feed-spy/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ limit }),
      });

      if (!res.body) {
        setSyncError('No response stream');
        setSyncing(false);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // Parse SSE events from buffer
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // keep incomplete line in buffer

        let eventType = '';
        for (const line of lines) {
          if (line.startsWith('event: ')) {
            eventType = line.slice(7);
          } else if (line.startsWith('data: ') && eventType) {
            try {
              const data = JSON.parse(line.slice(6));
              if (eventType === 'progress') {
                setSyncProgress(data);
              } else if (eventType === 'done') {
                setSyncResult(data);
                fetchStats();
              } else if (eventType === 'error') {
                setSyncError(data.error || 'Sync failed');
              }
            } catch { /* skip malformed */ }
            eventType = '';
          }
        }
      }
    } catch (err) {
      setSyncError(err instanceof Error ? err.message : 'Sync failed');
    } finally {
      setSyncing(false);
      setSyncProgress(null);
    }
  };

  const handleFetchAvatars = async () => {
    setFetchingAvatars(true);
    setAvatarResult(null);
    setAvatarError('');

    try {
      const res = await fetch('/api/admin/fetch-avatars', { method: 'POST' });
      const data = await res.json();

      if (data.success) {
        setAvatarResult({ fetched: data.fetched, total: data.total || 0, message: data.message });
      } else {
        setAvatarError(data.error || 'Failed to fetch avatars');
      }
    } catch (err) {
      setAvatarError(err instanceof Error ? err.message : 'Failed to fetch avatars');
    } finally {
      setFetchingAvatars(false);
    }
  };

  const fetchUsers = async () => {
    try {
      const res = await fetch('/api/admin/users');
      const data = await res.json();
      if (data.users) setUsers(data.users);
    } catch {}
  };

  useEffect(() => {
    if (authenticated) {
      fetchStats();
      fetchConfig();
      fetchUsers();
    }
  }, [authenticated]);

  if (checking) {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-purple-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  // Login screen
  if (!authenticated) {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center">
        <div className="bg-gray-900 border border-gray-700 rounded-2xl p-8 w-full max-w-sm">
          <div className="text-center mb-6">
            <div className="w-14 h-14 bg-gradient-to-br from-purple-600 to-pink-600 rounded-2xl flex items-center justify-center text-white font-bold text-2xl mx-auto mb-4">
              R
            </div>
            <h1 className="text-xl font-bold text-white">Admin Access</h1>
            <p className="text-sm text-gray-400 mt-1">rofe.ai control panel</p>
          </div>

          <form onSubmit={handleLogin} className="space-y-4">
            <div>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="Username"
                className="w-full px-4 py-3 bg-gray-800 border border-gray-600 rounded-xl text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-purple-500"
                autoFocus
              />
            </div>
            <div>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Password"
                className="w-full px-4 py-3 bg-gray-800 border border-gray-600 rounded-xl text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-purple-500"
              />
            </div>

            {loginError && (
              <div className="text-red-400 text-sm text-center">{loginError}</div>
            )}

            <button
              type="submit"
              className="w-full py-3 bg-purple-600 text-white font-semibold rounded-xl hover:bg-purple-700 transition"
            >
              Log In
            </button>
          </form>
        </div>
      </div>
    );
  }

  // ── Tab metadata table — drives both the tab strip and the breadcrumb.
  // Each entry has the label, the tab key, and the per-tab accent color
  // (used as a small dot beside the label so the "where am I" cue
  // survives the move from filled-pill tabs to user-style underlined tabs).
  const tabs: Array<{
    key: typeof adminSection;
    label: string;
    dot: string;          // Tailwind bg-* class for the accent dot
    badge?: React.ReactNode;
    onClick?: () => void; // optional side-effect on activation (e.g. fetch admin tokens)
  }> = [
    { key: 'general',        label: 'General',         dot: 'bg-purple-500/70' },
    { key: 'niche',          label: 'Niche Explorer',  dot: 'bg-amber-500/70' },
    { key: 'enrich',         label: 'Enrich Data',     dot: 'bg-purple-500/70' },
    { key: 'datacollection', label: 'Data Collection', dot: 'bg-cyan-500/70' },
    { key: 'tokens',         label: 'Admin Tokens',    dot: 'bg-red-500/70',
      onClick: () => { fetch('/api/admin/admin-tokens').then(r => r.json()).then(d => setAdminTokens(d.tokens || [])).catch(() => {}); } },
    { key: 'agents',         label: 'Agents',          dot: 'bg-green-500/70',
      badge: agentsData && agentsData.totalActive > 0 ? (
        <span className="ml-1 text-[10px] bg-green-500/15 text-green-400 border border-green-500/25 rounded-full px-1.5 py-0.5">{agentsData.totalActive}</span>
      ) : null,
      onClick: () => { setAgentsLoading(true); fetch('/api/admin/agents').then(r => r.json()).then(d => { setAgentsData(d); setAgentsLoading(false); }).catch(() => setAgentsLoading(false)); } },
    { key: 'vizard',         label: 'Vizard',          dot: 'bg-pink-500/70',
      badge: vizardProjects.some(p => p.status === 'pending' || p.status === 'processing') ? (
        <span className="ml-1 text-[10px] bg-pink-500/15 text-pink-400 border border-pink-500/25 rounded-full px-1.5 py-0.5 animate-pulse">
          {vizardProjects.filter(p => p.status === 'pending' || p.status === 'processing').length}
        </span>
      ) : null },
    { key: 'novelty',        label: 'Novelty',         dot: 'bg-indigo-500/70' },
    { key: 'tree',           label: 'Niche Tree',      dot: 'bg-amber-500/70' },
    { key: 'lifecycle',      label: 'Cluster Lifecycle', dot: 'bg-fuchsia-500/70' },
    { key: 'seed',           label: 'Video Seed',      dot: 'bg-emerald-500/70' },
    { key: 'docs',           label: 'Docs',            dot: 'bg-slate-400/70' },
    { key: 'tools',          label: 'Tools',           dot: 'bg-yellow-500/70' },
    { key: 'vid-gen',        label: 'Vid Gen',         dot: 'bg-rose-500/70' },
    { key: 'content-gen',    label: 'Content Gen',     dot: 'bg-amber-500/70' },
    { key: 'imagegen',       label: 'Image Gen',       dot: 'bg-lime-500/70' },
    { key: 'audiogen',       label: 'Audio Gen',       dot: 'bg-sky-500/70' },
    { key: 'screencap',      label: 'Screen Capture',  dot: 'bg-blue-500/70' },
    { key: 'producer',       label: 'Producer',        dot: 'bg-emerald-500/70' },
    { key: 'embed-reqs',     label: 'Embed reqs',      dot: 'bg-cyan-400/70' },
    { key: 'analyze-vids',   label: 'Analyze Vids',    dot: 'bg-teal-400/70' },
    { key: 'xg-vid-dl',      label: 'XG vid download', dot: 'bg-orange-400/70' },
  ];
  const activeTab = tabs.find(t => t.key === adminSection);

  // Admin dashboard — restyled to match the user-side `/niche/*` chrome:
  // page bg #0a0a0a, fixed top bar with breadcrumb, top tab strip with
  // amber underline for the active tab and a per-tab accent dot for the
  // section identity cue.
  return (
    <div className="min-h-screen bg-[#0a0a0a]">
      {/* ── Top bar (mirrors components/TopBar.tsx) ─────────────────── */}
      <div className="h-14 px-6 flex items-center justify-between border-b border-[#1a1a1a] bg-[#0a0a0a]">
        <div className="flex items-center gap-2 text-sm">
          <a href="/" className="text-[#888] hover:text-white transition-colors" title="Home">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
            </svg>
          </a>
          <span className="text-[#444]">·</span>
          <span className="text-[#888]">Admin</span>
          {activeTab && (
            <>
              <span className="text-[#444]">·</span>
              <span className="text-white font-medium">{activeTab.label}</span>
            </>
          )}
        </div>
        <div className="flex items-center gap-3">
          <a href="/" className="text-xs text-[#888] hover:text-white transition-colors">Back to App</a>
          <div className="w-8 h-8 rounded-full bg-orange-600 flex items-center justify-center text-white text-sm font-bold">A</div>
        </div>
      </div>

      {/* ── Tab strip (top tabs, restyled to match user vocabulary) ── */}
      {/* Active tab: amber underline + white text. Inactive: muted text-3
          with hover-to-white. Per-tab accent preserved as a 1.5px dot to
          the left of the label so we keep the section identity cue. */}
      <div className="border-b border-[#1a1a1a] bg-[#0a0a0a] sticky top-0 z-10">
        <div className="max-w-[1400px] mx-auto px-6 flex items-center gap-1 overflow-x-auto -mb-px">
          {tabs.map(tab => {
            const active = adminSection === tab.key;
            return (
              <button
                key={tab.key}
                onClick={() => { setAdminSection(tab.key); tab.onClick?.(); }}
                className={`px-4 h-12 text-xs font-medium flex items-center gap-2 whitespace-nowrap transition border-b-2 ${
                  active
                    ? 'text-white font-semibold border-amber-500'
                    : 'text-[#888] hover:text-white border-transparent'
                }`}
              >
                <span className={`w-1.5 h-1.5 rounded-full ${active ? tab.dot.replace('/70', '') : tab.dot}`} />
                {tab.label}
                {tab.badge}
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Page content ─────────────────────────────────────────── */}
      <div className="max-w-[1400px] mx-auto px-4 sm:px-6 py-6 sm:py-8">
        {/* Header — kept the section title for the inactive-block tabs.
            Once each tab adopts user-style section headers (title + action
            inline) we can drop this. For now it covers the pre-restyle
            tabs that still expect a page heading. */}
        {/* Heading band — kept for tabs that haven't been ported to the
            user-style "title + inline action" header yet. The Niche Tree
            tab renders its own header so we hide this for that tab. */}
        <div style={{ display: adminSection === 'tree' ? 'none' : 'block' }} className="mb-6 sm:mb-8">
          <h1 className="text-xl sm:text-2xl font-bold text-white">{activeTab?.label || 'Admin Panel'}</h1>
          <p className="text-[#888] text-xs sm:text-sm">rofe.ai data operations</p>
        </div>

        <div style={{ display: adminSection === 'general' ? 'block' : 'none' }}>
        {/* Navigation */}
        <div className="space-y-3 mb-8">
          <a
            href="/admin/x-posts"
            className="block bg-gray-900 border border-gray-800 rounded-2xl p-5 hover:border-purple-600/50 hover:bg-gray-900/80 transition group"
          >
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-white font-bold text-lg group-hover:text-purple-400 transition">Daily X Posts</h2>
                <p className="text-gray-500 text-sm mt-0.5">Generate &amp; preview tweet content from today&apos;s discoveries</p>
              </div>
              <svg className="w-5 h-5 text-gray-600 group-hover:text-purple-400 transition" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
              </svg>
            </div>
          </a>
          <a
            href="/admin/deep-analysis"
            className="block bg-gray-900 border border-gray-800 rounded-2xl p-5 hover:border-cyan-600/50 hover:bg-gray-900/80 transition group"
          >
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-white font-bold text-lg group-hover:text-cyan-400 transition">Deep Analysis</h2>
                <p className="text-gray-500 text-sm mt-0.5">AI pipeline: triage &rarr; storyboard &rarr; synthesis &rarr; post generation</p>
              </div>
              <svg className="w-5 h-5 text-gray-600 group-hover:text-cyan-400 transition" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
              </svg>
            </div>
          </a>
          <a
            href="/admin/sync"
            className="block bg-gray-900 border border-gray-800 rounded-2xl p-5 hover:border-red-600/50 hover:bg-gray-900/80 transition group"
          >
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-white font-bold text-lg group-hover:text-red-400 transition">Sync Monitor</h2>
                <p className="text-gray-500 text-sm mt-0.5">Run data syncs with full visibility — before/after stats &amp; live progress</p>
              </div>
              <svg className="w-5 h-5 text-gray-600 group-hover:text-red-400 transition" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
              </svg>
            </div>
          </a>
        </div>

        {/* Stats */}
        {stats && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4 mb-6 sm:mb-10">
            {[
              { label: 'Videos', value: parseInt(stats.total_videos).toLocaleString(), color: 'text-blue-400' },
              { label: 'Channels', value: parseInt(stats.total_channels).toLocaleString(), color: 'text-purple-400' },
              { label: 'Data Points', value: parseInt(stats.total_sightings).toLocaleString(), color: 'text-orange-400' },
              { label: 'Collections', value: parseInt(stats.total_collections).toLocaleString(), color: 'text-green-400' },
            ].map((s, i) => (
              <div key={i} className="bg-gray-900 border border-gray-800 rounded-xl p-4">
                <div className={`text-2xl font-bold ${s.color}`}>{s.value}</div>
                <div className="text-xs text-gray-500">{s.label}</div>
              </div>
            ))}
          </div>
        )}

        {/* Users */}
        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6 mb-6">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-lg font-bold text-white">Users</h2>
              <p className="text-gray-400 text-sm">{users.length} registered user{users.length !== 1 ? 's' : ''}</p>
            </div>
            <button
              onClick={fetchUsers}
              className="px-3 py-1.5 bg-gray-800 text-gray-300 rounded-lg hover:bg-gray-700 transition text-sm"
            >
              Refresh
            </button>
          </div>

          {users.length === 0 ? (
            <div className="text-gray-500 text-sm py-4">No users yet</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-gray-500 text-xs uppercase tracking-wider border-b border-gray-800">
                    <th className="pb-2 pr-4">User</th>
                    <th className="pb-2 pr-4">Joined</th>
                    <th className="pb-2 pr-4">Last active</th>
                    <th className="pb-2 pr-4 text-right">Channels seen</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-800/50">
                  {users.map((u) => (
                    <tr key={u.id} className="text-gray-300">
                      <td className="py-2.5 pr-4">
                        <div className="flex items-center gap-2.5">
                          {u.image ? (
                            <img src={u.image} alt="" className="w-7 h-7 rounded-full" />
                          ) : (
                            <div className="w-7 h-7 rounded-full bg-purple-600 flex items-center justify-center text-white text-xs font-bold">
                              {(u.name?.[0] ?? '?').toUpperCase()}
                            </div>
                          )}
                          <div className="min-w-0">
                            <div className="text-white text-sm truncate">{u.name || 'Unknown'}</div>
                            <div className="text-gray-500 text-xs truncate">{u.email}</div>
                          </div>
                        </div>
                      </td>
                      <td className="py-2.5 pr-4 text-xs text-gray-400 whitespace-nowrap">
                        {new Date(u.created_at).toLocaleDateString()}
                      </td>
                      <td className="py-2.5 pr-4 text-xs text-gray-400 whitespace-nowrap">
                        {u.last_active ? timeAgo(new Date(u.last_active)) : 'Never'}
                      </td>
                      <td className="py-2.5 pr-4 text-right font-mono text-xs">
                        {u.channels_seen}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Feed Spy Sync */}
        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6 mb-6">
          <h2 className="text-lg font-bold text-white mb-2">Feed Spy — Sync</h2>
          <p className="text-gray-400 text-sm mb-4">
            Pull completed tasks from xgodo, store video/channel data in PostgreSQL, and mark tasks as confirmed.
          </p>

          <div className="flex items-center gap-3 mb-4">
            <button
              onClick={handleSync}
              disabled={syncing}
              className="px-6 py-3 bg-red-600 text-white font-semibold rounded-xl hover:bg-red-700 disabled:opacity-50 transition flex items-center gap-3"
            >
              {syncing ? (
                <>
                  <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  Syncing...
                </>
              ) : (
                <>
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                  Sync Now
                </>
              )}
            </button>
            <div className="flex items-center gap-2">
              <label className="text-xs text-gray-500 whitespace-nowrap">Tasks limit</label>
              <input
                type="number"
                min={1}
                max={5000}
                value={syncLimit}
                onChange={(e) => setSyncLimit(e.target.value)}
                disabled={syncing}
                className="w-20 px-2.5 py-3 bg-gray-800 border border-gray-700 rounded-xl text-white text-sm text-center focus:outline-none focus:ring-2 focus:ring-red-500 disabled:opacity-50"
              />
            </div>
          </div>

          {/* Live progress */}
          {syncing && syncProgress && (
            <div className="mb-4 bg-gray-800/80 border border-gray-700 rounded-xl p-4 space-y-3">
              {/* Phase label */}
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 bg-red-400 rounded-full animate-pulse" />
                <span className="text-xs font-medium text-gray-400 uppercase tracking-wider">
                  {syncProgress.phase === 'fetching' ? 'Fetching from xgodo' :
                   syncProgress.phase === 'resolving' ? 'Resolving channel IDs' :
                   syncProgress.phase === 'processing' ? 'Processing tasks' :
                   syncProgress.phase === 'avatars' ? 'Fetching YouTube data' :
                   syncProgress.phase === 'confirming' ? 'Confirming on xgodo' : syncProgress.phase}
                </span>
              </div>

              {/* Progress bar — always visible when we have numbers */}
              {syncProgress.phase === 'fetching' && (
                <>
                  <div className="w-full bg-gray-700 rounded-full h-2.5 overflow-hidden">
                    <div className="bg-red-500/60 h-full rounded-full animate-pulse" style={{ width: '100%' }} />
                  </div>
                  <div className="text-center">
                    <span className="text-2xl font-bold text-white font-mono">{syncProgress.tasksFetched ?? 0}</span>
                    <span className="text-sm text-gray-400 ml-2">tasks fetched</span>
                  </div>
                </>
              )}

              {syncProgress.phase === 'processing' && syncProgress.total != null && syncProgress.processed != null && (
                <>
                  <div className="w-full bg-gray-700 rounded-full h-2.5">
                    <div
                      className="bg-gradient-to-r from-red-500 to-orange-500 h-full rounded-full transition-all duration-200"
                      style={{ width: `${Math.round((syncProgress.processed / syncProgress.total) * 100)}%` }}
                    />
                  </div>
                  <div className="flex items-baseline justify-center gap-1">
                    <span className="text-3xl font-bold text-white font-mono">{syncProgress.processed}</span>
                    <span className="text-lg text-gray-500 font-mono">/ {syncProgress.total}</span>
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    <div className="bg-green-900/30 border border-green-800/30 rounded-lg px-2 py-1.5 text-center">
                      <div className="text-base font-bold text-green-400 font-mono">{syncProgress.synced ?? 0}</div>
                      <div className="text-[9px] text-green-500/70 uppercase">synced</div>
                    </div>
                    <div className="bg-blue-900/30 border border-blue-800/30 rounded-lg px-2 py-1.5 text-center">
                      <div className="text-base font-bold text-blue-400 font-mono">{syncProgress.videos ?? 0}</div>
                      <div className="text-[9px] text-blue-500/70 uppercase">videos</div>
                    </div>
                    <div className="bg-gray-800 border border-gray-700/50 rounded-lg px-2 py-1.5 text-center">
                      <div className="text-base font-bold text-gray-400 font-mono">{syncProgress.skipped ?? 0}</div>
                      <div className="text-[9px] text-gray-500 uppercase">skipped</div>
                    </div>
                    <div className="bg-yellow-900/30 border border-yellow-800/30 rounded-lg px-2 py-1.5 text-center">
                      <div className="text-base font-bold text-yellow-400 font-mono">{syncProgress.empty ?? 0}</div>
                      <div className="text-[9px] text-yellow-500/70 uppercase">empty</div>
                    </div>
                  </div>
                </>
              )}

              {(syncProgress.phase === 'resolving' || syncProgress.phase === 'avatars' || syncProgress.phase === 'confirming') && (
                <>
                  <div className="w-full bg-gray-700 rounded-full h-2.5 overflow-hidden">
                    <div className="bg-purple-500/60 h-full rounded-full animate-pulse" style={{ width: '100%' }} />
                  </div>
                  <div className="text-sm text-gray-300 text-center">{syncProgress.message}</div>
                </>
              )}
            </div>
          )}

          {syncResult && (
            <div className="mt-4 bg-green-900/20 border border-green-600/30 rounded-xl p-4">
              <div className="text-green-400 font-medium mb-2">Sync Complete</div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-sm">
                <div className="bg-green-900/30 rounded-lg px-3 py-2 text-center">
                  <div className="text-lg font-bold text-green-300">{syncResult.synced}</div>
                  <div className="text-[10px] text-green-400/70">tasks synced</div>
                </div>
                <div className="bg-blue-900/30 rounded-lg px-3 py-2 text-center">
                  <div className="text-lg font-bold text-blue-300">{syncResult.videos}</div>
                  <div className="text-[10px] text-blue-400/70">videos ingested</div>
                </div>
                <div className="bg-purple-900/30 rounded-lg px-3 py-2 text-center">
                  <div className="text-lg font-bold text-purple-300">{syncResult.confirmed}</div>
                  <div className="text-[10px] text-purple-400/70">confirmed</div>
                </div>
                <div className="bg-gray-800 rounded-lg px-3 py-2 text-center">
                  <div className="text-lg font-bold text-gray-300">{syncResult.totalFetched}</div>
                  <div className="text-[10px] text-gray-400/70">fetched from xgodo</div>
                </div>
              </div>
              {(syncResult.skipped > 0 || syncResult.empty > 0) && (
                <div className="flex gap-3 mt-2 text-xs text-gray-400">
                  {syncResult.skipped > 0 && <span>{syncResult.skipped} already synced (skipped)</span>}
                  {syncResult.empty > 0 && <span className="text-yellow-400/70">{syncResult.empty} empty tasks</span>}
                </div>
              )}
            </div>
          )}

          {syncResult && syncResult.emptyTaskIds && syncResult.emptyTaskIds.length > 0 && (
            <div className="mt-4 bg-yellow-900/20 border border-yellow-600/30 rounded-xl p-4">
              <div className="text-yellow-400 font-medium mb-2">Empty Tasks ({syncResult.emptyTaskIds.length})</div>
              <div className="text-xs text-yellow-300/70 mb-2">These tasks returned 0 videos and were confirmed as paid:</div>
              <div className="flex flex-wrap gap-1.5">
                {syncResult.emptyTaskIds.map((id) => (
                  <code key={id} className="px-2 py-0.5 bg-yellow-900/30 border border-yellow-700/30 rounded text-xs text-yellow-300 font-mono">{id}</code>
                ))}
              </div>
            </div>
          )}

          {syncResult && syncResult.synced === 0 && syncResult.empty === 0 && syncResult.skipped === 0 && (
            <div className="mt-4 bg-gray-800 border border-gray-700 rounded-xl p-4">
              <div className="text-gray-300 text-sm">No new tasks to sync. All pending data has been collected.</div>
            </div>
          )}

          {syncError && (
            <div className="mt-4 bg-red-900/20 border border-red-600/30 rounded-xl p-4">
              <div className="text-red-400 font-medium mb-1">Sync Failed</div>
              <div className="text-sm text-red-300/70">{syncError}</div>
            </div>
          )}
        </div>

        {/* Fetch Avatars */}
        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6 mb-6">
          <h2 className="text-lg font-bold text-white mb-2">Channel Avatars</h2>
          <p className="text-gray-400 text-sm mb-6">
            Fetch YouTube profile pictures for channels that are missing avatars. Uses the YouTube Data API key from config.
          </p>

          <button
            onClick={handleFetchAvatars}
            disabled={fetchingAvatars}
            className="px-6 py-3 bg-purple-600 text-white font-semibold rounded-xl hover:bg-purple-700 disabled:opacity-50 transition flex items-center gap-3"
          >
            {fetchingAvatars ? (
              <>
                <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                Fetching avatars...
              </>
            ) : (
              <>
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5.121 17.804A13.937 13.937 0 0112 16c2.5 0 4.847.655 6.879 1.804M15 10a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
                Fetch Missing Avatars
              </>
            )}
          </button>

          {avatarResult && (
            <div className="mt-4 bg-green-900/20 border border-green-600/30 rounded-xl p-4">
              <div className="text-green-400 font-medium mb-1">Done</div>
              <div className="text-sm text-green-300/70">
                {avatarResult.message || `${avatarResult.fetched} of ${avatarResult.total} missing avatars fetched`}
              </div>
            </div>
          )}

          {avatarError && (
            <div className="mt-4 bg-red-900/20 border border-red-600/30 rounded-xl p-4">
              <div className="text-red-400 font-medium mb-1">Failed</div>
              <div className="text-sm text-red-300/70">{avatarError}</div>
            </div>
          )}
        </div>

        {/* Schedule Tasks */}
        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6 mb-6">
          <h2 className="text-lg font-bold text-white mb-2">Feed Spy — Schedule Tasks</h2>
          <p className="text-gray-400 text-sm mb-6">
            Submit planned spy tasks to xgodo. Each task will collect YouTube Shorts feed data with the specified parameters.
          </p>

          <div className="space-y-5">
            {/* Task Count */}
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1">Number of tasks to schedule</label>
              <input
                type="number"
                min={1}
                max={100}
                value={schedTaskCount}
                onChange={(e) => setSchedTaskCount(Math.max(1, Math.min(100, parseInt(e.target.value) || 1)))}
                className="w-32 px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-xl text-white focus:outline-none focus:ring-2 focus:ring-purple-500 text-sm"
              />
              <p className="text-xs text-gray-500 mt-1">All tasks will use the same inputs below (max 100)</p>
            </div>

            <div className="border-t border-gray-800 pt-5">
              <div className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-4">Task Inputs</div>

              {/* Num Videos */}
              <div className="mb-4">
                <label className="block text-sm font-medium text-gray-300 mb-1">
                  Num videos <span className="text-red-400">*</span>
                </label>
                <input
                  type="number"
                  min={1}
                  max={50}
                  value={schedNumVideos}
                  onChange={(e) => setSchedNumVideos(Math.max(1, parseInt(e.target.value) || 1))}
                  className="w-32 px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-xl text-white focus:outline-none focus:ring-2 focus:ring-purple-500 text-sm"
                />
                <p className="text-xs text-gray-500 mt-1">Number of videos to collect per task</p>
              </div>

              {/* Fetch Channel Age */}
              <div className="mb-4">
                <label className="block text-sm font-medium text-gray-300 mb-2">Fetch channel age</label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={schedFetchAge}
                    onChange={(e) => setSchedFetchAge(e.target.checked)}
                    className="w-4 h-4 rounded border-gray-600 bg-gray-800 text-purple-500 focus:ring-purple-500 focus:ring-offset-0"
                  />
                  <span className="text-sm text-gray-300">Enabled</span>
                </label>
              </div>

              {/* YouTube API Key */}
              <div className="mb-4">
                <label className="block text-sm font-medium text-gray-300 mb-1">
                  YouTube API key
                  <span className="text-gray-500 text-xs ml-1">{schedFetchAge ? '(required)' : '(optional)'}</span>
                </label>
                <input
                  type="password"
                  value={schedYoutubeKey}
                  onChange={(e) => setSchedYoutubeKey(e.target.value)}
                  placeholder="Only required when fetching channel age"
                  className="w-full px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-xl text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-purple-500 font-mono text-sm"
                />
              </div>

              {/* Fetch Channel Video Count */}
              <div className="mb-2">
                <label className="block text-sm font-medium text-gray-300 mb-2">Fetch channel video count</label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={schedFetchVideoCount}
                    onChange={(e) => setSchedFetchVideoCount(e.target.checked)}
                    className="w-4 h-4 rounded border-gray-600 bg-gray-800 text-purple-500 focus:ring-purple-500 focus:ring-offset-0"
                  />
                  <span className="text-sm text-gray-300">Fetch number of videos of the channel</span>
                </label>
              </div>
            </div>

            {/* Submit */}
            <div className="border-t border-gray-800 pt-5">
              <button
                onClick={handleSchedule}
                disabled={scheduling || schedNumVideos < 1}
                className="px-6 py-3 bg-blue-600 text-white font-semibold rounded-xl hover:bg-blue-700 disabled:opacity-50 transition flex items-center gap-3"
              >
                {scheduling ? (
                  <>
                    <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    Scheduling...
                  </>
                ) : (
                  <>
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6l4 2m6-2a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    Schedule {schedTaskCount} Task{schedTaskCount > 1 ? 's' : ''}
                  </>
                )}
              </button>
            </div>

            {scheduleResult && (
              <div className="bg-green-900/20 border border-green-600/30 rounded-xl p-4">
                <div className="text-green-400 font-medium mb-1">Tasks Scheduled</div>
                <div className="text-sm text-green-300/70">
                  {scheduleResult.scheduled} task{scheduleResult.scheduled > 1 ? 's' : ''} submitted to xgodo. They will be picked up by workers and results will appear after syncing.
                </div>
              </div>
            )}

            {scheduleError && (
              <div className="bg-red-900/20 border border-red-600/30 rounded-xl p-4">
                <div className="text-red-400 font-medium mb-1">Schedule Failed</div>
                <div className="text-sm text-red-300/70">{scheduleError}</div>
              </div>
            )}
          </div>

          {/* Auto-Schedule Autopilot */}
          <div className="border-t border-gray-800 pt-5 mt-5 space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold text-gray-300">Autopilot</h3>
                <p className="text-xs text-gray-500 mt-0.5">Automatically schedule tasks on a timer, even with browser closed</p>
              </div>
              <button
                onClick={async () => {
                  const next = !autoSchedEnabled;
                  setAutoSchedEnabled(next);
                  await saveAutoSchedConfig({ auto_schedule_enabled: next ? 'true' : 'false' });
                }}
                className={`relative w-12 h-6 rounded-full transition-colors ${autoSchedEnabled ? 'bg-green-600' : 'bg-gray-700'}`}
              >
                <div className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full transition-transform ${autoSchedEnabled ? 'translate-x-6' : ''}`} />
              </button>
            </div>

            {autoSchedEnabled && (
              <div className="space-y-3 bg-gray-800/30 rounded-xl p-4">
                <div className="flex flex-wrap items-center gap-4">
                  <div className="flex items-center gap-2">
                    <label className="text-xs text-gray-400">Every</label>
                    <div className="flex gap-1 items-center">
                      {[
                        { label: '30m', value: '30' },
                        { label: '1h', value: '60' },
                        { label: '2h', value: '120' },
                        { label: '6h', value: '360' },
                        { label: '12h', value: '720' },
                      ].map(opt => (
                        <button
                          key={opt.value}
                          onClick={async () => {
                            setAutoSchedInterval(opt.value);
                            await saveAutoSchedConfig({ auto_schedule_interval_minutes: opt.value });
                          }}
                          className={`px-2.5 py-1 text-xs font-medium rounded-lg transition ${
                            autoSchedInterval === opt.value
                              ? 'bg-blue-600 text-white'
                              : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
                          }`}
                        >
                          {opt.label}
                        </button>
                      ))}
                      <input
                        type="number"
                        min={1}
                        max={1440}
                        value={!['30','60','120','360','720'].includes(autoSchedInterval) ? autoSchedInterval : ''}
                        placeholder="min"
                        onChange={(e) => setAutoSchedInterval(e.target.value)}
                        onBlur={async () => {
                          const val = String(Math.max(1, Math.min(1440, parseInt(autoSchedInterval) || 60)));
                          setAutoSchedInterval(val);
                          await saveAutoSchedConfig({ auto_schedule_interval_minutes: val });
                        }}
                        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                        className={`w-14 px-2 py-1 text-xs font-mono rounded-lg border focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                          !['30','60','120','360','720'].includes(autoSchedInterval)
                            ? 'bg-blue-600 border-blue-500 text-white'
                            : 'bg-gray-800 border-gray-700 text-gray-400'
                        }`}
                      />
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <label className="text-xs text-gray-400">Tasks</label>
                    <input
                      type="number"
                      min={1}
                      max={100}
                      value={autoSchedTaskCount}
                      onChange={(e) => setAutoSchedTaskCount(e.target.value)}
                      onBlur={async () => {
                        const val = String(Math.max(1, Math.min(100, parseInt(autoSchedTaskCount) || 10)));
                        setAutoSchedTaskCount(val);
                        await saveAutoSchedConfig({ auto_schedule_task_count: val });
                      }}
                      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                      className="w-16 px-2 py-1 bg-gray-800 border border-gray-700 rounded-lg text-white text-xs text-center font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>

                  <div className="flex items-center gap-2">
                    <label className="text-xs text-gray-400">Videos</label>
                    <input
                      type="number"
                      min={1}
                      max={50}
                      value={autoSchedNumVideos}
                      onChange={(e) => setAutoSchedNumVideos(e.target.value)}
                      onBlur={async () => {
                        const val = String(Math.max(1, Math.min(50, parseInt(autoSchedNumVideos) || 20)));
                        setAutoSchedNumVideos(val);
                        await saveAutoSchedConfig({ auto_schedule_num_videos: val });
                      }}
                      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                      className="w-16 px-2 py-1 bg-gray-800 border border-gray-700 rounded-lg text-white text-xs text-center font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                </div>

                <div className="flex items-center gap-4">
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={autoSchedFetchAge}
                      onChange={async (e) => {
                        setAutoSchedFetchAge(e.target.checked);
                        await saveAutoSchedConfig({ auto_schedule_fetch_age: e.target.checked ? 'true' : 'false' });
                      }}
                      className="w-3.5 h-3.5 rounded border-gray-600 bg-gray-800 text-blue-500 focus:ring-blue-500 focus:ring-offset-0"
                    />
                    <span className="text-xs text-gray-400">Channel age</span>
                  </label>
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={autoSchedFetchVideoCount}
                      onChange={async (e) => {
                        setAutoSchedFetchVideoCount(e.target.checked);
                        await saveAutoSchedConfig({ auto_schedule_fetch_video_count: e.target.checked ? 'true' : 'false' });
                      }}
                      className="w-3.5 h-3.5 rounded border-gray-600 bg-gray-800 text-blue-500 focus:ring-blue-500 focus:ring-offset-0"
                    />
                    <span className="text-xs text-gray-400">Video count</span>
                  </label>
                </div>

                {lastAutoSchedule && (
                  <div className="flex items-center gap-3 text-xs pt-2 border-t border-gray-700/50">
                    <span className="text-gray-500">Last run:</span>
                    <span className="text-gray-300">{formatTimeAgo(lastAutoSchedule.at)}</span>
                    {lastAutoSchedule.result && !lastAutoSchedule.result.error && (
                      <>
                        <span className="text-gray-600">·</span>
                        <span className="text-blue-400">{lastAutoSchedule.result.scheduled} tasks scheduled</span>
                      </>
                    )}
                    {lastAutoSchedule.result?.error && (
                      <span className="text-red-400">{lastAutoSchedule.result.error}</span>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Visible Tabs */}
        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6 mb-6">
          <h2 className="text-lg font-bold text-white mb-2">Visible Tabs</h2>
          <p className="text-gray-400 text-sm mb-6">
            Toggle which tabs are visible to regular users. Hidden tabs are still accessible via direct URL.
          </p>

          <div className="space-y-3">
            {ALL_TABS.map((tab) => (
              <label key={tab.id} className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={visibleTabs.includes(tab.id)}
                  onChange={(e) => {
                    setVisibleTabs((prev) =>
                      e.target.checked
                        ? [...prev, tab.id]
                        : prev.filter((t) => t !== tab.id)
                    );
                    setTabsSaved(false);
                  }}
                  className="w-4 h-4 rounded border-gray-600 bg-gray-800 text-purple-500 focus:ring-purple-500 focus:ring-offset-0"
                />
                <span className="text-sm text-gray-300">{tab.label}</span>
              </label>
            ))}
          </div>

          <div className="flex items-center gap-3 mt-5">
            <button
              onClick={async () => {
                setTabsSaving(true);
                setTabsSaved(false);
                try {
                  await fetch('/api/admin/config', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ config: { visible_tabs: JSON.stringify(visibleTabs) } }),
                  });
                  setTabsSaved(true);
                  setTimeout(() => setTabsSaved(false), 3000);
                } catch {}
                setTabsSaving(false);
              }}
              disabled={tabsSaving}
              className="px-5 py-2.5 bg-purple-600 text-white font-semibold rounded-xl hover:bg-purple-700 disabled:opacity-50 transition"
            >
              {tabsSaving ? 'Saving...' : 'Save'}
            </button>
            {tabsSaved && <span className="text-green-400 text-sm">Saved</span>}
          </div>
        </div>

        {/* Homepage override */}
        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6 mb-6">
          <h2 className="text-lg font-bold text-white mb-2">Homepage</h2>
          <p className="text-gray-400 text-sm mb-6">
            Pick what end users see when they hit the bare domain (<code className="text-gray-300">/</code>).
            Default is the product picker; toggle this on to send them straight into the Niche grid instead.
          </p>

          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={homepageToNiche}
              onChange={(e) => {
                setHomepageToNiche(e.target.checked);
                setHomepageSaved(false);
              }}
              className="w-4 h-4 mt-0.5 rounded border-gray-600 bg-gray-800 text-purple-500 focus:ring-purple-500 focus:ring-offset-0"
            />
            <div>
              <span className="text-sm text-gray-300">
                Use <code className="text-gray-100">/niche</code> as the homepage
              </span>
              <p className="text-xs text-gray-500 mt-0.5">
                When enabled, <code className="text-gray-400">rofe.ai/</code> redirects to{' '}
                <code className="text-gray-400">rofe.ai/niche</code>. The original welcome page stays
                reachable at <code className="text-gray-400">/welcome</code>.
              </p>
            </div>
          </label>

          <div className="flex items-center gap-3 mt-5">
            <button
              onClick={async () => {
                setHomepageSaving(true);
                setHomepageSaved(false);
                try {
                  await fetch('/api/admin/config', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      config: { homepage_to_niche: homepageToNiche ? 'true' : 'false' },
                    }),
                  });
                  setHomepageSaved(true);
                  setTimeout(() => setHomepageSaved(false), 3000);
                } catch {}
                setHomepageSaving(false);
              }}
              disabled={homepageSaving}
              className="px-5 py-2.5 bg-purple-600 text-white font-semibold rounded-xl hover:bg-purple-700 disabled:opacity-50 transition"
            >
              {homepageSaving ? 'Saving...' : 'Save'}
            </button>
            {homepageSaved && <span className="text-green-400 text-sm">Saved</span>}
          </div>
        </div>

        {/* xgodo Config */}
        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6">
          <h2 className="text-lg font-bold text-white mb-2">xgodo Configuration</h2>
          <p className="text-gray-400 text-sm mb-6">API token and job IDs for xgodo integrations.</p>

          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1">xgodo API Token</label>
              <input
                type="password"
                value={xgodoToken}
                onChange={(e) => setXgodoToken(e.target.value)}
                placeholder="Bearer token from xgodo"
                className="w-full px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-xl text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-purple-500 font-mono text-sm"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1">Shorts Spy Job ID</label>
              <input
                type="text"
                value={xgodoJobId}
                onChange={(e) => setXgodoJobId(e.target.value)}
                placeholder="e.g. 698709196049e1a09a72fb4e"
                className="w-full px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-xl text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-purple-500 font-mono text-sm"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1">Niche Spy Token</label>
              <input
                type="password"
                value={nicheSpyToken}
                onChange={(e) => setNicheSpyToken(e.target.value)}
                placeholder="xgodo JWT for niche spy job"
                className="w-full px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-xl text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-purple-500 font-mono text-sm"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1">Vizard API Key</label>
              <input
                type="password"
                value={vizardApiKey}
                onChange={(e) => setVizardApiKey(e.target.value)}
                placeholder="VIZARDAI_API_KEY from vizard.ai dashboard"
                className="w-full px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-xl text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-pink-500 font-mono text-sm"
              />
              <p className="mt-1 text-[11px] text-gray-500">Used by the Vizard tab to submit videos for AI clip generation.</p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="sm:col-span-2">
                <label className="block text-sm font-medium text-gray-300 mb-1">Proxy Host</label>
                <input
                  type="text"
                  value={xgodoProxyHost}
                  onChange={(e) => setXgodoProxyHost(e.target.value)}
                  placeholder="54.36.178.74"
                  className="w-full px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-xl text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-purple-500 font-mono text-sm"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-1">Port</label>
                <input
                  type="text"
                  value={xgodoProxyPort}
                  onChange={(e) => setXgodoProxyPort(e.target.value)}
                  placeholder="1082"
                  className="w-full px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-xl text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-purple-500 font-mono text-sm"
                />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1">Channel Check API Key</label>
              <input
                type="password"
                value={channelCheckApiKey}
                onChange={(e) => setChannelCheckApiKey(e.target.value)}
                placeholder="API key for /api/feed-spy/check-channel"
                className="w-full px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-xl text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-purple-500 font-mono text-sm"
              />
              <p className="text-xs text-gray-500 mt-1">Used by xgodo workers to check if a channel is already known</p>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1">YouTube API Key</label>
              <input
                type="password"
                value={schedYoutubeKey}
                onChange={(e) => setSchedYoutubeKey(e.target.value)}
                placeholder="For channel age fetching in spy tasks"
                className="w-full px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-xl text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-purple-500 font-mono text-sm"
              />
            </div>

            <div className="flex items-center gap-3">
              <button
                onClick={saveConfig}
                disabled={configSaving}
                className="px-5 py-2.5 bg-purple-600 text-white font-semibold rounded-xl hover:bg-purple-700 disabled:opacity-50 transition"
              >
                {configSaving ? 'Saving...' : 'Save Config'}
              </button>
              {configSaved && (
                <span className="text-green-400 text-sm">Saved</span>
              )}
            </div>
          </div>

        </div>
        </div>

        <div style={{ display: adminSection === 'niche' ? 'block' : 'none' }}>
        {/* Niche Explorer Admin Tab */}
        <div className="space-y-6">
          {/* Embedding Stats */}
          <div className="bg-gray-800/50 rounded-2xl border border-gray-700 p-6">
            <h2 className="text-lg font-bold text-white mb-4">Embedding Generation</h2>

            {embeddingStats && (
              <div className="space-y-4">
                {/* Per-target stats — 4 cards side-by-side for the embedding spaces */}
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
                  {([
                    { key: 'title_v1',     label: 'Title v1',     subtitle: 'gemini-embedding-001',       accent: 'text-gray-300', border: 'border-gray-700' },
                    { key: 'title_v2',     label: 'Title v2',     subtitle: 'gemini-embedding-2-preview', accent: 'text-cyan-300', border: 'border-cyan-800/40' },
                    { key: 'thumbnail_v2', label: 'Thumbnail v2', subtitle: 'gemini-embedding-2-preview (image)', accent: 'text-purple-300', border: 'border-purple-800/40' },
                    { key: 'combined_v2',  label: 'Combined v2',  subtitle: 'gemini-embedding-2-preview (title + thumb, joint)', accent: 'text-pink-300', border: 'border-pink-800/40' },
                  ] as const).map(t => {
                    const s = embeddingStats.targets[t.key];
                    if (!s) return null;  // gracefully handle pre-deploy stats payloads
                    const pct = s.totalVideos > 0 ? Math.round((s.embedded / s.totalVideos) * 100) : 0;
                    const isActiveSource = embeddingStats.similaritySource === t.key;
                    return (
                      <div key={t.key} className={`bg-gray-900/50 border ${t.border} rounded-lg p-3 ${isActiveSource ? 'ring-1 ring-amber-500/60' : ''}`}>
                        <div className="flex items-center justify-between mb-1">
                          <div className={`text-sm font-semibold ${t.accent}`}>{t.label}</div>
                          {isActiveSource && <span className="text-[9px] uppercase tracking-wider bg-amber-500/20 text-amber-300 border border-amber-500/40 px-1.5 py-0.5 rounded">active source</span>}
                        </div>
                        <div className="text-[10px] text-gray-500 mb-2 truncate">{t.subtitle}</div>
                        <div className="flex items-end justify-between mb-1">
                          <div>
                            <div className="text-2xl font-bold text-white">{s.embedded.toLocaleString()}</div>
                            <div className="text-[10px] text-gray-500">of {s.totalVideos.toLocaleString()} embedded</div>
                          </div>
                          <div className="text-xs text-amber-400 font-mono">{pct}%</div>
                        </div>
                        <div className="h-1.5 bg-gray-700 rounded-full overflow-hidden">
                          <div className={`h-full rounded-full ${pct >= 100 ? 'bg-green-500' : 'bg-amber-500'}`} style={{ width: `${pct}%` }} />
                        </div>
                        <div className="flex items-center justify-between mt-2 text-[10px]">
                          <span className="text-yellow-400">{s.notEmbedded.toLocaleString()} remaining</span>
                          <div className="flex gap-1.5">
                            <button
                              onClick={async () => {
                                const res = await fetch('/api/niche-spy/embeddings', {
                                  method: 'POST',
                                  headers: { 'Content-Type': 'application/json' },
                                  body: JSON.stringify({ limit: nicheLimit, batchSize: nicheBatchSize, threads: nicheThreads, target: t.key }),
                                });
                                if (!res.ok) {
                                  const data = await res.json().catch(() => ({}));
                                  alert(data.message || `Failed to start: ${res.status}`);
                                }
                              }}
                              disabled={(embeddingStats.job?.status === 'running' && embeddingStats.job?.target !== t.key) || s.notEmbedded === 0}
                              className="px-2.5 py-1 bg-amber-600 text-white font-semibold rounded-md hover:bg-amber-700 disabled:opacity-40 disabled:cursor-not-allowed transition text-xs"
                              title={`Generate one batch (up to ${nicheLimit.toLocaleString()} videos)`}
                            >
                              {embeddingStats.job?.status === 'running' && embeddingStats.job?.target === t.key ? 'Running...' :
                               embeddingStats.job?.status === 'running' ? 'Other running' :
                               'Generate'}
                            </button>
                            <button
                              onClick={async () => {
                                if (!confirm(`Run ${t.label} embeddings indefinitely until cancelled or all ${s.notEmbedded.toLocaleString()} remaining are done?`)) return;
                                const res = await fetch('/api/niche-spy/embeddings', {
                                  method: 'POST',
                                  headers: { 'Content-Type': 'application/json' },
                                  body: JSON.stringify({ limit: nicheLimit, batchSize: nicheBatchSize, threads: nicheThreads, target: t.key, indefinite: true }),
                                });
                                if (!res.ok) {
                                  const data = await res.json().catch(() => ({}));
                                  alert(data.message || `Failed to start: ${res.status}`);
                                }
                              }}
                              disabled={(embeddingStats.job?.status === 'running') || s.notEmbedded === 0}
                              className="px-2.5 py-1 bg-pink-700 text-white font-semibold rounded-md hover:bg-pink-600 disabled:opacity-40 disabled:cursor-not-allowed transition text-xs"
                              title="Run until cancelled OR until every remaining video has this embedding"
                            >
                              ∞
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* Meta row — api keys + model note */}
                <div className="flex items-center justify-between text-xs text-gray-400 px-1">
                  <span>API keys configured: <span className="text-blue-400 font-medium">{embeddingStats.apiKeysConfigured}</span></span>
                  <span>Legacy model: {embeddingStats.legacyModel}</span>
                </div>

                {/* Current job status */}
                {embeddingStats.job && (
                  <div className={`border rounded-lg px-4 py-3 ${
                    embeddingStats.job.status === 'running' ? 'bg-blue-900/20 border-blue-600/40' :
                    embeddingStats.job.status === 'done' ? 'bg-green-900/20 border-green-600/40' :
                    embeddingStats.job.status === 'error' ? 'bg-red-900/20 border-red-600/40' :
                    'bg-gray-900/20 border-gray-700'
                  }`}>
                    <div className="flex items-center gap-3">
                      {embeddingStats.job.status === 'running' && (
                        <div className="w-4 h-4 border-2 border-blue-400 border-t-transparent rounded-full animate-spin flex-shrink-0" />
                      )}
                      <div className="flex-1">
                        <div className="flex items-center justify-between">
                          <span className="text-sm font-medium text-white">
                            <span className="inline-block px-2 py-0.5 text-[10px] uppercase tracking-wider rounded mr-2 bg-amber-500/20 text-amber-300 border border-amber-500/40">
                              {embeddingStats.job.target || 'unknown target'}
                            </span>
                            {embeddingStats.job.status === 'running' ? `Batch ${embeddingStats.job.current_batch}/${embeddingStats.job.total_batches}` :
                             embeddingStats.job.status === 'done' ? 'Complete' :
                             embeddingStats.job.status === 'cancelled' ? 'Cancelled' :
                             embeddingStats.job.status === 'error' ? 'Error' :
                             embeddingStats.job.status}
                          </span>
                          <span className="text-xs text-gray-400">
                            {embeddingStats.job.processed}/{embeddingStats.job.total_needed} processed
                            {embeddingStats.job.errors > 0 && ` · ${embeddingStats.job.errors} errors`}
                          </span>
                        </div>
                        {embeddingStats.job.status === 'running' && embeddingStats.job.total_needed > 0 && (
                          <div className="h-1.5 bg-gray-700 rounded-full overflow-hidden mt-2">
                            <div className="h-full bg-blue-500 rounded-full transition-all"
                              style={{ width: `${(embeddingStats.job.processed / embeddingStats.job.total_needed) * 100}%` }} />
                          </div>
                        )}
                        {embeddingStats.job.error_message && (
                          <p className="text-xs text-yellow-400 mt-1">{embeddingStats.job.error_message}</p>
                        )}
                        <p className="text-[10px] text-gray-500 mt-1">
                          Started: {new Date(embeddingStats.job.started_at).toLocaleString()}
                          {embeddingStats.job.completed_at && ` · Completed: ${new Date(embeddingStats.job.completed_at).toLocaleString()}`}
                        </p>
                      </div>
                    </div>
                  </div>
                )}

                {/* Controls + Action buttons */}
                <div className="flex items-center gap-3 flex-wrap">
                  <div className="flex items-center gap-2">
                    <label className="text-xs text-gray-400">Batch</label>
                    <select value={nicheBatchSize} onChange={e => setNicheBatchSize(parseInt(e.target.value))}
                      className="bg-gray-800 border border-gray-700 text-white text-sm rounded-lg px-2 py-1.5">
                      <option value={5}>5</option>
                      <option value={10}>10</option>
                      <option value={20}>20</option>
                      <option value={50}>50</option>
                      <option value={100}>100</option>
                    </select>
                  </div>
                  <div className="flex items-center gap-2">
                    <label className="text-xs text-gray-400">Limit</label>
                    <select value={nicheLimit} onChange={e => setNicheLimit(parseInt(e.target.value))}
                      className="bg-gray-800 border border-gray-700 text-white text-sm rounded-lg px-2 py-1.5">
                      <option value={100}>100</option>
                      <option value={500}>500</option>
                      <option value={1000}>1K</option>
                      <option value={2000}>2K</option>
                      <option value={5000}>5K</option>
                      <option value={10000}>10K</option>
                    </select>
                  </div>
                  <div className="flex items-center gap-2">
                    <label className="text-xs text-gray-400">Threads</label>
                    <select value={nicheThreads} onChange={e => setNicheThreads(parseInt(e.target.value))}
                      className="bg-gray-800 border border-gray-700 text-white text-sm rounded-lg px-2 py-1.5">
                      <option value={1}>1</option>
                      <option value={2}>2</option>
                      <option value={3}>3</option>
                      <option value={5}>5</option>
                      <option value={10}>10</option>
                      <option value={15}>15</option>
                      <option value={20}>20</option>
                      <option value={30}>30</option>
                    </select>
                  </div>
                  {/* The per-target "Generate" buttons live inside each target card
                      above. Only the global Cancel button remains here. */}
                  {embeddingStats.job?.status === 'running' && (
                    <button
                      onClick={async () => { await fetch('/api/niche-spy/embeddings', { method: 'DELETE' }); }}
                      className="px-5 py-2.5 bg-red-600 text-white font-semibold rounded-xl hover:bg-red-700 transition"
                    >
                      Cancel running job
                    </button>
                  )}
                </div>

                {/* Key & Proxy Status Table */}
                {(embeddingStats.keys || embeddingStats.proxy) && (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
                    {/* API Keys */}
                    {embeddingStats.keys && embeddingStats.keys.length > 0 && (
                      <div className="bg-gray-900/50 rounded-lg p-3">
                        <h4 className="text-xs text-gray-500 uppercase tracking-wider mb-2">API Keys</h4>
                        <div className="space-y-1.5">
                          {embeddingStats.keys.map((k, i) => (
                            <div key={i} className="flex items-center justify-between text-xs">
                              <div className="flex items-center gap-2">
                                <span className="font-mono text-gray-300">{k.key}</span>
                                <span className="text-blue-400 font-mono">→ {k.proxy}</span>
                              </div>
                              {k.banned ? (
                                <span className="text-red-400 flex items-center gap-1">
                                  <span className="w-2 h-2 bg-red-500 rounded-full" />
                                  banned ({k.banExpiresIn}s)
                                </span>
                              ) : (
                                <span className="text-green-400 flex items-center gap-1">
                                  <span className="w-2 h-2 bg-green-500 rounded-full" />
                                  active
                                </span>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Proxy Status */}
                    {embeddingStats.proxy && (
                      <div className="bg-gray-900/50 rounded-lg p-3">
                        <h4 className="text-xs text-gray-500 uppercase tracking-wider mb-2">Proxy</h4>
                        <div className="space-y-1.5 text-xs">
                          <div className="flex justify-between">
                            <span className="text-gray-400">Available</span>
                            <span className="text-white font-medium">{embeddingStats.proxy.total} devices</span>
                          </div>
                          {embeddingStats.proxy.current && (
                            <div className="flex justify-between">
                              <span className="text-gray-400">Current</span>
                              <span className="text-blue-400 font-mono">{embeddingStats.proxy.current.deviceId}... ({embeddingStats.proxy.current.networkType})</span>
                            </div>
                          )}
                          <div className="flex justify-between">
                            <span className="text-gray-400">Cache</span>
                            <span className="text-gray-300">{embeddingStats.proxy.cached ? `fresh (${embeddingStats.proxy.cacheAge}s)` : 'stale'}</span>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* Per-keyword embedding coverage — 3 columns (title v1 / title v2 / thumb v2).
                    Fixed grid-template needs ~600px; wrap in overflow-x-auto so narrow
                    viewports get horizontal scroll instead of clipped content. */}
                {embeddingStats.keywordCoverage && embeddingStats.keywordCoverage.length > 0 && (
                  <div className="mt-4 bg-gray-900/50 rounded-lg p-3 overflow-x-auto">
                    <div className="min-w-[600px]">
                    <h4 className="text-xs text-gray-500 uppercase tracking-wider mb-2">Coverage by Keyword</h4>
                    <div className="grid grid-cols-[minmax(140px,1fr)_repeat(3,minmax(120px,1fr))_60px] gap-3 items-center text-[10px] text-gray-500 uppercase tracking-wider pb-1.5 border-b border-gray-800">
                      <div>Keyword</div>
                      <div>Title v1</div>
                      <div>Title v2</div>
                      <div>Thumb v2</div>
                      <div className="text-right">Total</div>
                    </div>
                    <div className="max-h-72 overflow-y-auto divide-y divide-gray-800/50">
                      {embeddingStats.keywordCoverage.map(k => {
                        const cell = (pct: number, embedded: number) => (
                          <div className="flex items-center gap-2 text-[11px]">
                            <div className="flex-1 h-1.5 bg-gray-700 rounded-full overflow-hidden">
                              <div className={`h-full rounded-full ${pct >= 100 ? 'bg-green-500' : pct > 0 ? 'bg-amber-500' : 'bg-gray-600'}`} style={{ width: `${pct}%` }} />
                            </div>
                            <span className={`font-mono w-8 text-right ${pct >= 100 ? 'text-green-400' : pct > 0 ? 'text-amber-400' : 'text-gray-600'}`}>{pct}%</span>
                            <span className="text-gray-600 text-[9px] w-10 text-right">{embedded}</span>
                          </div>
                        );
                        return (
                          <div key={k.keyword} className="grid grid-cols-[minmax(140px,1fr)_repeat(3,minmax(120px,1fr))_60px] gap-3 items-center py-1.5">
                            <span className="text-gray-300 text-xs truncate">{k.keyword}</span>
                            {cell(k.title_v1.pct, k.title_v1.embedded)}
                            {cell(k.title_v2.pct, k.title_v2.embedded)}
                            {cell(k.thumbnail_v2.pct, k.thumbnail_v2.embedded)}
                            <span className="text-gray-500 text-[10px] text-right font-mono">{k.total}</span>
                          </div>
                        );
                      })}
                    </div>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Sub-niche Clustering */}
          <div className="bg-gray-800/50 rounded-2xl border border-gray-700 p-6">
            <h2 className="text-lg font-bold text-white mb-2">Sub-niche Clustering</h2>
            <p className="text-xs text-gray-500 mb-4">Run HDBSCAN clustering on video embeddings to discover sub-niches within a keyword.</p>

            <div className="flex items-center gap-3 mb-4 flex-wrap">
              <select id="cluster-keyword" className="bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 text-white text-sm flex-1 min-w-[200px]">
                {embeddingStats?.keywordCoverage?.map(k => (
                  <option key={k.keyword} value={k.keyword}>{k.keyword} ({k.title_v1.embedded} v1 / {k.title_v2.embedded} v2 / {k.thumbnail_v2.embedded} thumb)</option>
                ))}
              </select>
              <select id="cluster-source" defaultValue="title_v1" className="bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 text-white text-sm"
                title="Embedding space to cluster on — combined concatenates title+thumbnail v2 vectors">
                <option value="title_v1">Title v1</option>
                <option value="title_v2">Title v2</option>
                <option value="thumbnail_v2">Thumbnail v2</option>
                <option value="combined">Combined (title + thumb)</option>
              </select>
              <button
                onClick={async () => {
                  const kw = (document.getElementById('cluster-keyword') as HTMLSelectElement)?.value;
                  const source = (document.getElementById('cluster-source') as HTMLSelectElement)?.value;
                  if (!kw) return;
                  const res = await fetch('/api/niche-spy/clusters', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ keyword: kw, source }),
                  });
                  const data = await res.json();
                  alert(data.ok
                    ? `Clustering started (run #${data.runId}, ${data.embeddedVideos} videos, source=${data.source})`
                    : `Error: ${data.error}`);
                }}
                className="px-4 py-2 bg-amber-600 hover:bg-amber-700 text-white rounded-xl text-sm font-medium"
              >
                Run Clustering
              </button>
              <button
                onClick={async () => {
                  const kw = (document.getElementById('cluster-keyword') as HTMLSelectElement)?.value;
                  if (!kw) return;
                  const res = await fetch('/api/niche-spy/clusters', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ keyword: kw, action: 'label' }),
                  });
                  const data = await res.json();
                  alert(data.ok ? 'AI labeling started' : `Error: ${data.error}`);
                }}
                className="px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-xl text-sm font-medium"
              >
                Upgrade Labels
              </button>
            </div>
          </div>

          {/* Keyword Management */}
          {embeddingStats?.keywordCoverage && (
            <div className="bg-gray-800/50 rounded-2xl border border-gray-700 p-6">
              <h2 className="text-lg font-bold text-white mb-4">Keyword Management</h2>
              <p className="text-xs text-gray-500 mb-3">Delete a keyword to remove it and ALL associated videos, embeddings, and saturation data.</p>
              <div className="space-y-1.5 max-h-80 overflow-y-auto">
                {embeddingStats.keywordCoverage.map(k => (
                  <div key={k.keyword} className="flex items-center gap-3 text-sm bg-gray-900/30 rounded-lg px-3 py-2">
                    <span className="text-gray-300 flex-1 truncate">{k.keyword}</span>
                    <span className="text-xs text-gray-500 w-16 text-right">{k.total} vids</span>
                    <span className={`text-xs w-10 text-right ${k.title_v1.pct >= 100 ? 'text-green-400' : k.title_v1.pct > 0 ? 'text-amber-400' : 'text-gray-600'}`}>
                      {k.title_v1.pct}%
                    </span>
                    <button
                      onClick={async () => {
                        if (!confirm(`Delete "${k.keyword}" and all ${k.total} videos?`)) return;
                        await fetch('/api/niche-spy/keywords', {
                          method: 'DELETE',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ keyword: k.keyword }),
                        });
                        // Refresh stats
                        fetch('/api/niche-spy/embeddings').then(r => r.json()).then(setEmbeddingStats).catch(() => {});
                      }}
                      className="text-red-500/60 hover:text-red-400 transition"
                      title={`Delete ${k.keyword}`}
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* API Keys Config */}
          <div className="bg-gray-800/50 rounded-2xl border border-gray-700 p-6">
            <h2 className="text-lg font-bold text-white mb-4">Configuration</h2>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-1">Google API Keys (for embeddings)</label>
                <textarea
                  value={nicheGoogleApiKeys}
                  onChange={(e) => setNicheGoogleApiKeys(e.target.value)}
                  placeholder="One API key per line. Keys are rotated automatically."
                  rows={4}
                  className="w-full px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-xl text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-amber-500 font-mono text-sm"
                />
                <p className="text-xs text-gray-500 mt-1">Free Google AI keys for gemini-embedding. One per line, rotated automatically.</p>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-1">Legacy Embedding Model (backward compat)</label>
                <select
                  value={nicheEmbeddingModel}
                  onChange={(e) => setNicheEmbeddingModel(e.target.value)}
                  className="w-full px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-xl text-white focus:outline-none focus:ring-2 focus:ring-amber-500 text-sm"
                >
                  <option value="gemini-embedding-001">gemini-embedding-001 (3072d, stable)</option>
                  <option value="gemini-embedding-2-preview">gemini-embedding-2-preview (3072d, latest)</option>
                </select>
                <p className="text-xs text-gray-500 mt-1">Controls the legacy batchEmbed() path. New v2 + thumbnail embeddings use their own fixed models.</p>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-300 mb-1">Similarity Source</label>
                <select
                  value={nicheSimilaritySource}
                  onChange={(e) => setNicheSimilaritySource(e.target.value as 'title_v1' | 'title_v2' | 'thumbnail_v2' | 'combined_v2')}
                  className="w-full px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-xl text-white focus:outline-none focus:ring-2 focus:ring-amber-500 text-sm"
                >
                  <option value="combined_v2">Combined v2 — gemini-embedding-2-preview (title + thumb, joint) ★ default</option>
                  <option value="title_v2">Title v2 — gemini-embedding-2-preview</option>
                  <option value="thumbnail_v2">Thumbnail v2 — gemini-embedding-2-preview (image)</option>
                  <option value="title_v1">Title v1 — gemini-embedding-001 (legacy)</option>
                </select>
                <p className="text-xs text-gray-500 mt-1">Controls which embedding space ALL similarity searches read from. Only videos with an embedding in the selected space will appear in similar results.</p>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-1">Priority Keywords (embed first)</label>
                <textarea
                  value={nichePriorityKeywords}
                  onChange={(e) => setNichePriorityKeywords(e.target.value)}
                  placeholder="One keyword per line. These niches get embedded first."
                  rows={3}
                  className="w-full px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-xl text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-amber-500 text-sm"
                />
                <p className="text-xs text-gray-500 mt-1">Videos matching these keywords are embedded before others. One per line.</p>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-1">Niche Spy xgodo Token</label>
                <input
                  type="password"
                  value={nicheSpyToken}
                  onChange={(e) => setNicheSpyToken(e.target.value)}
                  placeholder="xgodo JWT for niche spy job"
                  className="w-full px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-xl text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-amber-500 font-mono text-sm"
                />
              </div>
              <div className="flex items-center gap-3">
                <button onClick={saveConfig} disabled={configSaving}
                  className="px-5 py-2.5 bg-amber-600 text-white font-semibold rounded-xl hover:bg-amber-700 disabled:opacity-50 transition">
                  {configSaving ? 'Saving...' : 'Save Config'}
                </button>
                {configSaved && <span className="text-green-400 text-sm">Saved</span>}
              </div>
            </div>
          </div>
        </div>
        </div>

        {/* Enrich Data Tab */}
        <div style={{ display: adminSection === 'enrich' ? 'block' : 'none' }}>
        <div className="space-y-6">
          <div className="bg-gray-800/50 rounded-2xl border border-gray-700 p-6">
            <h2 className="text-lg font-bold text-white mb-4">Enrich Data (YouTube Data API)</h2>

            {nicheEnrichStats && (
              <div className="space-y-4">
                {/* Per-data-point indicators — each number shows how many rows
                    still need that specific field enriched. Ticks down live via
                    the 3s poll in the useEffect above as each phase walks. */}
                {nicheEnrichStats.videos && nicheEnrichStats.channels && (
                  <div className="space-y-3">
                    {/* Videos row — Phase 1 fields */}
                    <div>
                      <div className="text-[11px] text-gray-400 mb-1.5 uppercase tracking-wider">
                        Videos <span className="text-gray-200 normal-case">· {nicheEnrichStats.videos.total.toLocaleString()} total</span>
                      </div>
                      <div className="grid grid-cols-4 md:grid-cols-7 gap-2">
                        {([
                          ['Never enriched',  nicheEnrichStats.videos.neverEnriched,    'text-orange-400'],
                          ['Views',           nicheEnrichStats.videos.missingViews,     'text-red-400'],
                          ['Likes',           nicheEnrichStats.videos.missingLikes,     'text-yellow-400'],
                          ['Comments',        nicheEnrichStats.videos.missingComments,  'text-yellow-400'],
                          ['Posted at',       nicheEnrichStats.videos.missingPostedAt,  'text-yellow-400'],
                          ['Thumbnail',       nicheEnrichStats.videos.missingThumbnail, 'text-yellow-400'],
                          ['Channel ID',      nicheEnrichStats.videos.missingChannelId, 'text-red-400'],
                        ] as Array<[string, number, string]>).map(([label, value, color]) => (
                          <div key={label} className="bg-gray-900/50 rounded-lg p-2 text-center">
                            <div className={`text-xl font-bold ${value === 0 ? 'text-gray-600' : color}`}>
                              {value.toLocaleString()}
                            </div>
                            <div className="text-[10px] text-gray-500">{label}</div>
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* Channels row — Phase 2 + Phase 3 fields */}
                    <div>
                      <div className="text-[11px] text-gray-400 mb-1.5 uppercase tracking-wider">
                        Channels <span className="text-gray-200 normal-case">· {nicheEnrichStats.channels.total.toLocaleString()} total</span>
                      </div>
                      <div className="grid grid-cols-3 md:grid-cols-9 gap-2">
                        {([
                          ['No row',         nicheEnrichStats.channels.missingRow,         'text-red-400'],
                          ['Subs',           nicheEnrichStats.channels.missingSubs,        'text-red-400'],
                          ['Created at',     nicheEnrichStats.channels.missingCreatedAt,   'text-yellow-400'],
                          ['Handle',         nicheEnrichStats.channels.missingHandle,      'text-yellow-400'],
                          ['Playlist ID',    nicheEnrichStats.channels.missingPlaylistId,  'text-yellow-400'],
                          ['Video count',    nicheEnrichStats.channels.missingVideoCount,  'text-yellow-400'],
                          ['First upload',   nicheEnrichStats.channels.missingFirstUpload, 'text-amber-400'],
                          // needMoreVideos = channels with <4 videos in
                          // niche_spy_videos. Phase 4 walks these and pulls
                          // 10 recent uploads each so the channel cards have
                          // enough thumbs to render the 4-thumb strip.
                          ['Need videos',    nicheEnrichStats.channels.needMoreVideos,     'text-amber-400'],
                          // tooBigForWalk = channels with >200 videos that we
                          // intentionally skip in Phase 3. Rendered dim because
                          // it's not a backlog, just a cap.
                          ['Too big (>200)', nicheEnrichStats.channels.tooBigForWalk,      'text-gray-500'],
                        ] as Array<[string, number, string]>).map(([label, value, color]) => (
                          <div key={label} className="bg-gray-900/50 rounded-lg p-2 text-center">
                            <div className={`text-xl font-bold ${value === 0 ? 'text-gray-600' : color}`}>
                              {value.toLocaleString()}
                            </div>
                            <div className="text-[10px] text-gray-500">{label}</div>
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* Proxies — kept as a small context card */}
                    <div className="inline-flex items-baseline gap-2 bg-gray-900/50 rounded-lg px-3 py-1.5">
                      <span className="text-base font-bold text-blue-400">{nicheEnrichStats.proxyStats?.total || 0}</span>
                      <span className="text-[10px] text-gray-500 uppercase tracking-wider">Proxies</span>
                    </div>
                  </div>
                )}

                {/* Current job status (mirrors the embedding job banner) */}
                {nicheEnrichStats.job && (
                  <div className={`border rounded-lg px-4 py-3 ${
                    nicheEnrichStats.job.status === 'running'   ? 'bg-blue-900/20 border-blue-600/40' :
                    nicheEnrichStats.job.status === 'done'      ? 'bg-green-900/20 border-green-600/40' :
                    nicheEnrichStats.job.status === 'cancelled' ? 'bg-yellow-900/20 border-yellow-600/40' :
                    nicheEnrichStats.job.status === 'error'     ? 'bg-red-900/20 border-red-600/40' :
                    'bg-gray-900/20 border-gray-700'
                  }`}>
                    <div className="flex items-center gap-3">
                      {nicheEnrichStats.job.status === 'running' && (
                        <div className="w-4 h-4 border-2 border-blue-400 border-t-transparent rounded-full animate-spin flex-shrink-0" />
                      )}
                      <div className="flex-1">
                        <div className="flex items-center justify-between">
                          <span className="text-sm font-medium text-white">
                            {nicheEnrichStats.job.keyword && (
                              <span className="inline-block px-2 py-0.5 text-[10px] uppercase tracking-wider rounded mr-2 bg-purple-500/20 text-purple-300 border border-purple-500/40">
                                {nicheEnrichStats.job.keyword}
                              </span>
                            )}
                            <span className="inline-block px-2 py-0.5 text-[10px] uppercase tracking-wider rounded mr-2 bg-amber-500/20 text-amber-300 border border-amber-500/40">
                              {nicheEnrichStats.job.threads}× threads
                            </span>
                            {nicheEnrichStats.job.status === 'running' ? `Batch ${nicheEnrichStats.job.current_batch}/${nicheEnrichStats.job.total_batches}` :
                             nicheEnrichStats.job.status === 'done' ? 'Complete' :
                             nicheEnrichStats.job.status === 'cancelled' ? 'Cancelled' :
                             nicheEnrichStats.job.status === 'error' ? 'Error' :
                             nicheEnrichStats.job.status}
                          </span>
                          <span className="text-xs text-gray-400">
                            {nicheEnrichStats.job.enriched_videos} videos · {nicheEnrichStats.job.enriched_channels} channels
                            {nicheEnrichStats.job.errors > 0 && ` · ${nicheEnrichStats.job.errors} errors`}
                          </span>
                        </div>
                        {nicheEnrichStats.job.status === 'running' && nicheEnrichStats.job.total_batches > 0 && (
                          <div className="h-1.5 bg-gray-700 rounded-full overflow-hidden mt-2">
                            <div className="h-full bg-blue-500 rounded-full transition-all"
                              style={{ width: `${(nicheEnrichStats.job.current_batch / nicheEnrichStats.job.total_batches) * 100}%` }} />
                          </div>
                        )}
                        {nicheEnrichStats.job.error_message && (
                          <p className="text-xs text-yellow-400 mt-1 truncate">{nicheEnrichStats.job.error_message}</p>
                        )}
                        <p className="text-[10px] text-gray-500 mt-1">
                          Started: {new Date(nicheEnrichStats.job.started_at).toLocaleString()}
                          {nicheEnrichStats.job.completed_at && ` · Completed: ${new Date(nicheEnrichStats.job.completed_at).toLocaleString()}`}
                        </p>
                      </div>
                    </div>
                  </div>
                )}

                {/* Controls */}
                <div className="flex items-center gap-3 flex-wrap">
                  <div className="flex items-center gap-2">
                    <label className="text-xs text-gray-400">Batch</label>
                    <select value={enrichBatchSize} onChange={e => setEnrichBatchSize(parseInt(e.target.value))}
                      className="bg-gray-800 border border-gray-700 text-white text-sm rounded-lg px-2 py-1.5">
                      <option value={10}>10</option>
                      <option value={20}>20</option>
                      <option value={50}>50</option>
                    </select>
                  </div>
                  <div className="flex items-center gap-2">
                    <label className="text-xs text-gray-400">Limit</label>
                    <select value={enrichLimit} onChange={e => setEnrichLimit(parseInt(e.target.value))}
                      className="bg-gray-800 border border-gray-700 text-white text-sm rounded-lg px-2 py-1.5">
                      <option value={100}>100</option>
                      <option value={500}>500</option>
                      <option value={1000}>1K</option>
                      <option value={2000}>2K</option>
                      <option value={5000}>5K</option>
                      <option value={10000}>10K</option>
                    </select>
                  </div>
                  <div className="flex items-center gap-2">
                    <label className="text-xs text-gray-400">Threads</label>
                    <select value={enrichThreads} onChange={e => setEnrichThreads(parseInt(e.target.value))}
                      className="bg-gray-800 border border-gray-700 text-white text-sm rounded-lg px-2 py-1.5">
                      <option value={1}>1</option>
                      <option value={2}>2</option>
                      <option value={3}>3</option>
                      <option value={5}>5</option>
                      <option value={10}>10</option>
                      <option value={15}>15</option>
                      <option value={20}>20</option>
                      <option value={30}>30</option>
                    </select>
                  </div>
                  <button
                    type="button"
                    onClick={() => setEnrichIndefinite(v => !v)}
                    className={`px-3 py-2.5 rounded-xl text-sm font-semibold transition ${
                      enrichIndefinite
                        ? 'bg-amber-500 text-black border border-amber-500 hover:bg-amber-400'
                        : 'bg-gray-800 text-gray-300 border border-gray-700 hover:bg-gray-700'
                    }`}
                    title="Indefinite mode: keep looping batches server-side until the queue is empty or you cancel."
                  >
                    ∞
                  </button>
                  <button
                    onClick={async () => {
                      const res = await fetch('/api/niche-spy/enrich', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ limit: enrichLimit, batchSize: enrichBatchSize, threads: enrichThreads, indefinite: enrichIndefinite }),
                      });
                      if (!res.ok) {
                        const d = await res.json().catch(() => ({}));
                        alert(d.error || d.message || `Failed: ${res.status}`);
                      }
                    }}
                    disabled={nicheEnrichStats.job?.status === 'running'}
                    className="px-5 py-2.5 bg-purple-600 text-white font-semibold rounded-xl hover:bg-purple-700 disabled:opacity-50 transition"
                  >
                    {nicheEnrichStats.job?.status === 'running' ? 'Running...' : (enrichIndefinite ? 'Enrich Data ∞' : 'Enrich Data')}
                  </button>
                  {nicheEnrichStats.job?.status === 'running' && (
                    <button
                      onClick={async () => { await fetch('/api/niche-spy/enrich', { method: 'DELETE' }); }}
                      className="px-5 py-2.5 bg-red-600 text-white font-semibold rounded-xl hover:bg-red-700 transition"
                    >
                      Cancel
                    </button>
                  )}
                  <span className="text-xs text-gray-500">Parallel YT Data API enrichment (views, likes, subs, dates, channel age) via proxies</span>
                </div>

                {/* Key status — per-key ban + proxy pairing */}
                {nicheEnrichStats.keys && nicheEnrichStats.keys.length > 0 && (
                  <div className="bg-gray-900/50 rounded-lg p-3">
                    <h4 className="text-xs text-gray-500 uppercase tracking-wider mb-2">YT API Keys</h4>
                    <div className="space-y-1.5">
                      {nicheEnrichStats.keys.map((k, i) => (
                        <div key={i} className="flex items-center justify-between text-xs">
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-gray-300">{k.key}</span>
                            <span className="text-blue-400 font-mono">→ {k.proxy}</span>
                          </div>
                          {k.banned ? (
                            <span className="text-red-400 flex items-center gap-1">
                              <span className="w-2 h-2 bg-red-500 rounded-full" />
                              banned ({k.banExpiresIn}s)
                            </span>
                          ) : (
                            <span className="text-green-400 flex items-center gap-1">
                              <span className="w-2 h-2 bg-green-500 rounded-full" />
                              active
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Outlier pipeline — Enrich channels + Recompute scores.
              Sits in the Enrich Data tab because both actions are admin-y
              data-mutation jobs that share the same YT API quota and proxy
              infrastructure as the bulk enrich above. Users go to
              /niche/outliers to CONSUME the scored data, not to trigger it. */}
          <div className="bg-gray-800/50 rounded-2xl border border-gray-700 p-6">
            <h2 className="text-lg font-bold text-white mb-1">Outlier Pipeline</h2>
            <p className="text-xs text-gray-500 mb-4">
              Pulls each channel&apos;s recent uploads via playlistItems.list
              + videos.list for unbiased avg-views, then computes the
              peer-bucket outlier score per channel. Cost: 2 quota units per
              channel on enrichment; recompute is DB-only.
            </p>

            {/* Counts — mirrors the Videos / Channels grid on the main enrich card */}
            {outlierStats && (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4">
                <div className="bg-gray-900/50 rounded-lg p-3 text-center">
                  <div className="text-2xl font-bold text-white">{outlierStats.total.toLocaleString()}</div>
                  <div className="text-[10px] text-gray-500 uppercase tracking-wider">Total enrich-able</div>
                </div>
                <div className="bg-gray-900/50 rounded-lg p-3 text-center">
                  <div className="text-2xl font-bold text-green-400">{outlierStats.enriched.toLocaleString()}</div>
                  <div className="text-[10px] text-gray-500 uppercase tracking-wider">With stats</div>
                </div>
                <div className="bg-gray-900/50 rounded-lg p-3 text-center">
                  <div className="text-2xl font-bold text-amber-400">{outlierStats.pending.toLocaleString()}</div>
                  <div className="text-[10px] text-gray-500 uppercase tracking-wider">Pending</div>
                </div>
                <div className="bg-gray-900/50 rounded-lg p-3 text-center">
                  <div className="text-2xl font-bold text-orange-400">{outlierStats.stale.toLocaleString()}</div>
                  <div className="text-[10px] text-gray-500 uppercase tracking-wider">Stale &gt;7d</div>
                </div>
              </div>
            )}

            {/* Controls */}
            <div className="flex items-center gap-3 flex-wrap mb-3">
              <div className="flex items-center gap-2">
                <label className="text-xs text-gray-400">Batch</label>
                <select value={outlierLimit} onChange={e => setOutlierLimit(parseInt(e.target.value))}
                  className="bg-gray-800 border border-gray-700 text-white text-sm rounded-lg px-2 py-1.5">
                  <option value={50}>50</option>
                  <option value={100}>100</option>
                  <option value={200}>200</option>
                  <option value={500}>500</option>
                </select>
              </div>
              <div className="flex items-center gap-2">
                <label className="text-xs text-gray-400">Threads</label>
                <select value={outlierThreads} onChange={e => setOutlierThreads(parseInt(e.target.value))}
                  className="bg-gray-800 border border-gray-700 text-white text-sm rounded-lg px-2 py-1.5">
                  <option value={1}>1</option>
                  <option value={2}>2</option>
                  <option value={4}>4</option>
                  <option value={6}>6</option>
                  <option value={10}>10</option>
                  <option value={15}>15</option>
                  <option value={20}>20</option>
                  <option value={30}>30</option>
                </select>
              </div>
              <div className="flex items-center gap-2">
                <label className="text-xs text-gray-400">Videos / channel</label>
                <select value={outlierMaxVideos} onChange={e => setOutlierMaxVideos(parseInt(e.target.value))}
                  className="bg-gray-800 border border-gray-700 text-white text-sm rounded-lg px-2 py-1.5">
                  <option value={10}>10</option>
                  <option value={20}>20</option>
                  <option value={30}>30</option>
                  <option value={50}>50</option>
                </select>
              </div>
              <button
                type="button"
                onClick={() => setOutlierIndefinite(v => !v)}
                disabled={outlierEnriching || outlierRecomputing}
                className={`px-3 py-2 rounded-xl text-sm font-medium transition ${
                  outlierIndefinite
                    ? 'bg-amber-500 text-black border border-amber-500 hover:bg-amber-400'
                    : 'bg-gray-800 text-gray-300 border border-gray-700 hover:bg-gray-700'
                } disabled:opacity-50`}
                title="Indefinite mode: keep looping batches server-side until the pending queue stays empty for 60s, or you cancel."
              >
                ∞
              </button>
              <button
                onClick={runOutlierEnrich}
                disabled={outlierEnriching || outlierRecomputing}
                className="px-4 py-2 bg-cyan-600 hover:bg-cyan-500 disabled:bg-gray-700 disabled:text-gray-500 text-white text-sm font-medium rounded-xl transition"
              >
                {outlierEnriching
                  ? (outlierIndefinite ? 'Looping…' : 'Enriching…')
                  : (outlierIndefinite ? 'Enrich channels ∞' : 'Enrich channels')}
              </button>
              {outlierEnriching && outlierIndefinite && (
                <button
                  type="button"
                  onClick={async () => {
                    await fetch('/api/admin/outliers/enrich-channels/agent', { method: 'DELETE' });
                  }}
                  className="px-4 py-2 bg-red-600 hover:bg-red-500 text-white text-sm font-medium rounded-xl transition"
                >
                  Cancel
                </button>
              )}
              <button
                onClick={runOutlierRecompute}
                disabled={outlierEnriching || outlierRecomputing}
                className="px-4 py-2 bg-purple-600 hover:bg-purple-500 disabled:bg-gray-700 disabled:text-gray-500 text-white text-sm font-medium rounded-xl transition"
              >
                {outlierRecomputing ? 'Recomputing…' : 'Recompute scores'}
              </button>
            </div>

            {(outlierEnrichMsg || outlierRecomputeMsg) && (
              <div className="px-3 py-2 bg-gray-900/50 border border-gray-700 rounded-lg text-xs text-gray-300 space-y-1">
                {outlierEnrichMsg && <div><span className="text-cyan-400">enrich:</span> {outlierEnrichMsg}</div>}
                {outlierRecomputeMsg && <div><span className="text-purple-400">recompute:</span> {outlierRecomputeMsg}</div>}
              </div>
            )}
          </div>

          {/* YouTube Data API Keys */}
          <div className="bg-gray-800/50 rounded-2xl border border-gray-700 p-6">
            <h2 className="text-lg font-bold text-white mb-4">YouTube Data API Keys</h2>
            <div className="space-y-4">
              <div>
                <textarea
                  value={nicheYtApiKeys}
                  onChange={(e) => setNicheYtApiKeys(e.target.value)}
                  placeholder="One YouTube Data API v3 key per line. Keys are rotated automatically."
                  rows={4}
                  className="w-full px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-xl text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-purple-500 font-mono text-sm"
                />
                <p className="text-xs text-gray-500 mt-1">Used for enrichment (views, subs, dates, channel age). One per line, rotated per batch.</p>
              </div>
              <div className="flex items-center gap-3">
                <button onClick={saveConfig} disabled={configSaving}
                  className="px-5 py-2.5 bg-purple-600 text-white font-semibold rounded-xl hover:bg-purple-700 disabled:opacity-50 transition">
                  {configSaving ? 'Saving...' : 'Save Keys'}
                </button>
                {configSaved && <span className="text-green-400 text-sm">Saved</span>}
              </div>
            </div>
          </div>
        </div>
        </div>

        {/* Admin Tokens Tab */}
        <div style={{ display: adminSection === 'tokens' ? 'block' : 'none' }}>
        <div className="space-y-6">
          <div className="bg-gray-800/50 rounded-2xl border border-gray-700 p-6">
            <h2 className="text-lg font-bold text-white mb-2">Admin API Tokens</h2>
            <p className="text-gray-400 text-sm mb-4">Generate tokens for admin-level API access. Prefix: <code className="text-red-400">hba_</code></p>

            {/* New token display */}
            {newAdminToken && (
              <div className="bg-red-900/20 border border-red-600 rounded-lg p-4 mb-4">
                <p className="text-sm text-red-300 mb-2 font-medium">Token created — copy now, won&apos;t be shown again:</p>
                <div className="flex items-center gap-2">
                  <code className="flex-1 bg-black/40 text-red-300 px-3 py-2 rounded text-sm font-mono break-all select-all">{newAdminToken}</code>
                  <button
                    onClick={() => { navigator.clipboard.writeText(newAdminToken); setAdminTokenCopied(true); setTimeout(() => setAdminTokenCopied(false), 2000); }}
                    className="px-3 py-2 bg-red-600 hover:bg-red-700 text-white rounded text-sm flex-shrink-0"
                  >{adminTokenCopied ? 'Copied!' : 'Copy'}</button>
                </div>
              </div>
            )}

            {/* Existing tokens */}
            {adminTokens.length > 0 && (
              <div className="space-y-2 mb-4">
                <h3 className="text-sm font-medium text-gray-300">Active admin tokens</h3>
                {adminTokens.map(t => (
                  <div key={t.id} className="flex items-center justify-between bg-gray-900/50 border border-gray-700 rounded-lg px-4 py-3">
                    <div className="flex items-center gap-3">
                      <span className="text-sm text-white font-mono">{t.tokenPreview}</span>
                      <span className="text-xs text-gray-500">{t.name}</span>
                      {t.lastUsedAt && <span className="text-xs text-gray-600">Used: {new Date(t.lastUsedAt).toLocaleDateString()}</span>}
                    </div>
                    <button
                      onClick={async () => {
                        await fetch(`/api/admin/admin-tokens?id=${t.id}`, { method: 'DELETE' });
                        setAdminTokens(prev => prev.filter(x => x.id !== t.id));
                      }}
                      className="text-red-400 hover:text-red-300 text-sm"
                    >Revoke</button>
                  </div>
                ))}
              </div>
            )}

            <button
              onClick={async () => {
                const res = await fetch('/api/admin/admin-tokens', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'admin-api' }) });
                const data = await res.json();
                if (data.token) {
                  setNewAdminToken(data.token);
                  const listRes = await fetch('/api/admin/admin-tokens');
                  setAdminTokens((await listRes.json()).tokens || []);
                }
              }}
              className="px-5 py-2.5 bg-red-600 text-white font-semibold rounded-xl hover:bg-red-700 transition"
            >Generate Admin Token</button>

            <div className="bg-gray-900/30 border border-gray-700 rounded-lg p-4 mt-4">
              <p className="text-xs text-gray-400 mb-2"><strong>Usage:</strong></p>
              <code className="text-xs text-gray-300 block">Authorization: Bearer hba_your_token_here</code>
              <p className="text-xs text-gray-500 mt-2">Admin tokens work with: keyword delete, niche count, title exists, and all admin endpoints.</p>
            </div>
          </div>
        </div>
        </div>

        {/* Data Collection Tab */}
        <div style={{ display: adminSection === 'datacollection' ? 'block' : 'none' }}>
          <DataCollection />
        </div>

        {/* Agents Tab */}
        <div style={{ display: adminSection === 'agents' ? 'block' : 'none' }}>
        <AgentsTab
          data={agentsData}
          loading={agentsLoading}
          autoRefresh={agentsAutoRefresh}
          setAutoRefresh={setAgentsAutoRefresh}
          deploy={agentsDeploy}
          setDeploy={setAgentsDeploy}
          deployMsg={agentsDeployMsg}
          setDeployMsg={setAgentsDeployMsg}
          onRefresh={() => {
            setAgentsLoading(true);
            fetch('/api/admin/agents').then(r => r.json()).then(d => { setAgentsData(d); setAgentsLoading(false); }).catch(() => setAgentsLoading(false));
          }}
          active={adminSection === 'agents'}
        />
        </div>

        {/* Vizard Tab — paste a video URL, get AI-generated clips back.
            Grid renders one card per clip with viral score, title, duration,
            and a download link + "Send to xgodo" action (TODO next phase). */}
        <div style={{ display: adminSection === 'vizard' ? 'block' : 'none' }}>
          <div className="space-y-6">
            {/* Sub-tabs: Projects (clip browser) | Uploads (YT upload reporting) | Devices (per-device history) */}
            <div className="flex gap-2 border-b border-gray-800 pb-1">
              {([
                { value: 'projects', label: 'Projects & Clips' },
                { value: 'uploads',  label: 'Uploads to YT' },
                { value: 'devices',  label: 'Devices' },
              ] as const).map(opt => (
                <button key={opt.value} onClick={() => setVizardView(opt.value)}
                  className={`px-4 py-2 text-sm font-medium rounded-lg transition ${
                    vizardView === opt.value
                      ? 'bg-pink-600 text-white'
                      : 'text-gray-400 hover:text-white hover:bg-gray-800'
                  }`}>
                  {opt.label}
                  {opt.value === 'uploads' && vizardUploadSummary &&
                   (vizardUploadSummary.queued + vizardUploadSummary.running > 0) && (
                    <span className="ml-1.5 bg-pink-500 text-white text-[10px] px-1.5 py-0.5 rounded-full animate-pulse">
                      {vizardUploadSummary.queued + vizardUploadSummary.running}
                    </span>
                   )}
                  {opt.value === 'devices' && vizardDevicesOverall && vizardDevicesOverall.needsAttention > 0 && (
                    <span className="ml-1.5 bg-red-500 text-white text-[10px] px-1.5 py-0.5 rounded-full" title="devices needing attention">
                      {vizardDevicesOverall.needsAttention}
                    </span>
                  )}
                </button>
              ))}
            </div>

            {/* PROJECTS VIEW (existing — clip browser + submission) */}
            <div style={{ display: vizardView === 'projects' ? 'block' : 'none' }}>
            <div className="space-y-6">
            {/* API-key warning when unset — other fields are pointless without it */}
            {!vizardApiKey && (
              <div className="bg-yellow-900/20 border border-yellow-600/40 rounded-2xl p-4 text-sm text-yellow-200">
                No Vizard API key configured. Add it in the <button onClick={() => setAdminSection('general')} className="underline hover:text-white">General tab</button> under <code className="text-yellow-400">vizard_api_key</code>, then come back.
              </div>
            )}

            {/* YT-upload description box. The same description is reused for
                every clip you click "Send to YT" on, since you typically
                queue several related clips at once. Title comes from Vizard
                directly — no rewriting per the agreed spec. */}
            <div className="bg-gray-800/50 rounded-2xl border border-gray-700 p-4">
              <label className="text-[10px] uppercase tracking-wider text-gray-500 block mb-1">
                YT description (applied to clips you send next)
              </label>
              <textarea
                value={uploadDescription}
                onChange={e => setUploadDescription(e.target.value)}
                placeholder="Optional. Leave empty if you want the YT description blank. Tip: drop a few hashtags and a CTA here — same text is reused for each clip you click 'Send to YT'."
                rows={2}
                className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-xs text-gray-200 placeholder-gray-600 focus:outline-none focus:border-pink-500"
              />
            </div>

            {/* Submit bar */}
            <div className="bg-gray-800/50 rounded-2xl border border-gray-700 p-5 sm:p-6">
              <h2 className="text-lg font-bold text-white mb-1">Generate Clips (Vizard.ai)</h2>
              <p className="text-xs text-gray-500 mb-4">Paste a YouTube / Vimeo / direct mp4 URL. Vizard returns short clips sorted by viral score. Polling runs server-side every 30s.</p>
              <div className="flex gap-2 flex-col sm:flex-row">
                <input
                  type="url"
                  value={vizardUrl}
                  onChange={e => setVizardUrl(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && !vizardSubmitting) submitVizardUrl(); }}
                  placeholder="https://www.youtube.com/watch?v=..."
                  className="flex-1 bg-gray-900 border border-gray-700 text-white text-sm rounded-xl px-3 py-2.5 focus:outline-none focus:border-pink-500"
                  disabled={vizardSubmitting}
                />
                <select
                  value={vizardPreferLength[0]}
                  onChange={e => setVizardPreferLength([parseInt(e.target.value)])}
                  className="bg-gray-900 border border-gray-700 text-white text-sm rounded-xl px-2 py-2.5"
                  title="Preferred clip length"
                >
                  <option value={0}>Auto length</option>
                  <option value={1}>&lt; 30s</option>
                  <option value={2}>30–60s</option>
                  <option value={3}>60–90s</option>
                  <option value={4}>90s–3min</option>
                </select>
                <select
                  value={vizardLang}
                  onChange={e => setVizardLang(e.target.value)}
                  className="bg-gray-900 border border-gray-700 text-white text-sm rounded-xl px-2 py-2.5"
                  title="Source language"
                >
                  <option value="auto">Auto</option>
                  <option value="en">English</option>
                  <option value="es">Spanish</option>
                  <option value="pt">Portuguese</option>
                  <option value="fr">French</option>
                  <option value="de">German</option>
                  <option value="ru">Russian</option>
                </select>
                <button
                  onClick={submitVizardUrl}
                  disabled={vizardSubmitting || !vizardApiKey}
                  className="px-5 py-2.5 bg-pink-600 hover:bg-pink-500 disabled:bg-gray-700 disabled:text-gray-500 text-white text-sm font-medium rounded-xl transition whitespace-nowrap"
                >
                  {vizardSubmitting ? 'Submitting…' : 'Generate'}
                </button>
              </div>
              {vizardSubmitError && (
                <p className="mt-2 text-xs text-red-400">{vizardSubmitError}</p>
              )}
            </div>

            {/* Refresh-all bar — global "pull fresh YT view counts for
                every uploaded clip" action. Hits the SSE stream so we
                can render a real progress bar instead of a spinner.
                One quota unit per 50 clips, so even a 1000-clip refresh
                is 20 units total. */}
            {(() => {
              const ras = refreshAllStatus;
              const pct = ras.totalBatches > 0
                ? Math.round((ras.completedBatches / ras.totalBatches) * 100)
                : 0;
              const justFinished = !!ras.finishedAt && Date.now() - ras.finishedAt < 8000;
              return (
                <div className="bg-gray-800/50 border border-gray-700 rounded-2xl p-4">
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      onClick={refreshAllClipViews}
                      disabled={ras.running}
                      className={`px-4 py-2 rounded-xl text-sm font-medium transition flex items-center gap-2 ${
                        ras.running
                          ? 'bg-pink-600/40 text-pink-100 cursor-not-allowed'
                          : 'bg-pink-600 hover:bg-pink-500 text-white'
                      }`}
                      title="Pull fresh YT view/like/comment counts for every uploaded clip across all projects"
                    >
                      <svg className={`w-4 h-4 ${ras.running ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5}
                              d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                      </svg>
                      {ras.running ? 'Refreshing view counts…' : 'Refresh all view counts'}
                    </button>
                    <div className="text-xs text-gray-400 flex-1">
                      {ras.running && ras.totalBatches > 0 && (
                        <>Batch <span className="text-white">{ras.completedBatches}</span>/{ras.totalBatches} · clips updated <span className="text-white">{ras.updated}</span>/{ras.totalClips}{ras.errors > 0 && <> · <span className="text-red-400">{ras.errors} batch error{ras.errors === 1 ? '' : 's'}</span></>}</>
                      )}
                      {ras.running && ras.totalBatches === 0 && (
                        <>Looking up uploaded clips…</>
                      )}
                      {!ras.running && justFinished && !ras.error && (
                        <span className="text-green-400">
                          Done — refreshed {ras.updated} of {ras.totalClips} clip{ras.totalClips === 1 ? '' : 's'} ({ras.calls} API call{ras.calls === 1 ? '' : 's'}{ras.errors > 0 ? `, ${ras.errors} batch error${ras.errors === 1 ? '' : 's'}` : ''})
                        </span>
                      )}
                      {!ras.running && ras.error && (
                        <span className="text-red-400">Error: {ras.error}</span>
                      )}
                      {!ras.running && !justFinished && !ras.error && (
                        <>Refresh YouTube view/like/comment counts across every uploaded clip. Costs 1 quota unit per 50 clips.</>
                      )}
                    </div>
                  </div>
                  {/* Progress bar — only renders while running OR for a few
                      seconds after to flash the 100% completion state. */}
                  {(ras.running || (justFinished && !ras.error)) && (
                    <div className="mt-3 h-1.5 bg-gray-900 rounded-full overflow-hidden">
                      <div
                        className={`h-full transition-all duration-300 ${
                          ras.errors > 0 ? 'bg-amber-500' : 'bg-pink-500'
                        }`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  )}
                </div>
              );
            })()}

            {/* Projects grid — one card per submitted URL. Each card holds
                its clips inline so processing state is visible inline. */}
            {vizardLoading && vizardProjects.length === 0 ? (
              <div className="text-center text-sm text-gray-500 py-12">Loading projects…</div>
            ) : vizardProjects.length === 0 ? (
              <div className="text-center text-sm text-gray-500 py-12">No projects yet. Paste a video URL above to generate clips.</div>
            ) : (
              <div className="space-y-4">
                {vizardProjects.map(project => {
                  const statusColors: Record<VizardProjectRow['status'], string> = {
                    pending:    'bg-gray-700 text-gray-300',
                    processing: 'bg-blue-600 text-white animate-pulse',
                    done:       'bg-green-600 text-white',
                    error:      'bg-red-700 text-white',
                  };
                  return (
                    <div key={project.id} className="bg-gray-800/50 rounded-2xl border border-gray-700 overflow-hidden">
                      {/* Project header */}
                      <div className="p-4 border-b border-gray-700/70 flex items-start gap-3 flex-wrap">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 flex-wrap mb-1">
                            <span className={`text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full ${statusColors[project.status]}`}>
                              {project.status}
                            </span>
                            {project.clipCount > 0 && (
                              <span className="text-[10px] text-gray-400">{project.clipCount} clips</span>
                            )}
                            <span className="text-[10px] text-gray-500">
                              {new Date(project.createdAt).toLocaleString()}
                            </span>
                          </div>
                          <a
                            href={project.videoUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-sm text-gray-300 hover:text-pink-400 truncate block max-w-full"
                            title={project.videoUrl}
                          >
                            {project.videoUrl}
                          </a>
                          {project.errorMessage && (
                            <p className="mt-1 text-xs text-red-400 break-words">{project.errorMessage}</p>
                          )}
                        </div>
                        {/* Refresh YT views — only meaningful when there's at
                            least one uploaded clip in this project. Forces a
                            fresh videos.list call ignoring the staleness gate. */}
                        {project.clips.some(c => c.youtubeUrl) && (
                          <button
                            onClick={() => refreshClipViews(
                              project.clips.filter(c => c.youtubeUrl).map(c => c.id)
                            )}
                            disabled={refreshingViews}
                            className="text-xs text-gray-400 hover:text-white disabled:text-gray-600 transition flex-shrink-0"
                            title="Refresh YouTube view counts for uploaded clips in this project"
                          >
                            {refreshingViews ? 'Refreshing…' : '↻ YT views'}
                          </button>
                        )}
                        <button
                          onClick={() => deleteVizardProject(project.id)}
                          className="text-xs text-gray-500 hover:text-red-400 transition flex-shrink-0"
                          title="Delete project"
                        >
                          Delete
                        </button>
                      </div>

                      {/* Clips list — compact row per clip, click row to expand
                          and load the inline player. Default collapsed so 40+
                          clips don't all preload mp4 bytes at once, which was
                          timing the browser out earlier. Bulk "Expand all" /
                          "Collapse all" in the header for power-browsing. */}
                      {project.clips.length > 0 ? (
                        <div>
                          <div className="flex items-center justify-between px-4 pt-3 pb-2 text-[10px] text-gray-500">
                            <span>Sorted by viral score</span>
                            <div className="flex gap-2">
                              <button
                                onClick={() => {
                                  setExpandedClipIds(prev => {
                                    const next = new Set(prev);
                                    for (const c of project.clips) next.add(c.id);
                                    return next;
                                  });
                                }}
                                className="hover:text-gray-200 transition"
                              >
                                Expand all
                              </button>
                              <span className="text-gray-700">|</span>
                              <button
                                onClick={() => {
                                  setExpandedClipIds(prev => {
                                    const next = new Set(prev);
                                    for (const c of project.clips) next.delete(c.id);
                                    return next;
                                  });
                                }}
                                className="hover:text-gray-200 transition"
                              >
                                Collapse all
                              </button>
                            </div>
                          </div>
                          <div className="divide-y divide-gray-800/70">
                            {project.clips.map((clip, idx) => {
                              const seconds = clip.durationMs ? Math.round(clip.durationMs / 1000) : null;
                              const score = clip.viralScore ? parseFloat(clip.viralScore) : null;
                              const scoreColor = score == null ? 'text-gray-500'
                                : score >= 8 ? 'text-green-400'
                                : score >= 6 ? 'text-yellow-400'
                                : 'text-gray-400';
                              const expanded = expandedClipIds.has(clip.id);
                              const uploadStatus = clip.xgodoUploadStatus;
                              const ytUrl = clip.youtubeUrl;
                              const canSend = !uploadStatus || uploadStatus === 'failed' || uploadStatus === 'declined';
                              const statusBg =
                                uploadStatus === 'confirmed' ? 'bg-emerald-600/20 text-emerald-300 border-emerald-600/40' :
                                uploadStatus === 'uploaded'  ? 'bg-green-600/20 text-green-300 border-green-600/40' :
                                uploadStatus === 'running'   ? 'bg-blue-600/20 text-blue-300 border-blue-600/40 animate-pulse' :
                                uploadStatus === 'queued'    ? 'bg-gray-700/40 text-gray-300 border-gray-600/40' :
                                uploadStatus === 'failed'    ? 'bg-red-600/20 text-red-300 border-red-600/40' :
                                uploadStatus === 'declined'  ? 'bg-orange-600/20 text-orange-300 border-orange-600/40' :
                                                               '';
                              return (
                                <div key={clip.id} className="px-4 py-2.5 hover:bg-gray-900/40 transition">
                                  {/* Row — left side toggles expand; inline action buttons live on
                                      the right and are NOT inside the toggle button (HTML can't
                                      nest <button>). Status pill + Send-to-YT + Watch-on-YT all
                                      visible without expanding the row. */}
                                  <div className="w-full flex items-center gap-3">
                                    <button
                                      type="button"
                                      onClick={() => toggleClipExpanded(clip.id)}
                                      className="flex items-center gap-3 text-left flex-1 min-w-0"
                                    >
                                      {/* Rank badge */}
                                      <span className="text-[10px] font-mono text-gray-600 w-5 flex-shrink-0 text-right">
                                        {idx + 1}
                                      </span>
                                      {/* Chevron */}
                                      <svg className={`w-3.5 h-3.5 text-gray-500 flex-shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                                      </svg>
                                      {/* Title */}
                                      <span className="text-xs text-white truncate flex-1 min-w-0" title={clip.title || ''}>
                                        {clip.title || '(no title)'}
                                      </span>
                                      {/* Duration */}
                                      {seconds != null && (
                                        <span className="text-[10px] text-gray-500 font-mono flex-shrink-0">
                                          {seconds}s
                                        </span>
                                      )}
                                      {/* Viral score */}
                                      {score != null && (
                                        <span className={`text-xs font-mono flex-shrink-0 w-12 text-right ${scoreColor}`} title={clip.viralReason || ''}>
                                          ⚡ {score.toFixed(1)}
                                        </span>
                                      )}
                                    </button>

                                    {/* Upload status pill — visible inline on collapsed row.
                                        Hover shows the device + finish time + worker comment. */}
                                    {uploadStatus && (
                                      <span
                                        className={`text-[10px] px-2 py-0.5 rounded-full border whitespace-nowrap flex-shrink-0 ${statusBg}`}
                                        title={
                                          (clip.xgodoFailureComment ? `Worker comment: ${clip.xgodoFailureComment}\n` : '') +
                                          (clip.xgodoFinishedAt ? `Finished ${new Date(clip.xgodoFinishedAt).toLocaleString()}` : '') +
                                          (clip.xgodoDeviceName ? ` · ${clip.xgodoDeviceName}` : '')
                                        }
                                      >
                                        {uploadStatus}
                                      </span>
                                    )}
                                    {/* Worker comment chip — visible inline for failed/declined
                                        rows so the user immediately sees WHY (e.g. "CRASH",
                                        "Login required") without having to expand or open
                                        the Uploads view. Click to view the failure screenshot
                                        if xgodo attached one. */}
                                    {clip.xgodoFailureComment && (uploadStatus === 'failed' || uploadStatus === 'declined') && (
                                      clip.xgodoFailureScreenshotUrl ? (
                                        <a
                                          href={clip.xgodoFailureScreenshotUrl}
                                          target="_blank"
                                          rel="noopener noreferrer"
                                          className="text-[10px] px-2 py-0.5 rounded-full border bg-red-700/30 text-red-200 border-red-700/50 hover:bg-red-700/40 whitespace-nowrap flex-shrink-0 max-w-[140px] truncate"
                                          title={`Worker comment — click for failure screenshot. Comment: ${clip.xgodoFailureComment}`}
                                        >
                                          ⚠ {clip.xgodoFailureComment}
                                        </a>
                                      ) : (
                                        <span
                                          className="text-[10px] px-2 py-0.5 rounded-full border bg-red-700/30 text-red-200 border-red-700/50 whitespace-nowrap flex-shrink-0 max-w-[140px] truncate"
                                          title={clip.xgodoFailureComment}
                                        >
                                          ⚠ {clip.xgodoFailureComment}
                                        </span>
                                      )
                                    )}

                                    {/* Inline Send-to-YT button. Shown when clip can be sent
                                        (never sent, or last attempt failed). */}
                                    {canSend && (
                                      <button
                                        onClick={() => sendClipsToYouTube([clip.id])}
                                        disabled={uploadingClipIds.has(clip.id)}
                                        className="text-[11px] px-2 py-1 bg-pink-600 hover:bg-pink-500 disabled:bg-gray-700 disabled:text-gray-500 text-white font-medium rounded-md transition whitespace-nowrap flex-shrink-0"
                                        title={uploadStatus ? 'Retry upload' : 'Send to YouTube'}
                                      >
                                        {uploadingClipIds.has(clip.id) ? '…' :
                                         uploadStatus ? '↻ Retry' : '↗ Send'}
                                      </button>
                                    )}

                                    {/* YT view-count chip — visible when we've fetched
                                        view stats at least once. Shows compact K/M number
                                        with hover tooltip for likes/comments + fetch time. */}
                                    {clip.youtubeViewCount != null && (
                                      <span
                                        className="text-[11px] text-green-400 font-mono whitespace-nowrap flex-shrink-0"
                                        title={
                                          `${clip.youtubeViewCount.toLocaleString()} views` +
                                          (clip.youtubeLikeCount    != null ? ` · ${clip.youtubeLikeCount.toLocaleString()} likes` : '') +
                                          (clip.youtubeCommentCount != null ? ` · ${clip.youtubeCommentCount.toLocaleString()} comments` : '') +
                                          (clip.youtubeViewsFetchedAt ? ` · fetched ${new Date(clip.youtubeViewsFetchedAt).toLocaleString()}` : '')
                                        }
                                      >
                                        👁 {fmtK(clip.youtubeViewCount)}
                                      </span>
                                    )}
                                    {/* Watch link once we have the YT URL. */}
                                    {ytUrl && (
                                      <a
                                        href={ytUrl}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="text-[11px] px-2 py-1 bg-red-600/20 hover:bg-red-600/30 text-red-300 border border-red-600/40 rounded-md transition whitespace-nowrap flex-shrink-0"
                                      >
                                        ▶ YT
                                      </a>
                                    )}
                                    {/* Per-clip delete — for the rare case where Vizard
                                        returned a bad source URL or wrong clip and we just
                                        want it out of our list. Confirmation prompt prevents
                                        accidental clicks on adjacent rows. Local-only —
                                        doesn't touch xgodo. */}
                                    <button
                                      type="button"
                                      onClick={(e) => { e.stopPropagation(); deleteClip(clip.id, clip.title); }}
                                      className="text-[11px] px-1.5 py-1 text-gray-600 hover:text-red-400 hover:bg-red-600/10 rounded-md transition whitespace-nowrap flex-shrink-0"
                                      title="Delete this clip from rofe.ai (does not affect xgodo)"
                                    >
                                      ✕
                                    </button>
                                  </div>

                                  {/* Expanded body — player + full transcript + actions */}
                                  {expanded && (
                                    <div className="mt-3 pl-11 pr-2">
                                      <div className="flex flex-col sm:flex-row gap-3">
                                        {/* 9:16 player — constrained so a 40-clip project
                                            doesn't push rows to 900px tall when all expanded */}
                                        <video
                                          src={clip.videoUrl ? `/api/admin/vizard/clips/${clip.id}/video` : undefined}
                                          controls
                                          preload="metadata"
                                          className="w-full sm:w-[220px] aspect-[9/16] bg-black rounded-lg object-contain flex-shrink-0"
                                        />
                                        <div className="flex-1 min-w-0 space-y-2">
                                          {clip.viralReason && (
                                            <div>
                                              <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-0.5">Why it scores</div>
                                              <div className="text-xs text-gray-300">{clip.viralReason}</div>
                                            </div>
                                          )}
                                          <div className="flex gap-1.5 flex-wrap items-center">
                                            {clip.videoUrl && (
                                              <a
                                                href={clip.videoUrl}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                className="text-[11px] px-2 py-1 bg-gray-800 hover:bg-gray-700 text-gray-200 rounded-md transition"
                                              >
                                                Download
                                              </a>
                                            )}
                                            {clip.clipEditorUrl && (
                                              <a
                                                href={clip.clipEditorUrl}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                className="text-[11px] px-2 py-1 bg-gray-800 hover:bg-gray-700 text-gray-200 rounded-md transition"
                                              >
                                                Edit
                                              </a>
                                            )}
                                            {/* Send-to-YT button + status. Hidden once already queued/uploaded;
                                                shown again only on failure so the user can retry. */}
                                            {(!clip.xgodoUploadStatus || clip.xgodoUploadStatus === 'failed' || clip.xgodoUploadStatus === 'declined') && (
                                              <button
                                                onClick={() => sendClipsToYouTube([clip.id])}
                                                disabled={uploadingClipIds.has(clip.id)}
                                                className="text-[11px] px-2 py-1 bg-pink-600 hover:bg-pink-500 disabled:bg-gray-700 disabled:text-gray-500 text-white font-medium rounded-md transition"
                                              >
                                                {uploadingClipIds.has(clip.id) ? 'Sending…' :
                                                 clip.xgodoUploadStatus ? 'Retry to YT' : 'Send to YT'}
                                              </button>
                                            )}
                                            {/* Inline status pill — shows current upload state. */}
                                            {clip.xgodoUploadStatus && (
                                              <span
                                                className={`text-[10px] px-2 py-0.5 rounded-full border ${
                                                  clip.xgodoUploadStatus === 'confirmed' ? 'bg-emerald-600/20 text-emerald-300 border-emerald-600/40' :
                                                  clip.xgodoUploadStatus === 'uploaded'  ? 'bg-green-600/20 text-green-300 border-green-600/40' :
                                                  clip.xgodoUploadStatus === 'running'   ? 'bg-blue-600/20 text-blue-300 border-blue-600/40 animate-pulse' :
                                                  clip.xgodoUploadStatus === 'queued'    ? 'bg-gray-700/40 text-gray-300 border-gray-600/40' :
                                                  clip.xgodoUploadStatus === 'failed'    ? 'bg-red-600/20 text-red-300 border-red-600/40' :
                                                                                            'bg-orange-600/20 text-orange-300 border-orange-600/40'
                                                }`}
                                                title={
                                                  clip.xgodoFinishedAt
                                                    ? `Uploaded ${new Date(clip.xgodoFinishedAt).toLocaleString()}` +
                                                      (clip.xgodoDeviceName ? ` from ${clip.xgodoDeviceName}` : '')
                                                    : ''
                                                }
                                              >
                                                {clip.xgodoUploadStatus}
                                              </span>
                                            )}
                                            {clip.youtubeUrl && (
                                              <a
                                                href={clip.youtubeUrl}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                className="text-[11px] px-2 py-1 bg-red-600/20 hover:bg-red-600/30 text-red-300 border border-red-600/40 rounded-md transition"
                                              >
                                                ▶ Watch on YT
                                              </a>
                                            )}
                                          </div>
                                        </div>
                                      </div>
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      ) : (
                        <div className="p-6 text-xs text-gray-500 text-center">
                          {project.status === 'processing' || project.status === 'pending'
                            ? 'Waiting for Vizard to generate clips… polls every 30s.'
                            : project.status === 'error'
                              ? 'No clips — see error above.'
                              : 'No clips returned.'}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            </div>
            </div>
            {/* end PROJECTS VIEW — closed inner space-y-6 + the
                vizardView==='projects' display wrapper added at the top */}

            {/* UPLOADS VIEW — YT-upload reporting dashboard.
                Shows every clip we sent to xgodo with status, device,
                worker, timing, error, final YT URL. Polls
                /api/admin/vizard/uploads every 15s while open; the cron
                is the source of truth. */}
            <div style={{ display: vizardView === 'uploads' ? 'block' : 'none' }}>
              <div className="space-y-4">
                {/* Summary tiles — clickable to filter */}
                {vizardUploadSummary && (
                  <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
                    {([
                      { key: 'queued',    label: 'Queued',    color: 'text-gray-300' },
                      { key: 'running',   label: 'Running',   color: 'text-blue-400' },
                      { key: 'uploaded',  label: 'Uploaded',  color: 'text-green-400' },
                      { key: 'confirmed', label: 'Confirmed', color: 'text-emerald-400' },
                      { key: 'failed',    label: 'Failed',    color: 'text-red-400' },
                      { key: 'declined',  label: 'Declined',  color: 'text-orange-400' },
                    ] as const).map(t => (
                      <button key={t.key}
                        onClick={() => setVizardUploadFilter(prev => prev === t.key ? '' : t.key)}
                        className={`bg-gray-900/50 rounded-lg p-3 text-center transition border ${
                          vizardUploadFilter === t.key ? 'border-pink-500/60' : 'border-transparent hover:border-gray-700'
                        }`}
                      >
                        <div className={`text-xl font-bold ${t.color}`}>{vizardUploadSummary[t.key].toLocaleString()}</div>
                        <div className="text-[10px] text-gray-500 uppercase tracking-wider">{t.label}</div>
                      </button>
                    ))}
                  </div>
                )}

                {/* Action bar */}
                <div className="flex items-center gap-3 flex-wrap">
                  {vizardUploadFilter && (
                    <button onClick={() => setVizardUploadFilter('')}
                      className="text-xs text-gray-400 hover:text-white">
                      Clear filter
                    </button>
                  )}
                  <span className="text-xs text-gray-500">
                    {vizardUploads.length} {vizardUploadFilter ? `of ${vizardUploadFilter} status` : 'uploads'} shown
                  </span>
                  <button
                    onClick={async () => {
                      setVizardUploadsRefreshing(true);
                      try {
                        await fetch('/api/admin/vizard/uploads', { method: 'POST' });
                        await refetchVizardUploads();
                      } finally { setVizardUploadsRefreshing(false); }
                    }}
                    disabled={vizardUploadsRefreshing}
                    className="ml-auto text-xs text-gray-400 hover:text-white disabled:text-gray-600"
                  >
                    {vizardUploadsRefreshing ? 'Refreshing…' : 'Refresh status'}
                  </button>
                  <button
                    onClick={() => refreshClipViews(
                      vizardUploads.filter(u => u.youtubeUrl).map(u => u.clipId)
                    )}
                    disabled={refreshingViews}
                    className="text-xs text-gray-400 hover:text-white disabled:text-gray-600"
                    title="Force-refresh YT view/like/comment counts via Data API"
                  >
                    {refreshingViews ? 'Fetching…' : '↻ YT views'}
                  </button>
                </div>

                {/* Reporting table */}
                <div className="bg-gray-800/50 rounded-2xl border border-gray-700 overflow-hidden">
                  {vizardUploads.length === 0 ? (
                    <div className="p-8 text-center text-sm text-gray-500">
                      No uploads yet. Send clips to YouTube from the Projects &amp; Clips tab.
                    </div>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs">
                        <thead className="bg-gray-900/40 text-[10px] uppercase tracking-wider text-gray-500">
                          <tr>
                            <th className="text-left px-3 py-2">Status</th>
                            <th className="text-left px-3 py-2">Title</th>
                            <th className="text-left px-3 py-2">YouTube</th>
                            <th className="text-left px-3 py-2">Views</th>
                            <th className="text-left px-3 py-2">Device</th>
                            <th className="text-left px-3 py-2">Submitted</th>
                            <th className="text-left px-3 py-2">Finished</th>
                            <th className="text-left px-3 py-2">Duration</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-800/70">
                          {vizardUploads.map(u => {
                            const statusColor =
                              u.status === 'confirmed' ? 'bg-emerald-600/20 text-emerald-300 border-emerald-600/40' :
                              u.status === 'uploaded'  ? 'bg-green-600/20 text-green-300 border-green-600/40' :
                              u.status === 'running'   ? 'bg-blue-600/20 text-blue-300 border-blue-600/40 animate-pulse' :
                              u.status === 'queued'    ? 'bg-gray-700/40 text-gray-300 border-gray-600/40' :
                              u.status === 'failed'    ? 'bg-red-600/20 text-red-300 border-red-600/40' :
                              u.status === 'declined'  ? 'bg-orange-600/20 text-orange-300 border-orange-600/40' :
                                                         'bg-gray-700/40 text-gray-300 border-gray-600/40';
                            const dur = (u.submittedAt && u.finishedAt)
                              ? Math.round((new Date(u.finishedAt).getTime() - new Date(u.submittedAt).getTime()) / 1000)
                              : null;
                            const fmtDur = (s: number | null) =>
                              s == null ? '—' :
                              s < 60 ? `${s}s` :
                              s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` :
                              `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
                            return (
                              <tr key={u.clipId} className="hover:bg-gray-900/30">
                                <td className="px-3 py-2">
                                  <span className={`inline-block text-[10px] px-2 py-0.5 rounded-full border ${statusColor}`}>
                                    {u.status}
                                  </span>
                                  {/* Worker comment from xgodo (e.g. "CRASH", "Login required") —
                                      attached to failed/declined task. Click for screenshot if
                                      one was captured. Persists until the user clicks Retry. */}
                                  {u.failureComment && (
                                    u.failureScreenshotUrl ? (
                                      <a
                                        href={u.failureScreenshotUrl}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="block text-[10px] text-red-300 hover:text-red-200 mt-0.5 max-w-[200px] truncate underline"
                                        title={`Worker comment: ${u.failureComment}\nClick for screenshot`}
                                      >
                                        ⚠ {u.failureComment}
                                      </a>
                                    ) : (
                                      <div className="text-[10px] text-red-400 mt-0.5 max-w-[200px] truncate" title={u.failureComment}>
                                        ⚠ {u.failureComment}
                                      </div>
                                    )
                                  )}
                                  {u.error && !u.failureComment && (
                                    <div className="text-[10px] text-red-400 mt-0.5 max-w-[200px] truncate" title={u.error}>
                                      {u.error}
                                    </div>
                                  )}
                                </td>
                                <td className="px-3 py-2 text-gray-200 max-w-[260px]">
                                  <div className="truncate" title={u.uploadTitle || u.clipTitle || ''}>
                                    {u.uploadTitle || u.clipTitle || '—'}
                                  </div>
                                  {u.viralScore && (
                                    <div className="text-[10px] text-gray-500">⚡ {u.viralScore}</div>
                                  )}
                                </td>
                                <td className="px-3 py-2">
                                  {u.youtubeUrl ? (
                                    <a href={u.youtubeUrl} target="_blank" rel="noopener noreferrer"
                                      className="text-pink-400 hover:text-pink-300 underline truncate inline-block max-w-[200px]"
                                      title={u.youtubeUrl}>
                                      {u.youtubeUrl.replace(/^https?:\/\//, '')}
                                    </a>
                                  ) : <span className="text-gray-600">—</span>}
                                </td>
                                <td className="px-3 py-2 whitespace-nowrap">
                                  {u.youtubeViewCount != null ? (
                                    <span className="text-green-400 font-mono"
                                      title={
                                        `${u.youtubeViewCount.toLocaleString()} views` +
                                        (u.youtubeLikeCount    != null ? ` · ${u.youtubeLikeCount.toLocaleString()} likes` : '') +
                                        (u.youtubeCommentCount != null ? ` · ${u.youtubeCommentCount.toLocaleString()} comments` : '') +
                                        (u.youtubeViewsFetchedAt ? ` · fetched ${new Date(u.youtubeViewsFetchedAt).toLocaleString()}` : '')
                                      }>
                                      👁 {fmtK(u.youtubeViewCount)}
                                    </span>
                                  ) : <span className="text-gray-600">—</span>}
                                </td>
                                <td className="px-3 py-2">
                                  {u.deviceName ? (
                                    <div>
                                      <div className="text-gray-200">{u.deviceName}</div>
                                      <div className="text-[10px] text-gray-500 font-mono"
                                        title={`device_id: ${u.deviceId}`}>
                                        {u.deviceId?.substring(0, 8)}…
                                      </div>
                                    </div>
                                  ) : <span className="text-gray-600">—</span>}
                                </td>
                                <td className="px-3 py-2 text-gray-300 whitespace-nowrap"
                                    title={u.submittedAt ? new Date(u.submittedAt).toLocaleString() : ''}>
                                  {fmtAgo(u.submittedAt)}
                                </td>
                                <td className="px-3 py-2 text-gray-300 whitespace-nowrap"
                                    title={u.finishedAt ? new Date(u.finishedAt).toLocaleString() : ''}>
                                  {fmtAgo(u.finishedAt)}
                                </td>
                                <td className="px-3 py-2 text-gray-300 whitespace-nowrap">
                                  {fmtDur(dur)}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </div>
            </div>
            {/* end UPLOADS VIEW */}

            {/* DEVICES VIEW — same task data as Uploads, regrouped by
                xgodo worker device. Each card shows the device's total
                stats, the per-(job, device) bucket xgodo holds for it
                (login state, account info), and an expandable recent-task
                history. Devices that look stuck (last 3+ tasks failed,
                or last failure comment mentions login/SMS/captcha) get a
                "needs attention" banner so they're easy to spot. */}
            <div style={{ display: vizardView === 'devices' ? 'block' : 'none' }}>
              <div className="space-y-4">
                {/* Header strip */}
                {vizardDevicesOverall && (
                  <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
                    <div className="bg-gray-900/50 rounded-lg p-3 text-center">
                      <div className="text-xl font-bold text-white">{vizardDevicesOverall.devices}</div>
                      <div className="text-[10px] text-gray-500 uppercase tracking-wider">Devices</div>
                    </div>
                    <div className="bg-gray-900/50 rounded-lg p-3 text-center">
                      <div className={`text-xl font-bold ${vizardDevicesOverall.needsAttention > 0 ? 'text-red-400' : 'text-gray-500'}`}>
                        {vizardDevicesOverall.needsAttention}
                      </div>
                      <div className="text-[10px] text-gray-500 uppercase tracking-wider">Need Attention</div>
                    </div>
                    <div className="bg-gray-900/50 rounded-lg p-3 text-center">
                      <div className="text-xl font-bold text-green-400">{vizardDevicesOverall.totalUploaded.toLocaleString()}</div>
                      <div className="text-[10px] text-gray-500 uppercase tracking-wider">Uploaded</div>
                    </div>
                    <div className="bg-gray-900/50 rounded-lg p-3 text-center">
                      <div className="text-xl font-bold text-red-400">{vizardDevicesOverall.totalFailed.toLocaleString()}</div>
                      <div className="text-[10px] text-gray-500 uppercase tracking-wider">Failed/Declined</div>
                    </div>
                    <div className="bg-gray-900/50 rounded-lg p-3 text-center">
                      <div className="text-xl font-bold text-blue-400">{vizardDevicesOverall.totalViews.toLocaleString()}</div>
                      <div className="text-[10px] text-gray-500 uppercase tracking-wider">Total YT Views</div>
                    </div>
                  </div>
                )}

                {/* Bucket-fetch error — non-fatal, but surface it so the
                    operator knows the bucket column might be stale. */}
                {vizardDevicesBucketError && (
                  <div className="bg-amber-900/20 border border-amber-600/40 rounded-lg p-3 text-xs text-amber-300">
                    Could not load xgodo job buckets — showing device stats only.
                    <span className="block mt-1 text-amber-400/70 font-mono break-all">{vizardDevicesBucketError}</span>
                  </div>
                )}

                <div className="flex items-center gap-3">
                  <span className="text-xs text-gray-500">
                    {vizardDevices.length} device{vizardDevices.length === 1 ? '' : 's'} grouped — sorted by needs-attention then most recent activity
                  </span>
                  <button
                    onClick={refreshVizardAccountsSubs}
                    disabled={vizardAccountsRefreshing}
                    className="ml-auto text-xs text-gray-400 hover:text-white disabled:text-gray-600"
                    title="Resolve YT channel + subscriber count for every gmail that uploaded a clip (Data API, ~2 quota units)"
                  >
                    {vizardAccountsRefreshing ? 'Fetching…' : '↻ Subs'}
                  </button>
                  <button
                    onClick={refetchVizardDevices}
                    disabled={vizardDevicesLoading}
                    className="text-xs text-gray-400 hover:text-white disabled:text-gray-600"
                  >
                    {vizardDevicesLoading ? 'Refreshing…' : 'Refresh'}
                  </button>
                </div>

                {/* Device cards */}
                {vizardDevices.length === 0 ? (
                  <div className="bg-gray-800/50 rounded-2xl border border-gray-700 p-8 text-center text-sm text-gray-500">
                    {vizardDevicesLoading ? 'Loading…' : 'No devices have processed Vizard uploads yet.'}
                  </div>
                ) : (
                  <div className="space-y-3">
                    {vizardDevices.map(d => {
                      const expanded = expandedDeviceIds.has(d.deviceId);
                      const toggleExpand = () => {
                        setExpandedDeviceIds(prev => {
                          const next = new Set(prev);
                          if (next.has(d.deviceId)) next.delete(d.deviceId);
                          else next.add(d.deviceId);
                          return next;
                        });
                      };
                      const fmtDur = (s: number | null) =>
                        s == null ? '—' :
                        s < 60 ? `${s}s` :
                        s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` :
                        `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
                      // Truncate the bucket data to a couple key/value lines so
                      // the card doesn't blow up when an automation stores big
                      // payloads. Full content is in the expanded view.
                      const bucketEntries = d.bucket.data
                        ? Object.entries(d.bucket.data).slice(0, 6)
                        : [];
                      return (
                        <div key={d.deviceId}
                          className={`bg-gray-800/50 rounded-2xl border ${
                            d.needsAttention ? 'border-red-600/40' : 'border-gray-700'
                          } overflow-hidden`}
                        >
                          {/* Attention banner */}
                          {d.needsAttention && (
                            <div className="bg-red-900/30 border-b border-red-600/40 px-4 py-2 text-xs text-red-200 flex items-center gap-2">
                              <span className="text-red-400">⚠</span>
                              <span>Needs attention — {d.attentionReason}</span>
                            </div>
                          )}

                          {/* Card header */}
                          <div className="p-4 flex flex-wrap items-start gap-3">
                            <div className="flex-1 min-w-[200px]">
                              <div className="text-sm font-bold text-white">
                                {d.deviceName || <span className="text-gray-500 font-mono">{d.deviceId.substring(0, 12)}…</span>}
                              </div>
                              <div className="text-[10px] text-gray-500 font-mono mt-0.5">
                                {d.deviceId}
                                {d.workerName && <span className="text-gray-400"> · {d.workerName}</span>}
                              </div>
                            </div>

                            {/* Status pills strip */}
                            <div className="flex flex-wrap items-center gap-1.5">
                              {([
                                { key: 'queued',    label: 'Q', color: 'bg-gray-700 text-gray-300' },
                                { key: 'running',   label: 'R', color: 'bg-blue-700/40 text-blue-300' },
                                { key: 'uploaded',  label: 'U', color: 'bg-green-700/40 text-green-300' },
                                { key: 'confirmed', label: 'C', color: 'bg-emerald-700/40 text-emerald-300' },
                                { key: 'failed',    label: 'F', color: 'bg-red-700/40 text-red-300' },
                                { key: 'declined',  label: 'D', color: 'bg-orange-700/40 text-orange-300' },
                              ] as const).map(s => {
                                const n = d.stats.byStatus[s.key];
                                return (
                                  <span key={s.key}
                                    className={`text-[10px] px-2 py-0.5 rounded ${n > 0 ? s.color : 'bg-gray-900 text-gray-600'}`}
                                    title={`${s.key}: ${n}`}
                                  >
                                    {s.label} {n}
                                  </span>
                                );
                              })}
                            </div>

                            {/* Right-side big numbers */}
                            <div className="flex items-center gap-4 text-right">
                              <div>
                                <div className="text-lg font-bold text-white">{d.stats.total}</div>
                                <div className="text-[10px] text-gray-500 uppercase">Total</div>
                              </div>
                              <div>
                                <div className={`text-lg font-bold ${d.stats.successRate >= 0.7 ? 'text-green-400' : d.stats.successRate >= 0.4 ? 'text-amber-400' : 'text-red-400'}`}>
                                  {(d.stats.successRate * 100).toFixed(0)}%
                                </div>
                                <div className="text-[10px] text-gray-500 uppercase">Success</div>
                              </div>
                              <div>
                                <div className="text-lg font-bold text-blue-400">{d.stats.totalViews.toLocaleString()}</div>
                                <div className="text-[10px] text-gray-500 uppercase">YT Views</div>
                              </div>
                            </div>
                          </div>

                          {/* Sub-info row: bucket + last activity + expand */}
                          <div className="border-t border-gray-700/60 bg-gray-900/30 px-4 py-2 flex flex-wrap gap-x-4 gap-y-1 items-center text-[11px]">
                            <div className="text-gray-400" title={d.stats.lastActivityAt ? new Date(d.stats.lastActivityAt).toLocaleString() : ''}>
                              <span className="text-gray-500">Last activity: </span>
                              {fmtAgo(d.stats.lastActivityAt)}
                            </div>
                            <div className="text-gray-400">
                              <span className="text-gray-500">Avg duration: </span>
                              {fmtDur(d.stats.avgDurationSec)}
                            </div>
                            <div className="text-gray-400">
                              <span className="text-gray-500">Last 24h: </span>
                              <span className="text-green-400">{d.stats.last24h.succeeded}↑</span>
                              <span className="text-gray-600"> / </span>
                              <span className="text-red-400">{d.stats.last24h.failed}↓</span>
                              <span className="text-gray-600"> / </span>
                              <span className="text-gray-300">{d.stats.last24h.total}</span>
                            </div>
                            <div className="text-gray-400">
                              <span className="text-gray-500">Bucket: </span>
                              {d.bucket.missing
                                ? <span className="text-gray-600 italic">none</span>
                                : bucketEntries.length === 0
                                  ? <span className="text-gray-600 italic">empty</span>
                                  : (
                                    <span className="text-gray-300 font-mono">
                                      {bucketEntries.map(([k, v]) => {
                                        const display = typeof v === 'boolean' ? String(v)
                                          : typeof v === 'number' ? String(v)
                                          : typeof v === 'string' ? (v.length > 24 ? v.slice(0, 21) + '…' : v)
                                          : '·';
                                        return `${k}=${display}`;
                                      }).join(' ')}
                                    </span>
                                  )
                              }
                              {d.bucket.updatedAt && (
                                <span className="text-gray-600 ml-1">
                                  ({new Date(d.bucket.updatedAt).toLocaleDateString()})
                                </span>
                              )}
                            </div>
                            <button onClick={toggleExpand}
                              className="ml-auto text-pink-400 hover:text-pink-300"
                            >
                              {expanded ? `Hide tasks ▴` : `Show ${d.recentTasks.length} recent task${d.recentTasks.length === 1 ? '' : 's'} ▾`}
                            </button>
                          </div>

                          {/* Accounts row — gmails that have uploaded from this
                              device, each with channel + subscriber count when
                              the YT Data API enrichment has been run. Hidden
                              when nothing is known yet (early-state device). */}
                          {d.accounts.length > 0 && (
                            <div className="border-t border-gray-700/60 bg-gray-900/30 px-4 py-2 flex flex-wrap gap-x-3 gap-y-1.5 items-center text-[11px]">
                              <span className="text-gray-500">Accounts:</span>
                              {d.accounts.map(acct => {
                                const subs = acct.subscriberCount;
                                const subsLabel = subs == null ? '—' : subs >= 1_000_000 ? (subs/1_000_000).toFixed(1).replace(/\.0$/, '') + 'M' : subs >= 1_000 ? (subs/1_000).toFixed(1).replace(/\.0$/, '') + 'K' : String(subs);
                                const subsColor = subs == null ? 'text-gray-600' :
                                  subs >= 10_000 ? 'text-green-400' :
                                  subs >= 1_000  ? 'text-blue-400'  :
                                  subs >= 100    ? 'text-gray-300'  : 'text-gray-500';
                                const channelHref = acct.customUrl
                                  ? (acct.customUrl.startsWith('@') ? `https://www.youtube.com/${acct.customUrl}` : `https://www.youtube.com/${acct.customUrl}`)
                                  : acct.channelId ? `https://www.youtube.com/channel/${acct.channelId}` : null;
                                return (
                                  <span key={acct.email}
                                    className="inline-flex items-center gap-1.5 bg-gray-900/60 border border-gray-700 rounded-md px-2 py-0.5"
                                    title={
                                      `${acct.email}` +
                                      (acct.channelTitle ? `\nchannel: ${acct.channelTitle}` : '') +
                                      (subs != null ? `\nsubs: ${subs.toLocaleString()}` : '\nsubs: not fetched (click ↻ Subs above)') +
                                      (acct.channelViewCount != null ? `\ntotal channel views: ${acct.channelViewCount.toLocaleString()}` : '') +
                                      (acct.videoCount != null ? `\nvideo count: ${acct.videoCount}` : '') +
                                      `\nuploads from this device: ${acct.uploadsOnDevice}` +
                                      (acct.fetchedAt ? `\nfetched: ${new Date(acct.fetchedAt).toLocaleString()}` : '')
                                    }
                                  >
                                    <span className="text-gray-300 font-mono">{acct.email.split('@')[0]}</span>
                                    <span className="text-gray-600">·</span>
                                    {channelHref ? (
                                      <a href={channelHref} target="_blank" rel="noreferrer" className={`${subsColor} hover:underline`}>
                                        {subsLabel} subs
                                      </a>
                                    ) : (
                                      <span className={subsColor}>{subsLabel} subs</span>
                                    )}
                                    <span className="text-gray-600">·</span>
                                    <span className="text-gray-500">{acct.uploadsOnDevice}↑</span>
                                  </span>
                                );
                              })}
                            </div>
                          )}

                          {/* Expanded recent-tasks table */}
                          {expanded && (
                            <div className="border-t border-gray-700/60 overflow-x-auto">
                              {d.recentTasks.length === 0 ? (
                                <div className="px-4 py-3 text-xs text-gray-500">
                                  No tasks yet — device has a bucket but hasn&apos;t run any clips.
                                </div>
                              ) : (
                                <table className="w-full text-xs">
                                  <thead className="bg-gray-900/40 text-[10px] uppercase tracking-wider text-gray-500">
                                    <tr>
                                      <th className="text-left px-3 py-2">Status</th>
                                      <th className="text-left px-3 py-2">Title</th>
                                      <th className="text-left px-3 py-2">Account</th>
                                      <th className="text-left px-3 py-2">YouTube</th>
                                      <th className="text-left px-3 py-2">Views</th>
                                      <th className="text-left px-3 py-2">Submitted</th>
                                      <th className="text-left px-3 py-2">Duration</th>
                                    </tr>
                                  </thead>
                                  <tbody className="divide-y divide-gray-800/70">
                                    {d.recentTasks.map(t => {
                                      const statusColor =
                                        t.status === 'confirmed' ? 'bg-emerald-600/20 text-emerald-300 border-emerald-600/40' :
                                        t.status === 'uploaded'  ? 'bg-green-600/20 text-green-300 border-green-600/40' :
                                        t.status === 'running'   ? 'bg-blue-600/20 text-blue-300 border-blue-600/40 animate-pulse' :
                                        t.status === 'queued'    ? 'bg-gray-700/40 text-gray-300 border-gray-600/40' :
                                        t.status === 'failed'    ? 'bg-red-600/20 text-red-300 border-red-600/40' :
                                        t.status === 'declined'  ? 'bg-orange-600/20 text-orange-300 border-orange-600/40' :
                                                                   'bg-gray-700/40 text-gray-300 border-gray-600/40';
                                      return (
                                        <tr key={t.clipId} className="hover:bg-gray-900/30">
                                          <td className="px-3 py-2 align-top">
                                            <span className={`inline-block text-[10px] px-2 py-0.5 rounded-full border ${statusColor}`}>
                                              {t.status || '—'}
                                            </span>
                                            {t.failureComment && (
                                              <div className="mt-1 text-[10px] text-red-300/80 max-w-[180px]" title={t.failureComment}>
                                                {t.failureComment.length > 60 ? t.failureComment.slice(0, 57) + '…' : t.failureComment}
                                                {t.failureScreenshotUrl && (
                                                  <a href={t.failureScreenshotUrl} target="_blank" rel="noreferrer"
                                                    className="block text-orange-400 hover:text-orange-300 underline mt-0.5">
                                                    screenshot
                                                  </a>
                                                )}
                                              </div>
                                            )}
                                          </td>
                                          <td className="px-3 py-2 text-gray-200 max-w-[260px] truncate" title={t.title || ''}>
                                            {t.title || <span className="text-gray-600">—</span>}
                                          </td>
                                          <td className="px-3 py-2 text-gray-400 font-mono whitespace-nowrap" title={t.accountEmail || ''}>
                                            {t.accountEmail ? t.accountEmail.split('@')[0] : <span className="text-gray-600">—</span>}
                                          </td>
                                          <td className="px-3 py-2">
                                            {t.youtubeUrl ? (
                                              <a href={t.youtubeUrl} target="_blank" rel="noreferrer"
                                                className="text-pink-400 hover:text-pink-300 underline">
                                                ▶ Watch
                                              </a>
                                            ) : <span className="text-gray-600">—</span>}
                                          </td>
                                          <td className="px-3 py-2 text-gray-300 whitespace-nowrap">
                                            {t.viewCount != null ? t.viewCount.toLocaleString() : '—'}
                                          </td>
                                          <td className="px-3 py-2 text-gray-300 whitespace-nowrap"
                                              title={t.submittedAt ? new Date(t.submittedAt).toLocaleString() : ''}>
                                            {fmtAgo(t.submittedAt)}
                                          </td>
                                          <td className="px-3 py-2 text-gray-300 whitespace-nowrap">
                                            {fmtDur(t.durationSec)}
                                          </td>
                                        </tr>
                                      );
                                    })}
                                  </tbody>
                                </table>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
            {/* end DEVICES VIEW */}
          </div>
        </div>

        {/* Novelty Tab — admin-only "blue ocean" viewer.
            Surfaces videos that are simultaneously (a) unique in the
            combined title+thumbnail embedding space (few close neighbors),
            and (b) performing well (peer-outlier score + views). These are
            potential new-angle formats with proof of demand and no
            copycat pressure. Gate kept admin-side while we decide if the
            signal is worth exposing to users. */}
        <div style={{ display: adminSection === 'novelty' ? 'block' : 'none' }}>
          <div className="space-y-6">
            {/* ── Niche-discovery seed candidates ───────────────────────
                Videos passing BOTH the novelty cutoff AND the content-gen
                channel-quality rules. These are the ones we'd seed xgodo
                bots from for auto-niche-discovery. Lives at the top of
                the tab because it's the action surface — the rest of the
                tab is for exploration. */}
            <div className="bg-gray-800/50 rounded-2xl border border-amber-500/30 p-6">
              <div className="flex items-start justify-between gap-3 flex-wrap mb-4">
                <div>
                  <h2 className="text-lg font-bold text-white mb-1 flex items-center gap-2">
                    <span className="px-2 py-0.5 rounded text-[10px] bg-amber-500/20 text-amber-300 border border-amber-500/40 font-bold uppercase tracking-wider">Seed</span>
                    Niche-discovery seed candidates
                  </h2>
                  <p className="text-xs text-gray-500 max-w-2xl">
                    Videos passing the novelty cutoff <span className="text-amber-300">AND</span> all content-gen channel-quality rules (subs band, top-video floor, ratio ≥5×, age ≤730d, video ≤12mo, ≥5 videos, not one-viral-wonder). Each one is a candidate seed for xgodo bots — they'll crawl the related-video graph outward to map fresh niche territory.
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <label className="text-xs text-gray-400">Top-K:</label>
                  <input
                    type="number"
                    min={5}
                    max={100}
                    value={seedTopK}
                    onChange={e => {
                      const n = parseInt(e.target.value);
                      if (Number.isFinite(n)) setSeedTopK(Math.max(5, Math.min(100, n)));
                    }}
                    className="w-16 bg-gray-900 border border-gray-700 rounded-lg px-2 py-1.5 text-xs text-white text-center"
                  />
                  <label className="text-xs text-gray-400 ml-2">Novelty ≥ top-X%:</label>
                  <input
                    type="number"
                    min={50}
                    max={99}
                    value={seedMinPct}
                    onChange={e => {
                      const n = parseFloat(e.target.value);
                      if (Number.isFinite(n)) setSeedMinPct(Math.max(50, Math.min(99, n)));
                    }}
                    className="w-16 bg-gray-900 border border-gray-700 rounded-lg px-2 py-1.5 text-xs text-white text-center"
                  />
                  <label className="text-xs text-gray-400 flex items-center gap-1.5 ml-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={seedLongFormOnly}
                      onChange={e => setSeedLongFormOnly(e.target.checked)}
                      className="w-3.5 h-3.5 accent-amber-400"
                    />
                    long-form only
                  </label>
                  <button
                    type="button"
                    onClick={() => void fetchSeedCandidates()}
                    disabled={seedLoading}
                    className="text-xs px-3 py-1.5 rounded-lg border border-amber-500/40 bg-amber-400/10 hover:bg-amber-400/20 text-amber-300 font-medium disabled:opacity-50"
                  >
                    {seedLoading ? 'Loading…' : 'Refresh'}
                  </button>
                </div>
              </div>

              {/* Pool stats */}
              {seedPool && (
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">
                  <div className="bg-gray-900/50 rounded-lg p-2.5 text-center">
                    <div className="text-base font-bold text-white tabular-nums">{seedPool.total_videos_with_novelty.toLocaleString()}</div>
                    <div className="text-[10px] text-gray-500 uppercase tracking-wider">Scored videos</div>
                  </div>
                  <div className="bg-gray-900/50 rounded-lg p-2.5 text-center">
                    <div className="text-base font-bold text-amber-300 tabular-nums">{seedPool.novelty_cutoff_used?.toFixed(3) ?? '—'}</div>
                    <div className="text-[10px] text-gray-500 uppercase tracking-wider">Cutoff score</div>
                  </div>
                  <div className="bg-gray-900/50 rounded-lg p-2.5 text-center">
                    <div className="text-base font-bold text-white tabular-nums">{seedPool.videos_above_cutoff.toLocaleString()}</div>
                    <div className="text-[10px] text-gray-500 uppercase tracking-wider">Above cutoff</div>
                  </div>
                  <div className="bg-gray-900/50 rounded-lg p-2.5 text-center">
                    <div className="text-base font-bold text-emerald-300 tabular-nums">{seedPool.seeds_after_channel_rules}</div>
                    <div className="text-[10px] text-gray-500 uppercase tracking-wider">Pass all rules</div>
                  </div>
                </div>
              )}

              {seedError && (
                <div className="mb-3 p-2 rounded-md bg-red-500/10 border border-red-500/30 text-xs text-red-300">{seedError}</div>
              )}

              {/* Seed cards */}
              {seedCandidates.length === 0 && !seedLoading && (
                <div className="p-4 rounded-md bg-gray-900/50 border border-gray-700 text-xs text-gray-400 text-center">
                  No seeds at the current threshold. Try lowering Novelty ≥ top-X% or wait for the recompute to finish.
                </div>
              )}
              {seedCandidates.length > 0 && (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                  {seedCandidates.map((s, idx) => (
                    <div
                      key={s.video_id}
                      className="bg-gray-900/50 border border-gray-700 rounded-xl overflow-hidden hover:border-amber-500/40 transition flex flex-col"
                    >
                      <a
                        href={s.video_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="block relative group"
                        title="Open on YouTube"
                      >
                        {s.video_thumbnail ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={s.video_thumbnail}
                            alt=""
                            className="w-full aspect-video object-cover bg-gray-800"
                          />
                        ) : (
                          <div className="w-full aspect-video bg-gray-800 flex items-center justify-center">
                            <svg className="w-8 h-8 text-gray-600" viewBox="0 0 24 24" fill="currentColor">
                              <path d="M8 5v14l11-7z" />
                            </svg>
                          </div>
                        )}
                        <div className="absolute inset-0 bg-black/30 opacity-0 group-hover:opacity-100 flex items-center justify-center transition">
                          <svg className="w-10 h-10 text-white drop-shadow-lg" viewBox="0 0 24 24" fill="currentColor">
                            <path d="M8 5v14l11-7z" />
                          </svg>
                        </div>
                        <div className="absolute top-1.5 left-1.5 flex items-center gap-1">
                          <span className="bg-black/70 text-amber-300 text-[10px] font-bold px-1.5 py-0.5 rounded">
                            #{idx + 1}
                          </span>
                          <span className="bg-black/70 text-emerald-300 text-[10px] font-bold px-1.5 py-0.5 rounded">
                            seed {s.seed_score.toFixed(2)}
                          </span>
                        </div>
                        <div className="absolute bottom-1.5 right-1.5">
                          <span className="bg-black/70 text-white text-[10px] font-medium px-1.5 py-0.5 rounded tabular-nums">
                            {s.view_count >= 1_000_000
                              ? `${(s.view_count / 1_000_000).toFixed(1)}M`
                              : s.view_count >= 1_000
                                ? `${(s.view_count / 1_000).toFixed(0)}K`
                                : String(s.view_count)} views
                          </span>
                        </div>
                      </a>
                      <div className="p-3 flex-1 flex flex-col gap-2">
                        <a
                          href={s.video_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-sm font-medium text-white line-clamp-2 hover:text-amber-300 transition"
                          title={s.video_title || ''}
                        >
                          {s.video_title || '—'}
                        </a>
                        <div className="flex items-center gap-2 text-xs">
                          {s.channel.channel_avatar && (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={s.channel.channel_avatar} alt="" className="w-5 h-5 rounded-full object-cover shrink-0" />
                          )}
                          <a
                            href={s.channel.channel_handle ? `https://www.youtube.com/${s.channel.channel_handle.startsWith('@') ? s.channel.channel_handle : `@${s.channel.channel_handle}`}` : '#'}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-gray-300 truncate hover:text-amber-300 transition"
                            title={s.channel.channel_name || ''}
                          >
                            {s.channel.channel_name || '(unnamed)'}
                          </a>
                          <span className={`text-[9px] px-1.5 py-px rounded border shrink-0 ${
                            s.channel.age_tier === 'ultra_young' ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30' :
                            s.channel.age_tier === 'young'       ? 'bg-cyan-500/15 text-cyan-300 border-cyan-500/30' :
                            s.channel.age_tier === 'mid_young'   ? 'bg-blue-500/15 text-blue-300 border-blue-500/30' :
                                                                   'bg-slate-500/15 text-slate-300 border-slate-500/30'
                          }`}>
                            {s.channel.age_tier === 'ultra_young' ? 'ultra' : s.channel.age_tier === 'mid_young' ? 'mid' : s.channel.age_tier}
                          </span>
                        </div>
                        <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-[10px] text-gray-400 tabular-nums">
                          <div><span className="text-gray-600">subs:</span> {s.channel.subscriber_count >= 1000 ? `${Math.round(s.channel.subscriber_count / 1000)}K` : s.channel.subscriber_count}</div>
                          <div><span className="text-gray-600">age:</span> {s.channel.channel_age_days}d</div>
                          <div><span className="text-gray-600">ratio:</span> <span className="text-emerald-400">{s.channel.views_to_subs_ratio}×</span></div>
                          <div><span className="text-gray-600">top pct:</span> top {((1 - (s.novelty_percentile ?? 0)) * 100).toFixed(1)}%</div>
                        </div>
                        <div className="flex items-center gap-1 mt-1 text-[9px] text-gray-500 border-t border-gray-700 pt-1.5">
                          <span title="Isolation (novelty)">iso {s.components.isolation.toFixed(2)}</span>
                          <span>·</span>
                          <span title="Channel quality (composite score)">qual {s.components.channel_quality.toFixed(2)}</span>
                          <span>·</span>
                          <span title="Traction (log-damped views)">trac {s.components.traction.toFixed(2)}</span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Header card — distribution + recompute */}
            <div className="bg-gray-800/50 rounded-2xl border border-gray-700 p-6">
              <div className="flex items-start justify-between gap-3 flex-wrap mb-4">
                <div>
                  <h2 className="text-lg font-bold text-white mb-1">Novelty (blue-ocean) scan</h2>
                  <p className="text-xs text-gray-500 max-w-2xl">
                    Ranks videos by novelty × peer-outlier × log(views). Novelty = mean
                    cosine distance to the 10 nearest neighbours across title_v2 +
                    thumbnail_v2 embeddings. High-novelty+high-performance videos are
                    potential blue-ocean formats (proof of demand, no copycats yet).
                  </p>
                </div>
                <button
                  onClick={runNoveltyRecompute}
                  disabled={noveltyRecomputing}
                  className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:bg-gray-700 disabled:text-gray-500 text-white text-sm font-medium rounded-xl transition"
                >
                  {noveltyRecomputing ? 'Recomputing…' : 'Recompute scores'}
                </button>
              </div>

              {noveltyDist && noveltyDist.total > 0 && (
                <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 mb-3">
                  <div className="bg-gray-900/50 rounded-lg p-3 text-center">
                    <div className="text-xl font-bold text-white">{noveltyDist.total.toLocaleString()}</div>
                    <div className="text-[10px] text-gray-500 uppercase tracking-wider">Scored</div>
                  </div>
                  <div className="bg-gray-900/50 rounded-lg p-3 text-center">
                    <div className="text-xl font-bold text-gray-300">{noveltyDist.p50?.toFixed(3) ?? '-'}</div>
                    <div className="text-[10px] text-gray-500 uppercase tracking-wider">Median (p50)</div>
                  </div>
                  <div className="bg-gray-900/50 rounded-lg p-3 text-center">
                    <div className="text-xl font-bold text-amber-400">{noveltyDist.p90?.toFixed(3) ?? '-'}</div>
                    <div className="text-[10px] text-gray-500 uppercase tracking-wider">p90</div>
                  </div>
                  <div className="bg-gray-900/50 rounded-lg p-3 text-center">
                    <div className="text-xl font-bold text-green-400">{noveltyDist.p99?.toFixed(3) ?? '-'}</div>
                    <div className="text-[10px] text-gray-500 uppercase tracking-wider">p99</div>
                  </div>
                  <div className="bg-gray-900/50 rounded-lg p-3 text-center">
                    <div className="text-xs text-gray-400 break-all">
                      {noveltyDist.lastUpdated ? new Date(noveltyDist.lastUpdated).toLocaleString() : 'never'}
                    </div>
                    <div className="text-[10px] text-gray-500 uppercase tracking-wider">Last run</div>
                  </div>
                </div>
              )}

              {noveltyRecomputeMsg && (
                <div className="px-3 py-2 bg-gray-900/50 border border-gray-700 rounded-lg text-xs text-gray-300">
                  {noveltyRecomputeMsg}
                </div>
              )}
            </div>

            {/* Filters + results */}
            <div className="bg-gray-800/50 rounded-2xl border border-gray-700 p-6 space-y-4">
              {/* Top bar: search + type + match count + active-filter chip + reset */}
              <div className="flex items-center gap-3 flex-wrap">
                <input
                  type="text"
                  value={noveltyQInput}
                  onChange={e => setNoveltyQInput(e.target.value)}
                  placeholder="Search titles or channels…"
                  className="flex-1 min-w-[200px] max-w-md bg-gray-900 border border-gray-700 rounded-xl px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500"
                />
                <div className="flex gap-1.5">
                  <button
                    onClick={() => setNoveltyType('any')}
                    className={`h-9 px-3 rounded-lg flex items-center justify-center transition text-xs font-medium ${noveltyType === 'any' ? 'bg-indigo-600 text-white' : 'bg-gray-900 text-gray-400 border border-gray-700 hover:border-gray-500'}`}
                    title="All video types"
                  >All</button>
                  <button
                    onClick={() => setNoveltyType('long')}
                    className={`w-9 h-9 rounded-lg flex items-center justify-center transition ${noveltyType === 'long' ? 'bg-red-600 text-white' : 'bg-gray-900 text-gray-400 border border-gray-700 hover:border-gray-500'}`}
                    title="Long videos only"
                  >
                    <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M19.615 3.184c-3.604-.246-11.631-.245-15.23 0-3.897.266-4.356 2.62-4.385 8.816.029 6.185.484 8.549 4.385 8.816 3.6.245 11.626.246 15.23 0 3.897-.266 4.356-2.62 4.385-8.816-.029-6.185-.484-8.549-4.385-8.816zm-10.615 12.816v-8l8 3.993-8 4.007z"/></svg>
                  </button>
                  <button
                    onClick={() => setNoveltyType('short')}
                    className={`w-9 h-9 rounded-lg flex items-center justify-center transition ${noveltyType === 'short' ? 'bg-pink-600 text-white' : 'bg-gray-900 text-gray-400 border border-gray-700 hover:border-gray-500'}`}
                    title="Shorts only"
                  >
                    <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M17.77 10.32l-1.2-.5L18 9.06c1.84-1 2.53-3.37 1.54-5.22-.74-1.17-1.79-1.64-2.89-1.64-.61 0-1.24.17-1.83.48L6.14 7c-1.31.62-2.16 1.97-2.14 3.42.12 1.47.97 2.75 2.29 3.37l1.2.5L6 14.94c-1.84 1-2.53 3.37-1.54 5.22.66 1.24 1.95 1.97 3.3 1.97.58 0 1.16-.14 1.7-.43L17.86 17c1.31-.62 2.16-1.97 2.14-3.42-.12-1.47-.97-2.75-2.29-3.37l.06.11z"/></svg>
                  </button>
                </div>
                <span className="text-sm text-gray-400 ml-auto">{noveltyTotal.toLocaleString()} matches</span>
                <button
                  onClick={() => {
                    setNoveltyType('any');
                    setNoveltyMinPct(0); setNoveltyMinViews(0); setNoveltyMaxViews(0);
                    setNoveltyMinOutlier(0); setNoveltyMaxOutlier(0);
                    setNoveltyMinSubs(0); setNoveltyMaxSubs(0);
                    setNoveltyPostedWithin('all'); setNoveltyChannelAge('any');
                    setNoveltyRequireOutlier(false);
                    setNoveltySort('blue_ocean');
                    setNoveltyQInput('');
                  }}
                  className="text-xs text-gray-500 hover:text-white transition"
                >
                  Reset all
                </button>
              </div>

              {/* Every knob is independent. Defaults = OFF so the raw
                  unfiltered distribution shows first. Each filter can be
                  turned on without requiring any other — "Novelty + new
                  channels" is just two selects, not a preset. */}
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-x-4 gap-y-2 text-xs">
                {/* Sort — standalone so admin can rank purely by one dimension */}
                <label className="flex items-center gap-2">
                  <span className="text-gray-500 uppercase tracking-wider whitespace-nowrap">Sort</span>
                  <select value={noveltySort} onChange={e => setNoveltySort(e.target.value as typeof noveltySort)}
                    className="bg-gray-900 border border-gray-700 text-white rounded-md px-2 py-1 flex-1">
                    <option value="blue_ocean">Blue ocean (composite)</option>
                    <option value="novelty">Novelty only</option>
                    <option value="views">Views desc</option>
                    <option value="outlier">Outlier desc</option>
                    <option value="recency">Newest first</option>
                    <option value="subs_asc">Subs asc (small first)</option>
                    <option value="channel_age_asc">Channel age asc (new first)</option>
                  </select>
                </label>

                {/* Novelty percentile */}
                <label className="flex items-center gap-2">
                  <span className="text-gray-500 uppercase tracking-wider whitespace-nowrap">Novelty ≥</span>
                  <select value={noveltyMinPct} onChange={e => setNoveltyMinPct(parseInt(e.target.value))}
                    className="bg-gray-900 border border-gray-700 text-white rounded-md px-2 py-1 flex-1">
                    <option value={0}>any (all scored)</option>
                    <option value={50}>top 50%</option>
                    <option value={75}>top 25%</option>
                    <option value={90}>top 10%</option>
                    <option value={95}>top 5%</option>
                    <option value={99}>top 1%</option>
                  </select>
                </label>

                {/* Views range */}
                <label className="flex items-center gap-2">
                  <span className="text-gray-500 uppercase tracking-wider whitespace-nowrap">Min views</span>
                  <select value={noveltyMinViews} onChange={e => setNoveltyMinViews(parseInt(e.target.value))}
                    className="bg-gray-900 border border-gray-700 text-white rounded-md px-2 py-1 flex-1">
                    <option value={0}>any</option>
                    <option value={1_000}>1k+</option>
                    <option value={10_000}>10k+</option>
                    <option value={50_000}>50k+</option>
                    <option value={100_000}>100k+</option>
                    <option value={500_000}>500k+</option>
                    <option value={1_000_000}>1M+</option>
                    <option value={5_000_000}>5M+</option>
                  </select>
                </label>
                <label className="flex items-center gap-2">
                  <span className="text-gray-500 uppercase tracking-wider whitespace-nowrap">Max views</span>
                  <select value={noveltyMaxViews} onChange={e => setNoveltyMaxViews(parseInt(e.target.value))}
                    className="bg-gray-900 border border-gray-700 text-white rounded-md px-2 py-1 flex-1">
                    <option value={0}>any</option>
                    <option value={10_000}>≤ 10k</option>
                    <option value={100_000}>≤ 100k</option>
                    <option value={500_000}>≤ 500k</option>
                    <option value={1_000_000}>≤ 1M</option>
                    <option value={10_000_000}>≤ 10M</option>
                  </select>
                </label>

                {/* Outlier range + require-toggle — the audit tool you asked
                    for: toggle 'Require outlier' off to see how the grid
                    looks WITHOUT any outlier filtering at all. */}
                <label className="flex items-center gap-2">
                  <span className="text-gray-500 uppercase tracking-wider whitespace-nowrap">Outlier ≥</span>
                  <select value={noveltyMinOutlier} onChange={e => setNoveltyMinOutlier(parseFloat(e.target.value))}
                    className="bg-gray-900 border border-gray-700 text-white rounded-md px-2 py-1 flex-1">
                    <option value={0}>any</option>
                    <option value={1}>1×</option>
                    <option value={2}>2×</option>
                    <option value={5}>5×</option>
                    <option value={10}>10×</option>
                    <option value={20}>20×</option>
                  </select>
                </label>
                <label className="flex items-center gap-2">
                  <span className="text-gray-500 uppercase tracking-wider whitespace-nowrap">Outlier ≤</span>
                  <select value={noveltyMaxOutlier} onChange={e => setNoveltyMaxOutlier(parseFloat(e.target.value))}
                    className="bg-gray-900 border border-gray-700 text-white rounded-md px-2 py-1 flex-1">
                    <option value={0}>any</option>
                    <option value={1}>≤ 1×</option>
                    <option value={2}>≤ 2×</option>
                    <option value={5}>≤ 5×</option>
                    <option value={10}>≤ 10×</option>
                  </select>
                </label>
                <label className="flex items-center gap-2 col-span-2 md:col-span-1">
                  <input type="checkbox"
                    checked={noveltyRequireOutlier}
                    onChange={e => setNoveltyRequireOutlier(e.target.checked)}
                    className="accent-indigo-500"
                  />
                  <span className="text-gray-400 uppercase tracking-wider whitespace-nowrap"
                    title="When off, videos whose channel has no peer-outlier score are INCLUDED (they contribute 1.0 to the composite rank). Toggle on to compare whether the outlier filter actually improves signal.">
                    Require outlier score
                  </span>
                </label>

                {/* Subs range — lets you focus on small/large channels
                    independently of the outlier metric. */}
                <label className="flex items-center gap-2">
                  <span className="text-gray-500 uppercase tracking-wider whitespace-nowrap">Min subs</span>
                  <select value={noveltyMinSubs} onChange={e => setNoveltyMinSubs(parseInt(e.target.value))}
                    className="bg-gray-900 border border-gray-700 text-white rounded-md px-2 py-1 flex-1">
                    <option value={0}>any</option>
                    <option value={100}>100+</option>
                    <option value={1_000}>1k+</option>
                    <option value={10_000}>10k+</option>
                    <option value={100_000}>100k+</option>
                    <option value={1_000_000}>1M+</option>
                  </select>
                </label>
                <label className="flex items-center gap-2">
                  <span className="text-gray-500 uppercase tracking-wider whitespace-nowrap">Max subs</span>
                  <select value={noveltyMaxSubs} onChange={e => setNoveltyMaxSubs(parseInt(e.target.value))}
                    className="bg-gray-900 border border-gray-700 text-white rounded-md px-2 py-1 flex-1">
                    <option value={0}>any</option>
                    <option value={1_000}>≤ 1k</option>
                    <option value={10_000}>≤ 10k</option>
                    <option value={50_000}>≤ 50k</option>
                    <option value={100_000}>≤ 100k</option>
                    <option value={1_000_000}>≤ 1M</option>
                  </select>
                </label>

                {/* Recency — posted window. 'all' disables. */}
                <label className="flex items-center gap-2">
                  <span className="text-gray-500 uppercase tracking-wider whitespace-nowrap">Posted</span>
                  <select value={noveltyPostedWithin} onChange={e => setNoveltyPostedWithin(e.target.value as typeof noveltyPostedWithin)}
                    className="bg-gray-900 border border-gray-700 text-white rounded-md px-2 py-1 flex-1">
                    <option value="all">All time</option>
                    <option value="30">Last 30d</option>
                    <option value="90">Last 3mo</option>
                    <option value="180">Last 6mo</option>
                    <option value="240">Last 8mo</option>
                    <option value="365">Last 1yr</option>
                  </select>
                </label>

                {/* Channel age — same effective-age chain the chip uses */}
                <label className="flex items-center gap-2">
                  <span className="text-gray-500 uppercase tracking-wider whitespace-nowrap">Channel age</span>
                  <select value={noveltyChannelAge} onChange={e => setNoveltyChannelAge(e.target.value as typeof noveltyChannelAge)}
                    className="bg-gray-900 border border-gray-700 text-white rounded-md px-2 py-1 flex-1"
                    title="Filters by the channel's first_upload_at (falling back to channel_created_at) — same derivation the age chip displays.">
                    <option value="any">Any age</option>
                    <option value="brand_new">Brand new (≤30d)</option>
                    <option value="30">≤ 30d</option>
                    <option value="90">≤ 3mo</option>
                    <option value="180">≤ 6mo</option>
                    <option value="365">≤ 1yr</option>
                    <option value="established">Established (&gt;1yr)</option>
                  </select>
                </label>
              </div>

              {/* Grid */}
              {noveltyLoading && noveltyVideos.length === 0 ? (
                <div className="text-center text-sm text-gray-500 py-12">Loading…</div>
              ) : noveltyVideos.length === 0 ? (
                <div className="text-center text-sm text-gray-500 py-12">
                  No videos match these filters. Click &quot;Reset all&quot; above to see the full unfiltered distribution.
                  {noveltyDist && noveltyDist.total === 0 && (
                    <div className="mt-2 text-gray-600">Novelty scores haven&apos;t been computed yet — click &quot;Recompute scores&quot; above.</div>
                  )}
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                  {noveltyVideos.map(v => {
                    const pct = v.noveltyPercentile != null ? Math.round(v.noveltyPercentile * 100) : null;
                    const outlier = v.peerOutlierScore;
                    // Outlier badge: same palette as /niche/outliers
                    const outlierBg = outlier == null ? 'bg-gray-700 text-gray-300'
                      : outlier >= 20 ? 'bg-purple-600 text-white'
                      : outlier >= 10 ? 'bg-pink-600 text-white'
                      : outlier >= 5  ? 'bg-green-600 text-white'
                      : outlier >= 2  ? 'bg-green-700 text-green-100'
                      : 'bg-gray-700 text-gray-300';
                    return (
                      <div key={v.id} className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden hover:border-gray-700 transition flex flex-col">
                        <a href={v.url} target="_blank" rel="noopener noreferrer" className="relative block aspect-video bg-black">
                          {v.thumbnail && (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={v.thumbnail} alt="" className="w-full h-full object-cover" loading="lazy" />
                          )}
                          <div className="absolute top-2 left-2 flex gap-1.5">
                            {pct != null && (
                              <span className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-indigo-600 text-white"
                                title={`Top ${100 - pct}% most novel — mean cosine distance to 10 nearest neighbours`}>
                                Novelty {pct}%
                              </span>
                            )}
                            {outlier != null && (
                              <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full ${outlierBg}`}
                                title={`Channel pulls ${outlier.toFixed(1)}× median avg-views of peers in ${v.peerOutlierBucket} bucket`}>
                                {outlier.toFixed(outlier >= 10 ? 0 : 1)}×
                              </span>
                            )}
                          </div>
                        </a>
                        <div className="p-3 flex-1 flex flex-col gap-1.5">
                          <h3 className="text-sm font-semibold text-white line-clamp-2" title={v.title}>{v.title}</h3>
                          <div className="text-[11px] text-gray-400 truncate">{v.channelName || '—'}</div>
                          <div className="flex items-center gap-3 text-[11px] text-gray-400 mt-auto">
                            <span className="text-green-400 font-medium">{fmtK(v.viewCount)} views</span>
                            {v.subscriberCount != null && v.subscriberCount > 0 && (
                              <span className="text-gray-500">{fmtK(v.subscriberCount)} subs</span>
                            )}
                            {v.peerOutlierBucket && (
                              <span className="text-gray-500 ml-auto">{v.peerOutlierBucket}</span>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Niche Tree Tab — restyled in user vocabulary. Cards are
            structurally identical to the user video grid in
            app/(products)/niche/niches/[keyword]/videos/page.tsx so the
            admin and user surfaces share one visual language. L2 drill-
            down + breadcrumbs come in the next iteration. */}
        <div style={{ display: adminSection === 'tree' ? 'block' : 'none' }}>
          <div className="space-y-6">
            {/* Section header — user pattern: title left, primary action right */}
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <div>
                <h1 className="text-xl font-bold text-white">Niche Tree</h1>
                <p className="text-[#888] text-xs mt-1 max-w-2xl">
                  HDBSCAN over the entire embedded video set — broad parent niches identified by the closest-to-centroid representative video.
                  Sandboxed in <code className="text-amber-400 text-[11px]">niche_tree_*</code> tables; user-facing pages untouched.
                </p>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <button
                  onClick={startTreeRun}
                  disabled={treeStarting || treeData.run?.status === 'running'}
                  className="px-4 h-9 bg-amber-500 hover:bg-amber-400 disabled:bg-[#222] disabled:text-[#666] text-black text-xs font-semibold rounded-md whitespace-nowrap transition"
                >
                  {treeStarting ? 'Starting…' :
                   treeData.run?.status === 'running' ? 'Running…' :
                   'Run global clustering'}
                </button>
                {/* Resume L2 baking — only shown when L1 exists but
                    some clusters lack children (e.g. cancelled bake or
                    pre-fix interrupted run). Walks every eligible
                    parent and bakes the missing L2. */}
                {treeData.run?.status !== 'running' && treeData.clusters.some(c => c.childrenCount === 0 && c.videoCount >= 50) && (
                  <button
                    onClick={async () => {
                      setTreeError(null);
                      try {
                        const r = await fetch('/api/admin/niche-tree/resume-l2', {
                          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
                        });
                        const d = await r.json();
                        if (!r.ok || !d.ok) {
                          setTreeError(d.error || `HTTP ${r.status}`);
                        }
                        // Always refetch — on 409 ("already running") the
                        // status line was stale and not refreshing it
                        // leaves the user staring at the old error.
                        await refetchTree();
                      } catch (err) {
                        setTreeError(err instanceof Error ? err.message : 'unknown');
                      }
                    }}
                    className="px-4 h-9 bg-amber-600/15 hover:bg-amber-600/25 text-amber-400 border border-amber-600/40 text-xs font-semibold rounded-md whitespace-nowrap transition"
                    title="Bake L2 sub-niches for any L1 cluster that doesn't have children yet"
                  >
                    Resume L2 baking
                  </button>
                )}
                {/* Cancel button — only shown while a run is in flight.
                    SIGTERMs the active python process and breaks the
                    L2 baking loop on its next iteration. UI confirms
                    first because cancel = lose all progress. */}
                {treeData.run?.status === 'running' && (
                  <button
                    onClick={async () => {
                      if (!confirm('Cancel this clustering run? All progress so far will be discarded and the partial run marked as errored.')) return;
                      setTreeError(null);
                      try {
                        const r = await fetch('/api/admin/niche-tree/cancel', {
                          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
                        });
                        const d = await r.json();
                        if (!r.ok || !d.ok) {
                          setTreeError(d.error || `HTTP ${r.status}`);
                        } else {
                          await refetchTree();
                        }
                      } catch (err) {
                        setTreeError(err instanceof Error ? err.message : 'unknown');
                      }
                    }}
                    className="px-4 h-9 bg-red-500/15 hover:bg-red-500/25 text-red-400 border border-red-500/40 text-xs font-semibold rounded-md whitespace-nowrap transition"
                    title="SIGTERM the python process + stop the L2 baking loop"
                  >
                    Cancel
                  </button>
                )}
              </div>
            </div>

            {/* Param controls — quieter card in user palette */}
            {treeData.run?.status !== 'running' && (
              <div className="bg-[#141414] border border-[#1f1f1f] rounded-xl p-4">
                <div className="flex flex-wrap gap-4 items-end">
                  <div>
                    <label className="block text-[10px] text-[#666] uppercase tracking-wider mb-1">Embedding</label>
                    <select
                      value={treeParams.source}
                      onChange={e => setTreeParams(p => ({ ...p, source: e.target.value as typeof treeParams.source }))}
                      className="bg-[#1a1a1a] border border-[#1f1f1f] rounded-lg px-3 h-9 text-xs text-white focus:outline-none focus:border-amber-500"
                    >
                      <option value="combined_v2">Combined v2 ✦ (joint multimodal)</option>
                      <option value="thumbnail_v2">Thumbnail v2</option>
                      <option value="title_v2">Title v2</option>
                      <option value="title_v1">Title v1</option>
                      <option value="combined">Combined legacy (title+thumb v2 concat)</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-[10px] text-[#666] uppercase tracking-wider mb-1" title="Bigger = fewer, broader niches. 80 is a good L1 default.">
                      min_cluster_size
                    </label>
                    <input type="number" min={10} max={500} value={treeParams.minClusterSize}
                      onChange={e => setTreeParams(p => ({ ...p, minClusterSize: parseInt(e.target.value) || 80 }))}
                      className="w-24 bg-[#1a1a1a] border border-[#1f1f1f] rounded-lg px-3 h-9 text-xs text-white focus:outline-none focus:border-amber-500" />
                  </div>
                  <div>
                    <label className="block text-[10px] text-[#666] uppercase tracking-wider mb-1">min_samples</label>
                    <input type="number" min={1} max={50} value={treeParams.minSamples}
                      onChange={e => setTreeParams(p => ({ ...p, minSamples: parseInt(e.target.value) || 10 }))}
                      className="w-24 bg-[#1a1a1a] border border-[#1f1f1f] rounded-lg px-3 h-9 text-xs text-white focus:outline-none focus:border-amber-500" />
                  </div>
                  <div>
                    <label className="block text-[10px] text-[#666] uppercase tracking-wider mb-1">umap_dims</label>
                    <input type="number" min={5} max={200} value={treeParams.umapDims}
                      onChange={e => setTreeParams(p => ({ ...p, umapDims: parseInt(e.target.value) || 50 }))}
                      className="w-24 bg-[#1a1a1a] border border-[#1f1f1f] rounded-lg px-3 h-9 text-xs text-white focus:outline-none focus:border-amber-500" />
                  </div>
                  <div>
                    <label className="block text-[10px] text-[#666] uppercase tracking-wider mb-1" title="UMAP k-NN graph fan-out. Higher = more global structure, less HDBSCAN noise. 15 = sensible default; 5 was inflating GPU noise to 64%.">
                      n_neighbors
                    </label>
                    <input type="number" min={2} max={100} value={treeParams.nNeighbors}
                      onChange={e => setTreeParams(p => ({ ...p, nNeighbors: parseInt(e.target.value) || 15 }))}
                      className="w-24 bg-[#1a1a1a] border border-[#1f1f1f] rounded-lg px-3 h-9 text-xs text-white focus:outline-none focus:border-amber-500" />
                  </div>
                  <div>
                    <label className="block text-[10px] text-[#666] uppercase tracking-wider mb-1" title="Tukey-fence multiplier for per-cluster outlier cleanup. 0 disables; 3.0 is lenient.">
                      iqr_mult
                    </label>
                    <input type="number" min={0} max={10} step={0.5} value={treeParams.outlierIqrMult}
                      onChange={e => setTreeParams(p => ({ ...p, outlierIqrMult: parseFloat(e.target.value) || 3.0 }))}
                      className="w-24 bg-[#1a1a1a] border border-[#1f1f1f] rounded-lg px-3 h-9 text-xs text-white focus:outline-none focus:border-amber-500" />
                  </div>
                  <div>
                    <label className="block text-[10px] text-[#666] uppercase tracking-wider mb-1" title="Minimum L1 cluster size that triggers an L2 subdivide. L1 clusters smaller than this are kept as leaves.">
                      l2_min_parent
                    </label>
                    <input type="number" min={50} max={5000} value={treeParams.minParentSize}
                      onChange={e => setTreeParams(p => ({ ...p, minParentSize: parseInt(e.target.value) || 200 }))}
                      className="w-24 bg-[#1a1a1a] border border-[#1f1f1f] rounded-lg px-3 h-9 text-xs text-white focus:outline-none focus:border-amber-500" />
                  </div>
                  {/* Execution mode — CPU subprocess on Railway, or GPU
                      dispatch to RunPod cuML. GPU is ~10× faster but
                      requires admin_config.runpod_* + vector_db_url_external. */}
                  <div>
                    <label className="block text-[10px] text-[#666] uppercase tracking-wider mb-1" title="Where to run the UMAP+HDBSCAN. GPU dispatches to RunPod cuML; CPU runs locally on Railway.">
                      execution
                    </label>
                    <div className="inline-flex rounded-lg border border-[#1f1f1f] overflow-hidden h-9">
                      {(['cpu', 'gpu'] as const).map(m => (
                        <button
                          key={m}
                          type="button"
                          onClick={() => setTreeParams(p => ({ ...p, executionMode: m }))}
                          className={
                            'px-3 text-xs transition ' +
                            (treeParams.executionMode === m
                              ? (m === 'gpu' ? 'bg-fuchsia-500/80 text-white font-semibold'
                                             : 'bg-amber-500 text-black font-semibold')
                              : 'bg-[#1a1a1a] text-[#888] hover:text-white')
                          }
                        >
                          {m.toUpperCase()}
                          {m === 'gpu' && <span className="ml-1 text-[10px] opacity-70">RunPod</span>}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Status line — single row, user vocabulary */}
            {treeData.run ? (
              <div className="text-xs text-[#888] flex flex-wrap items-center gap-x-3 gap-y-1">
                <span>
                  Latest run:{' '}
                  <span className={
                    treeData.run.status === 'done'    ? 'text-green-400 font-medium' :
                    treeData.run.status === 'running' ? 'text-amber-400 animate-pulse font-medium' :
                    'text-red-400 font-medium'
                  }>{treeData.run.status}</span>
                </span>
                {treeData.run.status === 'done' && (() => {
                  // Prefer the live numAssigned (computed off the
                  // assignments table) over the stored numNoise, since
                  // the latter is the HDBSCAN-time figure and doesn't
                  // reflect post-cleanup demotions. If numAssigned isn't
                  // present (older run row), fall back to total - noise.
                  const total    = treeData.run.totalVideos;
                  const assigned = treeData.run.numAssigned ?? Math.max(0, total - (treeData.run.numNoise ?? 0));
                  const unassigned = Math.max(0, total - assigned);
                  const pct = total > 0 ? (assigned / total * 100) : 0;
                  return (
                    <>
                      <span className="text-[#444]">·</span>
                      <span><span className="text-white font-medium">{treeData.run.numClusters}</span> clusters</span>
                      <span className="text-[#444]">·</span>
                      <span title="Videos with cluster_id != NULL in niche_tree_assignments (post-cleanup)">
                        <span className="text-green-400 font-medium">{assigned.toLocaleString()}</span> in clusters
                        <span className="text-[#666] ml-1">({pct.toFixed(1)}%)</span>
                      </span>
                      <span className="text-[#444]">·</span>
                      <span title="Videos with cluster_id NULL — HDBSCAN noise + IQR/cascade demotions">
                        <span className="text-[#aaa]">{unassigned.toLocaleString()}</span> unassigned
                      </span>
                      <span className="text-[#444]">·</span>
                      <span>{total.toLocaleString()} total</span>
                    </>
                  );
                })()}
                <span className="text-[#444]">·</span>
                <span title={new Date(treeData.run.startedAt).toLocaleString()}>started {fmtAgo(treeData.run.startedAt)}</span>
                {treeData.run.completedAt && (
                  <>
                    <span className="text-[#444]">·</span>
                    <span title={new Date(treeData.run.completedAt).toLocaleString()}>completed {fmtAgo(treeData.run.completedAt)}</span>
                  </>
                )}
                <span className="text-[#444]">·</span>
                <span className="text-[#666]">source={treeData.run.source}</span>
                {treeData.run.errorMessage && (
                  <div className="w-full mt-1 text-red-400 break-all">error: {treeData.run.errorMessage}</div>
                )}
              </div>
            ) : (
              <div className="text-xs text-[#666]">No global run yet. Configure params and click <span className="text-amber-400">Run global clustering</span> to start.</div>
            )}
            {treeError && (
              <div className="text-xs text-red-400">{treeError}</div>
            )}

            {/* In-progress stepper — shown whenever a run is active.
                Each stage's elapsed time persists once it completes; the
                current stage gets a live ticker. Tail of stderr below
                gives operator confidence that work is actually moving. */}
            {treeData.run?.status === 'running' && (() => {
              const prog = treeData.run.progress;
              // GPU and CPU paths share most stages; GPU adds two
              // "gpu_*" stages up-front that cover RunPod queue +
              // in-container compute (which is one opaque block from
              // the operator's view). CPU runs hit the same UMAP /
              // HDBSCAN / labeling sequence directly on the Railway
              // worker. The stepper renders whichever stages are
              // reachable in this run's mode.
              const isGpu = (treeData.run?.params?.executionMode === 'gpu');
              const TREE_STAGES_UI: Array<{ key: TreeStage; label: string; sub: string }> = isGpu ? [
                { key: 'starting',     label: 'Starting',         sub: 'preparing RunPod payload' },
                { key: 'gpu_queued',   label: 'GPU queued',       sub: 'RunPod worker initializing (cold pull ~10 min)' },
                { key: 'gpu_running',  label: 'GPU running',      sub: 'cuML UMAP + HDBSCAN + L2 in single container' },
                { key: 'writing',      label: 'Writing',          sub: 'PG inserts for clusters + assignments' },
                { key: 'stitching',    label: 'Stitching',        sub: 'matching L1 against prior runs' },
                { key: 'baking_l2',    label: 'Baking L2',        sub: 'per-parent writes + L2 stitch + AI labels' },
              ] : [
                { key: 'starting',     label: 'Starting',         sub: 'spawning python' },
                { key: 'fetching',     label: 'Fetching',         sub: 'pulling embeddings + matrix' },
                { key: 'umap_cluster', label: 'UMAP clustering',  sub: 'longest stage; raw embedding → 50D' },
                { key: 'hdbscan',      label: 'HDBSCAN',          sub: 'density clustering + rep videos' },
                { key: 'labeling',     label: 'Auto-labels',      sub: 'TF-IDF per cluster' },
                { key: 'writing',      label: 'Writing',          sub: 'cards populate live below' },
                { key: 'baking_l2',    label: 'Baking L2',         sub: 'subdivide each L1 niche' },
              ];
              const currentStage: TreeStage = prog?.stage ?? 'starting';
              const currentIdx = TREE_STAGES_UI.findIndex(s => s.key === currentStage);
              const fmtMs = (ms?: number) => {
                if (ms == null) return '';
                const s = Math.round(ms / 1000);
                if (s < 60) return `${s}s`;
                return `${Math.floor(s / 60)}m ${s % 60}s`;
              };
              const stageLiveMs = prog?.stageStartedAt
                ? Date.now() - new Date(prog.stageStartedAt).getTime()
                : null;
              return (
                <div className="bg-[#141414] border border-[#1f1f1f] rounded-xl p-4 space-y-3">
                  {/* Stepper */}
                  <div className="flex items-stretch gap-2 overflow-x-auto">
                    {TREE_STAGES_UI.map((s, i) => {
                      const done = i < currentIdx;
                      const active = i === currentIdx;
                      const elapsed = active
                        ? fmtMs(stageLiveMs ?? 0)
                        : done
                          ? fmtMs(prog?.stagesElapsedMs?.[s.key])
                          : '';
                      return (
                        <div key={s.key}
                          className={`flex-1 min-w-[140px] rounded-lg border px-3 py-2 transition ${
                            done   ? 'border-[#1f1f1f] bg-[#0a0a0a]' :
                            active ? 'border-amber-500/40 bg-amber-500/5' :
                                     'border-[#1a1a1a] bg-[#111] opacity-60'
                          }`}
                        >
                          <div className="flex items-center gap-2 mb-0.5">
                            {done ? (
                              <svg className="w-3.5 h-3.5 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                              </svg>
                            ) : active ? (
                              <div className="w-3.5 h-3.5 border-2 border-amber-400 border-t-transparent rounded-full animate-spin" />
                            ) : (
                              <div className="w-3.5 h-3.5 rounded-full border border-[#333]" />
                            )}
                            <span className={`text-xs font-medium ${active ? 'text-white' : done ? 'text-[#888]' : 'text-[#666]'}`}>
                              {s.label}
                            </span>
                            {elapsed && (
                              <span className={`ml-auto text-[10px] font-mono ${active ? 'text-amber-300' : 'text-[#666]'}`}>
                                {elapsed}
                              </span>
                            )}
                          </div>
                          <div className="text-[10px] text-[#666] truncate">{s.sub}</div>
                        </div>
                      );
                    })}
                  </div>

                  {/* RunPod job link + timing — only relevant when a
                      GPU dispatch is in flight. Deep-links to RunPod's
                      log viewer for the operator who wants stderr in
                      real time (vs the polled tail we surface below). */}
                  {isGpu && prog?.runpodJobId && (
                    <div className="text-xs text-[#888] flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span>RunPod job:</span>
                      <a
                        href={`https://console.runpod.io/serverless/user/endpoint/9b6old274avgya?tab=logs`}
                        target="_blank"
                        rel="noreferrer"
                        className="font-mono text-fuchsia-400 hover:text-fuchsia-300 underline"
                      >
                        {prog.runpodJobId.slice(0, 12)}…
                      </a>
                      {prog.runpodDelayMs != null && (
                        <>
                          <span className="text-[#444]">·</span>
                          <span>queue: <span className="text-white">{fmtMs(prog.runpodDelayMs)}</span></span>
                        </>
                      )}
                      {prog.runpodExecMs != null && (
                        <>
                          <span className="text-[#444]">·</span>
                          <span>exec: <span className="text-white">{fmtMs(prog.runpodExecMs)}</span></span>
                        </>
                      )}
                    </div>
                  )}

                  {/* Counts surfaced as soon as HDBSCAN reports them, even
                      before the writing stage starts populating the grid. */}
                  {(prog?.numClusters != null || prog?.numNoise != null) && currentStage !== 'done' && currentStage !== 'baking_l2' && (
                    <div className="text-xs text-[#888]">
                      {prog?.numClusters != null && (
                        <>HDBSCAN found <span className="text-white font-medium">{prog.numClusters}</span> clusters</>
                      )}
                      {prog?.numNoise != null && <span> · {prog.numNoise} noise</span>}
                      {currentStage === 'writing' && (
                        <span className="text-amber-400"> · writing to DB — cards populate below</span>
                      )}
                    </div>
                  )}

                  {/* L2 baking aggregate progress — shown while the chained
                      subdivide loop runs. The L1 grid is fully populated
                      below at this point; each card flips its L2 chip
                      from "L2 pending" → "baking…" → "N sub-niches" as
                      the loop walks through them. */}
                  {currentStage === 'baking_l2' && prog?.l2 && (
                    <div className="text-xs text-[#888] flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span>
                        Baking L2:{' '}
                        <span className="text-white font-medium">{prog.l2.completed}</span>
                        <span className="text-[#666]"> / {prog.l2.total}</span>
                        {' '}clusters subdivided
                      </span>
                      {prog.l2.skipped > 0 && (
                        <><span className="text-[#444]">·</span><span>{prog.l2.skipped} too small to split</span></>
                      )}
                      {prog.l2.failed > 0 && (
                        <><span className="text-[#444]">·</span><span className="text-red-400">{prog.l2.failed} failed</span></>
                      )}
                      {prog.l2.currentParentLabel && (
                        <><span className="text-[#444]">·</span>
                          <span className="text-amber-400 truncate max-w-[300px]">
                            current: {prog.l2.currentParentLabel}
                          </span>
                        </>
                      )}
                    </div>
                  )}

                  {/* Stderr tail — collapsible, helps confirm work is
                      moving during the long UMAP stage. */}
                  {prog?.recentLogs && prog.recentLogs.length > 0 && (
                    <details className="text-[11px]">
                      <summary className="text-[#666] cursor-pointer hover:text-white">Recent log output</summary>
                      <pre className="mt-2 p-2 bg-[#0a0a0a] border border-[#1f1f1f] rounded-md text-[#888] font-mono overflow-x-auto max-h-40">
{prog.recentLogs.join('\n')}
                      </pre>
                    </details>
                  )}
                </div>
              );
            })()}

            {/* Per-cluster video grid view — opens when the user clicks
                the "view videos" button on any L1/L2+ cluster card. Hides
                the cluster grid entirely while open; back chevron returns
                to whichever cluster level was active before. */}
            {treeVideosClusterId != null && (() => {
              const vd = treeVideosData;
              const parent = vd?.parent;
              const ancestors = vd?.ancestors ?? [];
              const total = vd?.total ?? 0;
              const videos = vd?.videos ?? [];
              const parentLabel = parent
                ? (parent.label || parent.autoLabel || `Cluster #${parent.clusterIndex}`)
                : 'Loading…';
              const sortOptions: Array<{ value: TreeVideoSort; label: string; title?: string }> = [
                { value: 'centroid', label: 'd ↑ closest to centroid',   title: 'Sort by distance-to-centroid ascending — most representative samples first' },
                { value: 'outlier',  label: 'd ↓ farthest from centroid', title: 'Sort by distance-to-centroid descending — niche-edge or possible misclassifications first' },
                { value: 'score',    label: 'Score' },
                { value: 'views',    label: 'Views' },
                { value: 'date',     label: 'Newest' },
                { value: 'oldest',   label: 'Oldest' },
                { value: 'likes',    label: 'Likes' },
              ];

              return (
                <div className="space-y-3">
                  {/* Breadcrumb + back chevron + total count */}
                  <div className="flex items-center gap-2 text-sm">
                    <button
                      type="button"
                      onClick={closeClusterVideos}
                      className="w-7 h-7 rounded-full bg-black/60 hover:bg-white/10 flex items-center justify-center text-white/80 hover:text-white transition flex-shrink-0"
                      title="Back"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M15 19l-7-7 7-7" />
                      </svg>
                    </button>
                    <button
                      type="button"
                      onClick={() => { closeClusterVideos(); setTreeViewedClusterId(null); }}
                      className="text-[#888] hover:text-white transition"
                    >
                      Niche Tree
                    </button>
                    {ancestors.map(a => (
                      <React.Fragment key={a.id}>
                        <span className="text-[#444]">·</span>
                        <button
                          type="button"
                          onClick={() => { closeClusterVideos(); setTreeViewedClusterId(a.id); }}
                          className="text-[#888] hover:text-white transition truncate max-w-[200px]"
                          title={a.label || a.autoLabel || `Cluster ${a.clusterIndex}`}
                        >
                          {a.label || a.autoLabel || `Cluster #${a.clusterIndex}`}
                        </button>
                      </React.Fragment>
                    ))}
                    <span className="text-[#444]">·</span>
                    <span className="text-white font-medium truncate max-w-[300px]" title={parentLabel}>
                      {parentLabel}
                    </span>
                    <span className="text-[10px] bg-blue-500/15 text-blue-300 border border-blue-500/30 px-2 py-0.5 rounded-full">videos</span>
                    <span className="ml-auto text-xs text-[#666]">{total.toLocaleString()} total</span>
                  </div>

                  {/* Search bar — title-only ILIKE filter applied on the
                      server. Debounced 300ms (see treeVideosSearchInput
                      effect) so each keystroke doesn't fire a query. */}
                  <div className="bg-[#141414] border border-[#1f1f1f] rounded-xl p-3">
                    <div className="flex items-center gap-2 bg-[#0a0a0a] border border-[#1f1f1f] rounded-xl px-3 py-2 focus-within:border-blue-500 transition">
                      <svg className="w-4 h-4 text-[#555] flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                      </svg>
                      <input
                        type="text"
                        value={treeVideosSearchInput}
                        onChange={e => setTreeVideosSearchInput(e.target.value)}
                        placeholder="Search videos by title…"
                        className="flex-1 bg-transparent text-white text-sm placeholder-[#555] focus:outline-none"
                      />
                      {treeVideosSearchInput && (
                        <button
                          type="button"
                          onClick={() => setTreeVideosSearchInput('')}
                          className="text-[#666] hover:text-white"
                          title="Clear search"
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                          </svg>
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Sort pills — same options as user-side videos page,
                      with `centroid` added (and made the default) since
                      the admin view sorts by representativeness first. */}
                  <div className="bg-[#141414] border border-[#1f1f1f] rounded-xl p-3 flex items-center gap-2 flex-wrap">
                    {sortOptions.map(opt => (
                      <button
                        key={opt.value}
                        onClick={() => setTreeVideosSort(opt.value)}
                        title={opt.title}
                        className={`px-3 py-1 rounded-full text-xs transition ${
                          treeVideosSort === opt.value
                            ? 'bg-white text-black font-medium'
                            : 'text-[#888] border border-[#333] hover:border-[#555]'
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                    <span className="ml-auto text-xs text-[#666]">
                      {videos.length}/{total}
                    </span>
                  </div>

                  {/* Video grid — 3 columns on lg+, mirrors the user-side
                      niche videos card layout (thumbnail + score badge,
                      title, views/channel/time row, likes/comments/subs
                      meta, optional top comment, URL footer). */}
                  {treeVideosLoading && videos.length === 0 ? (
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                      {Array.from({ length: 9 }).map((_, i) => (
                        <div key={i} className="bg-[#141414] border border-[#1f1f1f] rounded-xl overflow-hidden animate-pulse">
                          <div className="aspect-video bg-[#1a1a1a]" />
                          <div className="p-3 space-y-2">
                            <div className="h-4 w-3/4 bg-[#1f1f1f] rounded" />
                            <div className="h-3 w-1/2 bg-[#1f1f1f] rounded" />
                            <div className="h-3 w-2/3 bg-[#1f1f1f] rounded" />
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : videos.length === 0 ? (
                    <div className="bg-[#141414] border border-[#1f1f1f] rounded-xl p-8 text-center text-sm text-[#888]">
                      {treeVideosSearch
                        ? <>No videos match &ldquo;{treeVideosSearch}&rdquo; in this cluster.</>
                        : 'No videos in this cluster.'}
                    </div>
                  ) : (
                    <>
                      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                        {videos.map(v => {
                          const score = v.score != null ? Math.round(v.score) : null;
                          const scoreBadge =
                            score == null ? null :
                            score >= 80   ? 'bg-green-500 text-white' :
                            score >= 50   ? 'bg-yellow-500 text-black' :
                                            'bg-red-500 text-white';
                          return (
                            <div key={v.videoId} className="bg-[#141414] border border-[#1f1f1f] rounded-xl overflow-hidden hover:border-[#333] transition">
                              <div className="relative aspect-video bg-[#0a0a0a]">
                                {v.thumbnail ? (
                                  // eslint-disable-next-line @next/next/no-img-element
                                  <img src={v.thumbnail} alt="" className="w-full h-full object-cover" loading="lazy" />
                                ) : (
                                  <div className="w-full h-full flex items-center justify-center text-[#333] text-xs">no thumb</div>
                                )}
                                {scoreBadge && (
                                  <div className={`absolute top-2 right-2 px-2 py-0.5 rounded-full text-xs font-bold ${scoreBadge}`}>
                                    ⚡ {score}
                                  </div>
                                )}
                                {v.distanceToCentroid != null && (
                                  <div className="absolute top-2 left-2 px-2 py-0.5 rounded-full text-[10px] font-mono bg-black/60 text-white/80 border border-white/10"
                                       title="Distance to cluster centroid (lower = more representative)">
                                    d={v.distanceToCentroid.toFixed(2)}
                                  </div>
                                )}
                              </div>
                              <div className="p-3">
                                {v.keyword && (
                                  <div className="mb-2">
                                    <span className="text-[10px] bg-purple-600/30 text-purple-300 border border-purple-600/50 rounded-full px-2 py-0.5">
                                      {v.keyword}
                                    </span>
                                  </div>
                                )}
                                <h3 className="text-sm font-medium text-white line-clamp-2 mb-2" title={v.title || ''}>
                                  {v.title || '(no title)'}
                                </h3>
                                <div className="flex items-center gap-2 text-xs text-[#888] mb-1.5 flex-wrap">
                                  {v.viewCount != null && (
                                    <span className="text-green-400 font-medium">{fmtK(v.viewCount)} views</span>
                                  )}
                                  {v.channelName && <span className="truncate">· {v.channelName}</span>}
                                  {(v.postedAt || v.postedDate) && (
                                    <span>· {v.postedAt ? fmtAgo(v.postedAt) : v.postedDate}</span>
                                  )}
                                </div>
                                <div className="flex items-center gap-3 text-xs text-[#666] mb-2 flex-wrap">
                                  {v.likeCount != null && v.likeCount > 0    && <span>👍 {fmtK(v.likeCount)}</span>}
                                  {v.commentCount != null && v.commentCount > 0 && <span>💬 {fmtK(v.commentCount)}</span>}
                                  {v.subscriberCount != null && v.subscriberCount > 0 && <span>👥 {fmtK(v.subscriberCount)} subs</span>}
                                </div>
                                {v.topComment && (
                                  <p className="text-xs text-[#666] italic line-clamp-2 border-l-2 border-[#333] pl-2 mb-2">
                                    &ldquo;{v.topComment}&rdquo;
                                  </p>
                                )}
                                {v.url && (
                                  <a href={v.url} target="_blank" rel="noreferrer"
                                     className="text-xs text-blue-400 hover:text-blue-300 truncate block">
                                    {v.url}
                                  </a>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>

                      {/* Auto-load: invisible sentinel that the
                          IntersectionObserver watches. Sits 300px above
                          the load-more button (rootMargin) so the next
                          page is already in flight before the user runs
                          out of cards. The button stays as a manual
                          fallback for keyboard nav / odd browsers. */}
                      {videos.length < total && (
                        <>
                          <div ref={treeVideosSentinelRef} aria-hidden className="h-px w-full" />
                          <div className="text-center">
                            <button
                              type="button"
                              onClick={() => treeVideosClusterId && fetchClusterVideos(treeVideosClusterId, treeVideosOffset, treeVideosSort, treeVideosSearch)}
                              disabled={treeVideosLoading}
                              className="px-6 py-2 bg-white/10 hover:bg-white/15 disabled:opacity-50 text-white rounded-xl text-sm transition"
                            >
                              {treeVideosLoading ? 'Loading…' : `Load more (${videos.length}/${total})`}
                            </button>
                          </div>
                        </>
                      )}
                    </>
                  )}
                </div>
              );
            })()}

            {/* Breadcrumb — shown when drilled into a cluster */}
            {treeVideosClusterId == null && treeViewedClusterId != null && treeViewedData?.parent && (
              <div className="flex items-center gap-2 text-sm">
                <button
                  type="button"
                  onClick={() => setTreeViewedClusterId(null)}
                  className="text-[#888] hover:text-white transition"
                >
                  Niche Tree
                </button>
                {treeViewedData.ancestors.map(a => (
                  <React.Fragment key={a.id}>
                    <span className="text-[#444]">·</span>
                    <button
                      type="button"
                      onClick={() => setTreeViewedClusterId(a.id)}
                      className="text-[#888] hover:text-white transition truncate max-w-[200px]"
                      title={a.label || a.autoLabel || `Cluster ${a.clusterIndex}`}
                    >
                      {a.label || a.autoLabel || `Cluster #${a.clusterIndex}`}
                    </button>
                  </React.Fragment>
                ))}
                <span className="text-[#444]">·</span>
                <span className="text-white font-medium truncate max-w-[300px]" title={treeViewedData.parent.label || treeViewedData.parent.autoLabel || ''}>
                  {treeViewedData.parent.label || treeViewedData.parent.autoLabel || `Cluster #${treeViewedData.parent.clusterIndex}`}
                </span>
                <span className="ml-auto text-xs text-[#666]">
                  L{treeViewedData.parent.level + 1} sub-niches
                </span>
              </div>
            )}

            {/* In-flight subdivide notice for the viewed cluster */}
            {treeVideosClusterId == null && treeViewedClusterId != null && treeViewedData?.subdivideRun?.status === 'running' && (
              <div className="bg-[#141414] border border-amber-500/40 rounded-xl p-4 flex items-center gap-3">
                <div className="w-5 h-5 border-2 border-amber-400 border-t-transparent rounded-full animate-spin" />
                <div className="text-xs text-amber-200">
                  Subdividing this niche…
                  {treeViewedData.subdivideRun.progress?.stage && (
                    <span className="text-[#888] ml-2">stage: {treeViewedData.subdivideRun.progress.stage}</span>
                  )}
                </div>
              </div>
            )}

            {treeVideosClusterId == null && treeViewedClusterId != null && treeViewedData?.subdivideRun?.status === 'error' && (treeViewedData.children.length === 0) && (
              <div className="bg-[#141414] border border-red-500/40 rounded-xl p-4 text-xs">
                <div className="text-red-400 font-medium mb-1">Subdivide failed</div>
                {treeViewedData.subdivideRun.errorMessage && (
                  <div className="text-[#888] break-all mb-2">{treeViewedData.subdivideRun.errorMessage.slice(0, 400)}</div>
                )}
                <button
                  type="button"
                  onClick={() => treeViewedClusterId && subdivideCluster(treeViewedClusterId)}
                  className="px-3 h-8 bg-amber-500 hover:bg-amber-400 text-black text-xs font-semibold rounded-md"
                >
                  Retry subdivide
                </button>
              </div>
            )}

            {treeVideosClusterId == null && treeViewedClusterId != null && treeViewedData && treeViewedData.children.length === 0
              && treeViewedData.subdivideRun?.status !== 'running'
              && treeViewedData.subdivideRun?.status !== 'error' && (
              <div className="bg-[#141414] border border-[#1f1f1f] rounded-xl p-6 text-center text-sm text-[#888]">
                {treeViewedData.parent && treeViewedData.parent.videoCount < 50
                  ? `This niche has only ${treeViewedData.parent.videoCount} videos — too few to subdivide meaningfully.`
                  : 'No sub-niches yet — click "Subdivide this niche" to bake them.'}
                {treeViewedData.parent && treeViewedData.parent.videoCount >= 50 && (
                  <div className="mt-3">
                    <button
                      type="button"
                      onClick={() => treeViewedClusterId && subdivideCluster(treeViewedClusterId)}
                      className="px-4 h-9 bg-amber-500 hover:bg-amber-400 text-black text-xs font-semibold rounded-md"
                    >
                      Subdivide this niche
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* Cluster rows — same layout for L1 grid and L2+ drill-down.
                Either treeData.clusters (L1) or treeViewedData.children
                (L2+) feeds the list. Multiple thumbs convey the niche's
                visual texture way better than a single rep video. */}
            {(() => {
              // Hide the cluster grid entirely when the per-cluster video
              // grid view is open — the videos block above takes over.
              if (treeVideosClusterId != null) return null;
              const displayedClusters: TreeCluster[] = treeViewedClusterId != null
                ? (treeViewedData?.children ?? [])
                : treeData.clusters;
              if (displayedClusters.length === 0) return null;
              return (
              <div className="space-y-3">
                {displayedClusters.map(c => {
                  const label = c.label || c.autoLabel || `Cluster #${c.clusterIndex}`;
                  const score = c.avgScore != null ? Math.round(c.avgScore) : null;
                  const scoreColor =
                    score == null ? 'text-[#666]' :
                    score >= 80   ? 'text-green-400' :
                    score >= 50   ? 'text-yellow-400' :
                                    'text-red-400';
                  // Pad popularVideos to 4 slots so the strip alignment
                  // is consistent even for sparse small clusters.
                  const slots: Array<typeof c.popularVideos[number] | null> = [...c.popularVideos];
                  while (slots.length < 4) slots.push(null);
                  // L2 status chip — derives a single status string from
                  // a few inputs: did we already have children, is the
                  // global L2 baking phase currently working on us, or
                  // did the latest subdivide error.
                  const isCurrentlyBaking =
                    treeData.run?.progress?.l2?.currentParentId === c.id;
                  const l2Chip: { label: string; cls: string; tooltip?: string } | null = (() => {
                    if (c.childrenCount > 0) {
                      return { label: `${c.childrenCount} sub-niches`, cls: 'bg-green-500/15 text-green-400 border-green-500/25' };
                    }
                    if (isCurrentlyBaking || c.subdivideStatus === 'running') {
                      return { label: 'baking…', cls: 'bg-amber-500/15 text-amber-400 border-amber-500/25 animate-pulse' };
                    }
                    if (c.subdivideStatus === 'error') {
                      return { label: 'L2 failed', cls: 'bg-red-500/15 text-red-400 border-red-500/25', tooltip: c.subdivideError || '' };
                    }
                    if (c.videoCount < 50) {
                      return { label: 'too small to split', cls: 'bg-[#1a1a1a] text-[#666] border-[#1f1f1f]' };
                    }
                    // Eligible but not yet baked — usually means user clicked
                    // before global L2 baking reached this cluster, or the
                    // cluster was added after a partial bake.
                    return { label: 'L2 pending', cls: 'bg-[#1a1a1a] text-[#888] border-[#1f1f1f]' };
                  })();

                  return (
                    <div key={c.id}
                      className="bg-[#141414] border border-[#1f1f1f] rounded-xl hover:border-[#333] transition cursor-pointer"
                      onClick={() => onClusterCardClick(c)}
                    >
                      {/* Header strip: cluster meta + score on the right */}
                      <div className="flex items-start justify-between gap-3 px-4 pt-4 pb-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 flex-wrap mb-1">
                            <span className="text-xs bg-amber-600/30 text-amber-300 border border-amber-600/50 rounded-full px-2 py-0.5 whitespace-nowrap">
                              {c.videoCount.toLocaleString()} videos
                            </span>
                            <span className="text-xs text-[#666] font-mono">#{c.clusterIndex}</span>
                            {l2Chip && (
                              <span
                                className={`text-[10px] px-2 py-0.5 rounded-full border whitespace-nowrap ${l2Chip.cls}`}
                                title={l2Chip.tooltip}
                              >
                                {l2Chip.label}
                              </span>
                            )}
                            {c.topChannels.length > 0 && (
                              <span className="text-xs text-[#888] truncate" title={c.topChannels.join(', ')}>
                                · {c.topChannels.slice(0, 3).join(', ')}
                                {c.topChannels.length > 3 && ` +${c.topChannels.length - 3}`}
                              </span>
                            )}
                          </div>
                          <h3 className="text-sm font-medium text-white line-clamp-1" title={label}>
                            {label}
                          </h3>
                        </div>
                        <div className="flex items-center gap-3 flex-shrink-0">
                          {score != null && (
                            <div className="text-right">
                              <div className={`text-lg font-bold ${scoreColor}`}>⚡ {score}</div>
                              <div className="text-[10px] text-[#666] uppercase tracking-wider">avg score</div>
                            </div>
                          )}
                          {/* View videos — opens the per-cluster paginated
                              video grid. Separate from the drill-arrow so
                              the user can pick: "see sub-niches" vs "see
                              every video in this niche". */}
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); openClusterVideos(c.id); }}
                            title={`View all ${c.videoCount.toLocaleString()} videos`}
                            className="w-8 h-8 rounded-full bg-black/60 hover:bg-blue-500/30 flex items-center justify-center text-white/80 hover:text-white transition flex-shrink-0"
                          >
                            {/* Grid icon — matches the "video grid" intent */}
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 10h16M4 14h16M4 18h16" />
                            </svg>
                          </button>
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); onClusterCardClick(c); }}
                            title={
                              c.childrenCount > 0
                                ? `Drill into ${c.childrenCount} sub-niches`
                                : c.subdivideStatus === 'running' || isCurrentlyBaking
                                  ? 'Subdividing in progress — click to watch'
                                  : c.videoCount < 50
                                    ? 'Too few videos to subdivide'
                                    : 'Subdivide into sub-niches'
                            }
                            className="w-8 h-8 rounded-full bg-black/60 hover:bg-amber-500/30 flex items-center justify-center text-white/80 hover:text-white transition flex-shrink-0"
                          >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" />
                            </svg>
                          </button>
                        </div>
                      </div>

                      {/* 4-tile stats row, mirrors the Nexlev metrics bar */}
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 px-4 mb-3">
                        <div className="bg-[#0a0a0a] border border-[#1f1f1f] rounded-lg px-3 py-2">
                          <div className="text-[10px] text-[#666] uppercase tracking-wider">Avg views per video</div>
                          <div className="text-base font-semibold text-white mt-0.5">
                            {c.avgViews != null ? fmtK(c.avgViews) : '—'}
                          </div>
                        </div>
                        <div className="bg-[#0a0a0a] border border-[#1f1f1f] rounded-lg px-3 py-2">
                          <div className="text-[10px] text-[#666] uppercase tracking-wider">Top channels</div>
                          <div className="text-base font-semibold text-white mt-0.5">
                            {c.topChannels.length || '—'}
                          </div>
                        </div>
                        <div className="bg-[#0a0a0a] border border-[#1f1f1f] rounded-lg px-3 py-2">
                          <div className="text-[10px] text-[#666] uppercase tracking-wider">Total views</div>
                          <div className="text-base font-semibold text-green-400 mt-0.5">
                            {c.totalViews != null ? fmtK(c.totalViews) : '—'}
                          </div>
                        </div>
                        <div className="bg-[#0a0a0a] border border-[#1f1f1f] rounded-lg px-3 py-2">
                          <div className="text-[10px] text-[#666] uppercase tracking-wider">Videos</div>
                          <div className="text-base font-semibold text-white mt-0.5">
                            {c.videoCount.toLocaleString()}
                          </div>
                        </div>
                      </div>

                      {/* Popular Videos strip — the headline change vs
                          the old single-thumb card. 4 thumbs side-by-side
                          give the niche's visual signature. */}
                      <div className="px-4 pb-4">
                        <div className="flex items-center justify-between mb-2">
                          <h4 className="text-[11px] text-[#666] uppercase tracking-wider">Most representative videos</h4>
                          {c.popularVideos.length > 0 && (
                            <span className="text-[10px] text-[#666]" title="Closest to cluster centroid, deduped to one per channel.">
                              closest to centroid · 1 per channel
                            </span>
                          )}
                        </div>
                        {/* 4-tile compact strip — overview density. On hover
                            each tile scales up so the title + thumbnail
                            become legible without sacrificing the at-a-glance
                            grid layout. transformOrigin per index so edge
                            tiles expand inward (1st → right, 4th → left)
                            instead of clipping past the row's edge. The
                            parent grid drops gap-2 in favour of a slightly
                            looser gap-3 to make hover bumps feel less crowded. */}
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                          {slots.map((v, i) => {
                            const origin =
                              i === 0 ? 'left center'  :
                              i === 3 ? 'right center' :
                                        'center';
                            return v ? (
                              <a
                                key={v.videoId}
                                href={v.url || '#'}
                                target="_blank"
                                rel="noreferrer"
                                onClick={(e) => e.stopPropagation()}
                                className="block group/thumb relative transition-transform duration-200 ease-out hover:scale-[1.45] hover:z-20 hover:shadow-2xl"
                                style={{ transformOrigin: origin }}
                              >
                                <div className="relative aspect-video bg-[#0a0a0a] rounded-md overflow-hidden border border-[#1f1f1f] group-hover/thumb:border-[#444] transition">
                                  {v.thumbnail ? (
                                    // eslint-disable-next-line @next/next/no-img-element
                                    <img src={v.thumbnail} alt="" className="w-full h-full object-cover" loading="lazy" />
                                  ) : (
                                    <div className="w-full h-full flex items-center justify-center text-[#333] text-[10px]">no thumb</div>
                                  )}
                                </div>
                                <div className="mt-1.5 text-[11px] text-white line-clamp-2 leading-tight" title={v.title || ''}>
                                  {v.title || '(no title)'}
                                </div>
                                <div className="mt-0.5 text-[10px] text-[#666] flex items-center gap-1.5">
                                  {v.viewCount != null && (
                                    <span className="text-green-400/90">{fmtK(v.viewCount)} views</span>
                                  )}
                                  {v.channelName && <span className="truncate">· {v.channelName}</span>}
                                </div>
                              </a>
                            ) : (
                              <div key={`empty-${i}`} className="aspect-video bg-[#0a0a0a] border border-dashed border-[#1f1f1f] rounded-md flex items-center justify-center text-[#333] text-[10px]">
                                —
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
              );
            })()}
            {treeVideosClusterId == null && treeViewedClusterId == null && treeData.run?.status === 'done' && treeData.clusters.length === 0 && (
              <div className="bg-[#141414] border border-[#1f1f1f] rounded-xl p-8 text-center text-sm text-[#888]">
                Run completed but no clusters were produced. Try lowering <code className="text-amber-400">min_cluster_size</code> or switching embedding source.
              </div>
            )}

            {/* Loading skeleton on first fetch */}
            {treeLoading && !treeData.run && (
              <div className="bg-[#141414] border border-[#1f1f1f] rounded-xl p-8 text-center text-sm text-[#666]">
                Loading…
              </div>
            )}
          </div>
        </div>

        {/* Cluster Lifecycle Tab — reads niche_cluster_events written by
            the L1 + L2 stitchers. Per-run diff: what was born, died,
            grew, shrank, split, merged between the previous global run
            and this one. Hits /api/admin/niche-tree/agent/diff. */}
        <div style={{ display: adminSection === 'lifecycle' ? 'block' : 'none' }}>
          <ClusterLifecycleTab active={adminSection === 'lifecycle'} />
        </div>

        {/* Video Seed Tab — live feed of niche_seed_expansions written
            by the new /api/niche-spy/video-seed/expand endpoint (which
            xgodo agents call instead of the keyword + Gemini scoring
            path). Polls /api/admin/niche-spy/seed-feed every 3s. */}
        <div style={{ display: adminSection === 'seed' ? 'block' : 'none' }}>
          <VideoSeedTab active={adminSection === 'seed'} />
        </div>

        {/* Docs Tab — renders markdown files from /docs in the repo.
            Reads via /api/admin/docs. Same admin styling as the other
            tabs; sidebar lists docs, main area renders the selected one. */}
        <div style={{ display: adminSection === 'docs' ? 'block' : 'none' }}>
          <DocsTab active={adminSection === 'docs'} />
        </div>

        {/* Tools Tab — admin one-off operations. First tool: AI Studio
            key import from xgodo. */}
        <div style={{ display: adminSection === 'tools' ? 'block' : 'none' }}>
          <ToolsTab active={adminSection === 'tools'} />
        </div>

        {/* Vid Gen Tab — manages the video_prompts queue + AI bulk
            generation. GET /api/video_prompt pops one for clients;
            this tab is the operator surface that fills the queue. */}
        <div style={{ display: adminSection === 'vid-gen' ? 'block' : 'none' }}>
          <VidGenTab active={adminSection === 'vid-gen'} />
        </div>

        {/* Content Gen — discovery picker for the listicle generator.
            Wires /api/admin/content-gen/{overwatch,discover,explain-channel}
            into a niche browser + channel explorer. See
            docs/content-gen/*.md for the spec stack. */}
        <div style={{ display: adminSection === 'content-gen' ? 'block' : 'none' }}>
          <ContentGenTab active={adminSection === 'content-gen'} />
        </div>

        {/* Image Gen — submit prompts to xgodo's image-gen flow, overwatch
            the queue, download the temp urls. The on-demand icon/asset
            factory for content-gen. */}
        <div style={{ display: adminSection === 'imagegen' ? 'block' : 'none' }}>
          <ImageGenTab active={adminSection === 'imagegen'} />
        </div>

        {/* Audio Gen — the voice + SFX + audio-bed pipeline. SFX vocabulary,
            voice library, and group-bed composer in one place. */}
        <div style={{ display: adminSection === 'audiogen' ? 'block' : 'none' }}>
          <AudioGenTab active={adminSection === 'audiogen'} />
        </div>

        {/* Screen Capture — Playwright + xgodo proxies. Capture real YT
            channel pages / about / videos / watch for the proof-side visuals,
            cached per (channel, kind, day). Live overwatch + gallery. */}
        <div style={{ display: adminSection === 'screencap' ? 'block' : 'none' }}>
          <ScreenCaptureTab active={adminSection === 'screencap'} />
        </div>

        {/* Producer — orchestrator that takes a ConcreteScript (from
            script-writer) and drives every gem tool call to render the
            final mp4. Timeline view: slots × gems with status pills,
            elapsed_ms, output urls, final video player. */}
        <div style={{ display: adminSection === 'producer' ? 'block' : 'none' }}>
          <ProducerTab active={adminSection === 'producer'} />
        </div>

        {/* Embedding requests — custom-niche owners file these when
            they want to cluster by an embedding source (title_v2 /
            thumbnail_v2 / combined_v2) that isn't computed for enough
            videos in their niche yet. Admin processes them out-of-
            band and flips the status. */}
        <div style={{ display: adminSection === 'embed-reqs' ? 'block' : 'none' }}>
          <EmbedReqsTab active={adminSection === 'embed-reqs'} />
        </div>

        {/* Analyze Vids — full per-video timeline generator. Each row
            in a niche becomes one job: yt-dlp download → ffmpeg split
            into ~60s clips → Gemini 2.5 Flash per clip (via our keys
            + proxy pool, no papaiapi) → collapse into a single
            per-video timeline JSON. */}
        <div style={{ display: adminSection === 'analyze-vids' ? 'block' : 'none' }}>
          <AnalyzeVidsTab active={adminSection === 'analyze-vids'} />
        </div>

        {/* XG vid download — bridges two xgodo jobs:
              review_job_id   (workers post videoUrl + remote_device_id)
              download_job_id (workers click labs.google download,
                               upload mp4 to xgodo.com/server/temp/)
            then we pull the mp4 to the Railway volume and mark both
            tasks confirmed. */}
        <div style={{ display: adminSection === 'xg-vid-dl' ? 'block' : 'none' }}>
          <XgVidDownloadTab active={adminSection === 'xg-vid-dl'} />
        </div>
      </div>
    </div>
  );
}

// Admin-local fmt helper for compact K/M view counts. Kept inline because
// there's only one use site — the novelty grid cards.
function fmtK(n: number | null | undefined): string {
  if (n == null) return '0';
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000)     return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)         return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/**
 * Compact "how long ago" formatter for ISO strings — used by the Uploads
 * + Devices reporting tables so the operator can see freshness at a
 * glance without parsing absolute timestamps. Returns "—" for null,
 * "now" for <30s, then "Nm" / "Nh Mm" / "Nd Nh".
 *
 * Pair with `title={new Date(iso).toLocaleString()}` on the cell so the
 * absolute timestamp is one hover away.
 */
function fmtAgo(iso: string | null | undefined): string {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  const sec = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (sec < 30)    return 'now';
  if (sec < 60)    return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60)    return `${min}m ago`;
  const hr  = Math.floor(min / 60);
  const mr  = min % 60;
  if (hr < 24)     return mr === 0 ? `${hr}h ago` : `${hr}h ${mr}m ago`;
  const day = Math.floor(hr / 24);
  const hRem = hr % 24;
  if (day < 7)     return hRem === 0 ? `${day}d ago` : `${day}d ${hRem}h ago`;
  // > 7d: just show the date so the column doesn't widen unboundedly
  return new Date(iso).toLocaleDateString();
}

interface DeployConfig {
  keyword: string; threads: number; apiKey: string; loopNumber: number;
  maxSearchResults: number; maxSuggestedResults: number; rofeAPIKey: string;
  // Seed mode (video-URL niche discovery)
  mode: 'keyword' | 'seed';
  seedUrl: string;
  nicheLabel: string;   // human name for a freshly-minted niche
  nicheId: string;      // set when adding seeds to an existing niche
}

// ────────────────────────────────────────────────────────────────
// Cluster Lifecycle Tab — reads /api/admin/niche-tree/agent/diff,
// renders born / died / grew / shrank / split / merged events for a
// given run as filterable cards. Powered by niche_cluster_events
// rows written by the L1 + L2 stitchers.
// ────────────────────────────────────────────────────────────────

interface LifecycleEvent {
  event: 'born' | 'died' | 'grew' | 'shrank' | 'same' | 'split' | 'merged';
  stable_id: string;
  parent_stable_id: string | null;
  size_before: number | null;
  size_after: number | null;
  delta: number | null;
  jaccard: number | null;
  label: string | null;
  auto_label: string | null;
  ai_label?: string | null;
  video_count: number | null;
  cluster_id: number | null;
  payload: Record<string, unknown> | null;
}

const EVENT_COLORS: Record<LifecycleEvent['event'], { bg: string; text: string; border: string; emoji: string }> = {
  born:   { bg: 'bg-green-500/10',   text: 'text-green-400',   border: 'border-green-500/30',   emoji: '✨' },
  grew:   { bg: 'bg-blue-500/10',    text: 'text-blue-400',    border: 'border-blue-500/30',    emoji: '↑' },
  shrank: { bg: 'bg-orange-500/10',  text: 'text-orange-400',  border: 'border-orange-500/30',  emoji: '↓' },
  same:   { bg: 'bg-gray-500/10',    text: 'text-gray-400',    border: 'border-gray-500/30',    emoji: '=' },
  split:  { bg: 'bg-purple-500/10',  text: 'text-purple-400',  border: 'border-purple-500/30',  emoji: '⤴' },
  merged: { bg: 'bg-cyan-500/10',    text: 'text-cyan-400',    border: 'border-cyan-500/30',    emoji: '⤵' },
  died:   { bg: 'bg-red-500/10',     text: 'text-red-400',     border: 'border-red-500/30',     emoji: '✕' },
};

interface ClusterCoverage {
  total: number;
  embedded: number;
  unembedded: number;
  latestRun: { id: number; source: string; status: string; startedAt: string | null; completedAt: string | null } | null;
  inLatestRun: { total: number; assigned: number; noise: number };
  newSinceLatestRun: number;
  coveragePct: number;
}

function ClusterLifecycleTab({ active }: { active: boolean }) {
  const [runId, setRunId] = useState<number | null>(null);
  const [runInput, setRunInput] = useState<string>('');     // text input override for runId
  const [prevRunId, setPrevRunId] = useState<number | null>(null);
  const [events, setEvents] = useState<LifecycleEvent[]>([]);
  const [totals, setTotals] = useState<Partial<Record<LifecycleEvent['event'], number>>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | LifecycleEvent['event']>('all');
  const [level, setLevel] = useState<'all' | 1 | 2>('all');
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState<'abs_delta' | 'size_after' | 'size_before' | 'jaccard'>('abs_delta');
  const [coverage, setCoverage] = useState<ClusterCoverage | null>(null);

  // Coverage — pulled once when the tab opens. Refresh on demand via
  // the Refresh button; this is also the input for "should we re-cluster?"
  // so we don't poll it.
  useEffect(() => {
    if (!active) return;
    let cancel = false;
    (async () => {
      try {
        const r = await fetch('/api/admin/niche-tree/coverage');
        if (!r.ok) return;
        const d = await r.json() as ClusterCoverage;
        if (!cancel) setCoverage(d);
      } catch { /* swallow — coverage card is best-effort */ }
    })();
    return () => { cancel = true; };
  }, [active]);

  const fetchDiff = useCallback(async (id?: number) => {
    setLoading(true);
    setError(null);
    try {
      const qs = id ? `?runId=${id}` : '';
      const r = await fetch(`/api/admin/niche-tree/agent/diff${qs}`);
      const d = await r.json();
      if (!r.ok || d.error) throw new Error(d.error || `HTTP ${r.status}`);
      setRunId(d.runId);
      setPrevRunId(d.prevRunId);
      setEvents(d.events || []);
      setTotals(d.totals || {});
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (active && runId == null) fetchDiff();
  }, [active, runId, fetchDiff]);

  // Derive an event's level from the cluster_id row (via payload or
  // parent_stable_id presence). Simpler: split / merged events have
  // parent_stable_id set when L1; L2 events also have parent_stable_id
  // (the L1 they live under). Use the payload's prev_cluster_index path
  // when present.
  // Pragmatic shortcut — backend always writes level=1 or level=2 on
  // niche_cluster_events but the /diff endpoint doesn't surface it.
  // For now we apply the level filter via the `payload.level` field if
  // present, else show everything.
  const filteredEvents = useMemo(() => {
    let arr = events;
    if (filter !== 'all') arr = arr.filter(e => e.event === filter);
    if (level !== 'all') {
      arr = arr.filter(e => {
        const lvl = (e.payload?.level as number | undefined) ?? null;
        // Fallback: parent_stable_id presence on an L2-only event row.
        if (lvl != null) return lvl === level;
        return true;
      });
    }
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      arr = arr.filter(e =>
        (e.label || '').toLowerCase().includes(q) ||
        (e.auto_label || '').toLowerCase().includes(q) ||
        (e.ai_label || '').toLowerCase().includes(q) ||
        e.stable_id.toLowerCase().includes(q),
      );
    }
    const sortKey = sortBy;
    return [...arr].sort((a, b) => {
      const av = sortKey === 'abs_delta' ? Math.abs(a.delta ?? 0)
        : sortKey === 'jaccard' ? (a.jaccard ?? 0)
        : sortKey === 'size_before' ? (a.size_before ?? 0)
        : (a.size_after ?? 0);
      const bv = sortKey === 'abs_delta' ? Math.abs(b.delta ?? 0)
        : sortKey === 'jaccard' ? (b.jaccard ?? 0)
        : sortKey === 'size_before' ? (b.size_before ?? 0)
        : (b.size_after ?? 0);
      return bv - av;
    });
  }, [events, filter, level, search, sortBy]);

  const grandTotal = Object.values(totals).reduce((a, b) => a + (b || 0), 0);

  return (
    <div className="space-y-6">
      {/* Coverage — "how much of the embedded corpus is in the latest run?"
          Surfaces the newSinceLatestRun delta so the operator knows when
          a re-cluster is worth kicking off. */}
      {coverage && (
        <div className="bg-[#141414] border border-[#1f1f1f] rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-[#1f1f1f] flex items-center justify-between gap-3 flex-wrap">
            <div>
              <div className="text-sm font-semibold text-white">Clustering coverage</div>
              <div className="text-[11px] text-[#888] mt-0.5">
                {coverage.latestRun ? (
                  <>Latest L1 run <span className="text-white font-medium">#{coverage.latestRun.id}</span> ({coverage.latestRun.source})
                    {' · '}<span className={
                      coverage.latestRun.status === 'done' ? 'text-emerald-400' :
                      coverage.latestRun.status === 'running' ? 'text-yellow-400' :
                                                                'text-red-400'}>{coverage.latestRun.status}</span>
                    {coverage.latestRun.completedAt && <> · finished {new Date(coverage.latestRun.completedAt).toLocaleString()}</>}
                  </>
                ) : 'No global L1 run yet.'}
              </div>
            </div>
            <div className="text-xs text-[#888]">
              Coverage <span className="text-white font-semibold ml-1">{coverage.coveragePct.toFixed(1)}%</span>
            </div>
          </div>
          <div className="px-4 py-3 grid grid-cols-2 md:grid-cols-7 gap-2">
            {[
              { label: 'Total videos',       value: coverage.total,              color: 'text-white' },
              { label: 'Embedded',           value: coverage.embedded,           color: 'text-white' },
              { label: 'Unembedded',         value: coverage.unembedded,         color: coverage.unembedded > 0 ? 'text-orange-400' : 'text-[#666]' },
              { label: 'In latest run',      value: coverage.inLatestRun.total,  color: 'text-white' },
              { label: '→ assigned',         value: coverage.inLatestRun.assigned, color: 'text-emerald-400' },
              { label: '→ noise',            value: coverage.inLatestRun.noise,  color: 'text-[#888]' },
              { label: 'New (unclustered)',  value: coverage.newSinceLatestRun,  color: coverage.newSinceLatestRun > 0 ? 'text-fuchsia-400' : 'text-[#666]' },
            ].map(s => (
              <div key={s.label} className="bg-[#0a0a0a] border border-[#1a1a1a] rounded-lg p-2 text-center">
                <div className={`text-lg font-bold ${s.color}`}>{s.value.toLocaleString()}</div>
                <div className="text-[10px] text-[#666] uppercase tracking-wider">{s.label}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-bold text-white">Cluster Lifecycle</h1>
          <p className="text-[#888] text-xs mt-1 max-w-2xl">
            Per-run diff of cluster lifecycle events (born / died / grew / shrank / split / merged) computed by the
            stitcher when a new global clustering run lands. Powered by
            <code className="text-fuchsia-400 text-[11px] mx-1">niche_cluster_events</code>.
            {runId != null && (
              <> Showing run <span className="text-white font-medium">{runId}</span>
                {prevRunId != null && (
                  <> vs predecessor <span className="text-white font-medium">{prevRunId}</span></>
                )}
                .
              </>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <input
            type="number"
            placeholder="Run ID"
            value={runInput}
            onChange={e => setRunInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                const v = parseInt(runInput);
                if (Number.isFinite(v)) fetchDiff(v);
              }
            }}
            className="w-24 px-2 h-8 bg-[#141414] border border-[#1f1f1f] text-white text-xs rounded focus:outline-none focus:border-fuchsia-500"
          />
          <button
            onClick={() => {
              const v = parseInt(runInput);
              if (Number.isFinite(v)) fetchDiff(v);
              else fetchDiff();
            }}
            disabled={loading}
            className="px-3 h-8 bg-fuchsia-500/15 hover:bg-fuchsia-500/25 text-fuchsia-400 border border-fuchsia-500/30 text-xs font-medium rounded transition disabled:opacity-50"
          >
            {loading ? 'Loading…' : runInput ? 'Load' : 'Latest'}
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-4 text-sm text-red-400">
          {error}
        </div>
      )}

      {/* Summary tiles */}
      {runId != null && grandTotal > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-2">
          {(['born', 'grew', 'shrank', 'same', 'split', 'merged', 'died'] as const).map(ev => {
            const c = EVENT_COLORS[ev];
            const count = totals[ev] || 0;
            const isActive = filter === ev;
            return (
              <button
                key={ev}
                onClick={() => setFilter(isActive ? 'all' : ev)}
                className={`text-center rounded-xl p-3 border transition ${
                  isActive ? `${c.bg} ${c.border}` : `bg-[#141414] border-[#1f1f1f] hover:border-[#2a2a2a]`
                }`}
              >
                <div className={`text-lg font-bold ${count === 0 ? 'text-[#444]' : c.text}`}>
                  {c.emoji} {count.toLocaleString()}
                </div>
                <div className="text-[10px] text-[#888] uppercase tracking-wider">{ev}</div>
              </button>
            );
          })}
        </div>
      )}

      {/* Filter row */}
      {runId != null && (
        <div className="bg-[#141414] border border-[#1f1f1f] rounded-xl p-3 flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] uppercase tracking-wider text-[#666]">Filter:</span>
            <button
              onClick={() => setFilter('all')}
              className={`px-3 py-1 rounded-full text-xs transition ${
                filter === 'all' ? 'bg-white text-black font-medium' : 'text-[#888] border border-[#333] hover:border-[#555]'
              }`}
            >
              All ({grandTotal.toLocaleString()})
            </button>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] uppercase tracking-wider text-[#666]">Level:</span>
            {(['all', 1, 2] as const).map(l => (
              <button
                key={l}
                onClick={() => setLevel(l)}
                className={`px-2 py-1 rounded-full text-xs transition ${
                  level === l ? 'bg-white text-black font-medium' : 'text-[#888] border border-[#333] hover:border-[#555]'
                }`}
              >
                {l === 'all' ? 'Both' : `L${l}`}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] uppercase tracking-wider text-[#666]">Sort:</span>
            <select
              value={sortBy}
              onChange={e => setSortBy(e.target.value as typeof sortBy)}
              className="bg-[#0a0a0a] border border-[#1f1f1f] text-white text-xs rounded px-2 py-1 focus:outline-none focus:border-fuchsia-500"
            >
              <option value="abs_delta">Biggest change</option>
              <option value="size_after">Size after</option>
              <option value="size_before">Size before</option>
              <option value="jaccard">Strongest match (jaccard)</option>
            </select>
          </div>
          <input
            type="text"
            placeholder="Search label / stable_id"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="flex-1 min-w-[200px] px-3 h-8 bg-[#0a0a0a] border border-[#1f1f1f] text-white text-xs rounded focus:outline-none focus:border-fuchsia-500"
          />
          <span className="text-xs text-[#666]">
            {filteredEvents.length.toLocaleString()} match{filteredEvents.length === 1 ? '' : 'es'}
          </span>
        </div>
      )}

      {/* Event cards */}
      {runId != null && filteredEvents.length === 0 && !loading && (
        <div className="bg-[#141414] border border-[#1f1f1f] rounded-xl p-8 text-center text-sm text-[#666]">
          No events match the current filters.
        </div>
      )}

      {filteredEvents.length > 0 && (
        <div className="space-y-2">
          {filteredEvents.slice(0, 500).map(e => {
            const c = EVENT_COLORS[e.event];
            const label = e.label || e.ai_label || e.auto_label || '(no label)';
            const matchMetric = e.payload?.match_metric as string | undefined;
            return (
              <div
                key={`${e.stable_id}-${e.event}`}
                className={`bg-[#141414] border border-[#1f1f1f] rounded-xl p-3 flex items-center gap-3 hover:border-[#2a2a2a] transition`}
              >
                <div className={`flex-shrink-0 w-16 text-center rounded-md py-1 ${c.bg} ${c.text} ${c.border} border text-xs font-medium uppercase tracking-wider`}>
                  {c.emoji} {e.event}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    {e.cluster_id ? (
                      <a
                        href={`/niche/cluster/${e.cluster_id}`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-sm text-white font-medium truncate hover:text-fuchsia-400 transition"
                      >
                        {label}
                      </a>
                    ) : (
                      <span className="text-sm text-white font-medium truncate">{label}</span>
                    )}
                    <code className="text-[10px] text-[#555] font-mono">{e.stable_id.slice(0, 14)}</code>
                    {e.parent_stable_id && (
                      <span className="text-[10px] text-[#555]">
                        ← <code className="font-mono">{e.parent_stable_id.slice(0, 14)}</code>
                      </span>
                    )}
                  </div>
                  {(e.size_before != null || e.size_after != null) && (
                    <div className="text-xs text-[#888] mt-0.5">
                      {e.size_before != null && <span>{e.size_before.toLocaleString()}</span>}
                      {e.size_before != null && e.size_after != null && <span> → </span>}
                      {e.size_after != null && <span>{e.size_after.toLocaleString()}</span>}
                      {e.delta != null && e.delta !== 0 && (
                        <span className={`ml-1 ${e.delta > 0 ? 'text-green-400' : 'text-orange-400'}`}>
                          ({e.delta > 0 ? '+' : ''}{e.delta.toLocaleString()})
                        </span>
                      )}
                      {e.jaccard != null && (
                        <span className="ml-2 text-[#666]">
                          · jaccard {(e.jaccard * 100).toFixed(0)}%
                          {matchMetric && matchMetric !== 'jaccard' && (
                            <span className="text-fuchsia-400/80"> (via {matchMetric})</span>
                          )}
                        </span>
                      )}
                    </div>
                  )}
                </div>
                {e.video_count != null && (
                  <div className="flex-shrink-0 text-[10px] text-[#666] tabular-nums">
                    {e.video_count.toLocaleString()} vids
                  </div>
                )}
              </div>
            );
          })}
          {filteredEvents.length > 500 && (
            <div className="text-center text-xs text-[#666] py-3">
              Showing top 500 of {filteredEvents.length.toLocaleString()} — refine filters to see more.
            </div>
          )}
        </div>
      )}

      {loading && events.length === 0 && (
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="bg-[#141414] border border-[#1f1f1f] rounded-xl h-14 animate-pulse" />
          ))}
        </div>
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────
// Tools Tab — admin one-off operations grouped into cards.
//
// First tool: AI Studio Keys Import. Pulls fresh Google AI Studio
// keys from an xgodo job's pending tasks, tests each via residential
// proxy, persists the good ones, and confirms / declines the xgodo
// task accordingly.
// ────────────────────────────────────────────────────────────────

interface KeyImportEvent {
  taskId: string;
  workerName: string | null;
  deviceName: string | null;
  finishedAt: string | null;
  key: string | null;
  result: 'valid' | 'invalid' | 'no_key' | 'duplicate' | 'error';
  reason: string | null;
  latencyMs: number | null;
  proxyUsed: string | null;
  action: 'confirmed' | 'declined' | 'skipped' | null;
  insertedId: number | null;
  detectedAt: string;
}

interface KeyImportState {
  running: boolean;
  jobKey: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  lastError: string | null;
  counts: {
    total: number; processed: number; valid: number; invalid: number;
    duplicate: number; noKey: number; errors: number;
  };
  events: KeyImportEvent[];
  defaultJobId: string;
}

const RESULT_STYLES: Record<KeyImportEvent['result'], { label: string; bg: string; text: string }> = {
  valid:     { label: 'VALID',     bg: 'bg-emerald-500/15', text: 'text-emerald-400' },
  duplicate: { label: 'DUP',       bg: 'bg-blue-500/15',    text: 'text-blue-400' },
  invalid:   { label: 'INVALID',   bg: 'bg-red-500/15',     text: 'text-red-400' },
  no_key:    { label: 'NO KEY',    bg: 'bg-orange-500/15',  text: 'text-orange-400' },
  error:     { label: 'ERROR',     bg: 'bg-yellow-500/15',  text: 'text-yellow-400' },
};

type ToolsSection =
  | 'import-ai-keys'
  | 'download-ai-keys'
  | 'import-yt-keys'
  | 'download-yt-keys';

type ToolsGroup = 'AI Studio keys' | 'YouTube Data keys';

const TOOLS_SECTIONS: Array<{ key: ToolsSection; label: string; group: ToolsGroup }> = [
  { key: 'import-ai-keys',    label: 'Import from xgodo',   group: 'AI Studio keys' },
  { key: 'download-ai-keys',  label: 'Download inventory',  group: 'AI Studio keys' },
  { key: 'import-yt-keys',    label: 'Import from xgodo',   group: 'YouTube Data keys' },
  { key: 'download-yt-keys',  label: 'Download inventory',  group: 'YouTube Data keys' },
];

interface KeyServiceConfig {
  /** Path to the import controller (GET state, POST start). */
  apiPath: string;
  /** Path to the export endpoint (GET ?format=...&status=...). */
  exportPath: string;
  /** Display name for the service (e.g. 'Google AI Studio'). */
  displayName: string;
  /** Short name for the inventory ("Google AI Studio key inventory"). */
  inventoryLabel: string;
  /** Value of xgodo_api_keys.service for this kind of key. */
  serviceColumn: string;
  /** Host shown in the import card's blurb. */
  validationHost: string;
  /** Default xgodo job id placeholder. */
  defaultJobIdPlaceholder: string;
}

const AI_STUDIO_KEYS_CFG: KeyServiceConfig = {
  apiPath: '/api/admin/tools/ai-studio-keys',
  exportPath: '/api/admin/tools/ai-studio-keys/export',
  displayName: 'Google AI Studio',
  inventoryLabel: 'Google AI Studio key inventory',
  serviceColumn: 'google_ai_studio',
  validationHost: 'generativelanguage.googleapis.com',
  defaultJobIdPlaceholder: '69f499d56730e5906b1eb576',
};

const YT_DATA_KEYS_CFG: KeyServiceConfig = {
  apiPath: '/api/admin/tools/yt-data-keys',
  exportPath: '/api/admin/tools/yt-data-keys/export',
  displayName: 'YouTube Data API',
  inventoryLabel: 'YouTube Data API key inventory',
  serviceColumn: 'youtube_data',
  validationHost: 'www.googleapis.com/youtube/v3',
  defaultJobIdPlaceholder: '69f49af26730e5906b239f36',
};

function ToolsTab({ active }: { active: boolean }) {
  const [section, setSection] = useState<ToolsSection>('import-ai-keys');

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold text-white">Tools</h1>
        <p className="text-[#888] text-xs mt-1 max-w-2xl">
          One-off admin operations. Sections grouped by purpose; each section is self-contained.
        </p>
      </div>

      {/* Section selector — grouped pills */}
      <div className="bg-[#141414] border border-[#1f1f1f] rounded-xl p-3">
        {Array.from(new Set(TOOLS_SECTIONS.map(s => s.group))).map(group => (
          <div key={group} className="flex items-center gap-2 flex-wrap [&+&]:mt-2">
            <span className="text-[10px] uppercase tracking-wider text-[#666] mr-1">{group}:</span>
            {TOOLS_SECTIONS.filter(s => s.group === group).map(s => (
              <button
                key={s.key}
                onClick={() => setSection(s.key)}
                className={`px-3 py-1.5 rounded-full text-xs transition ${
                  section === s.key
                    ? 'bg-yellow-500 text-black font-medium'
                    : 'text-[#888] border border-[#333] hover:border-[#555]'
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>
        ))}
      </div>

      {section === 'import-ai-keys'    && <KeyImportCard   active={active} cfg={AI_STUDIO_KEYS_CFG} />}
      {section === 'download-ai-keys'  && <KeyDownloadCard active={active} cfg={AI_STUDIO_KEYS_CFG} />}
      {section === 'import-yt-keys'    && <KeyImportCard   active={active} cfg={YT_DATA_KEYS_CFG}    />}
      {section === 'download-yt-keys'  && <KeyDownloadCard active={active} cfg={YT_DATA_KEYS_CFG}    />}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────
// Download inventory — exports all google_ai_studio keys via
// /api/admin/tools/ai-studio-keys/export. Status / source / format
// configurable. Browser receives a Content-Disposition: attachment.
// ────────────────────────────────────────────────────────────────

interface KeyInventory {
  bySource: Array<{ source: string; status: string; count: number }>;
  total: number;
}

function KeyDownloadCard({ active, cfg }: { active: boolean; cfg: KeyServiceConfig }) {
  const [format, setFormat] = useState<'txt' | 'csv' | 'json'>('txt');
  const [status, setStatus] = useState<'active' | 'invalid' | 'banned' | 'all'>('active');
  const [source, setSource] = useState<string>('');
  const [inv, setInv] = useState<KeyInventory | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Show counts in the UI by sniffing the export endpoint with
  // format=json&status=all and counting on the client. Railway pg
  // returns the rows fast enough that doing this on every section
  // open is fine.
  useEffect(() => {
    if (!active) return;
    let cancel = false;
    (async () => {
      try {
        const r = await fetch(`${cfg.exportPath}?format=json&status=all`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const d = await r.json() as { keys: Array<{ source: string; status: string }> };
        if (cancel) return;
        const counts = new Map<string, number>();
        for (const k of d.keys) {
          const key = `${k.source}|${k.status}`;
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
        const bySource = Array.from(counts.entries()).map(([k, count]) => {
          const [src, st] = k.split('|');
          return { source: src, status: st, count };
        }).sort((a, b) => b.count - a.count);
        setInv({ bySource, total: d.keys.length });
        setError(null);
      } catch (err) {
        if (!cancel) setError((err as Error).message);
      }
    })();
    return () => { cancel = true; };
  }, [active, cfg.exportPath]);

  const matching = useMemo(() => {
    if (!inv) return null;
    let rows = inv.bySource;
    if (status !== 'all') rows = rows.filter(r => r.status === status);
    if (source.trim()) rows = rows.filter(r => r.source === source.trim());
    return rows.reduce((s, r) => s + r.count, 0);
  }, [inv, status, source]);

  const download = () => {
    const sp = new URLSearchParams({ format, status });
    if (source.trim()) sp.set('source', source.trim());
    // Open in same tab — browser handles Content-Disposition: attachment.
    window.location.href = `${cfg.exportPath}?${sp.toString()}`;
  };

  return (
    <div className="bg-[#141414] border border-[#1f1f1f] rounded-xl overflow-hidden">
      <div className="px-4 py-3 border-b border-[#1f1f1f]">
        <div className="text-sm font-semibold text-white">Download {cfg.inventoryLabel}</div>
        <div className="text-[11px] text-[#888] mt-0.5 max-w-3xl">
          Exports all keys from <code className="text-yellow-400 text-[10px] mx-1">xgodo_api_keys</code> where
          <code className="text-yellow-400 text-[10px] mx-1">service=&apos;{cfg.serviceColumn}&apos;</code>. Filter by
          status / source, pick format, browser downloads the file. <code className="text-yellow-400 text-[10px] mx-1">txt</code>
          gives one key per line for piping into other systems.
        </div>
      </div>

      {error && (
        <div className="px-4 py-2 border-b border-[#1f1f1f] bg-red-500/5 text-[11px] text-red-400">{error}</div>
      )}

      {/* Inventory breakdown */}
      {inv && (
        <div className="px-4 py-3 border-b border-[#1f1f1f]">
          <div className="text-[10px] uppercase tracking-wider text-[#666] mb-2">
            Inventory ({inv.total.toLocaleString()} total)
          </div>
          <div className="flex flex-wrap gap-2">
            {inv.bySource.map(r => (
              <div
                key={`${r.source}|${r.status}`}
                className={`bg-[#0a0a0a] border rounded-lg px-3 py-1.5 text-[11px] ${
                  r.status === 'active' ? 'border-emerald-500/30 text-emerald-400' :
                  r.status === 'invalid' ? 'border-red-500/30 text-red-400' :
                                           'border-[#333] text-[#888]'
                }`}
              >
                <span className="font-semibold text-white">{r.count.toLocaleString()}</span>{' '}
                <span className="text-[#888]">{r.source}</span> · {r.status}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Controls */}
      <div className="px-4 py-3 grid grid-cols-2 md:grid-cols-4 gap-3 items-end">
        <div>
          <label className="block text-[10px] uppercase tracking-wider text-[#666] mb-1">format</label>
          <select
            value={format} onChange={e => setFormat(e.target.value as typeof format)}
            className="w-full px-2 h-8 bg-[#0a0a0a] border border-[#1f1f1f] text-white text-xs rounded focus:outline-none focus:border-yellow-500"
          >
            <option value="txt">txt — one key per line</option>
            <option value="csv">csv — with metadata</option>
            <option value="json">json — full records</option>
          </select>
        </div>
        <div>
          <label className="block text-[10px] uppercase tracking-wider text-[#666] mb-1">status</label>
          <select
            value={status} onChange={e => setStatus(e.target.value as typeof status)}
            className="w-full px-2 h-8 bg-[#0a0a0a] border border-[#1f1f1f] text-white text-xs rounded focus:outline-none focus:border-yellow-500"
          >
            <option value="active">active</option>
            <option value="invalid">invalid</option>
            <option value="banned">banned</option>
            <option value="all">all</option>
          </select>
        </div>
        <div>
          <label className="block text-[10px] uppercase tracking-wider text-[#666] mb-1">source (optional)</label>
          <input
            type="text" placeholder="any (e.g. xgodo-import)"
            value={source} onChange={e => setSource(e.target.value)}
            className="w-full px-2 h-8 bg-[#0a0a0a] border border-[#1f1f1f] text-white text-xs rounded focus:outline-none focus:border-yellow-500"
          />
        </div>
        <button
          onClick={download}
          disabled={!matching}
          className="px-4 h-8 bg-yellow-500 hover:bg-yellow-400 disabled:bg-[#222] disabled:text-[#666] text-black text-xs font-semibold rounded transition whitespace-nowrap"
        >
          Download {matching != null ? `(${matching.toLocaleString()})` : ''}
        </button>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────
// Import card — pulls pending tasks from the xgodo key job for the
// configured service and reviews them. Used for both Google AI Studio
// keys and YouTube Data API keys, swapping endpoints / labels via the
// `cfg` prop.
// ────────────────────────────────────────────────────────────────

function KeyImportCard({ active, cfg }: { active: boolean; cfg: KeyServiceConfig }) {
  const [state, setState] = useState<KeyImportState | null>(null);
  const [jobId, setJobId] = useState<string>('');
  const [limit, setLimit] = useState<number>(50);
  const [concurrency, setConcurrency] = useState<number>(5);
  const [dryRun, setDryRun] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  // Reset transient UI state when the service changes — otherwise the
  // YT card would hydrate with the AI Studio job id / state.
  useEffect(() => {
    setState(null);
    setJobId('');
    setError(null);
  }, [cfg.apiPath]);

  const fetchState = useCallback(async () => {
    try {
      const r = await fetch(cfg.apiPath);
      const d = await r.json();
      if (!r.ok || d.error) throw new Error(d.error || `HTTP ${r.status}`);
      setState(d as KeyImportState);
      if (!jobId && d.defaultJobId) setJobId(d.defaultJobId);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [jobId, cfg.apiPath]);

  useEffect(() => { if (active) fetchState(); }, [active, fetchState]);

  // Poll every 2s while running OR while the tab is freshly opened.
  useEffect(() => {
    if (!active) return;
    const running = state?.running ?? false;
    const interval = running ? 2000 : 8000;
    const t = setInterval(fetchState, interval);
    return () => clearInterval(t);
  }, [active, state?.running, fetchState]);

  const start = async () => {
    if (!confirm(dryRun
      ? `Run a DRY RUN against xgodo job ${jobId || '<default>'} (no confirm/decline calls)?`
      : `Pull up to ${limit} pending tasks from xgodo job ${jobId || '<default>'} and review them?`
    )) return;
    setStarting(true);
    try {
      const r = await fetch(cfg.apiPath, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId: jobId || undefined, limit, concurrency, dryRun }),
      });
      const d = await r.json();
      if (!r.ok || d.error) throw new Error(d.error || `HTTP ${r.status}`);
      setError(null);
      await fetchState();
    } catch (err) {
      setError((err as Error).message);
    }
    setStarting(false);
  };

  const counts = state?.counts;

  return (
    <>
      {error && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-4 text-sm text-red-400">{error}</div>
      )}

      <div className="bg-[#141414] border border-[#1f1f1f] rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-[#1f1f1f] flex items-center justify-between gap-3 flex-wrap">
          <div>
            <div className="text-sm font-semibold text-white">Import {cfg.displayName} keys from xgodo</div>
            <div className="text-[11px] text-[#888] mt-0.5 max-w-3xl">
              Pulls tasks awaiting employer review from the xgodo {cfg.displayName} key job, tests each candidate against
              <code className="text-yellow-400 text-[10px] mx-1">{cfg.validationHost}</code>
              via a residential proxy, persists the good ones into
              <code className="text-yellow-400 text-[10px] mx-1">xgodo_api_keys</code>, and
              confirms / declines each task back to xgodo.
            </div>
          </div>
          <div className="flex items-center gap-2">
            {state?.running ? (
              <span className="inline-flex items-center gap-1.5 text-xs text-yellow-400">
                <span className="w-2 h-2 bg-yellow-400 rounded-full animate-pulse" />
                Running…
              </span>
            ) : state?.finishedAt ? (
              <span className="text-xs text-[#888]">Last run: {new Date(state.finishedAt).toLocaleString()}</span>
            ) : null}
          </div>
        </div>

        {/* Controls */}
        <div className="px-4 py-3 border-b border-[#1f1f1f] grid grid-cols-2 md:grid-cols-5 gap-3 items-end">
          <div>
            <label className="block text-[10px] uppercase tracking-wider text-[#666] mb-1">xgodo job id</label>
            <input
              type="text" value={jobId} onChange={e => setJobId(e.target.value)}
              placeholder={state?.defaultJobId || cfg.defaultJobIdPlaceholder}
              className="w-full px-2 h-8 bg-[#0a0a0a] border border-[#1f1f1f] text-white text-xs rounded font-mono focus:outline-none focus:border-yellow-500"
            />
          </div>
          <div>
            <label className="block text-[10px] uppercase tracking-wider text-[#666] mb-1">limit</label>
            <input
              type="number" min={1} max={500} value={limit} onChange={e => setLimit(parseInt(e.target.value) || 50)}
              className="w-full px-2 h-8 bg-[#0a0a0a] border border-[#1f1f1f] text-white text-xs rounded focus:outline-none focus:border-yellow-500"
            />
          </div>
          <div>
            <label className="block text-[10px] uppercase tracking-wider text-[#666] mb-1">parallel tests</label>
            <input
              type="number" min={1} max={20} value={concurrency} onChange={e => setConcurrency(parseInt(e.target.value) || 5)}
              className="w-full px-2 h-8 bg-[#0a0a0a] border border-[#1f1f1f] text-white text-xs rounded focus:outline-none focus:border-yellow-500"
            />
          </div>
          <label className="flex items-center gap-1.5 text-xs text-[#888] cursor-pointer mt-5 md:mt-0">
            <input type="checkbox" checked={dryRun} onChange={e => setDryRun(e.target.checked)} className="accent-yellow-500" />
            Dry run (skip xgodo review)
          </label>
          <button
            onClick={start}
            disabled={starting || (state?.running ?? false)}
            className="px-4 h-8 bg-yellow-500 hover:bg-yellow-400 disabled:bg-[#222] disabled:text-[#666] text-black text-xs font-semibold rounded transition whitespace-nowrap"
          >
            {state?.running ? 'Running…' : starting ? 'Starting…' : 'Run import'}
          </button>
        </div>

        {/* Summary tiles */}
        {counts && counts.total > 0 && (
          <div className="px-4 py-3 border-b border-[#1f1f1f] grid grid-cols-3 md:grid-cols-7 gap-2">
            {[
              { label: 'Total',     value: counts.total,     color: 'text-white' },
              { label: 'Processed', value: counts.processed, color: 'text-white' },
              { label: 'Valid',     value: counts.valid,     color: 'text-emerald-400' },
              { label: 'Duplicate', value: counts.duplicate, color: 'text-blue-400' },
              { label: 'Invalid',   value: counts.invalid,   color: 'text-red-400' },
              { label: 'No key',    value: counts.noKey,     color: 'text-orange-400' },
              { label: 'Errors',    value: counts.errors,    color: counts.errors > 0 ? 'text-yellow-400' : 'text-[#666]' },
            ].map(s => (
              <div key={s.label} className="bg-[#0a0a0a] border border-[#1a1a1a] rounded-lg p-2 text-center">
                <div className={`text-lg font-bold ${s.color}`}>{s.value.toLocaleString()}</div>
                <div className="text-[10px] text-[#666] uppercase tracking-wider">{s.label}</div>
              </div>
            ))}
          </div>
        )}

        {state?.lastError && (
          <div className="px-4 py-2 border-b border-[#1f1f1f] bg-red-500/5 text-[11px] text-red-400">
            Last error: {state.lastError}
          </div>
        )}

        {/* Events table */}
        {state && state.events.length === 0 ? (
          <div className="p-8 text-center text-sm text-[#666]">
            No events yet. Click <span className="text-yellow-400">Run import</span> to pull pending tasks from xgodo.
          </div>
        ) : state ? (
          <div className="overflow-x-auto">
            <div className="grid grid-cols-[140px_90px_180px_60px_70px_1fr_100px] gap-3 px-3 py-2 border-b border-[#1f1f1f] text-[10px] uppercase tracking-wider text-[#666]">
              <div>Time</div>
              <div>Result</div>
              <div>Key (masked)</div>
              <div className="text-right">Latency</div>
              <div>Proxy</div>
              <div>Detail</div>
              <div>Task</div>
            </div>
            <div className="divide-y divide-[#1a1a1a]">
              {state.events.map(e => {
                const style = RESULT_STYLES[e.result];
                const ts = e.detectedAt ? new Date(e.detectedAt) : null;
                return (
                  <div key={e.taskId + '|' + (e.key ?? 'nokey') + '|' + e.detectedAt}
                       className="grid grid-cols-[140px_90px_180px_60px_70px_1fr_100px] gap-3 px-3 py-2 items-center hover:bg-[#181818] transition">
                    <div className="text-[11px] text-[#888] font-mono">
                      {ts ? `${ts.toLocaleTimeString()}` : '—'}
                    </div>
                    <div>
                      <span className={`inline-block ${style.bg} ${style.text} rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wider`}>
                        {style.label}
                      </span>
                    </div>
                    <div className="text-xs text-white font-mono truncate" title={e.key ?? ''}>
                      {e.key ?? '—'}
                    </div>
                    <div className="text-right text-xs text-[#aaa] font-mono">
                      {e.latencyMs != null ? `${e.latencyMs}ms` : '—'}
                    </div>
                    <div className="text-[11px] text-[#888] truncate" title={e.proxyUsed ?? ''}>
                      {e.proxyUsed ?? '—'}
                    </div>
                    <div className="text-[11px] text-[#ccc] truncate" title={e.reason ?? ''}>
                      {e.reason ?? '—'}
                      {e.workerName && <span className="text-[#666] ml-2">· {e.workerName}</span>}
                    </div>
                    <div className="text-[11px] text-[#888] font-mono truncate" title={e.taskId}>
                      {e.taskId.slice(-10)}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="p-8 text-center text-sm text-[#666]">Loading…</div>
        )}
      </div>
    </>
  );
}

// ────────────────────────────────────────────────────────────────
// Docs Tab — renders markdown from /docs via /api/admin/docs.
// Sidebar lists available docs, main area renders the selected one.
// ────────────────────────────────────────────────────────────────

interface DocListEntry {
  slug: string;
  title: string;
  description: string;
  mtime: string;
}

function DocsTab({ active }: { active: boolean }) {
  const [docs, setDocs] = useState<DocListEntry[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [contentMeta, setContentMeta] = useState<{ title: string; mtime: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!active) return;
    setLoading(true);
    fetch('/api/admin/docs')
      .then(r => r.json())
      .then(d => {
        if (d.error) throw new Error(d.error);
        setDocs(d.docs || []);
        // Auto-select the first doc on first open if nothing is chosen yet.
        setSelected(prev => prev ?? (d.docs?.[0]?.slug || null));
      })
      .catch(err => setError((err as Error).message))
      .finally(() => setLoading(false));
  }, [active]);

  useEffect(() => {
    if (!selected) return;
    setError(null);
    fetch(`/api/admin/docs?slug=${encodeURIComponent(selected)}`)
      .then(r => r.json())
      .then(d => {
        if (d.error) throw new Error(d.error);
        setContent(d.content || '');
        setContentMeta({ title: d.title || selected, mtime: d.mtime });
      })
      .catch(err => setError((err as Error).message));
  }, [selected]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold text-white">Docs</h1>
        <p className="text-[#888] text-xs mt-1 max-w-2xl">
          Architecture notes and API references for the major systems —
          rendered live from <code className="text-slate-400 text-[11px]">/docs/*.md</code> in the repo, so
          edits to the markdown files show up here on the next deploy.
        </p>
      </div>

      {error && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-4 text-sm text-red-400">{error}</div>
      )}

      <div className="grid grid-cols-[260px_1fr] gap-6 items-start">
        {/* Sidebar */}
        <div className="bg-[#141414] border border-[#1f1f1f] rounded-xl p-2 space-y-1">
          {loading && docs.length === 0 && (
            <div className="text-xs text-[#666] p-3">Loading…</div>
          )}
          {docs.length === 0 && !loading && (
            <div className="text-xs text-[#666] p-3">No docs found in /docs.</div>
          )}
          {docs.map(d => (
            <button
              key={d.slug}
              onClick={() => setSelected(d.slug)}
              className={`w-full text-left rounded-lg px-3 py-2 transition ${
                selected === d.slug
                  ? 'bg-slate-700/40 text-white'
                  : 'hover:bg-[#1a1a1a] text-[#ccc]'
              }`}
            >
              <div className="text-xs font-medium truncate">{d.title}</div>
              <div className="text-[10px] text-[#666] truncate mt-0.5">{d.description}</div>
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="bg-[#141414] border border-[#1f1f1f] rounded-xl p-6 min-h-[400px]">
          {!selected ? (
            <div className="text-sm text-[#666] text-center py-12">
              Pick a doc from the sidebar.
            </div>
          ) : content == null ? (
            <div className="text-sm text-[#666] text-center py-12">Loading…</div>
          ) : (
            <>
              <Markdown source={content} />
              {contentMeta?.mtime && (
                <div className="mt-8 pt-4 border-t border-[#222] text-[10px] text-[#555]">
                  Last modified: {new Date(contentMeta.mtime).toLocaleString()}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────
// Video Seed Tab — live feed of niche_seed_expansions rows written
// by /api/niche-spy/video-seed/expand. xgodo agents POST seed +
// candidate URLs there; we render every (seed, candidate, similarity)
// tuple as it lands, newest-first.
// ────────────────────────────────────────────────────────────────

interface SeedFeedRow {
  id: string;
  seedVideoId: number | null;
  seedUrl: string | null;
  seedTitle: string | null;
  seedThumbnail: string | null;
  candidateVideoId: number | null;
  candidateUrl: string;
  candidateTitle: string | null;
  candidateThumbnail: string | null;
  similarity: number | null;
  rankInBatch: number | null;
  taskId: string | null;
  keyword: string | null;
  errorMessage: string | null;
  detectedAt: string | null;
}

interface SeedFeedStats {
  total: number;
  errors: number;
  avgSimilarity: number | null;
  distinctSeeds: number;
  distinctTasks: number;
}

function VideoSeedTab({ active }: { active: boolean }) {
  const [rows, setRows] = useState<SeedFeedRow[]>([]);
  const [stats, setStats] = useState<SeedFeedStats | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [taskFilter, setTaskFilter] = useState('');
  const [keywordFilter, setKeywordFilter] = useState('');
  const [minSimFilter, setMinSimFilter] = useState('');
  const [error, setError] = useState<string | null>(null);
  const seenIds = useRef<Set<string>>(new Set());

  const fetchFeed = useCallback(async () => {
    try {
      const sp = new URLSearchParams();
      sp.set('limit', '200');
      if (taskFilter.trim()) sp.set('taskId', taskFilter.trim());
      if (keywordFilter.trim()) sp.set('keyword', keywordFilter.trim());
      if (minSimFilter.trim()) sp.set('minSim', minSimFilter.trim());
      const r = await fetch(`/api/admin/niche-spy/seed-feed?${sp.toString()}`);
      const d = await r.json();
      if (!r.ok || d.error) throw new Error(d.error || `HTTP ${r.status}`);
      setRows(d.rows ?? []);
      setStats(d.stats ?? null);
      seenIds.current = new Set((d.rows ?? []).map((row: SeedFeedRow) => row.id));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [taskFilter, keywordFilter, minSimFilter]);

  // Initial load + filter-change reload.
  useEffect(() => {
    if (!active) return;
    fetchFeed();
  }, [active, fetchFeed]);

  // Auto-poll every 3s while the tab is open + autoRefresh on.
  useEffect(() => {
    if (!active || !autoRefresh) return;
    const t = setInterval(fetchFeed, 3000);
    return () => clearInterval(t);
  }, [active, autoRefresh, fetchFeed]);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-bold text-white">Video Seed</h1>
          <p className="text-[#888] text-xs mt-1 max-w-2xl">
            Live feed of <code className="text-emerald-400 text-[11px]">niche_seed_expansions</code> —
            every (seed, candidate, cosine similarity) tuple xgodo agents submit via
            <code className="text-emerald-400 text-[11px] mx-1">/api/niche-spy/video-seed/expand</code>.
            Each candidate is compared against its seed video in the combined_v2 multimodal embedding
            space — every candidate is scored, no server-side match/no-match verdict (thresholds were too niche-dependent to be useful).
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <label className="flex items-center gap-1.5 text-xs text-[#888] cursor-pointer">
            <input type="checkbox" checked={autoRefresh} onChange={e => setAutoRefresh(e.target.checked)} className="accent-emerald-500" />
            Auto refresh (3s)
          </label>
          <button
            onClick={fetchFeed}
            className="px-3 h-8 bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-400 border border-emerald-500/30 text-xs font-medium rounded transition"
          >
            Refresh now
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-4 text-sm text-red-400">{error}</div>
      )}

      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-2">
          {[
            { label: 'Total events', value: stats.total.toLocaleString(), color: 'text-white' },
            { label: 'Errors', value: stats.errors.toLocaleString(), color: stats.errors > 0 ? 'text-red-400' : 'text-[#666]' },
            { label: 'Avg sim', value: stats.avgSimilarity != null ? stats.avgSimilarity.toFixed(3) : '—', color: 'text-blue-400' },
            { label: 'Distinct seeds', value: stats.distinctSeeds.toLocaleString(), color: 'text-[#888]' },
            { label: 'Distinct tasks', value: stats.distinctTasks.toLocaleString(), color: 'text-[#888]' },
          ].map((s, i) => (
            <div key={i} className="bg-[#141414] border border-[#1f1f1f] rounded-xl p-3 text-center">
              <div className={`text-lg font-bold ${s.color}`}>{s.value}</div>
              <div className="text-[10px] text-[#666] uppercase tracking-wider">{s.label}</div>
            </div>
          ))}
        </div>
      )}

      {/* Error-category breakdown — derived client-side from the rows
          currently in view so the operator can spot the bottleneck
          (which pool is failing) without scrolling the table. Same
          classifier as the per-row Error column below. */}
      {(() => {
        const cats: Record<string, number> = {};
        for (const r of rows) {
          if (!r.errorMessage) continue;
          const m = r.errorMessage;
          let cat: string;
          if (/^thumb_fetch_failed/.test(m))         cat = 'thumb';
          else if (/^missing_title_or_thumb/.test(m)) cat = 'meta';
          else if (/^metadata fetch failed/.test(m)) cat = 'yt-key';
          else if (/^embed_api_failed/.test(m))      cat = 'ai-key';
          else if (/^persist_failed/.test(m))        cat = 'db';
          else if (/^no embedding/.test(m))          cat = 'no-emb';
          else                                         cat = 'other';
          cats[cat] = (cats[cat] ?? 0) + 1;
        }
        const totalErr = Object.values(cats).reduce((a, b) => a + b, 0);
        if (totalErr === 0) return null;
        const colourClass: Record<string, string> = {
          'thumb':  'bg-amber-500/10 text-amber-300 border-amber-500/30',
          'meta':   'bg-amber-500/10 text-amber-300 border-amber-500/30',
          'yt-key': 'bg-orange-500/10 text-orange-300 border-orange-500/30',
          'ai-key': 'bg-red-500/10 text-red-300 border-red-500/30',
          'db':     'bg-fuchsia-500/10 text-fuchsia-300 border-fuchsia-500/30',
          'no-emb': 'bg-zinc-500/10 text-zinc-300 border-zinc-500/30',
          'other':  'bg-zinc-500/10 text-zinc-300 border-zinc-500/30',
        };
        const order = ['ai-key', 'yt-key', 'thumb', 'meta', 'db', 'no-emb', 'other'];
        return (
          <div className="flex items-center gap-2 flex-wrap text-[11px]">
            <span className="text-[#666] uppercase tracking-wider text-[10px]">
              Errors by category (loaded rows · {totalErr}):
            </span>
            {order.filter(c => cats[c]).map(c => (
              <span key={c} className={`inline-block rounded px-2 py-0.5 font-mono border ${colourClass[c]}`}>
                {c} {cats[c]} ({((cats[c] / totalErr) * 100).toFixed(0)}%)
              </span>
            ))}
          </div>
        );
      })()}

      <div className="bg-[#141414] border border-[#1f1f1f] rounded-xl p-3 flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] uppercase tracking-wider text-[#666]">Task:</span>
          <input
            type="text" placeholder="any" value={taskFilter}
            onChange={e => setTaskFilter(e.target.value)}
            className="w-32 px-2 h-7 bg-[#0a0a0a] border border-[#1f1f1f] text-white text-xs rounded focus:outline-none focus:border-emerald-500"
          />
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] uppercase tracking-wider text-[#666]">Keyword:</span>
          <input
            type="text" placeholder="any" value={keywordFilter}
            onChange={e => setKeywordFilter(e.target.value)}
            className="w-40 px-2 h-7 bg-[#0a0a0a] border border-[#1f1f1f] text-white text-xs rounded focus:outline-none focus:border-emerald-500"
          />
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] uppercase tracking-wider text-[#666]">Min sim:</span>
          <input
            type="number" min={0} max={1} step={0.05} placeholder="0.00" value={minSimFilter}
            onChange={e => setMinSimFilter(e.target.value)}
            className="w-20 px-2 h-7 bg-[#0a0a0a] border border-[#1f1f1f] text-white text-xs rounded focus:outline-none focus:border-emerald-500"
          />
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="bg-[#141414] border border-[#1f1f1f] rounded-xl p-8 text-center text-sm text-[#666]">
          No expansions yet. xgodo agents will populate this as they call
          <code className="text-emerald-400 text-[11px] mx-1">/api/niche-spy/video-seed/expand</code>.
        </div>
      ) : (
        <div className="bg-[#141414] border border-[#1f1f1f] rounded-xl overflow-hidden">
          <div className="grid grid-cols-[140px_2fr_20px_2fr_80px_200px_120px_80px] gap-2 px-3 py-2 border-b border-[#1f1f1f] text-[10px] uppercase tracking-wider text-[#666]">
            <div>Time</div>
            <div>Seed</div>
            <div></div>
            <div>Candidate</div>
            <div className="text-right">Similarity</div>
            <div>Error</div>
            <div>Task</div>
            <div>Keyword</div>
          </div>
          <div className="divide-y divide-[#1a1a1a]">
            {rows.map(r => {
              const simPct = r.similarity != null ? (r.similarity * 100).toFixed(1) : null;
              const ts = r.detectedAt ? new Date(r.detectedAt) : null;
              return (
                <div key={r.id} className="grid grid-cols-[140px_2fr_20px_2fr_80px_200px_120px_80px] gap-2 px-3 py-2 items-center hover:bg-[#181818] transition">
                  <div className="text-[11px] text-[#888] font-mono">
                    {ts ? `${ts.toLocaleTimeString()}.${String(ts.getMilliseconds()).padStart(3,'0')}` : '—'}
                  </div>
                  <div className="flex items-center gap-2 min-w-0">
                    {r.seedThumbnail ? (
                      <img src={r.seedThumbnail} alt="" className="w-10 h-6 object-cover rounded flex-shrink-0" />
                    ) : (
                      <div className="w-10 h-6 bg-[#222] rounded flex-shrink-0" />
                    )}
                    <div className="text-xs text-white truncate" title={r.seedTitle || r.seedUrl || ''}>
                      {r.seedTitle || r.seedUrl || `#${r.seedVideoId}`}
                    </div>
                  </div>
                  <div className="text-[#444] text-center">→</div>
                  <div className="flex items-center gap-2 min-w-0">
                    {r.candidateThumbnail ? (
                      <img src={r.candidateThumbnail} alt="" className="w-10 h-6 object-cover rounded flex-shrink-0" />
                    ) : (
                      <div className="w-10 h-6 bg-[#222] rounded flex-shrink-0" />
                    )}
                    <a
                      href={r.candidateUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-xs text-white hover:text-emerald-400 truncate"
                      title={r.candidateTitle || r.candidateUrl}
                    >
                      {r.candidateTitle || r.candidateUrl}
                    </a>
                  </div>
                  <div className={`text-right text-xs font-mono ${
                    r.similarity == null ? 'text-[#444]' :
                    r.similarity >= 0.7  ? 'text-emerald-400' :
                    r.similarity >= 0.5  ? 'text-yellow-400' :
                                           'text-[#888]'
                  }`}>
                    {simPct != null ? `${simPct}%` : '—'}
                  </div>
                  {/* Error column — category badge + full message tooltip so
                      operator can see at-a-glance whether the bottleneck is
                      AI keys (embed), YT keys (metadata), thumbnail fetch,
                      DB persist, etc. */}
                  <div className="min-w-0">
                    {r.errorMessage ? (() => {
                      const msg = r.errorMessage;
                      // Categorise — strings match what lib/video-seed.ts emits
                      // via the EmbedOutcome union plus the expandFromSeed
                      // fallback branches.
                      let cat: string; let colour: string;
                      if (/^thumb_fetch_failed/.test(msg))        { cat = 'thumb';   colour = 'amber'; }
                      else if (/^missing_title_or_thumb/.test(msg)) { cat = 'meta';   colour = 'amber'; }
                      else if (/^metadata fetch failed/.test(msg)) { cat = 'yt-key'; colour = 'orange'; }
                      else if (/^embed_api_failed/.test(msg))     { cat = 'ai-key'; colour = 'red'; }
                      else if (/^persist_failed/.test(msg))       { cat = 'db';     colour = 'fuchsia'; }
                      else if (/^no embedding/.test(msg))         { cat = 'no-emb'; colour = 'zinc'; }
                      else                                          { cat = 'other';  colour = 'zinc'; }
                      const colourClass = {
                        amber:   'bg-amber-500/15 text-amber-300 border-amber-500/30',
                        orange:  'bg-orange-500/15 text-orange-300 border-orange-500/30',
                        red:     'bg-red-500/15 text-red-300 border-red-500/30',
                        fuchsia: 'bg-fuchsia-500/15 text-fuchsia-300 border-fuchsia-500/30',
                        zinc:    'bg-zinc-500/15 text-zinc-300 border-zinc-500/30',
                      }[colour];
                      // Detail = everything after the first colon if present
                      const detail = msg.includes(':') ? msg.slice(msg.indexOf(':') + 1).trim() : '';
                      return (
                        <div className="flex items-center gap-1.5 min-w-0" title={msg}>
                          <span className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-mono border flex-shrink-0 ${colourClass}`}>
                            {cat}
                          </span>
                          <span className="text-[10px] text-[#888] font-mono truncate">
                            {detail || msg}
                          </span>
                        </div>
                      );
                    })() : <span className="text-[10px] text-[#444]">—</span>}
                  </div>
                  <div className="text-[11px] text-[#888] font-mono truncate" title={r.taskId ?? ''}>
                    {r.taskId ? r.taskId.slice(-12) : '—'}
                  </div>
                  <div className="text-[11px] text-[#888] truncate" title={r.keyword ?? ''}>
                    {r.keyword ?? '—'}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function AgentsTab({ data, loading, autoRefresh, setAutoRefresh, deploy, setDeploy, deployMsg, setDeployMsg, onRefresh, active }: {
  data: { totalActive: number; byKeyword: Array<{ keyword: string; active: number; taskIds: string[]; kind?: 'keyword' | 'seed' | 'unknown'; label?: string; seedUrls?: string[] }>; tasks: Array<{ id: string; keyword: string; startedAt: string | null }> } | null;
  loading: boolean;
  autoRefresh: boolean;
  setAutoRefresh: (v: boolean) => void;
  deploy: DeployConfig;
  setDeploy: React.Dispatch<React.SetStateAction<DeployConfig>>;
  deployMsg: string | null;
  setDeployMsg: (v: string | null) => void;
  onRefresh: () => void;
  active: boolean;
}) {
  // Load defaults from admin config on first render
  useEffect(() => {
    if (!active) return;
    fetch('/api/admin/config').then(r => r.json()).then(d => {
      if (d.config) {
        setDeploy(prev => ({
          ...prev,
          apiKey: prev.apiKey || d.config.agent_api_key || '',
          rofeAPIKey: prev.rofeAPIKey || d.config.agent_rofe_api_key || '',
          loopNumber: parseInt(d.config.agent_loop_number) || prev.loopNumber,
          maxSearchResults: parseInt(d.config.agent_max_search_results) || prev.maxSearchResults,
          maxSuggestedResults: parseInt(d.config.agent_max_suggested_results) || prev.maxSuggestedResults,
        }));
      }
    }).catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
  // Auto-refresh polling
  useEffect(() => {
    if (!active || !autoRefresh) return;
    const interval = setInterval(onRefresh, 5000);
    return () => clearInterval(interval);
  }, [active, autoRefresh, onRefresh]);

  const deployAgents = async () => {
    const isSeed = deploy.mode === 'seed';
    if (isSeed ? !deploy.seedUrl.trim() : !deploy.keyword.trim()) return;
    setDeployMsg(null);
    try {
      // Save shared defaults to admin config (api keys + loop knobs)
      fetch('/api/admin/config', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: {
          agent_api_key: deploy.apiKey,
          agent_rofe_api_key: deploy.rofeAPIKey,
          agent_loop_number: String(deploy.loopNumber),
          agent_max_search_results: String(deploy.maxSearchResults),
          agent_max_suggested_results: String(deploy.maxSuggestedResults),
        }}),
      }).catch(() => {});

      const body = isSeed
        ? {
            mode: 'seed' as const,
            seedUrl: deploy.seedUrl.trim(),
            // nicheId set → add seeds to existing niche; else mint new with label
            ...(deploy.nicheId ? { nicheId: deploy.nicheId } : { label: deploy.nicheLabel.trim() || undefined }),
            threads: deploy.threads,
            apiKey: deploy.apiKey,
            loopNumber: deploy.loopNumber,
            maxSuggestedResultsBeforeFallback: deploy.maxSuggestedResults,
            rofeAPIKey: deploy.rofeAPIKey,
            createdFrom: 'manual',
          }
        : {
            keyword: deploy.keyword.trim(),
            threads: deploy.threads,
            apiKey: deploy.apiKey,
            loopNumber: deploy.loopNumber,
            maxSearchResultsBeforeFallback: deploy.maxSearchResults,
            maxSuggestedResultsBeforeFallback: deploy.maxSuggestedResults,
            rofeAPIKey: deploy.rofeAPIKey,
          };

      const res = await fetch('/api/admin/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const d = await res.json();
      if (d.ok) {
        if (isSeed) {
          setDeployMsg(`Deployed ${d.deployed} seed agents · niche ${d.nicheId}`);
          // Pin to the niche we just created so follow-up deploys add to it
          if (d.nicheId) setDeploy(p => ({ ...p, nicheId: d.nicheId }));
        } else {
          setDeployMsg(`Deployed ${d.deployed} agents for "${d.keyword}"`);
        }
        setTimeout(onRefresh, 2000);
      } else {
        setDeployMsg(`Error: ${d.error}`);
      }
    } catch (err) {
      setDeployMsg(`Error: ${err instanceof Error ? err.message : 'Failed'}`);
    }
    setTimeout(() => setDeployMsg(null), 6000);
  };

  const addThread = async (kw: { keyword: string; kind?: 'keyword' | 'seed' | 'unknown'; seedUrls?: string[] }) => {
    try {
      // Seed niches: add a thread for one of the niche's existing seed
      // URLs (reuse the primary). Keyword niches: add a keyword thread.
      const body = kw.kind === 'seed' && kw.seedUrls && kw.seedUrls.length > 0
        ? {
            mode: 'seed' as const,
            nicheId: kw.keyword,            // the work-unit key IS the nicheId
            seedUrl: kw.seedUrls[0],
            threads: 1,
            apiKey: deploy.apiKey, loopNumber: deploy.loopNumber,
            maxSuggestedResultsBeforeFallback: deploy.maxSuggestedResults,
            rofeAPIKey: deploy.rofeAPIKey,
          }
        : {
            keyword: kw.keyword, threads: 1,
            apiKey: deploy.apiKey, loopNumber: deploy.loopNumber,
            maxSearchResultsBeforeFallback: deploy.maxSearchResults,
            maxSuggestedResultsBeforeFallback: deploy.maxSuggestedResults,
            rofeAPIKey: deploy.rofeAPIKey,
          };
      const res = await fetch('/api/admin/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const d = await res.json();
      if (d.ok) setTimeout(onRefresh, 2000);
    } catch { /* ok */ }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="bg-gray-800/50 rounded-2xl border border-gray-700 p-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-lg font-bold text-white">Agent Monitor</h2>
            <p className="text-gray-400 text-sm">Track and control xgodo data collection agents</p>
          </div>
          <div className="flex items-center gap-3">
            <span className={`text-2xl font-bold ${data && data.totalActive > 0 ? 'text-green-400' : 'text-gray-500'}`}>
              {loading ? '...' : data?.totalActive ?? 0}
            </span>
            <span className="text-sm text-gray-400">running</span>
            <label className="flex items-center gap-2 ml-4 cursor-pointer">
              <input type="checkbox" checked={autoRefresh} onChange={e => setAutoRefresh(e.target.checked)}
                className="w-4 h-4 rounded bg-gray-700 border-gray-600 text-green-600 focus:ring-green-500" />
              <span className="text-xs text-gray-400">Auto-refresh</span>
            </label>
            <button onClick={onRefresh} className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-white rounded-lg text-sm">
              Refresh
            </button>
          </div>
        </div>

        {/* Per-keyword thread cards */}
        {data && data.byKeyword.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {data.byKeyword.map(kw => {
              const isSeed = kw.kind === 'seed';
              return (
                <div key={kw.keyword} className={`bg-gray-900/60 border rounded-xl p-4 flex items-center justify-between ${isSeed ? 'border-amber-500/40' : 'border-gray-700'}`}>
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      {isSeed && <span className="text-[9px] uppercase font-bold px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/40">seed</span>}
                      <div className="text-sm font-semibold text-white truncate" title={isSeed ? kw.keyword : ''}>{kw.label || kw.keyword}</div>
                    </div>
                    {isSeed && kw.seedUrls && kw.seedUrls.length > 0 && (
                      <div className="text-[10px] text-gray-500 truncate mt-0.5">
                        {kw.seedUrls.length} seed{kw.seedUrls.length === 1 ? '' : 's'} · <a href={kw.seedUrls[0]} target="_blank" rel="noopener noreferrer" className="text-amber-400/80 hover:text-amber-300">{kw.seedUrls[0].replace(/^https?:\/\/(www\.)?/, '').slice(0, 32)}</a>
                      </div>
                    )}
                    <div className="flex items-center gap-1.5 mt-1">
                      <span className={`text-2xl font-bold ${isSeed ? 'text-amber-400' : 'text-green-400'}`}>{kw.active}</span>
                      <span className="text-xs text-gray-500">threads</span>
                    </div>
                  </div>
                  <button onClick={() => addThread(kw)}
                    className={`w-8 h-8 text-white rounded-lg flex items-center justify-center text-lg font-bold transition shrink-0 ${isSeed ? 'bg-amber-500 hover:bg-amber-400 text-black' : 'bg-green-600 hover:bg-green-700'}`}
                    title="Add 1 thread"
                  >+</button>
                </div>
              );
            })}
          </div>
        ) : !loading ? (
          <div className="text-center py-8 text-gray-500">
            <div className="text-4xl mb-2">🤖</div>
            No active agents. Deploy some below.
          </div>
        ) : (
          <div className="text-center py-8">
            <div className="w-6 h-6 border-2 border-green-400 border-t-transparent rounded-full animate-spin mx-auto" />
          </div>
        )}
      </div>

      {/* Deploy Agents */}
      <div className="bg-gray-800/50 rounded-2xl border border-gray-700 p-6">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-bold text-white">Deploy Agents</h3>
          {/* Mode toggle: Keyword | Video seed */}
          <div className="flex items-center gap-1 bg-gray-900 border border-gray-700 rounded-lg p-0.5">
            <button
              onClick={() => setDeploy(p => ({ ...p, mode: 'keyword' }))}
              className={`px-3 py-1 rounded-md text-xs font-medium transition ${deploy.mode === 'keyword' ? 'bg-green-600 text-white' : 'text-gray-400 hover:text-white'}`}
            >Keyword</button>
            <button
              onClick={() => setDeploy(p => ({ ...p, mode: 'seed' }))}
              className={`px-3 py-1 rounded-md text-xs font-medium transition ${deploy.mode === 'seed' ? 'bg-amber-500 text-black' : 'text-gray-400 hover:text-white'}`}
            >Video seed</button>
          </div>
        </div>

        {deploy.mode === 'seed' ? (
          <>
            {/* Seed row: seed URL + threads */}
            <div className="flex items-end gap-3 mb-3">
              <div className="flex-1">
                <label className="block text-xs text-gray-500 mb-1">Seed video URL</label>
                <input type="text" value={deploy.seedUrl} onChange={e => setDeploy(p => ({ ...p, seedUrl: e.target.value }))}
                  placeholder="https://youtu.be/… or https://youtube.com/watch?v=…"
                  className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white text-sm placeholder-gray-600 focus:outline-none focus:border-amber-500" />
              </div>
              <div className="w-24">
                <label className="block text-xs text-gray-500 mb-1">Threads</label>
                <input type="number" min={1} max={20} value={deploy.threads} onChange={e => setDeploy(p => ({ ...p, threads: parseInt(e.target.value) || 1 }))}
                  className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:border-amber-500" />
              </div>
            </div>
            {/* Niche identity row: label (new) OR existing nicheId */}
            <div className="flex items-end gap-3 mb-3">
              <div className="flex-1">
                <label className="block text-xs text-gray-500 mb-1">
                  Niche label {deploy.nicheId ? <span className="text-amber-400">(adding to existing niche {deploy.nicheId})</span> : <span className="text-gray-600">(optional — auto-derived from the video if blank)</span>}
                </label>
                <input type="text" value={deploy.nicheLabel} disabled={!!deploy.nicheId}
                  onChange={e => setDeploy(p => ({ ...p, nicheLabel: e.target.value }))}
                  placeholder="e.g. Sumerian tablets explainers"
                  className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white text-sm placeholder-gray-600 focus:outline-none focus:border-amber-500 disabled:opacity-50" />
              </div>
              {deploy.nicheId && (
                <button
                  onClick={() => setDeploy(p => ({ ...p, nicheId: '', nicheLabel: '' }))}
                  className="px-3 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded-lg text-xs"
                  title="Start a fresh niche instead of adding to the existing one"
                >New niche</button>
              )}
            </div>
          </>
        ) : (
          /* Keyword row: keyword + threads */
          <div className="flex items-end gap-3 mb-3">
            <div className="flex-1">
              <label className="block text-xs text-gray-500 mb-1">Keyword</label>
              <input type="text" value={deploy.keyword} onChange={e => setDeploy(p => ({ ...p, keyword: e.target.value }))}
                placeholder="e.g. youtube automation"
                className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white text-sm placeholder-gray-600 focus:outline-none focus:border-green-500" />
            </div>
            <div className="w-24">
              <label className="block text-xs text-gray-500 mb-1">Threads</label>
              <input type="number" min={1} max={20} value={deploy.threads} onChange={e => setDeploy(p => ({ ...p, threads: parseInt(e.target.value) || 1 }))}
                className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:border-green-500" />
            </div>
          </div>
        )}

        {/* Row 2: API Key */}
        <div className="mb-3">
          <label className="block text-xs text-gray-500 mb-1">API Key</label>
          <input type="password" value={deploy.apiKey} onChange={e => setDeploy(p => ({ ...p, apiKey: e.target.value }))}
            placeholder="sk_live_..."
            className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white text-sm placeholder-gray-600 focus:outline-none focus:border-green-500 font-mono" />
        </div>

        {/* Row 3: rofeAPIKey */}
        <div className="mb-3">
          <label className="block text-xs text-gray-500 mb-1">rofe API Key</label>
          <input type="password" value={deploy.rofeAPIKey} onChange={e => setDeploy(p => ({ ...p, rofeAPIKey: e.target.value }))}
            placeholder="hba_..."
            className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white text-sm placeholder-gray-600 focus:outline-none focus:border-green-500 font-mono" />
        </div>

        {/* Row 4: Loop Number + Max Search + Max Suggested */}
        <div className="flex items-end gap-3 mb-4">
          <div className="w-28">
            <label className="block text-xs text-gray-500 mb-1">Loop Number</label>
            <input type="number" min={1} max={100} value={deploy.loopNumber} onChange={e => setDeploy(p => ({ ...p, loopNumber: parseInt(e.target.value) || 30 }))}
              className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:border-green-500" />
          </div>
          {/* Max Search Results — keyword mode only (seed mode has no search step) */}
          {deploy.mode === 'keyword' && (
            <div className="w-36">
              <label className="block text-xs text-gray-500 mb-1">Max Search Results</label>
              <input type="number" min={1} max={200} value={deploy.maxSearchResults} onChange={e => setDeploy(p => ({ ...p, maxSearchResults: parseInt(e.target.value) || 50 }))}
                className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:border-green-500" />
            </div>
          )}
          <div className="w-36">
            <label className="block text-xs text-gray-500 mb-1">Max Suggested Results</label>
            <input type="number" min={1} max={200} value={deploy.maxSuggestedResults} onChange={e => setDeploy(p => ({ ...p, maxSuggestedResults: parseInt(e.target.value) || 50 }))}
              className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:border-green-500" />
          </div>
          <button onClick={deployAgents}
            className={`px-5 py-2 text-white rounded-lg text-sm font-medium transition ml-auto ${deploy.mode === 'seed' ? 'bg-amber-500 hover:bg-amber-400 text-black' : 'bg-green-600 hover:bg-green-700'}`}>
            {deploy.mode === 'seed' ? 'Deploy seed' : 'Deploy'}
          </button>
        </div>
        {deployMsg && (
          <div className={`mt-3 text-sm ${deployMsg.startsWith('Error') ? 'text-red-400' : 'text-green-400'}`}>
            {deployMsg}
          </div>
        )}
      </div>

      {/* Thread Targets (Thermostat) */}
      <ThreadTargets />

      {/* Active Tasks Table */}
      {data && data.tasks.length > 0 && (
        <div className="bg-gray-800/50 rounded-2xl border border-gray-700 p-6">
          <h3 className="text-sm font-bold text-white mb-3">Active Tasks ({data.tasks.length})</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-700 text-left">
                  <th className="px-3 py-2 text-xs text-gray-500 uppercase">Task ID</th>
                  <th className="px-3 py-2 text-xs text-gray-500 uppercase">Keyword</th>
                  <th className="px-3 py-2 text-xs text-gray-500 uppercase">Running</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-700/50">
                {data.tasks.map((t: Record<string, unknown>) => {
                  const dur = t.duration as number | null;
                  const fmtDur = dur != null
                    ? dur < 60 ? `${dur}s` : dur < 3600 ? `${Math.floor(dur / 60)}m ${dur % 60}s` : `${Math.floor(dur / 3600)}h ${Math.floor((dur % 3600) / 60)}m`
                    : '—';
                  return (
                    <tr key={t.id as string} className="hover:bg-gray-700/20">
                      <td className="px-3 py-2 text-gray-400 font-mono text-xs">{(t.id as string).slice(-8)}</td>
                      <td className="px-3 py-2 text-white">{t.keyword as string}</td>
                      <td className="px-3 py-2 text-green-400 font-mono text-xs">{fmtDur}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Task History Log */}
      <AgentLog />
    </div>
  );
}

/** Thread target manager — set how many threads to maintain per keyword */
function ThreadTargets() {
  const [targets, setTargets] = useState<Array<{
    id: number; keyword: string; target_threads: number; active_threads: number;
    enabled: boolean; last_deployed_at: string | null; last_checked_at: string | null;
  }>>([]);
  const [newKeyword, setNewKeyword] = useState('');
  const [newTarget, setNewTarget] = useState(6);

  const fetchTargets = useCallback(() => {
    fetch('/api/admin/agents/targets').then(r => r.json()).then(d => {
      if (d.targets) setTargets(d.targets);
    }).catch(() => {});
  }, []);

  useEffect(() => { fetchTargets(); }, [fetchTargets]);

  useEffect(() => {
    const interval = setInterval(fetchTargets, 10000);
    return () => clearInterval(interval);
  }, [fetchTargets]);

  const updateTarget = async (keyword: string, targetThreads: number, enabled: boolean) => {
    await fetch('/api/admin/agents/targets', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keyword, targetThreads, enabled }),
    });
    fetchTargets();
  };

  const removeTarget = async (keyword: string) => {
    await fetch('/api/admin/agents/targets', {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keyword }),
    });
    fetchTargets();
  };

  const addTarget = async () => {
    if (!newKeyword.trim()) return;
    await updateTarget(newKeyword.trim(), newTarget, true);
    setNewKeyword('');
  };

  return (
    <div className="bg-gray-800/50 rounded-2xl border border-gray-700 p-6">
      <h3 className="text-sm font-bold text-white mb-1">Thread Targets</h3>
      <p className="text-xs text-gray-500 mb-4">Maintain exact thread count per keyword. Thermostat auto-deploys when threads drop below target (60s cooldown).</p>

      {targets.length > 0 && (
        <div className="space-y-2 mb-4">
          {targets.map(t => (
            <div key={t.id} className="flex items-center gap-3 bg-gray-900/60 border border-gray-700 rounded-lg px-4 py-3">
              <button onClick={() => updateTarget(t.keyword, t.target_threads, !t.enabled)}
                className={`w-3 h-3 rounded-full flex-shrink-0 ${t.enabled ? 'bg-green-500' : 'bg-gray-600'}`}
                title={t.enabled ? 'Click to pause' : 'Click to enable'} />
              <span className="text-sm text-white font-medium flex-1">{t.keyword}</span>
              <div className="flex items-center gap-1.5">
                <span className={`text-lg font-bold ${t.active_threads >= t.target_threads ? 'text-green-400' : 'text-yellow-400'}`}>
                  {t.active_threads}
                </span>
                <span className="text-xs text-gray-500">/</span>
                <input type="number" min={0} max={20} value={t.target_threads}
                  onChange={e => updateTarget(t.keyword, parseInt(e.target.value) || 0, t.enabled)}
                  className="w-14 px-2 py-1 bg-gray-800 border border-gray-700 rounded text-white text-sm text-center focus:outline-none focus:border-green-500" />
              </div>
              {t.last_deployed_at && (
                <span className="text-[10px] text-gray-600">
                  deployed {Math.round((Date.now() - new Date(t.last_deployed_at).getTime()) / 1000)}s ago
                </span>
              )}
              <button onClick={() => removeTarget(t.keyword)} className="text-red-400 hover:text-red-300 text-xs">Remove</button>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-end gap-3">
        <div className="flex-1">
          <label className="block text-xs text-gray-500 mb-1">Keyword</label>
          <input type="text" value={newKeyword} onChange={e => setNewKeyword(e.target.value)}
            placeholder="e.g. youtube automation"
            className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white text-sm placeholder-gray-600 focus:outline-none focus:border-green-500"
            onKeyDown={e => e.key === 'Enter' && addTarget()} />
        </div>
        <div className="w-20">
          <label className="block text-xs text-gray-500 mb-1">Threads</label>
          <input type="number" min={1} max={20} value={newTarget} onChange={e => setNewTarget(parseInt(e.target.value) || 6)}
            className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:border-green-500" />
        </div>
        <button onClick={addTarget}
          className="px-4 py-2 bg-green-600 hover:bg-green-700 text-white rounded-lg text-sm font-medium transition">
          Add Target
        </button>
      </div>

      <div className="mt-4 text-[10px] text-gray-600">
        Thermostat: <code className="text-gray-500">GET /api/cron/agents</code> — call every 30-60s via cron.
      </div>
    </div>
  );
}

/** Browsable task history log */
function AgentLog() {
  const [logData, setLogData] = useState<{
    tasks: Array<{ id: string; keyword: string; status: string; workerName: string; firstSeen: string; lastSeen: string; duration: number }>;
    total: number; page: number; totalPages: number;
    stats: { running: number; completed: number; total: number; avgDuration: number; maxDuration: number; minDuration: number };
  } | null>(null);
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState('');

  const fetchLog = useCallback(() => {
    const params = new URLSearchParams({ page: String(page), limit: '30' });
    if (statusFilter) params.set('status', statusFilter);
    fetch(`/api/admin/agents/log?${params}`).then(r => r.json()).then(d => setLogData(d)).catch(() => {});
  }, [page, statusFilter]);

  useEffect(() => { fetchLog(); }, [fetchLog]);

  // Auto-refresh every 30s
  useEffect(() => {
    const interval = setInterval(fetchLog, 30000);
    return () => clearInterval(interval);
  }, [fetchLog]);

  const fmtDur = (s: number) => {
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
    return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  };

  const fmtTime = (iso: string) => {
    const d = new Date(iso);
    const now = new Date();
    const diffH = (now.getTime() - d.getTime()) / 3600000;
    if (diffH < 24) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  if (!logData) return null;

  return (
    <div className="bg-gray-800/50 rounded-2xl border border-gray-700 p-6">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-bold text-white">Task History</h3>
        <div className="flex items-center gap-3 text-xs">
          {logData.stats.total > 0 && (
            <div className="flex items-center gap-3 text-gray-500">
              <span>Avg: <span className="text-gray-300">{fmtDur(logData.stats.avgDuration)}</span></span>
              <span>Min: <span className="text-gray-300">{fmtDur(logData.stats.minDuration)}</span></span>
              <span>Max: <span className="text-gray-300">{fmtDur(logData.stats.maxDuration)}</span></span>
              <span className="text-green-400">{logData.stats.running} running</span>
              <span>{logData.stats.completed} completed</span>
            </div>
          )}
          <div className="flex gap-1">
            {['', 'running', 'completed'].map(s => (
              <button key={s} onClick={() => { setStatusFilter(s); setPage(1); }}
                className={`px-2 py-0.5 rounded text-[10px] ${statusFilter === s ? 'bg-white/15 text-white' : 'text-gray-600 hover:text-gray-400'}`}>
                {s || 'All'}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-700 text-left">
              <th className="px-3 py-2 text-xs text-gray-500 uppercase">Task ID</th>
              <th className="px-3 py-2 text-xs text-gray-500 uppercase">Keyword</th>
              <th className="px-3 py-2 text-xs text-gray-500 uppercase">Status</th>
              <th className="px-3 py-2 text-xs text-gray-500 uppercase">Duration</th>
              <th className="px-3 py-2 text-xs text-gray-500 uppercase">Started</th>
              <th className="px-3 py-2 text-xs text-gray-500 uppercase">Ended</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-700/50">
            {logData.tasks.map(t => (
              <tr key={t.id} className="hover:bg-gray-700/20">
                <td className="px-3 py-2 text-gray-400 font-mono text-xs">{t.id.slice(-8)}</td>
                <td className="px-3 py-2 text-white text-xs">{t.keyword}</td>
                <td className="px-3 py-2">
                  <span className={`text-[10px] px-1.5 py-0.5 rounded ${t.status === 'running' ? 'bg-green-500/20 text-green-400' : 'bg-gray-700 text-gray-400'}`}>
                    {t.status}
                  </span>
                </td>
                <td className="px-3 py-2 font-mono text-xs">
                  <span className={t.status === 'running' ? 'text-green-400' : 'text-gray-300'}>{fmtDur(t.duration)}</span>
                </td>
                <td className="px-3 py-2 text-gray-500 text-xs">{fmtTime(t.firstSeen)}</td>
                <td className="px-3 py-2 text-gray-500 text-xs">{t.status === 'completed' ? fmtTime(t.lastSeen) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {logData.totalPages > 1 && (
        <div className="flex items-center justify-between mt-3">
          <span className="text-xs text-gray-500">{logData.total} tasks · Page {logData.page}/{logData.totalPages}</span>
          <div className="flex gap-1">
            <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page <= 1}
              className="px-2 py-1 bg-gray-700 hover:bg-gray-600 disabled:bg-gray-800 disabled:text-gray-600 text-white rounded text-xs">Prev</button>
            <button onClick={() => setPage(p => Math.min(logData.totalPages, p + 1))} disabled={page >= logData.totalPages}
              className="px-2 py-1 bg-gray-700 hover:bg-gray-600 disabled:bg-gray-800 disabled:text-gray-600 text-white rounded text-xs">Next</button>
          </div>
        </div>
      )}
    </div>
  );
}


/** Data Collection controls — console-style log output */
function DataCollection() {
  const [syncing, setSyncing] = useState(false);
  const [enriching, setEnriching] = useState(false);
  const [logs, setLogs] = useState<Array<{ time: string; type: 'info' | 'success' | 'error' | 'data' | 'tick'; msg: string }>>([]);
  const logRef = useRef<HTMLDivElement>(null);
  const [batchSize, setBatchSize] = useState(25);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const tickStartRef = useRef(0);

  const log = (type: 'info' | 'success' | 'error' | 'data' | 'tick', msg: string) => {
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    setLogs(prev => [...prev, { time, type, msg }]);
    setTimeout(() => logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' }), 50);
  };

  const startTick = (label: string) => {
    stopTick();
    tickStartRef.current = Date.now();
    tickRef.current = setInterval(() => {
      const elapsed = Math.round((Date.now() - tickStartRef.current) / 1000);
      setLogs(prev => {
        const last = prev[prev.length - 1];
        if (last?.type === 'tick') return [...prev.slice(0, -1), { ...last, msg: `${label} (${elapsed}s)` }];
        return [...prev, { time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }), type: 'tick' as const, msg: `${label} (${elapsed}s)` }];
      });
    }, 1000);
  };

  const stopTick = () => {
    if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null; }
    setLogs(prev => prev.filter(l => l.type !== 'tick'));
  };

  const runSync = async () => {
    setSyncing(true);
    log('info', `[sync] Starting — batch size: ${batchSize} tasks per request`);
    let totalInserted = 0, totalUpdated = 0, batches = 0, totalTasks = 0;
    const syncStart = Date.now();
    try {
      while (true) {
        batches++;
        startTick(`[sync] ⏳ Fetching batch ${batches} from xgodo...`);
        const res = await fetch('/api/niche-spy/sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ limit: batchSize }),
        });
        stopTick();
        const data = await res.json();
        if (data.error) { log('error', `[sync] ✗ Error: ${data.error}`); break; }

        totalInserted += data.videosInserted || 0;
        totalUpdated += data.videosUpdated || 0;
        totalTasks += data.tasksProcessed || 0;

        log('data', `[sync] Batch ${batches}: ${data.tasksProcessed || 0} tasks → +${data.videosInserted || 0} new, ${data.videosUpdated || 0} updated, ${data.tasksConfirmed || 0} confirmed`);

        if (data.keywordBreakdown) {
          for (const k of data.keywordBreakdown) {
            log('data', `[sync]   ├ ${k.keyword}: +${k.new} new / ${k.total} total`);
          }
        }
        if (data.saturation) {
          for (const s of data.saturation.slice(0, 5)) {
            log('data', `[sync]   ├ sat ${s.keyword}: run=${s.runSatPct}% global=${s.globalSatPct}% +${s.A} new`);
          }
        }
        if (data.totalLocal) log('info', `[sync]   └ DB: ${data.totalLocal.toLocaleString()} videos, ${data.totalKeywords || '?'} keywords`);

        if (data.status === 'idle' || data.tasksProcessed === 0) {
          const elapsed = ((Date.now() - syncStart) / 1000).toFixed(1);
          log('success', `[sync] ✓ Done in ${elapsed}s — ${totalTasks} tasks, +${totalInserted} new, ${totalUpdated} updated across ${batches} batches`);
          break;
        }
        if (data.tasksProcessed < batchSize) {
          const elapsed = ((Date.now() - syncStart) / 1000).toFixed(1);
          log('success', `[sync] ✓ Done in ${elapsed}s (partial) — ${totalTasks} tasks, +${totalInserted} new, ${totalUpdated} updated`);
          break;
        }
        log('info', `[sync] Running total: +${totalInserted} new, ${totalUpdated} updated from ${totalTasks} tasks...`);
        await new Promise(r => setTimeout(r, 300));
      }
    } catch (err) {
      stopTick();
      log('error', `[sync] ✗ Failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
    setSyncing(false);
  };

  const runEnrich = async () => {
    setEnriching(true);
    startTick('[enrich] ⏳ Checking enrichment needs...');
    let totalV = 0, totalC = 0, totalErr = 0, round = 0;
    const enrichStart = Date.now();
    try {
      const checkRes = await fetch('/api/niche-spy/enrich');
      stopTick();
      const checkData = await checkRes.json();
      const needed = parseInt(checkData.need_enrichment) || 0;
      if (needed === 0) {
        log('success', '[enrich] ✓ All videos already enriched.');
        setEnriching(false);
        return;
      }
      const rounds = Math.ceil(needed / 200);
      log('info', `[enrich] ${needed} videos need enrichment (~${rounds} rounds of 200)`);

      while (true) {
        round++;
        const pct = needed > 0 ? Math.round((totalV / needed) * 100) : 0;
        log('info', `[enrich] Round ${round}/${rounds} starting... (${pct}% done, ${needed - totalV} remaining)`);
        startTick(`[enrich] ⏳ Round ${round}/${rounds} processing...`);

        const res = await fetch('/api/niche-spy/enrich', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ limit: 200 }),
        });
        const reader = res.body?.getReader();
        const decoder = new TextDecoder();
        let buf = '', rv = 0, rc = 0;
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
                if (d.step === 'videos' && d.done) {
                  stopTick();
                  rv = d.enriched || 0;
                  log('data', `[enrich]   ├ videos: ${rv} enriched`);
                } else if (d.step === 'videos' && !d.done && !d.error && d.batch != null) {
                  stopTick();
                  log('data', `[enrich]   ├ batch ${d.batch}: processing...`);
                  startTick(`[enrich] ⏳ Video batch ${(d.batch || 0) + 1}...`);
                } else if (d.step === 'videos' && d.error) {
                  log('error', `[enrich]   └ video error: ${d.error}`);
                } else if (d.step === 'channels' && !d.done && !d.error) {
                  startTick('[enrich] ⏳ Fetching subscriber counts...');
                } else if (d.step === 'channels' && d.done) {
                  stopTick();
                  rc = d.enriched || 0;
                  log('data', `[enrich]   ├ channels: ${rc} subscriber counts fetched`);
                } else if (d.step === 'channels' && d.error) {
                  log('error', `[enrich]   └ channel error: ${d.error}`);
                } else if (d.step === 'complete') {
                  stopTick();
                  rv = d.enrichedVideos || 0;
                  rc = d.enrichedChannels || 0;
                  totalErr += d.errors || 0;
                  log('success', `[enrich] ✓ Round ${round}: ${rv} videos, ${rc} channels${d.errors ? `, ${d.errors} errors` : ''}`);
                }
              } catch { /* skip */ }
            }
          }
        }
        totalV += rv; totalC += rc;
        if (rv === 0) {
          log('info', '[enrich] No more videos to enrich');
          break;
        }
        await new Promise(r => setTimeout(r, 300));
      }
      const elapsed = ((Date.now() - enrichStart) / 1000).toFixed(1);
      log('success', `[enrich] ✓ All done in ${elapsed}s — ${totalV} videos, ${totalC} channels across ${round} rounds${totalErr ? `, ${totalErr} errors` : ''}`);
    } catch (err) {
      stopTick();
      log('error', `[enrich] ✗ Failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
    setEnriching(false);
  };

  const typeColors: Record<string, string> = {
    info: 'text-blue-300',
    success: 'text-green-400',
    error: 'text-red-400',
    data: 'text-gray-400',
    tick: 'text-yellow-300 animate-pulse',
  };

  return (
    <div className="bg-gray-800/50 rounded-2xl border border-gray-700 p-6">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h3 className="text-sm font-bold text-white">Data Collection</h3>
          <p className="text-xs text-gray-500">Pull completed task data from xgodo and enrich with YouTube API.</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={runSync} disabled={syncing || enriching}
            className="px-4 py-2 bg-red-600 hover:bg-red-700 disabled:bg-gray-600 text-white rounded-lg text-sm font-medium transition">
            {syncing ? 'Syncing...' : 'Sync'}
          </button>
          <button onClick={runEnrich} disabled={enriching || syncing}
            className="px-4 py-2 bg-purple-600 hover:bg-purple-700 disabled:bg-gray-600 text-white rounded-lg text-sm font-medium transition">
            {enriching ? 'Enriching...' : 'Enrich'}
          </button>
          <div className="flex items-center gap-1.5 ml-2">
            <label className="text-[10px] text-gray-500">Batch:</label>
            <select value={batchSize} onChange={e => setBatchSize(parseInt(e.target.value))}
              className="bg-gray-800 border border-gray-700 text-white text-xs rounded px-2 py-1">
              <option value={10}>10</option>
              <option value={25}>25</option>
              <option value={50}>50</option>
              <option value={100}>100</option>
            </select>
          </div>
          {logs.length > 0 && (
            <button onClick={() => setLogs([])}
              className="px-3 py-2 bg-gray-700 hover:bg-gray-600 text-gray-300 rounded-lg text-xs transition ml-auto">
              Clear
            </button>
          )}
        </div>
      </div>

      {/* Console log */}
      {logs.length > 0 && (
        <div ref={logRef} className="bg-[#0a0a0a] border border-[#1a1a1a] rounded-lg p-3 font-mono text-xs max-h-72 overflow-y-auto space-y-0.5">
          {logs.map((l, i) => (
            <div key={i} className="flex gap-2">
              <span className="text-[#555] flex-shrink-0">{l.time}</span>
              <span className={typeColors[l.type] || 'text-gray-400'}>{l.msg}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────
 *  Vid Gen Tab — video_prompts queue management + AI bulk generation
 * ──────────────────────────────────────────────────────────────── */
interface VidPromptRow {
  id: number;
  prompt: string;
  source: string;
  generationMeta: Record<string, unknown> | null;
  createdAt: string;
  servedAt: string | null;
  servedTo: string | null;
}
interface VidPromptCounts {
  available: number;
  reserved: number;   // popped via ?reservable=1 awaiting POST /confirm, <5min old
  confirmed: number;  // truly used
  manual: number;
  ai: number;
  total: number;
}
interface VidGenRun {
  id: string;
  startedAt: string;
  completedAt: string | null;
  status: 'running' | 'done' | 'failed';
  mode: 'sync' | 'background';
  countRequested: number;
  countGenerated: number;
  countInserted: number;
  countDuplicates: number;
  batchesTotal: number;
  batchesFailed: number;
  theme: string | null;
  model: string;
  lastError: string | null;
  concurrency: number;
}

function VidGenTab({ active }: { active: boolean }) {
  const [counts, setCounts] = useState<VidPromptCounts | null>(null);
  const [prompts, setPrompts] = useState<VidPromptRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [statusFilter, setStatusFilter] = useState<'available' | 'reserved' | 'confirmed' | 'all'>('available');
  const [sourceFilter, setSourceFilter] = useState<'all' | 'manual' | 'ai-generated'>('all');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [page, setPage] = useState(0);
  const limit = 50;

  // Manual-add form state
  const [manualInput, setManualInput] = useState('');
  const [addBusy, setAddBusy] = useState(false);
  const [addMsg, setAddMsg] = useState<string | null>(null);

  // AI-gen form state
  const [genCount, setGenCount] = useState(50);
  const [genTheme, setGenTheme] = useState('');
  const [genBg, setGenBg] = useState(false);
  const [genConcurrency, setGenConcurrency] = useState(6);
  const [genBusy, setGenBusy] = useState(false);
  const [genMsg, setGenMsg] = useState<string | null>(null);

  // Recent runs + the run currently being watched live.
  const [runs, setRuns] = useState<VidGenRun[]>([]);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);

  // Global serve-time suffix — appended to every prompt returned by
  // GET /api/video_prompt when enabled. Lets us bolt on style modifiers
  // ("photoreal, cinematic 8k") without touching stored rows.
  const [suffix, setSuffix] = useState('');
  const [suffixEnabled, setSuffixEnabled] = useState(false);
  const [suffixBusy, setSuffixBusy] = useState(false);
  const [suffixMsg, setSuffixMsg] = useState<string | null>(null);
  const [suffixDirty, setSuffixDirty] = useState(false);

  // Auto-refill — when a client pops drops available below threshold,
  // a background generation of `target` prompts using `theme` fires
  // automatically. State mirrors the settings endpoint's shape.
  const [autoTheme, setAutoTheme] = useState('');
  const [autoRefillEnabled, setAutoRefillEnabled] = useState(false);
  const [autoRefillThreshold, setAutoRefillThreshold] = useState(500);
  const [autoRefillTarget, setAutoRefillTarget] = useState(500);
  const [autoBusy, setAutoBusy] = useState(false);
  const [autoMsg, setAutoMsg] = useState<string | null>(null);
  const [autoDirty, setAutoDirty] = useState(false);

  // Target render model (Veo Lite vs Veo Omni) the CLIENT will use to
  // render each prompt. Stored on vid_gen_settings + stamped onto every
  // new prompt row at insert time so clients see the choice as part of
  // /api/video_prompt's response. Changing the dropdown only affects
  // prompts generated AFTER the save — existing rows keep what they
  // were stamped with.
  type TargetModel = 'veo-lite' | 'veo-omni';
  const [targetModel, setTargetModel] = useState<TargetModel>('veo-omni');
  const [modelBusy, setModelBusy] = useState(false);
  const [modelMsg, setModelMsg] = useState<string | null>(null);

  // Debounce search input — 300ms.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  const fetchPrompts = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams({
        status: statusFilter,
        source: sourceFilter,
        search: debouncedSearch,
        limit: String(limit),
        offset: String(page * limit),
      });
      const r = await fetch(`/api/admin/tools/vid-gen?${qs.toString()}`);
      const d = await r.json();
      if (d.ok) {
        setPrompts(d.prompts || []);
        setCounts(d.counts || null);
      }
    } finally {
      setLoading(false);
    }
  }, [statusFilter, sourceFilter, debouncedSearch, page]);

  const fetchRuns = useCallback(async () => {
    try {
      const r = await fetch('/api/admin/tools/vid-gen/generate?limit=10');
      const d = await r.json();
      if (d.ok) setRuns(d.runs || []);
    } catch { /* silent */ }
  }, []);

  useEffect(() => {
    if (!active) return;
    fetchPrompts();
  }, [active, fetchPrompts]);

  // Load recent runs whenever the tab activates so the runs panel
  // shows audit history even before a new run is fired.
  useEffect(() => {
    if (!active) return;
    fetchRuns();
  }, [active, fetchRuns]);

  // Live-poll the active run + the runs list at 3s while anything
  // is still running. Stops polling once everything is settled.
  useEffect(() => {
    if (!active) return;
    const anyRunning = activeRunId || runs.some(r => r.status === 'running');
    if (!anyRunning) return;
    const t = setInterval(() => {
      fetchRuns();
      // If the active run completed, also refresh the prompts table
      // so newly-inserted rows show up.
      fetchPrompts();
    }, 3000);
    return () => clearInterval(t);
  }, [active, activeRunId, runs, fetchRuns, fetchPrompts]);

  // Drop the activeRunId once that run finishes — stops the noisy
  // "watching X…" message lingering forever after completion.
  useEffect(() => {
    if (!activeRunId) return;
    const r = runs.find(x => x.id === activeRunId);
    if (r && r.status !== 'running') {
      setGenMsg(`Run ${activeRunId.slice(0, 8)} ${r.status}: inserted ${r.countInserted}/${r.countRequested}, ${r.batchesFailed}/${r.batchesTotal} batches failed${r.lastError ? ` (${r.lastError})` : ''}`);
      setActiveRunId(null);
    }
  }, [activeRunId, runs]);

  // Load both suffix + auto-refill settings on tab activation. We
  // don't refetch on every filter change since settings are independent
  // of the prompt table.
  useEffect(() => {
    if (!active) return;
    (async () => {
      try {
        const r = await fetch('/api/admin/tools/vid-gen/settings');
        const d = await r.json();
        if (d.ok) {
          setSuffix(d.suffix || '');
          setSuffixEnabled(!!d.suffixEnabled);
          setSuffixDirty(false);
          setAutoTheme(d.autoTheme || '');
          setAutoRefillEnabled(!!d.autoRefillEnabled);
          setAutoRefillThreshold(typeof d.autoRefillThreshold === 'number' ? d.autoRefillThreshold : 500);
          setAutoRefillTarget(typeof d.autoRefillTarget === 'number' ? d.autoRefillTarget : 500);
          setAutoDirty(false);
          if (d.targetModel === 'veo-lite' || d.targetModel === 'veo-omni') {
            setTargetModel(d.targetModel);
          }
        }
      } catch { /* silent */ }
    })();
  }, [active]);

  // Persist a target_model change. Fires on dropdown change — no
  // separate Save button, the choice is binary and atomic.
  const saveTargetModel = async (next: TargetModel) => {
    const prev = targetModel;
    setTargetModel(next);            // optimistic
    setModelBusy(true);
    setModelMsg(null);
    try {
      const r = await fetch('/api/admin/tools/vid-gen/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetModel: next }),
      });
      const d = await r.json();
      if (d.ok) {
        setModelMsg(`Saved — new prompts will tag as ${next === 'veo-lite' ? 'Veo Lite' : 'Veo Omni'}`);
      } else {
        setTargetModel(prev);        // rollback
        setModelMsg(d.error || 'Failed');
      }
    } catch (e) {
      setTargetModel(prev);
      setModelMsg((e as Error).message);
    } finally {
      setModelBusy(false);
    }
  };

  // Save suffix config. Called from both the explicit Save button and
  // implicitly when the toggle flips, so flipping the switch never
  // needs a second click.
  // Persist auto-refill settings. Like saveSuffix, can be called from
  // the toggle (saves immediately) or the Save button (saves all dirty
  // fields together).
  const saveAutoRefill = async (next: {
    autoTheme?: string; autoRefillEnabled?: boolean;
    autoRefillThreshold?: number; autoRefillTarget?: number;
  }) => {
    setAutoBusy(true);
    setAutoMsg(null);
    try {
      const r = await fetch('/api/admin/tools/vid-gen/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(next),
      });
      const d = await r.json();
      if (d.ok) {
        setAutoTheme(d.autoTheme || '');
        setAutoRefillEnabled(!!d.autoRefillEnabled);
        setAutoRefillThreshold(typeof d.autoRefillThreshold === 'number' ? d.autoRefillThreshold : 500);
        setAutoRefillTarget(typeof d.autoRefillTarget === 'number' ? d.autoRefillTarget : 500);
        setAutoDirty(false);
        setAutoMsg(d.autoRefillEnabled ? 'Saved — auto-refill active' : 'Saved — auto-refill disabled');
      } else {
        setAutoMsg(d.error || 'Failed');
      }
    } catch (e) {
      setAutoMsg((e as Error).message);
    } finally {
      setAutoBusy(false);
    }
  };

  const saveSuffix = async (next: { suffix?: string; suffixEnabled?: boolean }) => {
    setSuffixBusy(true);
    setSuffixMsg(null);
    try {
      const r = await fetch('/api/admin/tools/vid-gen/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(next),
      });
      const d = await r.json();
      if (d.ok) {
        setSuffix(d.suffix || '');
        setSuffixEnabled(!!d.suffixEnabled);
        setSuffixDirty(false);
        setSuffixMsg(d.suffixEnabled ? 'Saved — suffix active' : 'Saved — suffix disabled');
      } else {
        setSuffixMsg(d.error || 'Failed');
      }
    } catch (e) {
      setSuffixMsg((e as Error).message);
    } finally {
      setSuffixBusy(false);
    }
  };

  const handleAddManual = async () => {
    // Split on newlines so the operator can paste multiple prompts
    // at once. Each non-blank line becomes one prompt.
    const prompts = manualInput
      .split(/\r?\n/)
      .map(s => s.trim())
      .filter(s => s.length > 0);
    if (prompts.length === 0) { setAddMsg('Paste at least one non-blank line'); return; }
    setAddBusy(true);
    setAddMsg(null);
    try {
      const r = await fetch('/api/admin/tools/vid-gen', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompts }),
      });
      const d = await r.json();
      if (d.ok) {
        setAddMsg(`Added ${d.added} (${d.skipped} duplicates skipped)`);
        setManualInput('');
        fetchPrompts();
      } else {
        setAddMsg(d.error || 'Failed');
      }
    } finally {
      setAddBusy(false);
    }
  };

  const handleGenerate = async () => {
    setGenBusy(true);
    setGenMsg(null);
    try {
      const r = await fetch('/api/admin/tools/vid-gen/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          count: genCount,
          theme: genTheme.trim() || undefined,
          background: genBg,
          concurrency: genConcurrency,
        }),
      });
      const d = await r.json();
      if (d.ok) {
        setActiveRunId(d.runId);
        if (d.mode === 'background') {
          setGenMsg(`Background run started (${d.concurrency} workers). Watching ${d.runId.slice(0, 8)}…`);
        } else {
          setGenMsg(`Sync done — inserted ${d.inserted}/${d.requested}, ${d.duplicates} dupes, ${d.batchesFailed}/${d.batches} batches failed.`);
        }
        fetchPrompts();
        fetchRuns();
      } else {
        setGenMsg(d.error || 'Failed');
      }
    } catch (e) {
      setGenMsg((e as Error).message);
    } finally {
      setGenBusy(false);
    }
  };

  const handleDelete = async (id: number) => {
    if (!confirm('Delete this prompt?')) return;
    await fetch('/api/admin/tools/vid-gen', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [id] }),
    });
    fetchPrompts();
  };

  // Wipe every unserved prompt in one shot. Useful for resetting a
  // bad batch (off-theme, low-quality, etc.) before regenerating.
  const [clearBusy, setClearBusy] = useState(false);
  const handleClearAvailable = async () => {
    if (!counts || counts.available === 0) return;
    if (!confirm(`Delete all ${counts.available} available prompts? This can't be undone.`)) return;
    setClearBusy(true);
    try {
      await fetch('/api/admin/tools/vid-gen', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clearStatus: 'available' }),
      });
      fetchPrompts();
    } finally {
      setClearBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl sm:text-2xl font-bold text-white mb-2">Vid Gen — Prompt Queue</h2>
        <p className="text-sm text-gray-400">
          Manages <code className="text-rose-300">video_prompts</code>. Clients pop one at a time via{' '}
          <code className="text-rose-300">GET /api/video_prompt</code> (returns 503 when empty).
        </p>
      </div>

      {/* Stats strip + bulk actions */}
      {counts && (
        <div className="space-y-2">
          <div className="grid grid-cols-2 sm:grid-cols-6 gap-3">
            <StatBox label="Available" value={counts.available} accent="text-emerald-400" />
            <StatBox label="Reserved"  value={counts.reserved}  accent="text-amber-400" />
            <StatBox label="Confirmed" value={counts.confirmed} accent="text-zinc-400" />
            <StatBox label="Manual"    value={counts.manual}    accent="text-blue-400" />
            <StatBox label="AI-gen"    value={counts.ai}        accent="text-rose-400" />
            <StatBox label="Total"     value={counts.total}     accent="text-white" />
          </div>
          <div className="flex justify-end">
            <button
              type="button"
              disabled={clearBusy || counts.available === 0}
              onClick={handleClearAvailable}
              className="px-3 py-1 text-xs font-medium text-red-300 border border-red-500/30 rounded-md hover:bg-red-500/10 hover:border-red-500/60 transition disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {clearBusy ? 'Clearing…' : `Clear ${counts.available} available`}
            </button>
          </div>
        </div>
      )}

      {/* Global suffix — appended to every served prompt when enabled.
          Toggle saves immediately so flipping it never needs a second
          click; edits to the text require pressing Save. */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
        <div className="flex items-center justify-between mb-2">
          <div>
            <h3 className="text-sm font-semibold text-white">Global suffix</h3>
            <p className="text-xs text-gray-500 mt-0.5">
              Appended to every served prompt while enabled — for style modifiers like{' '}
              <code className="text-rose-300">, photoreal, cinematic 8k</code>. Stored rows stay clean.
            </p>
          </div>
          <label className="flex items-center gap-2 text-xs text-gray-300 cursor-pointer select-none whitespace-nowrap">
            <input
              type="checkbox"
              checked={suffixEnabled}
              disabled={suffixBusy}
              onChange={e => {
                const next = e.target.checked;
                setSuffixEnabled(next);
                // Persist toggle immediately, sending the current text too
                // so an unsaved edit doesn't get clobbered by the toggle.
                saveSuffix({ suffixEnabled: next, suffix });
              }}
              className="accent-rose-500 w-4 h-4"
            />
            <span className={suffixEnabled ? 'text-emerald-300 font-medium' : 'text-gray-400'}>
              {suffixEnabled ? 'Enabled' : 'Disabled'}
            </span>
          </label>
        </div>
        <input
          type="text"
          value={suffix}
          onChange={e => { setSuffix(e.target.value); setSuffixDirty(true); }}
          placeholder=", photoreal, cinematic, 8k, shot on Arri"
          className="w-full px-3 py-2 text-sm bg-black border border-gray-800 rounded-md text-white placeholder-gray-600 focus:outline-none focus:border-rose-500/50 font-mono"
        />
        <div className="flex items-center justify-between mt-2 gap-3">
          <span className="text-xs text-gray-500 truncate">
            {suffix.trim() && suffixEnabled
              ? <>Preview: <span className="text-gray-300">&lt;prompt&gt;{/^[,.;:!?]/.test(suffix.trim()) ? '' : ' '}{suffix.trim()}</span></>
              : <>{suffix.length}/500 chars</>}
          </span>
          <div className="flex items-center gap-2">
            {suffixMsg && <span className="text-xs text-rose-300">{suffixMsg}</span>}
            <button
              type="button"
              disabled={suffixBusy || !suffixDirty}
              onClick={() => saveSuffix({ suffix, suffixEnabled })}
              className="px-4 py-1.5 text-xs font-semibold bg-rose-500 text-white rounded-md hover:bg-rose-400 transition disabled:opacity-50"
            >
              {suffixBusy ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </div>

      {/* Target render model — Veo Lite vs Veo Omni. Stamped onto every
          new prompt row at insert time and returned to clients in the
          public /api/video_prompt response. Lets clients route each
          prompt to the right Veo flavour without a second lookup.
          Changing the dropdown only affects future inserts; existing
          rows keep what they were originally stamped with. */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-semibold text-white">Render model for new prompts</h3>
            <p className="text-xs text-gray-500 mt-0.5">
              Which Veo flavour clients will use to render each prompt. Sent back
              with every <code className="text-rose-300">GET /api/video_prompt</code>{' '}
              response as <code className="text-rose-300">model</code>. Switching here
              only tags prompts generated <em>after</em> the change.
            </p>
          </div>
          <div className="flex items-center gap-2 whitespace-nowrap">
            <select
              value={targetModel}
              disabled={modelBusy}
              onChange={e => saveTargetModel(e.target.value as TargetModel)}
              className="px-3 py-1.5 text-xs bg-black border border-gray-800 rounded-md text-white focus:outline-none focus:border-rose-500/50"
            >
              <option value="veo-omni">Veo Omni</option>
              <option value="veo-lite">Veo Lite</option>
            </select>
            {modelBusy && <span className="text-xs text-gray-500">Saving…</span>}
          </div>
        </div>
        {modelMsg && (
          <div className="mt-2 text-xs text-emerald-300">{modelMsg}</div>
        )}
      </div>

      {/* Auto-refill — keeps the queue topped up automatically using a
          saved theme. Triggered lazily on every /api/video_prompt pop:
          if available drops below threshold, fires a background gen of
          target prompts. */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h3 className="text-sm font-semibold text-white">Auto-refill</h3>
            <p className="text-xs text-gray-500 mt-0.5">
              When available drops below threshold, automatically generate more using the saved theme.
            </p>
          </div>
          <label className="flex items-center gap-2 text-xs text-gray-300 cursor-pointer select-none whitespace-nowrap">
            <input
              type="checkbox"
              checked={autoRefillEnabled}
              disabled={autoBusy}
              onChange={e => {
                const next = e.target.checked;
                setAutoRefillEnabled(next);
                // Persist toggle immediately, sending current text/numbers
                // too so an unsaved edit doesn't get clobbered.
                saveAutoRefill({
                  autoRefillEnabled: next,
                  autoTheme,
                  autoRefillThreshold,
                  autoRefillTarget,
                });
              }}
              className="accent-rose-500 w-4 h-4"
            />
            <span className={autoRefillEnabled ? 'text-emerald-300 font-medium' : 'text-gray-400'}>
              {autoRefillEnabled ? 'Enabled' : 'Disabled'}
            </span>
          </label>
        </div>
        <div className="space-y-2.5">
          <div>
            <label className="text-xs text-gray-400 block mb-1">Saved theme</label>
            <textarea
              value={autoTheme}
              onChange={e => { setAutoTheme(e.target.value); setAutoDirty(true); }}
              placeholder="optional — e.g. 'AI faceless YT shorts about urban legends'"
              rows={2}
              className="w-full px-3 py-2 text-sm bg-black border border-gray-800 rounded-md text-white placeholder-gray-600 focus:outline-none focus:border-rose-500/50"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-gray-400 block mb-1">Threshold (min available)</label>
              <input
                type="number" min={0} max={10000}
                value={autoRefillThreshold}
                onChange={e => {
                  const v = Math.max(0, Math.min(10000, parseInt(e.target.value) || 0));
                  setAutoRefillThreshold(v); setAutoDirty(true);
                }}
                className="w-full px-3 py-2 text-sm bg-black border border-gray-800 rounded-md text-white focus:outline-none focus:border-rose-500/50"
              />
            </div>
            <div>
              <label className="text-xs text-gray-400 block mb-1">Target (prompts per refill)</label>
              <input
                type="number" min={1} max={1000}
                value={autoRefillTarget}
                onChange={e => {
                  const v = Math.max(1, Math.min(1000, parseInt(e.target.value) || 1));
                  setAutoRefillTarget(v); setAutoDirty(true);
                }}
                className="w-full px-3 py-2 text-sm bg-black border border-gray-800 rounded-md text-white focus:outline-none focus:border-rose-500/50"
              />
            </div>
          </div>
        </div>
        <div className="flex items-center justify-between mt-3 gap-3">
          <span className="text-xs text-gray-500 truncate">
            {autoRefillEnabled
              ? <>Will refill to <span className="text-gray-300">+{autoRefillTarget}</span> when available drops below <span className="text-gray-300">{autoRefillThreshold}</span></>
              : <>{autoTheme.length}/2000 chars</>}
          </span>
          <div className="flex items-center gap-2">
            {autoMsg && <span className="text-xs text-rose-300">{autoMsg}</span>}
            <button
              type="button"
              disabled={autoBusy || !autoDirty}
              onClick={() => saveAutoRefill({ autoTheme, autoRefillEnabled, autoRefillThreshold, autoRefillTarget })}
              className="px-4 py-1.5 text-xs font-semibold bg-rose-500 text-white rounded-md hover:bg-rose-400 transition disabled:opacity-50"
            >
              {autoBusy ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </div>

      {/* Add manual + AI gen forms — side-by-side on desktop */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <h3 className="text-sm font-semibold text-white mb-2">Add prompts manually</h3>
          <p className="text-xs text-gray-500 mb-3">One prompt per line. Pastes a whole batch at once. Duplicates skipped.</p>
          <textarea
            value={manualInput}
            onChange={e => setManualInput(e.target.value)}
            placeholder={'A red panda balancing on a unicycle through a neon-lit Tokyo alley\nMacro shot of raindrops bouncing off a sunflower petal'}
            rows={6}
            className="w-full px-3 py-2 text-sm bg-black border border-gray-800 rounded-md text-white placeholder-gray-600 focus:outline-none focus:border-rose-500/50 font-mono"
          />
          <div className="flex items-center justify-between mt-2">
            <span className="text-xs text-gray-500">{manualInput.split(/\r?\n/).filter(s => s.trim()).length} lines</span>
            <div className="flex items-center gap-2">
              {addMsg && <span className="text-xs text-rose-300">{addMsg}</span>}
              <button
                type="button"
                disabled={addBusy || !manualInput.trim()}
                onClick={handleAddManual}
                className="px-4 py-1.5 text-xs font-semibold bg-rose-500 text-white rounded-md hover:bg-rose-400 transition disabled:opacity-50"
              >
                {addBusy ? 'Adding…' : 'Add'}
              </button>
            </div>
          </div>
        </div>

        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <h3 className="text-sm font-semibold text-white mb-2">Bulk-generate via Gemini</h3>
          <p className="text-xs text-gray-500 mb-3">Uses a random active <code>google_ai_studio</code> key. 25/batch. Background mode for &gt; 50.</p>
          <div className="space-y-2.5">
            <div className="flex items-center gap-2">
              <label className="text-xs text-gray-400 w-20">Count</label>
              <input
                type="number"
                min={1}
                max={1000}
                value={genCount}
                onChange={e => setGenCount(Math.max(1, Math.min(1000, parseInt(e.target.value) || 1)))}
                className="w-24 px-2 py-1 text-sm bg-black border border-gray-800 rounded-md text-white focus:outline-none focus:border-rose-500/50"
              />
              <label className="text-xs text-gray-400 ml-3 flex items-center gap-1.5 cursor-pointer">
                <input type="checkbox" checked={genBg} onChange={e => setGenBg(e.target.checked)} className="accent-rose-500" />
                Background
              </label>
              {genBg && (
                <>
                  <label className="text-xs text-gray-400 ml-3">Workers</label>
                  <input
                    type="number"
                    min={1}
                    max={12}
                    value={genConcurrency}
                    onChange={e => setGenConcurrency(Math.max(1, Math.min(12, parseInt(e.target.value) || 1)))}
                    className="w-16 px-2 py-1 text-sm bg-black border border-gray-800 rounded-md text-white focus:outline-none focus:border-rose-500/50"
                  />
                </>
              )}
            </div>
            <div className="flex items-center gap-2">
              <label className="text-xs text-gray-400 w-20">Theme</label>
              <input
                type="text"
                value={genTheme}
                onChange={e => setGenTheme(e.target.value)}
                placeholder={autoTheme.trim() ? 'leave empty to use saved Auto-refill theme' : "optional — e.g. 'urban legend horror shorts'"}
                className="flex-1 px-2 py-1 text-sm bg-black border border-gray-800 rounded-md text-white placeholder-gray-600 focus:outline-none focus:border-rose-500/50"
              />
            </div>
            {/* Hint: when the user has a saved theme but the bulk input
                is empty, the server will fall back to the saved theme.
                Without this hint the operator can't tell whether their
                manual generation will inherit the steering. */}
            {autoTheme.trim() && !genTheme.trim() && (
              <div className="text-[11px] text-emerald-300/80 pl-[5.5rem]">
                Will use saved Auto-refill theme ({autoTheme.trim().length} chars).
              </div>
            )}
          </div>
          <div className="flex items-center justify-between mt-3">
            {genMsg && <span className="text-xs text-rose-300 truncate flex-1 mr-3">{genMsg}</span>}
            <button
              type="button"
              disabled={genBusy}
              onClick={handleGenerate}
              className="px-4 py-1.5 text-xs font-semibold bg-rose-500 text-white rounded-md hover:bg-rose-400 transition disabled:opacity-50 ml-auto"
            >
              {genBusy ? 'Generating…' : `Generate ${genCount}`}
            </button>
          </div>
        </div>
      </div>

      {/* Recent AI-gen runs */}
      {runs.length > 0 && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <h3 className="text-sm font-semibold text-white mb-2">Recent generation runs</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-gray-500 uppercase">
                <tr>
                  <th className="px-2 py-1 text-left font-medium">When</th>
                  <th className="px-2 py-1 text-left font-medium">Mode</th>
                  <th className="px-2 py-1 text-left font-medium">Status</th>
                  <th className="px-2 py-1 text-right font-medium">Inserted/Req</th>
                  <th className="px-2 py-1 text-right font-medium">Dupes</th>
                  <th className="px-2 py-1 text-right font-medium">Batches ok/fail</th>
                  <th className="px-2 py-1 text-left font-medium">Theme</th>
                  <th className="px-2 py-1 text-left font-medium">Last error</th>
                </tr>
              </thead>
              <tbody>
                {runs.map(r => {
                  const pct = r.countRequested > 0
                    ? Math.round((r.countInserted / r.countRequested) * 100)
                    : 0;
                  const elapsed = r.completedAt
                    ? Math.max(0, (new Date(r.completedAt).getTime() - new Date(r.startedAt).getTime()) / 1000)
                    : Math.max(0, (Date.now() - new Date(r.startedAt).getTime()) / 1000);
                  return (
                    <tr key={r.id} className={`border-t border-gray-800/60 ${r.status === 'running' ? 'bg-rose-500/5' : ''}`}>
                      <td className="px-2 py-1.5 text-gray-300">
                        <span title={r.startedAt}>{r.startedAt.slice(11, 19)}</span>
                        <span className="text-gray-500 ml-1.5">({elapsed.toFixed(0)}s)</span>
                      </td>
                      <td className="px-2 py-1.5 text-gray-400">
                        {r.mode}{r.mode === 'background' && r.concurrency > 1 ? `×${r.concurrency}` : ''}
                      </td>
                      <td className="px-2 py-1.5">
                        <span className={
                          r.status === 'done'    ? 'text-emerald-400' :
                          r.status === 'failed'  ? 'text-red-400' :
                          'text-amber-400 animate-pulse'
                        }>{r.status}</span>
                      </td>
                      <td className="px-2 py-1.5 text-right font-mono">
                        <span className="text-white">{r.countInserted}</span>
                        <span className="text-gray-500">/{r.countRequested}</span>
                        <span className="text-gray-500 ml-1.5">({pct}%)</span>
                      </td>
                      <td className="px-2 py-1.5 text-right text-gray-400 font-mono">{r.countDuplicates}</td>
                      <td className="px-2 py-1.5 text-right text-gray-400 font-mono">
                        {r.batchesTotal - r.batchesFailed}/<span className={r.batchesFailed > 0 ? 'text-red-400' : 'text-gray-400'}>{r.batchesFailed}</span>
                      </td>
                      <td className="px-2 py-1.5 text-gray-500 max-w-[160px] truncate" title={r.theme || ''}>{r.theme || '—'}</td>
                      <td className="px-2 py-1.5 text-red-300 max-w-[260px] truncate font-mono text-[10px]" title={r.lastError || ''}>{r.lastError || '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-1.5">
          {(['available','reserved','confirmed','all'] as const).map(s => (
            <button
              key={s}
              onClick={() => { setStatusFilter(s); setPage(0); }}
              className={`px-3 py-1 text-xs rounded-full transition ${
                statusFilter === s ? 'bg-white text-black font-medium' : 'text-gray-400 border border-gray-700 hover:text-white'
              }`}
            >
              {s}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1.5">
          {(['all','manual','ai-generated'] as const).map(s => (
            <button
              key={s}
              onClick={() => { setSourceFilter(s); setPage(0); }}
              className={`px-3 py-1 text-xs rounded-full transition ${
                sourceFilter === s ? 'bg-white text-black font-medium' : 'text-gray-400 border border-gray-700 hover:text-white'
              }`}
            >
              {s === 'ai-generated' ? 'AI' : s}
            </button>
          ))}
        </div>
        <input
          type="text"
          value={search}
          onChange={e => { setSearch(e.target.value); setPage(0); }}
          placeholder="Search prompt text…"
          className="flex-1 min-w-[200px] px-3 py-1.5 text-xs bg-black border border-gray-800 rounded-md text-white placeholder-gray-600 focus:outline-none focus:border-rose-500/50"
        />
      </div>

      {/* Prompts table */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
        {loading && prompts.length === 0 && (
          <div className="px-5 py-8 text-center text-sm text-gray-500">Loading…</div>
        )}
        {!loading && prompts.length === 0 && (
          <div className="px-5 py-12 text-center text-sm text-gray-500">
            No prompts match this filter. Add some above or trigger AI generation.
          </div>
        )}
        {prompts.length > 0 && (
          <table className="w-full text-sm">
            <thead className="bg-gray-950/60 text-xs text-gray-500 uppercase">
              <tr>
                <th className="px-4 py-2 text-left font-medium">Prompt</th>
                <th className="px-4 py-2 text-left font-medium w-28">Source</th>
                <th className="px-4 py-2 text-left font-medium w-32">Created</th>
                <th className="px-4 py-2 text-left font-medium w-32">Status</th>
                <th className="px-4 py-2 text-right font-medium w-20"></th>
              </tr>
            </thead>
            <tbody>
              {prompts.map(p => (
                <tr key={p.id} className="border-t border-gray-800/60 hover:bg-gray-800/30">
                  <td className="px-4 py-2 text-gray-200 max-w-md">
                    <div className="line-clamp-2">{p.prompt}</div>
                  </td>
                  <td className="px-4 py-2">
                    <span className={`text-[10px] uppercase tracking-wider font-medium ${
                      p.source === 'ai-generated' ? 'text-rose-400' : 'text-blue-400'
                    }`}>{p.source === 'ai-generated' ? 'AI' : p.source}</span>
                  </td>
                  <td className="px-4 py-2 text-xs text-gray-500">
                    {new Date(p.createdAt).toLocaleDateString()}
                  </td>
                  <td className="px-4 py-2 text-xs">
                    {p.servedAt
                      ? <span className="text-gray-500">served {new Date(p.servedAt).toLocaleDateString()}</span>
                      : <span className="text-emerald-400">available</span>}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <button
                      type="button"
                      onClick={() => handleDelete(p.id)}
                      className="text-xs text-red-400 hover:text-red-300"
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Pagination */}
      <div className="flex items-center justify-between">
        <button
          type="button"
          disabled={page === 0}
          onClick={() => setPage(p => Math.max(0, p - 1))}
          className="px-3 py-1.5 text-xs text-gray-400 border border-gray-700 rounded-md hover:text-white disabled:opacity-30 disabled:cursor-not-allowed"
        >
          ← Prev
        </button>
        <span className="text-xs text-gray-500">Page {page + 1}</span>
        <button
          type="button"
          disabled={prompts.length < limit}
          onClick={() => setPage(p => p + 1)}
          className="px-3 py-1.5 text-xs text-gray-400 border border-gray-700 rounded-md hover:text-white disabled:opacity-30 disabled:cursor-not-allowed"
        >
          Next →
        </button>
      </div>
    </div>
  );
}

function StatBox({ label, value, accent }: { label: string; value: number; accent: string }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg px-4 py-3">
      <div className="text-[10px] uppercase tracking-wider text-gray-500 font-medium">{label}</div>
      <div className={`text-xl font-bold ${accent} mt-1 font-mono`}>{value.toLocaleString()}</div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────
 *  Embedding requests tab — admin surface for custom-niche owners
 *  who can't cluster because their niche lacks enough of a given
 *  embedding source. Each pending row is a group of videos awaiting
 *  embedding generation.
 * ──────────────────────────────────────────────────────────────── */
interface EmbedRequest {
  id: number;
  customNicheId: number;
  nicheName: string | null;
  nicheDescription: string | null;
  source: string;
  videoCount: number;
  processed: number;
  errors: number;
  requestedBy: string | null;
  requesterLabel: string | null;
  status: 'pending' | 'processing' | 'done' | 'failed' | 'dismissed';
  note: string | null;
  createdAt: string;
  processedAt: string | null;
}

function EmbedReqsTab({ active }: { active: boolean }) {
  const [requests, setRequests] = useState<EmbedRequest[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  // 'active' = pending OR processing — what the operator usually wants
  // to see. Keeps a row visible after Process is clicked (status flips
  // to processing immediately, a pending-only filter would hide it).
  const [statusFilter, setStatusFilter] = useState<'active' | 'all'>('active');
  const [loading, setLoading] = useState(false);
  const [updateBusy, setUpdateBusy] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`/api/admin/embedding-requests?status=${statusFilter}&limit=100`);
      const d = await r.json();
      if (d.ok) {
        setRequests(d.requests || []);
        setCounts(d.counts || {});
      }
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => {
    if (!active) return;
    load();
  }, [active, load]);

  // Poll while anything is processing. 2s cadence is brisk enough that
  // the "x/62 processed" counter looks live without spamming the DB.
  useEffect(() => {
    if (!active) return;
    const anyProcessing = requests.some(r => r.status === 'processing');
    if (!anyProcessing) return;
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, [active, requests, load]);

  const updateStatus = async (id: number, status: EmbedRequest['status']) => {
    setUpdateBusy(id);
    try {
      await fetch('/api/admin/embedding-requests', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, status }),
      });
      await load();
    } finally {
      setUpdateBusy(null);
    }
  };

  // Kicks off the embedding job in the background. POST returns
  // immediately with status='processing'; the worker writes incremental
  // progress to embedding_requests.processed/.errors/.note and the poll
  // effect above keeps the row's progress cell live.
  const processRequest = async (id: number) => {
    setUpdateBusy(id);
    try {
      const r = await fetch(`/api/admin/embedding-requests/${id}/process`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      const d = await r.json();
      if (!r.ok || d.ok === false) {
        alert(`Process failed: ${d.error || `HTTP ${r.status}`}`);
      }
      await load();
    } finally {
      setUpdateBusy(null);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl sm:text-2xl font-bold text-white mb-2">Embedding Requests</h2>
        <p className="text-sm text-gray-400">
          Custom-niche owners file these when they want to cluster by a source
          that's not computed for enough of their niche's videos. Pending rows
          show what's queued; mark them <span className="text-emerald-400">done</span> once the
          embeddings exist (the embedding pipeline lives in <code className="text-cyan-300">lib/embeddings.ts</code>).
        </p>
      </div>

      {/* Counts row */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        <StatBox label="Pending"    value={counts.pending    ?? 0} accent="text-amber-400" />
        <StatBox label="Processing" value={counts.processing ?? 0} accent="text-cyan-400" />
        <StatBox label="Done"       value={counts.done       ?? 0} accent="text-emerald-400" />
        <StatBox label="Failed"     value={counts.failed     ?? 0} accent="text-red-400" />
        <StatBox label="Dismissed"  value={counts.dismissed  ?? 0} accent="text-zinc-400" />
      </div>

      {/* Status filter pills */}
      <div className="flex items-center gap-1.5">
        {(['active', 'all'] as const).map(s => (
          <button
            key={s}
            onClick={() => setStatusFilter(s)}
            className={`px-3 py-1 text-xs rounded-full transition ${
              statusFilter === s ? 'bg-white text-black font-medium' : 'text-gray-400 border border-gray-700 hover:text-white'
            }`}
          >
            {s}
          </button>
        ))}
      </div>

      {/* Requests table */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
        {loading && requests.length === 0 && (
          <div className="px-5 py-8 text-center text-sm text-gray-500">Loading…</div>
        )}
        {!loading && requests.length === 0 && (
          <div className="px-5 py-12 text-center text-sm text-gray-500">
            No {statusFilter === 'all' ? '' : statusFilter} requests.
          </div>
        )}
        {requests.length > 0 && (
          <table className="w-full text-sm">
            <thead className="bg-gray-950/60 text-xs text-gray-500 uppercase">
              <tr>
                <th className="px-4 py-2 text-left font-medium">When</th>
                <th className="px-4 py-2 text-left font-medium">Niche</th>
                <th className="px-4 py-2 text-left font-medium w-32">Source</th>
                <th className="px-4 py-2 text-right font-medium w-24">Videos</th>
                <th className="px-4 py-2 text-left font-medium">Requester</th>
                <th className="px-4 py-2 text-left font-medium w-28">Status</th>
                <th className="px-4 py-2 text-right font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {requests.map(r => (
                <tr key={r.id} className="border-t border-gray-800/60 hover:bg-gray-950/40">
                  <td className="px-4 py-2 text-xs text-gray-400 whitespace-nowrap">
                    {new Date(r.createdAt).toLocaleString()}
                  </td>
                  <td className="px-4 py-2">
                    <a
                      href={`/niche/custom/${r.customNicheId}`}
                      target="_blank" rel="noreferrer"
                      className="text-cyan-300 hover:text-cyan-200 underline underline-offset-2"
                    >
                      {r.nicheName || `#${r.customNicheId}`}
                    </a>
                    {r.nicheDescription && (
                      <div className="text-[10px] text-gray-500 truncate max-w-[280px]" title={r.nicheDescription}>
                        {r.nicheDescription}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-2">
                    <span className="px-2 py-0.5 text-[10px] rounded-full bg-amber-500/15 text-amber-300 border border-amber-500/30 font-mono">
                      {r.source}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-right font-mono text-white">{r.videoCount}</td>
                  <td className="px-4 py-2 text-xs text-gray-400" title={r.requestedBy || ''}>
                    {r.requesterLabel || r.requestedBy?.slice(0, 12) || '—'}
                  </td>
                  <td className="px-4 py-2">
                    <div className={`text-xs ${
                      r.status === 'pending'    ? 'text-amber-400' :
                      r.status === 'processing' ? 'text-cyan-400 animate-pulse' :
                      r.status === 'done'       ? 'text-emerald-400' :
                      r.status === 'failed'     ? 'text-red-400' :
                                                  'text-zinc-500'
                    }`}>{r.status}</div>
                    {/* Live progress while processing; final counts
                        once done/failed. Note tooltip surfaces the
                        full per-batch summary from the worker. */}
                    {(r.status === 'processing' || r.status === 'done' || r.status === 'failed') && (
                      <div className="text-[10px] text-gray-500 mt-0.5 font-mono" title={r.note || ''}>
                        {r.processed}/{r.videoCount}
                        {r.errors > 0 && <span className="text-red-400 ml-1">· {r.errors} err</span>}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-2 text-right whitespace-nowrap">
                    {r.status === 'pending' && (
                      <>
                        {/* Primary action — runs the embedding job
                            against the request's video_ids + source
                            inline. Synchronous; the row flips to
                            done/failed when this returns. */}
                        <button
                          type="button"
                          disabled={updateBusy === r.id}
                          onClick={() => processRequest(r.id)}
                          className="px-2 py-0.5 text-[10px] font-semibold text-black bg-amber-400 rounded hover:bg-amber-300 transition mr-1.5 disabled:opacity-50"
                        >
                          {updateBusy === r.id ? 'Processing…' : `Process ${r.videoCount}`}
                        </button>
                        <button
                          type="button"
                          disabled={updateBusy === r.id}
                          onClick={() => updateStatus(r.id, 'dismissed')}
                          className="px-2 py-0.5 text-[10px] text-zinc-400 border border-zinc-700 rounded hover:bg-zinc-800 transition disabled:opacity-50"
                        >
                          Dismiss
                        </button>
                      </>
                    )}
                    {r.status === 'processing' && (
                      <>
                        <button
                          type="button"
                          disabled={updateBusy === r.id}
                          onClick={() => updateStatus(r.id, 'done')}
                          className="px-2 py-0.5 text-[10px] text-emerald-300 border border-emerald-500/30 rounded hover:bg-emerald-500/10 transition mr-1.5 disabled:opacity-50"
                        >
                          Mark done
                        </button>
                        <button
                          type="button"
                          disabled={updateBusy === r.id}
                          onClick={() => updateStatus(r.id, 'failed')}
                          className="px-2 py-0.5 text-[10px] text-red-300 border border-red-500/30 rounded hover:bg-red-500/10 transition disabled:opacity-50"
                        >
                          Mark failed
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
// Analyze Vids tab — operator UI for the video-analysis pipeline.
//
// Top: enqueue form (custom niche + user email + limit + concurrency).
// Stats strip: pending / running / done / error.
// Filters: niche pill, status pills, recency selector.
// Job list: one row per video. Click to expand and see per-clip
// progress + attempt history.
// ────────────────────────────────────────────────────────────────────
interface AnalyzeVidsJob {
  id: number;
  videoId: number | null;
  customNicheId: number | null;
  userId: string | null;
  youtubeUrl: string;
  title: string | null;
  durationS: number | null;
  numClips: number;
  numClipsDone: number;
  numClipsFailed: number;
  totalSegments: number | null;
  status: string;
  stage: string | null;
  errorMessage: string | null;
  startedAt: string | null;
  completedAt: string | null;
  lastProgressAt: string | null;
  createdAt: string;
  autoRetryCount?: number;
  lastAutoRetryAt?: string | null;
}
interface AnalyzeVidsStats { pending: number; running: number; done: number; error: number; total: number; }
interface AnalyzeVidsClip {
  id: number;
  clipIndex: number;
  durationS: number | null;
  sizeBytes: number | null;
  status: string;
  attempts: Array<{ n: number; elapsed_s: number; category: string; http_status: number | null; detail: string | null }>;
  attemptCount: number;
  segmentsCount: number | null;
  errorCategory: string | null;
  errorDetail: string | null;
  hasRawDebug: boolean;
  elapsedS: number | null;
  startedAt: string | null;
  completedAt: string | null;
}

function AnalyzeVidsTab({ active }: { active: boolean }) {
  const [rows, setRows] = useState<AnalyzeVidsJob[]>([]);
  const [stats, setStats] = useState<AnalyzeVidsStats>({ pending: 0, running: 0, done: 0, error: 0, total: 0 });
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Enqueue form state.
  const [customNiches, setCustomNiches] = useState<Array<{ id: number; name: string; videoCount: number }>>([]);
  const [pickNicheId, setPickNicheId] = useState<number | ''>('');
  const [userEmail, setUserEmail] = useState('sigadiga@gmail.com');
  const [enqueueLimit, setEnqueueLimit] = useState(10);
  const [concurrentStarts, setConcurrentStarts] = useState(5);
  const [skipAnalysed, setSkipAnalysed] = useState(true);

  // Filter state.
  const [filterNicheId, setFilterNicheId] = useState<number | ''>('');
  const [filterStatus, setFilterStatus] = useState<string>('all');   // all|active|done|error
  const [filterRecent, setFilterRecent] = useState<'24h' | '7d' | 'all'>('24h');

  // Per-row drill-in state — only fetch clips when expanded to keep
  // the list query cheap when the operator just glances.
  const [expandedJobId, setExpandedJobId] = useState<number | null>(null);
  const [expandedClips, setExpandedClips] = useState<AnalyzeVidsClip[]>([]);
  const [expandedLoading, setExpandedLoading] = useState(false);

  // Per-niche progress data (loaded when filterNicheId is set). Holds
  // both the rollup tiles and the per-video grid so we don't have to
  // refetch on filter changes inside the panel.
  interface NicheProgress {
    nicheName: string;
    totalVideos: number;
    statusCounts: { not_enqueued: number; pending: number; in_flight: number; done: number; error: number };
    doneWithFailures: number;
    clips: { analysed: number; expected: number; failed: number };
    totalSegments: number;
    perVideo: Array<{
      videoId: number; title: string | null; url: string;
      jobId: number | null; status: string;
      numClips: number | null; numClipsDone: number | null; numClipsFailed: number | null;
      totalSegments: number | null; durationS: number | null;
      startedAt: string | null; completedAt: string | null; errorMessage: string | null;
    }>;
  }
  const [nicheProgress, setNicheProgress] = useState<NicheProgress | null>(null);
  const [nicheProgressLoading, setNicheProgressLoading] = useState(false);
  // Per-video grid sub-filter (inside the niche progress panel).
  type PerVideoFilter = 'all' | 'not_enqueued' | 'in_flight' | 'done' | 'done_with_failures' | 'error';
  const [perVideoFilter, setPerVideoFilter] = useState<PerVideoFilter>('all');

  // Load custom niches once when the tab activates.
  useEffect(() => {
    if (!active) return;
    fetch('/api/niche-spy/custom-niches?limit=200')
      .then(r => r.json())
      .then(d => setCustomNiches(d.niches || d.rows || []))
      .catch(() => {});
  }, [active]);

  const loadJobs = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      if (filterNicheId !== '') qs.set('customNicheId', String(filterNicheId));
      if (filterStatus === 'active') qs.set('status', 'pending,downloading,splitting,analyzing,collapsing');
      else if (filterStatus === 'done')  qs.set('status', 'done');
      else if (filterStatus === 'error') qs.set('status', 'error');
      if (filterRecent !== 'all') {
        const h = filterRecent === '24h' ? 24 : 24 * 7;
        qs.set('since', new Date(Date.now() - h * 3600_000).toISOString());
      }
      qs.set('limit', '200');
      const r = await fetch(`/api/admin/analyze-vids/jobs?${qs.toString()}`);
      const d = await r.json();
      if (d.ok) {
        setRows(d.rows || []);
        setStats(d.stats || { pending: 0, running: 0, done: 0, error: 0, total: 0 });
      }
    } finally {
      setLoading(false);
    }
  }, [filterNicheId, filterStatus, filterRecent]);

  useEffect(() => { if (active) loadJobs(); }, [active, loadJobs]);

  // Live poll while the tab is active and anything is in flight.
  useEffect(() => {
    if (!active) return;
    if (stats.pending === 0 && stats.running === 0) return;
    const t = setInterval(loadJobs, 4000);
    return () => clearInterval(t);
  }, [active, stats.pending, stats.running, loadJobs]);

  // Niche progress loader. Fires whenever the niche filter changes,
  // and polls while anything is in flight within the niche.
  const loadNicheProgress = useCallback(async () => {
    if (filterNicheId === '') { setNicheProgress(null); return; }
    setNicheProgressLoading(true);
    try {
      const qs = new URLSearchParams();
      if (userEmail) qs.set('userEmail', userEmail);
      const r = await fetch(`/api/admin/analyze-vids/niches/${filterNicheId}/progress?${qs.toString()}`);
      const d = await r.json();
      if (d.ok) {
        setNicheProgress({
          nicheName: d.nicheName,
          totalVideos: d.totalVideos,
          statusCounts: d.statusCounts,
          doneWithFailures: d.doneWithFailures,
          clips: d.clips,
          totalSegments: d.totalSegments,
          perVideo: d.perVideo,
        });
      }
    } finally {
      setNicheProgressLoading(false);
    }
  }, [filterNicheId, userEmail]);

  useEffect(() => { if (active) loadNicheProgress(); }, [active, loadNicheProgress]);
  useEffect(() => {
    if (!active || filterNicheId === '' || !nicheProgress) return;
    const inFlight = nicheProgress.statusCounts.in_flight + nicheProgress.statusCounts.pending;
    if (inFlight === 0) return;
    const t = setInterval(loadNicheProgress, 5000);
    return () => clearInterval(t);
  }, [active, filterNicheId, nicheProgress, loadNicheProgress]);

  // Bulk: retry all failed clips across every job in the current niche
  // filter. The server resets error→pending and fires the first N
  // workers. Keeps already-done clips intact.
  const handleBulkRetryFailed = async () => {
    if (filterNicheId === '') { setErr('pick a niche in the filter first'); return; }
    if (!confirm('Retry all failed clips for every job in this niche? Already-done clips stay done.')) return;
    setBusy(true); setErr(null); setMsg(null);
    try {
      const r = await fetch('/api/admin/analyze-vids/retry-failed', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customNicheId: filterNicheId,
          userEmail: userEmail || undefined,
          concurrentStarts: 5,
        }),
      });
      const d = await r.json();
      if (!r.ok || d.ok === false) {
        setErr(d.error || `HTTP ${r.status}`);
      } else {
        setMsg(`Reset ${d.clipsReset} failed clip${d.clipsReset === 1 ? '' : 's'} across ${d.jobsReset} job${d.jobsReset === 1 ? '' : 's'} · ${d.started} starting now`);
        await Promise.all([loadJobs(), loadNicheProgress()]);
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // Bulk-enqueue every not-yet-analysed video in the filtered niche.
  // Convenience over the form (which caps at the user-set limit).
  const handleEnqueueRest = async () => {
    if (filterNicheId === '' || !nicheProgress) return;
    const remaining = nicheProgress.statusCounts.not_enqueued;
    if (remaining === 0) { setMsg('all videos in this niche already have a job'); return; }
    if (!confirm(`Enqueue ${remaining} not-yet-analysed video${remaining === 1 ? '' : 's'} from "${nicheProgress.nicheName}"?`)) return;
    setBusy(true); setErr(null); setMsg(null);
    try {
      const r = await fetch('/api/admin/analyze-vids/jobs', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customNicheId: filterNicheId,
          userEmail: userEmail || undefined,
          limit: remaining,
          concurrentStarts: 5,
          skipAnalysed: true,
          autoStart: true,
        }),
      });
      const d = await r.json();
      if (!r.ok || d.ok === false) setErr(d.error || `HTTP ${r.status}`);
      else {
        setMsg(`Enqueued ${d.created} new job${d.created === 1 ? '' : 's'} · ${d.startedNow} starting now`);
        await Promise.all([loadJobs(), loadNicheProgress()]);
      }
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  const handleEnqueue = async () => {
    if (pickNicheId === '') { setErr('pick a custom niche'); return; }
    setBusy(true); setErr(null); setMsg(null);
    try {
      const r = await fetch('/api/admin/analyze-vids/jobs', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customNicheId: pickNicheId,
          userEmail: userEmail || undefined,
          limit: enqueueLimit,
          concurrentStarts,
          skipAnalysed,
          autoStart: true,
        }),
      });
      const d = await r.json();
      if (!r.ok || d.ok === false) {
        setErr(d.error || `HTTP ${r.status}`);
      } else {
        setMsg(`Enqueued ${d.created} job${d.created === 1 ? '' : 's'}` + (d.skipped ? ` (skipped ${d.skipped} already-analysed)` : '') + (d.startedNow ? ` — ${d.startedNow} starting now` : ''));
        await loadJobs();
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const handleProcessPending = async () => {
    setBusy(true); setErr(null); setMsg(null);
    try {
      const r = await fetch('/api/admin/analyze-vids/process-pending', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ limit: 10 }),
      });
      const d = await r.json();
      if (d.ok) { setMsg(`Claimed ${d.claimed} job${d.claimed === 1 ? '' : 's'} to run.`); await loadJobs(); }
      else setErr(d.error || `HTTP ${r.status}`);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  const handleRetry = async (jobId: number) => {
    setBusy(true); setErr(null);
    try {
      const r = await fetch(`/api/admin/analyze-vids/jobs/${jobId}/retry`, { method: 'POST' });
      const d = await r.json();
      if (d.ok) { setMsg(`Retrying job ${jobId}`); await loadJobs(); }
      else setErr(d.error || `HTTP ${r.status}`);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  const handleCancel = async (jobId: number) => {
    if (!confirm(`Cancel job ${jobId}? Already-finished clips keep their results.`)) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/admin/analyze-vids/jobs/${jobId}/cancel`, { method: 'POST' });
      const d = await r.json();
      if (d.ok) await loadJobs(); else setErr(d.error || `HTTP ${r.status}`);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  const handleExpand = async (jobId: number) => {
    if (expandedJobId === jobId) { setExpandedJobId(null); setExpandedClips([]); return; }
    setExpandedJobId(jobId); setExpandedClips([]); setExpandedLoading(true);
    try {
      const r = await fetch(`/api/admin/analyze-vids/jobs/${jobId}`);
      const d = await r.json();
      if (d.ok) setExpandedClips(d.clips || []);
    } finally {
      setExpandedLoading(false);
    }
  };

  // Live poll the expanded job for clip-level progress too.
  useEffect(() => {
    if (!active || expandedJobId == null) return;
    const t = setInterval(() => { handleExpand(expandedJobId); }, 4000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, expandedJobId]);

  const STATUS_COLOUR: Record<string, string> = {
    pending: 'bg-zinc-500/15 text-zinc-300 border-zinc-500/30',
    downloading: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
    splitting: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
    analyzing: 'bg-teal-500/15 text-teal-300 border-teal-500/30',
    collapsing: 'bg-teal-500/15 text-teal-300 border-teal-500/30',
    done: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
    error: 'bg-red-500/15 text-red-300 border-red-500/30',
    cancelled: 'bg-zinc-500/15 text-zinc-400 border-zinc-500/30',
    not_enqueued: 'bg-[#1a1a1a] text-[#888] border-[#333]',
  };

  return (
    <div>
      {/* Header + brief explainer */}
      <div className="mb-6">
        <h2 className="text-base font-semibold text-white mb-1">Video analysis pipeline</h2>
        <p className="text-xs text-[#888] leading-relaxed max-w-3xl">
          Each job downloads one YouTube video, splits it into ~60 second clips, asks Gemini 2.5 Flash to describe what&apos;s happening in every second (visual + speech + audio), and stitches the result into a single timeline JSON. Runs through our key pool and proxies — no papaiapi. Roughly $0.045 per 14-min video.
        </p>
      </div>

      {/* Enqueue form */}
      <div className="mb-4 p-4 rounded-xl bg-[#0f0f0f] border border-[#1f1f1f]">
        <div className="text-xs font-semibold text-white mb-3">Enqueue new jobs</div>
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-[10px] text-[#888]">Source niche</span>
            <select
              value={pickNicheId}
              onChange={e => setPickNicheId(e.target.value === '' ? '' : parseInt(e.target.value))}
              className="px-2 py-1.5 text-xs bg-[#0a0a0a] border border-[#2a2a2a] rounded text-white min-w-[14rem]"
            >
              <option value="">— pick a custom niche —</option>
              {customNiches.map(n => (
                <option key={n.id} value={n.id}>
                  {n.name} ({n.videoCount ?? 0})
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-[10px] text-[#888]">User email</span>
            <input
              type="email" value={userEmail}
              onChange={e => setUserEmail(e.target.value)}
              placeholder="optional"
              className="px-2 py-1.5 text-xs bg-[#0a0a0a] border border-[#2a2a2a] rounded text-white min-w-[16rem]"
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-[10px] text-[#888]">Max jobs to create</span>
            <input
              type="number" min={1} max={1000} value={enqueueLimit}
              onChange={e => setEnqueueLimit(Math.max(1, Math.min(1000, parseInt(e.target.value) || 1)))}
              className="px-2 py-1.5 text-xs bg-[#0a0a0a] border border-[#2a2a2a] rounded text-white w-20"
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-[10px] text-[#888]">Start now (parallel)</span>
            <input
              type="number" min={1} max={20} value={concurrentStarts}
              onChange={e => setConcurrentStarts(Math.max(1, Math.min(20, parseInt(e.target.value) || 1)))}
              className="px-2 py-1.5 text-xs bg-[#0a0a0a] border border-[#2a2a2a] rounded text-white w-16"
            />
          </label>

          <label className="flex items-center gap-1.5 text-xs text-[#ccc] pb-2">
            <input type="checkbox" checked={skipAnalysed} onChange={e => setSkipAnalysed(e.target.checked)} />
            Skip already-analysed
          </label>

          <button
            type="button" disabled={busy || pickNicheId === ''}
            onClick={handleEnqueue}
            className="ml-auto px-4 py-1.5 text-xs font-semibold bg-teal-400 text-black rounded-md hover:bg-teal-300 transition disabled:opacity-40"
          >
            {busy ? 'Working…' : 'Enqueue'}
          </button>
          <button
            type="button" disabled={busy}
            onClick={handleProcessPending}
            className="px-3 py-1.5 text-xs font-semibold text-teal-300 border border-teal-500/40 hover:bg-teal-500/10 rounded-md transition disabled:opacity-40"
            title="Atomically claim up to 10 pending jobs and start their workers"
          >
            Drain queue
          </button>
        </div>
        {msg && <div className="mt-3 text-xs text-emerald-300">{msg}</div>}
        {err && <div className="mt-3 text-xs text-red-300">{err}</div>}
      </div>

      {/* Stats strip */}
      <div className="mb-4 grid grid-cols-2 sm:grid-cols-5 gap-2">
        {[
          { label: 'Pending',  v: stats.pending, c: 'text-zinc-300' },
          { label: 'Running',  v: stats.running, c: 'text-teal-300' },
          { label: 'Done',     v: stats.done,    c: 'text-emerald-300' },
          { label: 'Errors',   v: stats.error,   c: 'text-red-300' },
          { label: 'Total',    v: stats.total,   c: 'text-white' },
        ].map(s => (
          <div key={s.label} className="p-3 rounded-lg bg-[#0f0f0f] border border-[#1f1f1f]">
            <div className="text-[10px] text-[#666] uppercase tracking-wider">{s.label}</div>
            <div className={`text-lg font-bold ${s.c}`}>{s.v}</div>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
        <span className="text-[10px] text-[#666]">FILTER:</span>
        <select
          value={filterNicheId}
          onChange={e => setFilterNicheId(e.target.value === '' ? '' : parseInt(e.target.value))}
          className="px-2 py-1 bg-[#0a0a0a] border border-[#2a2a2a] rounded text-white"
        >
          <option value="">all niches</option>
          {customNiches.map(n => <option key={n.id} value={n.id}>{n.name}</option>)}
        </select>
        {(['all', 'active', 'done', 'error'] as const).map(s => (
          <button
            key={s}
            onClick={() => setFilterStatus(s)}
            className={`px-2.5 py-0.5 rounded-full border transition ${
              filterStatus === s
                ? 'bg-teal-500/15 text-teal-300 border-teal-500/40'
                : 'text-[#888] border-[#333] hover:border-[#555]'
            }`}
          >
            {s}
          </button>
        ))}
        {(['24h', '7d', 'all'] as const).map(s => (
          <button
            key={s}
            onClick={() => setFilterRecent(s)}
            className={`px-2.5 py-0.5 rounded-full border transition ${
              filterRecent === s
                ? 'bg-teal-500/15 text-teal-300 border-teal-500/40'
                : 'text-[#888] border-[#333] hover:border-[#555]'
            }`}
          >
            {s}
          </button>
        ))}
        <button
          onClick={loadJobs} disabled={loading}
          className="ml-auto px-2 py-0.5 text-[10px] text-[#888] hover:text-white disabled:opacity-50"
        >
          {loading ? 'Refreshing…' : '↻ Refresh'}
        </button>
      </div>

      {/* ── Niche progress panel ───────────────────────────────────────
          Only renders when a specific niche is picked in the filter.
          Surfaces the overall "X of N analysed" picture plus the
          per-video grid so the operator can spot which exact videos
          still need work without scrolling the global job list. */}
      {filterNicheId !== '' && nicheProgress && (() => {
        const sc = nicheProgress.statusCounts;
        const totalEnqueued = sc.pending + sc.in_flight + sc.done + sc.error;
        const overallPct = nicheProgress.totalVideos > 0
          ? Math.round((sc.done / nicheProgress.totalVideos) * 100) : 0;
        const filteredVideos = nicheProgress.perVideo.filter(v => {
          if (perVideoFilter === 'all') return true;
          if (perVideoFilter === 'not_enqueued') return v.status === 'not_enqueued';
          if (perVideoFilter === 'in_flight') return ['pending', 'downloading', 'splitting', 'analyzing', 'collapsing'].includes(v.status);
          if (perVideoFilter === 'done') return v.status === 'done';
          if (perVideoFilter === 'done_with_failures') return v.status === 'done' && (v.numClipsFailed ?? 0) > 0;
          if (perVideoFilter === 'error') return v.status === 'error';
          return true;
        });
        return (
          <div className="mb-4 p-4 rounded-xl bg-[#0f0f0f] border border-[#1f1f1f]">
            <div className="flex items-start justify-between gap-4 flex-wrap mb-3">
              <div>
                <div className="text-xs font-semibold text-white">
                  Niche progress · {nicheProgress.nicheName}
                  {nicheProgressLoading && <span className="ml-2 text-[10px] text-[#666] animate-pulse">refreshing…</span>}
                </div>
                <div className="text-[11px] text-[#888] mt-1">
                  {sc.done} of {nicheProgress.totalVideos} videos analysed ({overallPct}%)
                  {nicheProgress.doneWithFailures > 0 && (
                    <span className="text-amber-300"> · {nicheProgress.doneWithFailures} with missing clips</span>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                {sc.not_enqueued > 0 && (
                  <button
                    type="button" disabled={busy}
                    onClick={handleEnqueueRest}
                    className="px-3 py-1 text-[11px] font-semibold bg-teal-400 text-black rounded hover:bg-teal-300 transition disabled:opacity-40"
                  >
                    Enqueue {sc.not_enqueued} not-yet-analysed
                  </button>
                )}
                {nicheProgress.clips.failed > 0 && (
                  <button
                    type="button" disabled={busy}
                    onClick={handleBulkRetryFailed}
                    className="px-3 py-1 text-[11px] font-semibold text-amber-300 border border-amber-500/40 hover:bg-amber-500/10 rounded transition disabled:opacity-40"
                    title={`Retry ${nicheProgress.clips.failed} failed clip${nicheProgress.clips.failed === 1 ? '' : 's'} across all jobs in this niche`}
                  >
                    ↻ Retry {nicheProgress.clips.failed} failed clip{nicheProgress.clips.failed === 1 ? '' : 's'}
                  </button>
                )}
                {sc.done > 0 && (
                  <a
                    href={`/api/admin/analyze-vids/export?customNicheId=${filterNicheId}${userEmail ? `&userEmail=${encodeURIComponent(userEmail)}` : ''}`}
                    download
                    className="px-3 py-1 text-[11px] font-semibold text-emerald-300 border border-emerald-500/40 hover:bg-emerald-500/10 rounded transition"
                    title={`Download a ZIP of all ${sc.done} analyzed videos: timelines + YouTube metadata (channel, views, dates, thumbnail) per video. No clip mp4s.`}
                  >
                    ⬇ Export {sc.done} as ZIP
                  </a>
                )}
              </div>
            </div>

            {/* Niche-level tiles */}
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 mb-3">
              {[
                { label: 'Total videos',    v: nicheProgress.totalVideos, c: 'text-white' },
                { label: 'Done',            v: sc.done,                   c: 'text-emerald-300' },
                { label: 'In flight',       v: sc.in_flight + sc.pending, c: 'text-teal-300' },
                { label: 'Errored',         v: sc.error,                  c: 'text-red-300' },
                { label: 'Not enqueued',    v: sc.not_enqueued,           c: 'text-zinc-300' },
              ].map(s => (
                <div key={s.label} className="p-2.5 rounded-lg bg-[#0a0a0a] border border-[#1f1f1f]">
                  <div className="text-[10px] text-[#666] uppercase tracking-wider">{s.label}</div>
                  <div className={`text-base font-bold ${s.c}`}>{s.v}</div>
                </div>
              ))}
            </div>

            {/* Clip-level summary line */}
            <div className="mb-3 text-[11px] text-[#888]">
              Across enqueued videos ({totalEnqueued}/{nicheProgress.totalVideos}):{' '}
              <span className="text-emerald-300">{nicheProgress.clips.analysed}</span> /{' '}
              <span className="text-[#ccc]">{nicheProgress.clips.expected || '?'}</span> clips analysed
              {nicheProgress.clips.failed > 0 && (
                <> · <span className="text-red-300">{nicheProgress.clips.failed} failed</span></>
              )}
              {nicheProgress.totalSegments > 0 && (
                <> · <span className="text-white">{nicheProgress.totalSegments.toLocaleString()}</span> segments produced</>
              )}
            </div>

            {/* Per-video table — sub-filtered by the pill row below */}
            <div className="flex items-center gap-1.5 mb-2 text-[10px]">
              <span className="text-[#666] mr-1">SHOW:</span>
              {([
                { k: 'all',                label: `all (${nicheProgress.totalVideos})` },
                { k: 'not_enqueued',       label: `not enqueued (${sc.not_enqueued})` },
                { k: 'in_flight',          label: `in flight (${sc.in_flight + sc.pending})` },
                { k: 'done',               label: `done (${sc.done})` },
                { k: 'done_with_failures', label: `done w/ gaps (${nicheProgress.doneWithFailures})` },
                { k: 'error',              label: `errored (${sc.error})` },
              ] as Array<{ k: PerVideoFilter; label: string }>).map(p => (
                <button
                  key={p.k}
                  onClick={() => setPerVideoFilter(p.k)}
                  className={`px-2 py-0.5 rounded-full border transition ${
                    perVideoFilter === p.k
                      ? 'bg-teal-500/15 text-teal-300 border-teal-500/40'
                      : 'text-[#888] border-[#222] hover:border-[#444]'
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>

            <div className="rounded-lg bg-[#0a0a0a] border border-[#1f1f1f] max-h-[420px] overflow-y-auto">
              {filteredVideos.length === 0 ? (
                <div className="p-4 text-center text-[11px] text-[#666]">No videos matching this sub-filter.</div>
              ) : (
                <table className="w-full text-[11px]">
                  <thead className="sticky top-0 bg-[#0a0a0a] z-10">
                    <tr className="text-[10px] text-[#666] uppercase tracking-wider border-b border-[#1f1f1f]">
                      <th className="text-left px-3 py-2">Video</th>
                      <th className="text-left px-2 py-2 w-[110px]">Status</th>
                      <th className="text-left px-2 py-2 w-[120px]">Clips</th>
                      <th className="text-left px-2 py-2 w-[80px]">Segments</th>
                      <th className="text-left px-2 py-2 w-[70px]">Duration</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredVideos.map(v => {
                      const pct = v.numClips != null && v.numClips > 0
                        ? Math.round(((v.numClipsDone ?? 0) / v.numClips) * 100) : 0;
                      return (
                        <tr key={v.videoId} className="border-t border-[#141414] hover:bg-[#0f0f0f]">
                          <td className="px-3 py-1.5 min-w-0">
                            <div className="truncate text-white max-w-[420px]">{v.title ?? v.url}</div>
                            <div className="text-[10px] text-[#666] truncate max-w-[420px]">
                              {v.url}
                              {v.jobId != null && <> · job #{v.jobId}</>}
                            </div>
                          </td>
                          <td className="px-2 py-1.5">
                            <span className={`inline-flex items-center px-1.5 py-0.5 rounded-full text-[9px] border ${STATUS_COLOUR[v.status] || 'bg-zinc-500/15 text-zinc-300 border-zinc-500/30'}`}>
                              {v.status === 'not_enqueued' ? 'not enqueued' : v.status}
                            </span>
                            {v.status === 'done' && (v.numClipsFailed ?? 0) > 0 && (
                              <span className="ml-1 text-[9px] text-amber-300">·gaps</span>
                            )}
                          </td>
                          <td className="px-2 py-1.5 text-[#ccc]">
                            {v.numClips != null ? (
                              <>
                                {v.numClipsDone ?? 0}/{v.numClips}
                                {(v.numClipsFailed ?? 0) > 0 && <span className="text-red-300"> · {v.numClipsFailed} err</span>}
                                {v.numClips > 0 && (
                                  <div className="mt-0.5 h-1 bg-[#1a1a1a] rounded overflow-hidden w-[100px]">
                                    <div className="h-full bg-teal-400" style={{ width: `${pct}%` }} />
                                  </div>
                                )}
                              </>
                            ) : '—'}
                          </td>
                          <td className="px-2 py-1.5 text-[#888]">{v.totalSegments ?? '—'}</td>
                          <td className="px-2 py-1.5 text-[#888]">{v.durationS != null ? `${Math.round(v.durationS)}s` : '—'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        );
      })()}

      {/* Job list */}
      <div className="rounded-xl bg-[#0f0f0f] border border-[#1f1f1f] overflow-hidden">
        {rows.length === 0 ? (
          <div className="p-6 text-center text-xs text-[#888]">
            {loading ? 'Loading…' : 'No jobs in view. Enqueue some above.'}
          </div>
        ) : (
          <div className="divide-y divide-[#1a1a1a]">
            <div className="px-3 py-2 grid grid-cols-[60px_1fr_120px_120px_100px_180px] gap-2 text-[10px] text-[#666] uppercase tracking-wider">
              <div>ID</div>
              <div>Video</div>
              <div>Status</div>
              <div>Clips</div>
              <div>Duration</div>
              <div className="text-right">Actions</div>
            </div>
            {rows.map(r => {
              const pct = r.numClips > 0 ? Math.round((r.numClipsDone / r.numClips) * 100) : 0;
              const isExpanded = expandedJobId === r.id;
              return (
                <div key={r.id}>
                  <div
                    className="px-3 py-2 grid grid-cols-[60px_1fr_120px_120px_100px_180px] gap-2 items-center text-xs hover:bg-[#141414] cursor-pointer"
                    onClick={() => handleExpand(r.id)}
                  >
                    <div className="text-[#666] font-mono">{r.id}</div>
                    <div className="min-w-0">
                      <div className="text-white truncate">{r.title ?? r.youtubeUrl}</div>
                      <div className="text-[10px] text-[#666] truncate">{r.youtubeUrl}</div>
                    </div>
                    <div>
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] border ${STATUS_COLOUR[r.status] || 'bg-zinc-500/15 text-zinc-300 border-zinc-500/30'}`}>
                        {r.status}
                      </span>
                      {(r.autoRetryCount ?? 0) > 0 && (
                        <span
                          className="ml-1 inline-flex items-center px-1.5 py-0.5 rounded-full text-[9px] border bg-purple-500/15 text-purple-300 border-purple-500/30"
                          title={`Watchdog auto-retried this job ${r.autoRetryCount} time${r.autoRetryCount === 1 ? '' : 's'}${r.lastAutoRetryAt ? ` (last: ${new Date(r.lastAutoRetryAt).toLocaleTimeString()})` : ''}`}
                        >
                          ↻{r.autoRetryCount}
                        </span>
                      )}
                    </div>
                    <div className="text-[#ccc]">
                      {r.numClipsDone}/{r.numClips || '?'}
                      {r.numClipsFailed > 0 && <span className="text-red-300"> · {r.numClipsFailed} err</span>}
                      {r.numClips > 0 && (
                        <div className="mt-1 h-1 bg-[#1a1a1a] rounded overflow-hidden">
                          <div className="h-full bg-teal-400" style={{ width: `${pct}%` }} />
                        </div>
                      )}
                    </div>
                    <div className="text-[#888]">
                      {r.durationS ? `${Math.round(r.durationS)}s` : '—'}
                      {r.totalSegments != null && (
                        <div className="text-[10px] text-[#666]">{r.totalSegments} segs</div>
                      )}
                    </div>
                    <div className="flex items-center gap-1 justify-end" onClick={e => e.stopPropagation()}>
                      {r.status === 'done' && (
                        <a
                          href={`/api/admin/analyze-vids/jobs/${r.id}/timeline`}
                          download
                          className="px-2 py-0.5 text-[10px] text-emerald-300 border border-emerald-500/30 hover:bg-emerald-500/10 rounded"
                          title="Download collapsed timeline JSON"
                        >
                          ⬇ Timeline
                        </a>
                      )}
                      {(r.status === 'error' || (r.status === 'done' && r.numClipsFailed > 0)) && (
                        <button
                          onClick={() => handleRetry(r.id)}
                          disabled={busy}
                          className="px-2 py-0.5 text-[10px] text-amber-300 border border-amber-500/30 hover:bg-amber-500/10 rounded disabled:opacity-50"
                          title="Re-analyze failed clips"
                        >
                          ↻ Retry
                        </button>
                      )}
                      {(r.status !== 'done' && r.status !== 'error' && r.status !== 'cancelled') && (
                        <button
                          onClick={() => handleCancel(r.id)}
                          disabled={busy}
                          className="px-2 py-0.5 text-[10px] text-[#888] border border-[#333] hover:border-red-500/40 hover:text-red-300 rounded disabled:opacity-50"
                          title="Stop the job"
                        >
                          ✕ Cancel
                        </button>
                      )}
                      <span className="text-[10px] text-[#666] w-3 text-center">
                        {isExpanded ? '▾' : '▸'}
                      </span>
                    </div>
                  </div>

                  {/* Expanded clip detail */}
                  {isExpanded && (
                    <div className="px-3 pb-3 bg-[#0a0a0a]">
                      {r.errorMessage && (
                        <div className="mb-2 p-2 text-[11px] text-red-300 border border-red-500/30 rounded bg-red-500/5">
                          <span className="font-semibold">Job error:</span> {r.errorMessage}
                        </div>
                      )}
                      {expandedLoading && expandedClips.length === 0 ? (
                        <div className="text-[11px] text-[#666] py-2">Loading clips…</div>
                      ) : expandedClips.length === 0 ? (
                        <div className="text-[11px] text-[#666] py-2">No clips yet — still downloading/splitting.</div>
                      ) : (
                        <div className="overflow-x-auto">
                          <table className="w-full text-[11px]">
                            <thead>
                              <tr className="text-[10px] text-[#666] uppercase tracking-wider">
                                <th className="text-left pr-3 py-1">#</th>
                                <th className="text-left pr-3 py-1">Status</th>
                                <th className="text-left pr-3 py-1">Duration</th>
                                <th className="text-left pr-3 py-1">Segments</th>
                                <th className="text-left pr-3 py-1">Attempts</th>
                                <th className="text-left pr-3 py-1">Elapsed</th>
                                <th className="text-left pr-3 py-1">Last error</th>
                              </tr>
                            </thead>
                            <tbody>
                              {expandedClips.map(c => (
                                <tr key={c.id} className="border-t border-[#1a1a1a]">
                                  <td className="pr-3 py-1 text-[#888] font-mono">{c.clipIndex}</td>
                                  <td className="pr-3 py-1">
                                    <span className={`inline-flex items-center px-1.5 py-0.5 rounded-full text-[9px] border ${STATUS_COLOUR[c.status] || 'bg-zinc-500/15 text-zinc-300 border-zinc-500/30'}`}>
                                      {c.status}
                                    </span>
                                  </td>
                                  <td className="pr-3 py-1 text-[#ccc]">{c.durationS != null ? `${c.durationS.toFixed(1)}s` : '—'}</td>
                                  <td className="pr-3 py-1 text-[#ccc]">{c.segmentsCount ?? '—'}</td>
                                  <td className="pr-3 py-1 text-[#ccc]">
                                    {c.attemptCount}
                                    {c.attempts && c.attempts.length > 0 && (
                                      <span className="ml-1 text-[#666]">
                                        ({c.attempts.map(a => a.category).join(', ')})
                                      </span>
                                    )}
                                  </td>
                                  <td className="pr-3 py-1 text-[#888]">{c.elapsedS != null ? `${c.elapsedS.toFixed(1)}s` : '—'}</td>
                                  <td className="pr-3 py-1 text-[#888] max-w-[300px] truncate" title={c.errorDetail ?? ''}>
                                    {c.errorCategory ? `${c.errorCategory}: ${c.errorDetail?.slice(0, 80) ?? ''}` : ''}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────
 *  XG vid download tab — bridges xgodo review job → download job →
 *  Railway-volume mp4 → confirm both xgodo tasks. Matches the visual
 *  language of Analyze Vids so the operator's eye doesn't have to
 *  re-learn another panel.
 * ────────────────────────────────────────────────────────────────── */
interface XgVidDownloadRow {
  id: number;
  reviewTaskId: string;
  reviewWorkerName: string | null;
  sourceVideoUrl: string;
  remoteDeviceId: string | null;
  downloadTaskId: string | null;
  prompt: string | null;
  model: string | null;
  uploadedUrl: string | null;
  localPath: string | null;
  fileBytes: number | null;
  status: string;
  errorMessage: string | null;
  attempts: number;
  createdAt: string;
  submittedAt: string | null;
  downloadedAt: string | null;
  confirmedAt: string | null;
}

function XgVidDownloadTab({ active }: { active: boolean }) {
  const [rows, setRows] = useState<XgVidDownloadRow[]>([]);
  const [stats, setStats] = useState<{ pending: number; running: number; done: number; errors: number; total: number }>({ pending: 0, running: 0, done: 0, errors: 0, total: 0 });
  const [filter, setFilter] = useState<'all' | 'queued' | 'submitted' | 'running' | 'downloaded' | 'confirmed' | 'failed' | 'gone'>('all');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Enqueue form — same shape as the Analyze Vids enqueue card so the
  // operator's muscle memory carries across.
  const [maxJobs, setMaxJobs] = useState(10);
  const [parallel, setParallel] = useState(5);

  // Auto-pull toggle. When 'off' the cron tick (and the cron endpoint)
  // still drain in-flight rows so nothing strands, but skip pulling
  // new pending review tasks from xgodo. Lets the operator stop the
  // intake without killing the pipeline. State lives in admin_config
  // so it survives redeploys.
  const [autoPull, setAutoPull] = useState<'on' | 'off' | 'loading'>('loading');
  const [togglingPull, setTogglingPull] = useState(false);
  const loadSettings = useCallback(async () => {
    try {
      const r = await fetch('/api/admin/xg-vid-download/settings');
      const d = await r.json();
      if (d.ok) setAutoPull(d.autoPull === 'off' ? 'off' : 'on');
    } catch { /* leave whatever state we had */ }
  }, []);
  useEffect(() => { if (active) loadSettings(); }, [active, loadSettings]);
  async function flipAutoPull() {
    if (autoPull === 'loading') return;
    setTogglingPull(true);
    const next = autoPull === 'on' ? 'off' : 'on';
    try {
      const r = await fetch('/api/admin/xg-vid-download/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ autoPull: next }),
      });
      const d = await r.json();
      if (d.ok) setAutoPull(d.autoPull);
    } finally {
      setTogglingPull(false);
    }
  }

  const load = useCallback(async () => {
    try {
      const qs = new URLSearchParams({ status: filter, limit: '100' });
      const r = await fetch(`/api/admin/xg-vid-download?${qs.toString()}`);
      const d = await r.json();
      if (d.ok) {
        setRows(d.rows || []);
        setStats({
          pending: d.pending ?? 0,
          running: d.running ?? 0,
          done:    d.done    ?? 0,
          errors:  d.errors  ?? 0,
          total:   d.total   ?? 0,
        });
      }
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [filter]);

  // Initial fetch + every 5s while the tab is visible. Cheap GET so
  // the polling cost is minimal and rows shift through statuses live.
  useEffect(() => { if (active) load(); }, [active, load]);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [active, load]);

  async function handleEnqueue() {
    setBusy(true); setMsg(null); setErr(null);
    try {
      const r = await fetch('/api/admin/xg-vid-download/enqueue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ maxJobs, parallel }),
      });
      const d = await r.json();
      if (!d.ok) {
        setErr(d.error || `HTTP ${r.status}`);
      } else {
        setMsg(
          `Fetched ${d.fetched} from xgodo · inserted ${d.inserted} new · skipped ${d.skipped} · drained ${d.drained}` +
          (d.results?.length ? ` (${d.results.filter((x: { finalStatus: string }) => x.finalStatus === 'confirmed').length} confirmed, ${d.results.filter((x: { finalStatus: string }) => x.finalStatus === 'failed').length} failed)` : ''),
        );
        await load();
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleDrain() {
    setBusy(true); setMsg(null); setErr(null);
    try {
      const r = await fetch('/api/admin/xg-vid-download/drain', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ limit: 25, parallel }),
      });
      const d = await r.json();
      if (!d.ok) {
        setErr(d.error || `HTTP ${r.status}`);
      } else {
        const confirmed = (d.results || []).filter((x: { finalStatus: string }) => x.finalStatus === 'confirmed').length;
        const failed    = (d.results || []).filter((x: { finalStatus: string }) => x.finalStatus === 'failed').length;
        setMsg(`Drained ${d.claimed} · ${confirmed} confirmed · ${failed} failed`);
        await load();
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function statusBadge(status: string): { colour: string; text: string } {
    switch (status) {
      case 'queued':     return { colour: 'bg-[#1f1f1f] text-[#aaa] border-[#333]',                          text: 'queued' };
      case 'submitted':  return { colour: 'bg-amber-500/15 text-amber-300 border-amber-500/30',              text: 'submitted' };
      case 'running':    return { colour: 'bg-amber-500/15 text-amber-300 border-amber-500/30 animate-pulse',text: 'running' };
      case 'downloaded': return { colour: 'bg-cyan-500/15 text-cyan-300 border-cyan-500/30',                 text: 'downloaded' };
      case 'confirmed':  return { colour: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',        text: 'confirmed' };
      case 'failed':     return { colour: 'bg-red-500/15 text-red-300 border-red-500/30',                    text: 'failed' };
      case 'gone':       return { colour: 'bg-fuchsia-500/15 text-fuchsia-300 border-fuchsia-500/30',        text: 'gone' };
      default:           return { colour: 'bg-[#1f1f1f] text-[#888] border-[#333]',                          text: status };
    }
  }

  function fmtBytes(n: number | null): string {
    if (!n) return '—';
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)} MB`;
    if (n >= 1_000)     return `${(n / 1_000).toFixed(1)} KB`;
    return `${n} B`;
  }

  return (
    <div className="px-2 sm:px-6 py-6 max-w-7xl mx-auto">
      <div className="flex items-start justify-between gap-4 flex-wrap mb-2">
        <div>
          <h2 className="text-xl sm:text-2xl font-bold text-white">XG vid download</h2>
          <p className="text-sm text-[#888]">rofe.ai · data operations</p>
        </div>

        {/* Auto-pull switch. Single source of truth for the cron's
            fetch leg — when OFF the every-minute tick still drains
            in-flight rows so the pipeline empties cleanly, but stops
            adding new pending review tasks from xgodo. Persists in
            admin_config so a redeploy doesn't silently re-enable it. */}
        <div className="flex items-center gap-3 px-3 py-2 rounded-xl bg-[#0f0f0f] border border-[#1f1f1f]">
          <div className="flex flex-col text-right">
            <span className="text-xs text-[#ccc] font-medium">
              Auto-pull from xgodo
            </span>
            <span className="text-[10px] text-[#666]">
              {autoPull === 'on'
                ? 'cron fetches new tasks every minute'
                : autoPull === 'off'
                  ? 'cron only drains in-flight rows'
                  : 'loading…'}
            </span>
          </div>
          <button
            type="button"
            disabled={togglingPull || autoPull === 'loading'}
            onClick={flipAutoPull}
            aria-pressed={autoPull === 'on'}
            title={autoPull === 'on'
              ? 'Click to pause auto-pull. Drain keeps running.'
              : autoPull === 'off'
                ? 'Click to resume auto-pull.'
                : 'Loading toggle state…'}
            className={`relative inline-flex w-12 h-6 items-center rounded-full transition disabled:opacity-50 ${
              autoPull === 'on' ? 'bg-emerald-500/70' : 'bg-[#333]'
            }`}
          >
            <span
              className={`inline-block w-5 h-5 bg-white rounded-full shadow transform transition ${
                autoPull === 'on' ? 'translate-x-6' : 'translate-x-0.5'
              }`}
            />
          </button>
        </div>
      </div>

      <div className="mt-6">
        <h3 className="text-base font-semibold text-white mb-2">Two-job xgodo pipeline</h3>
        <p className="text-sm text-[#aaa] leading-relaxed max-w-3xl">
          Pulls pending review tasks from xgodo (workers submit a labs.google videoUrl + their
          remote_device_id), schedules a download task on the second job so a worker clicks the
          download button and uploads the mp4 to xgodo&apos;s temp store, then fetches that mp4
          to the Railway volume at <code className="text-[#ccc] bg-[#1a1a1a] px-1.5 py-0.5 rounded">/data/xg_videos</code>.
          Once the file&apos;s on disk we mark both xgodo tasks confirmed in one go.
        </p>
      </div>

      {/* Enqueue + Drain card — mirrors Analyze Vids. */}
      <div className="mt-6 p-4 rounded-xl bg-[#0f0f0f] border border-[#1f1f1f]">
        <h4 className="text-sm font-semibold text-white mb-3">Process pending review tasks</h4>
        <div className="flex items-end gap-4 flex-wrap">
          <div className="flex flex-col">
            <label className="text-[11px] text-[#888] mb-1">Max review tasks to pull</label>
            <input
              type="number" min={1} max={50}
              value={maxJobs}
              onChange={e => setMaxJobs(Math.max(1, Math.min(50, parseInt(e.target.value) || 1)))}
              className="w-24 px-3 py-1.5 text-sm text-white bg-[#0a0a0a] border border-[#2a2a2a] focus:border-amber-400 focus:outline-none rounded"
            />
          </div>
          <div className="flex flex-col">
            <label className="text-[11px] text-[#888] mb-1">Parallel workers</label>
            <input
              type="number" min={1} max={10}
              value={parallel}
              onChange={e => setParallel(Math.max(1, Math.min(10, parseInt(e.target.value) || 1)))}
              className="w-24 px-3 py-1.5 text-sm text-white bg-[#0a0a0a] border border-[#2a2a2a] focus:border-amber-400 focus:outline-none rounded"
            />
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={handleEnqueue}
            className="px-4 py-1.5 text-xs font-semibold rounded-md transition disabled:opacity-40 bg-transparent text-orange-300 border border-orange-500/40 hover:bg-orange-500/10"
            title="Pull N pending review tasks from xgodo, insert any new ones, then push the queue forward."
          >
            {busy ? 'Working…' : 'Enqueue + process'}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={handleDrain}
            className="px-4 py-1.5 text-xs font-semibold rounded-md transition disabled:opacity-40 bg-transparent text-amber-300 border border-amber-500/40 hover:bg-amber-500/10"
            title="Don't pull anything new — just walk already-queued rows one step further."
          >
            Drain queue
          </button>
          <button
            type="button"
            onClick={load}
            className="ml-auto text-xs text-[#888] hover:text-amber-300"
          >
            ↻ Refresh
          </button>
        </div>
        {msg && <div className="mt-3 text-[12px] text-emerald-300">{msg}</div>}
        {err && <div className="mt-3 text-[12px] text-red-300">{err}</div>}
      </div>

      {/* Stats tiles */}
      <div className="mt-6 grid grid-cols-2 sm:grid-cols-5 gap-3">
        <div className="p-3 rounded-lg bg-[#0f0f0f] border border-[#1f1f1f]">
          <div className="text-[10px] uppercase tracking-wider text-[#666] mb-1">Pending</div>
          <div className="text-xl font-bold text-amber-300">{stats.pending}</div>
        </div>
        <div className="p-3 rounded-lg bg-[#0f0f0f] border border-[#1f1f1f]">
          <div className="text-[10px] uppercase tracking-wider text-[#666] mb-1">Running</div>
          <div className="text-xl font-bold text-amber-300">{stats.running}</div>
        </div>
        <div className="p-3 rounded-lg bg-[#0f0f0f] border border-[#1f1f1f]">
          <div className="text-[10px] uppercase tracking-wider text-[#666] mb-1">Confirmed</div>
          <div className="text-xl font-bold text-emerald-300">{stats.done}</div>
        </div>
        <div className="p-3 rounded-lg bg-[#0f0f0f] border border-[#1f1f1f]">
          <div className="text-[10px] uppercase tracking-wider text-[#666] mb-1">Errors</div>
          <div className="text-xl font-bold text-red-300">{stats.errors}</div>
        </div>
        <div className="p-3 rounded-lg bg-[#0f0f0f] border border-[#1f1f1f]">
          <div className="text-[10px] uppercase tracking-wider text-[#666] mb-1">Total</div>
          <div className="text-xl font-bold text-white">{stats.total}</div>
        </div>
      </div>

      {/* Status filter pills */}
      <div className="mt-6 flex items-center gap-2 flex-wrap">
        <span className="text-xs text-[#666] mr-1">FILTER:</span>
        {(['all', 'queued', 'submitted', 'running', 'downloaded', 'confirmed', 'failed', 'gone'] as const).map(k => (
          <button
            key={k}
            type="button"
            onClick={() => setFilter(k)}
            className={`px-2.5 py-1 rounded-full text-[11px] transition ${
              filter === k
                ? 'bg-orange-400/15 text-orange-300 border border-orange-400/40'
                : 'text-[#888] border border-[#333] hover:border-[#555]'
            }`}
          >
            {k}
          </button>
        ))}
      </div>

      {/* Rows table */}
      <div className="mt-4 rounded-xl bg-[#0f0f0f] border border-[#1f1f1f] overflow-hidden">
        <div className="px-3 py-2 text-[10px] uppercase tracking-wider text-[#666] grid gap-2 border-b border-[#1f1f1f]"
             style={{ gridTemplateColumns: '60px 1fr 1.4fr 100px 110px 90px 100px' }}>
          <span>#</span>
          <span>Source / prompt</span>
          <span>Model · device</span>
          <span>Status</span>
          <span>File</span>
          <span>Created</span>
          <span></span>
        </div>
        {rows.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-[#666]">No rows match this filter.</div>
        )}
        {rows.map(r => {
          const sb = statusBadge(r.status);
          return (
            <div key={r.id} className="px-3 py-2.5 grid gap-2 border-b border-[#1a1a1a] hover:bg-[#141414]"
                 style={{ gridTemplateColumns: '60px 1fr 1.4fr 100px 110px 90px 100px' }}>
              <span className="text-[11px] text-[#666]">#{r.id}</span>
              <div className="min-w-0">
                <a
                  href={r.sourceVideoUrl}
                  target="_blank" rel="noreferrer"
                  className="text-[11px] text-amber-300 hover:text-amber-200 truncate block"
                  title={r.sourceVideoUrl}
                >
                  {r.sourceVideoUrl.replace(/^https:\/\/labs\.google\/fx\/tools\/flow\/shared\/video\//, '…/')}
                </a>
                {r.prompt && (
                  <div className="text-[11px] text-[#ccc] truncate mt-0.5" title={r.prompt}>
                    {r.prompt}
                  </div>
                )}
                {r.errorMessage && (
                  <div className="text-[11px] text-red-300 truncate mt-0.5" title={r.errorMessage}>
                    ⚠ {r.errorMessage}
                  </div>
                )}
              </div>
              <div className="min-w-0">
                {r.model && <div className="text-[11px] text-[#ccc] truncate" title={r.model}>{r.model}</div>}
                {r.reviewWorkerName && <div className="text-[10px] text-[#666] truncate">@{r.reviewWorkerName}</div>}
                {r.remoteDeviceId && <div className="text-[10px] text-[#666] truncate" title={r.remoteDeviceId}>dev {r.remoteDeviceId.slice(0, 8)}…</div>}
              </div>
              <div>
                <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] border ${sb.colour}`}>
                  {sb.text}
                </span>
                {r.attempts > 1 && (
                  <span className="text-[10px] text-[#666] ml-1">×{r.attempts}</span>
                )}
              </div>
              <span className="text-[11px] text-[#888]">{fmtBytes(r.fileBytes)}</span>
              <span className="text-[11px] text-[#888]">
                {timeAgo(new Date(r.createdAt))}
              </span>
              <div className="text-right">
                {r.localPath ? (
                  <a
                    href={`/api/admin/xg-vid-download/${r.id}/file`}
                    target="_blank" rel="noreferrer"
                    className="text-[11px] text-emerald-300 hover:text-emerald-200"
                    title={r.localPath}
                  >
                    open ↗
                  </a>
                ) : r.uploadedUrl ? (
                  <a
                    href={r.uploadedUrl}
                    target="_blank" rel="noreferrer"
                    className="text-[11px] text-amber-300 hover:text-amber-200"
                    title="xgodo temp url (no local copy yet)"
                  >
                    xgodo ↗
                  </a>
                ) : (
                  <span className="text-[11px] text-[#444]">—</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
