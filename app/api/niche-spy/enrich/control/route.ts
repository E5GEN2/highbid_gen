import { NextRequest, NextResponse } from 'next/server';
import { isAdmin } from '@/lib/admin-auth';

/**
 * Admin-auth wrapper around /api/niche-spy/enrich for programmatic
 * (Claude / curl) drivers. Same underlying job machinery, but:
 *   - Bearer hba_… token required
 *   - Sensible "max speed" defaults on POST (threads=30, indefinite=true)
 *   - Terse status payload on GET, optimised for tailing in a terminal
 *
 * POST   /api/niche-spy/enrich/control     start (or no-op if already running)
 * GET    /api/niche-spy/enrich/control     job + key gap snapshot
 * DELETE /api/niche-spy/enrich/control     cancel current job
 */

const BASE_PATH = '/api/niche-spy/enrich';

export async function POST(req: NextRequest) {
  if (!await isAdmin(req)) {
    return NextResponse.json({ error: 'Admin token required' }, { status: 403 });
  }
  const body = await req.json().catch(() => ({}));
  const payload = {
    keyword: body.keyword ?? null,
    limit: body.limit ?? 10000,
    batchSize: body.batchSize ?? 50,
    threads: body.threads ?? 30,
    delayMs: body.delayMs ?? 200,
    indefinite: body.indefinite ?? true,
  };
  const res = await fetch(`${req.nextUrl.origin}${BASE_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  return NextResponse.json({ ok: res.ok, sent: payload, response: data }, { status: res.status });
}

export async function GET(req: NextRequest) {
  if (!await isAdmin(req)) {
    return NextResponse.json({ error: 'Admin token required' }, { status: 403 });
  }
  const keyword = req.nextUrl.searchParams.get('keyword');
  const url = new URL(`${req.nextUrl.origin}${BASE_PATH}`);
  if (keyword) url.searchParams.set('keyword', keyword);
  const res = await fetch(url.toString(), { method: 'GET' });
  const d = await res.json().catch(() => ({}));

  const job = d.job || null;
  const v = d.videos || {};
  const ch = d.channels || {};
  const proxy = d.proxyStats || {};
  const keys = d.keys || [];
  const activeKeys = keys.filter((k: { banned: boolean }) => !k.banned).length;

  let phase: string | null = null;
  let etaSeconds: number | null = null;
  if (job?.status === 'running' && job.started_at) {
    const startedMs = new Date(job.started_at).getTime();
    const elapsedSec = Math.max(1, (Date.now() - startedMs) / 1000);
    const processed = parseInt(job.processed) || 0;
    const total = parseInt(job.total_needed) || 0;
    if (processed > 0 && total > processed) {
      const rate = processed / elapsedSec;
      etaSeconds = Math.round((total - processed) / rate);
    }
    const msg: string = (job.error_message || '').toString();
    if (/Phase 4/.test(msg)) phase = 'phase4-need-videos';
    else if (/Phase 3/.test(msg)) phase = 'phase3-channel-walk';
    else if (/Phase 2/.test(msg)) phase = 'phase2-channel-meta';
    else if (/Phase 1/.test(msg) || /video.*batch/i.test(msg)) phase = 'phase1-videos';
    else phase = 'starting';
  }

  return NextResponse.json({
    job: job ? {
      id: job.id,
      status: job.status,
      phase,
      processed: parseInt(job.processed) || 0,
      total_needed: parseInt(job.total_needed) || 0,
      enriched_videos: parseInt(job.enriched_videos) || 0,
      enriched_channels: parseInt(job.enriched_channels) || 0,
      errors: parseInt(job.errors) || 0,
      current_batch: parseInt(job.current_batch) || 0,
      total_batches: parseInt(job.total_batches) || 0,
      threads: job.threads,
      indefinite: !!job.indefinite,
      loops: job.loops ?? 0,
      message: job.error_message || null,
      started_at: job.started_at,
      completed_at: job.completed_at,
      eta_seconds: etaSeconds,
    } : null,
    gaps: {
      videos_missing_views:    v.missingViews    ?? 0,
      videos_never_enriched:   v.neverEnriched   ?? 0,
      videos_missing_channel:  v.missingChannelId ?? 0,
      channels_missing_subs:   ch.missingSubs    ?? 0,
      channels_missing_first:  ch.missingFirstUpload ?? 0,
      channels_need_more_vids: ch.needMoreVideos ?? 0,
      channels_total:          ch.total ?? 0,
      videos_total:            v.total  ?? 0,
    },
    fleet: {
      yt_keys_total: keys.length,
      yt_keys_active: activeKeys,
      proxies_online: proxy.online ?? 0,
      proxies_total: proxy.total ?? 0,
    },
  });
}

export async function DELETE(req: NextRequest) {
  if (!await isAdmin(req)) {
    return NextResponse.json({ error: 'Admin token required' }, { status: 403 });
  }
  const res = await fetch(`${req.nextUrl.origin}${BASE_PATH}`, { method: 'DELETE' });
  const data = await res.json().catch(() => ({}));
  return NextResponse.json({ ok: res.ok, response: data }, { status: res.status });
}
