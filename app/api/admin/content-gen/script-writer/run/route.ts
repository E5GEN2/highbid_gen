/**
 * Script-writer vertical slice — exercises the Gemini-backed writer for one
 * niche of one channel.
 *
 * GET  /api/admin/content-gen/script-writer/run?channelId=...&beat_id=channel_proof_1
 *   Auto-builds a single-beat input + calls writeScript. Returns the
 *   ConcreteScript (or errors + raw response for diagnostics).
 *
 * POST /api/admin/content-gen/script-writer/run
 *   Body: { channel: ChannelData, niche_index, video_id, beats: NarrationBeat[] }
 *   Lets us pass a full multi-beat narration script and get back the
 *   producer-ready concrete script in one shot.
 */

import { NextRequest, NextResponse } from 'next/server';
import { isAdmin } from '@/lib/admin-auth';
import { getPool } from '@/lib/db';
import { getPapaiApiKey } from '@/lib/config';
import { writeScript, type ScriptWriterInput, type NarrationBeat, type ChannelData } from '@/lib/content-gen/script-writer';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 60;

async function loadChannel(channelId: string): Promise<ChannelData | null> {
  const pool = await getPool();
  const r = await pool.query<{
    channel_id: string; channel_name: string | null; subscriber_count: number | null;
    total_views: number | null; video_count: number | null; channel_handle: string | null;
  }>(
    `SELECT channel_id, channel_name, subscriber_count, total_views, video_count, channel_handle
       FROM niche_spy_channels WHERE channel_id = $1`,
    [channelId],
  );
  if (r.rows.length === 0) return null;
  const ch = r.rows[0];

  const ana = await pool.query<{ niche: string | null; sub_niche: string | null }>(
    `SELECT niche, sub_niche FROM channel_analysis WHERE channel_id = $1 LIMIT 1`,
    [channelId],
  );

  const top = await pool.query<{ video_id: string; title: string; view_count: number }>(
    `SELECT video_id, title, view_count FROM niche_spy_videos
      WHERE channel_id = $1 AND view_count IS NOT NULL
      ORDER BY view_count DESC LIMIT 1`,
    [channelId],
  );

  return {
    channelId: ch.channel_id,
    channel_name: ch.channel_name ?? ch.channel_id,
    subscriber_count: ch.subscriber_count ?? undefined,
    total_views: ch.total_views ?? undefined,
    video_count: ch.video_count ?? undefined,
    niche: ana.rows[0]?.niche ?? undefined,
    sub_niche: ana.rows[0]?.sub_niche ?? undefined,
    top_video_id: top.rows[0]?.video_id,
    top_video_title: top.rows[0]?.title,
    top_video_view_count: top.rows[0]?.view_count != null ? Number(top.rows[0].view_count) : undefined,
  };
}

/** Stub narration for the single-beat vertical slice. Real pipeline gets
 *  this from the upstream skeleton's Gemini call. */
function stubNarrationForBeat(beat_id: string, ch: ChannelData): NarrationBeat[] {
  switch (beat_id) {
    case 'channel_proof_1': {
      const subs = ch.subscriber_count != null ? humanizeNumber(ch.subscriber_count) : 'tens of thousands of';
      return [{
        beat_id: 'channel_proof_1',
        text: `This channel already has more than ${subs} subscribers.`,
        hold_s: 1.8,
        audio_cue: { sfx: ['whoosh_on_load', 'ding_on_circle_reveal'] },
      }];
    }
    case 'channel_proof_2': {
      const v = ch.total_views != null ? humanizeNumber(ch.total_views) : 'millions of';
      return [{
        beat_id: 'channel_proof_2',
        text: `The channel has already gained over ${v} total views.`,
        hold_s: 1.5,
        audio_cue: { sfx: ['whoosh', 'ding'] },
      }];
    }
    case 'top_video_callout': {
      const v = ch.top_video_view_count != null ? humanizeNumber(ch.top_video_view_count) : 'over a million';
      return [{
        beat_id: 'top_video_callout',
        text: `Their most popular video has more than ${v} views.`,
        hold_s: 2.0,
        audio_cue: { sfx: ['whoosh', 'ding'] },
      }];
    }
    default:
      return [];
  }
}

function humanizeNumber(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)} billion`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)} million`;
  if (n >= 1_000) return `${Math.round(n / 1_000)} thousand`;
  return `${n}`;
}

export async function GET(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin token required' }, { status: 403 });
  const sp = req.nextUrl.searchParams;
  const channelId = sp.get('channelId');
  const beat_id = sp.get('beat_id') ?? 'channel_proof_1';
  if (!channelId) return NextResponse.json({ error: 'channelId required' }, { status: 400 });

  const ch = await loadChannel(channelId);
  if (!ch) return NextResponse.json({ error: `channel ${channelId} not in DB` }, { status: 404 });

  const beats = stubNarrationForBeat(beat_id, ch);
  if (beats.length === 0) return NextResponse.json({ error: `no stub narration for beat_id=${beat_id}` }, { status: 400 });

  const apiKey = await getPapaiApiKey();
  if (!apiKey) return NextResponse.json({ error: 'papai_api_key not configured' }, { status: 500 });

  const input: ScriptWriterInput = {
    channel: ch,
    niche_index: 1,
    video_id: `slice-${beat_id}-${ch.channelId.slice(-6)}`,
    beats,
    voice: 'money_groot',
    width: 1080,
    height: 1920,
  };

  const t0 = Date.now();
  const result = await writeScript(input, apiKey);
  return NextResponse.json({
    ok: result.ok,
    elapsed_ms: Date.now() - t0,
    input_summary: { channel_name: ch.channel_name, beat_id, narration_text: beats[0].text },
    ...result,
  });
}

export async function POST(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin token required' }, { status: 403 });
  const body = await req.json().catch(() => ({})) as Partial<ScriptWriterInput>;
  if (!body.channel || !Array.isArray(body.beats) || body.beats.length === 0) {
    return NextResponse.json({ error: 'channel + beats required' }, { status: 400 });
  }
  const apiKey = await getPapaiApiKey();
  if (!apiKey) return NextResponse.json({ error: 'papai_api_key not configured' }, { status: 500 });

  const input: ScriptWriterInput = {
    channel: body.channel,
    niche_index: body.niche_index ?? 1,
    video_id: body.video_id ?? `wf-${Date.now()}`,
    beats: body.beats,
    voice: body.voice ?? 'money_groot',
    width: body.width ?? 1080,
    height: body.height ?? 1920,
  };

  const t0 = Date.now();
  const result = await writeScript(input, apiKey);
  return NextResponse.json({ ok: result.ok, elapsed_ms: Date.now() - t0, ...result });
}
