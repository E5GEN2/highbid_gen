/**
 * POST /api/admin/content-gen/producer/start
 *
 * Body: { script: ConcreteScript }  OR  { channelId, beat_id } (auto-runs
 * the script-writer + immediately enqueues producer for the resulting
 * single-beat script — vertical slice convenience for first renders).
 *
 * Returns { job_id }. Job runs ASYNC — poll /producer/status?id=N.
 */

import { NextRequest, NextResponse } from 'next/server';
import { isAdmin } from '@/lib/admin-auth';
import { startJob, runJob } from '@/lib/content-gen/producer';
import { writeScript, type ScriptWriterInput, type ChannelData, type NarrationBeat } from '@/lib/content-gen/script-writer';
import { assertValidScript, type ConcreteScript } from '@/lib/content-gen/concrete-script';
import { getPool } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 600;

async function loadChannel(channelId: string): Promise<ChannelData | null> {
  const pool = await getPool();
  const r = await pool.query<{
    channel_id: string; channel_name: string | null; subscriber_count: number | null;
    video_count: number | null; channel_created_at: string | null; first_upload_at: string | null;
    recent_videos_avg_views: number | null;
  }>(
    `SELECT channel_id, channel_name, subscriber_count, video_count,
            channel_created_at, first_upload_at, recent_videos_avg_views
       FROM niche_spy_channels WHERE channel_id = $1`,
    [channelId],
  );
  if (r.rows.length === 0) return null;
  const ch = r.rows[0];
  const top = await pool.query<{ url: string; title: string; view_count: number }>(
    `SELECT url, title, view_count FROM niche_spy_videos
      WHERE channel_id=$1 AND view_count IS NOT NULL
      ORDER BY view_count DESC LIMIT 1`,
    [channelId],
  );
  const topRow = top.rows[0];
  const topVideoId = topRow?.url?.match(/(?:shorts\/|watch\?v=)([A-Za-z0-9_-]{6,})/)?.[1];
  const totalApprox = ch.recent_videos_avg_views != null && ch.video_count != null
    ? Number(ch.recent_videos_avg_views) * Number(ch.video_count) : undefined;
  return {
    channelId: ch.channel_id,
    channel_name: ch.channel_name ?? ch.channel_id,
    subscriber_count: ch.subscriber_count != null ? Number(ch.subscriber_count) : undefined,
    total_views: totalApprox,
    video_count: ch.video_count ?? undefined,
    joined_date: ch.channel_created_at ?? ch.first_upload_at ?? undefined,
    top_video_id: topVideoId,
    top_video_title: topRow?.title,
    top_video_view_count: topRow?.view_count != null ? Number(topRow.view_count) : undefined,
  };
}

function stubNarration(beat_id: string, ch: ChannelData): NarrationBeat[] {
  const sub = ch.subscriber_count != null ? humanizeNumber(ch.subscriber_count) : 'thousands of';
  const tv = ch.total_views != null ? humanizeNumber(ch.total_views) : 'millions of';
  const vv = ch.top_video_view_count != null ? humanizeNumber(ch.top_video_view_count) : 'a million';
  switch (beat_id) {
    case 'channel_proof_1': return [{ beat_id, text: `This channel already has more than ${sub} subscribers.`, hold_s: 1.8, audio_cue: { sfx: ['whoosh', 'ding'] } }];
    case 'channel_proof_2': return [{ beat_id, text: `The channel has already gained over ${tv} total views.`, hold_s: 1.5, audio_cue: { sfx: ['whoosh', 'ding'] } }];
    case 'top_video_callout': return [{ beat_id, text: `Their most popular video has more than ${vv} views.`, hold_s: 2.0, audio_cue: { sfx: ['whoosh', 'ding'] } }];
    case 'niche_segment_3':
      // Compound: a full 3-beat per-niche segment. The script-writer
      // expands this into 3 slots: subs reveal → total views reveal →
      // top video callout. Producer composes all 3 into one mp4.
      return [
        { beat_id: 'channel_proof_1',   text: `This channel already has more than ${sub} subscribers.`, hold_s: 1.8, audio_cue: { sfx: ['whoosh', 'ding'] } },
        { beat_id: 'channel_proof_2',   text: `The channel has already gained over ${tv} total views.`,  hold_s: 1.5, audio_cue: { sfx: ['whoosh', 'ding'] } },
        { beat_id: 'top_video_callout', text: `Their most popular video has more than ${vv} views.`,     hold_s: 2.0, audio_cue: { sfx: ['whoosh', 'ding'] } },
      ];
    case 'niche_segment_full':
      // Richer preset that exercises text_card + chalkboard_card + screenshots.
      // Visual grammar: niche label → channel subs (screenshot) → views
      // (screenshot) → money-shot text_card → concept_tag chalkboard.
      return [
        { beat_id: 'intro_card',         text: `Number 1.`,                                                hold_s: 0.8, audio_cue: { sfx: ['whoosh'] } },
        { beat_id: 'niche_name_card',    text: `${ch.niche ?? 'Faceless Animation'}.`,                     hold_s: 1.2, audio_cue: { sfx: ['whoosh'] } },
        { beat_id: 'channel_proof_1',    text: `This channel already has ${sub} subscribers.`,            hold_s: 1.8, audio_cue: { sfx: ['whoosh', 'ding'] } },
        { beat_id: 'channel_proof_2',    text: `And ${tv} total views.`,                                  hold_s: 1.5, audio_cue: { sfx: ['whoosh', 'ding'] } },
        { beat_id: 'top_video_callout',  text: `Their top video has ${vv} views.`,                        hold_s: 2.0, audio_cue: { sfx: ['whoosh', 'ding'] } },
        { beat_id: 'concept_tag',        text: `consistency`,                                              hold_s: 1.2, audio_cue: { sfx: ['ding'] } },
      ];
    default: return [];
  }
}
function humanizeNumber(n: number): string {
  if (n >= 1e9) return `${(n/1e9).toFixed(1)} billion`;
  if (n >= 1e6) return `${(n/1e6).toFixed(1)} million`;
  if (n >= 1e3) return `${Math.round(n/1e3)} thousand`;
  return `${n}`;
}

export async function POST(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin token required' }, { status: 403 });
  const body = await req.json().catch(() => ({})) as {
    script?: ConcreteScript;
    channelId?: string;
    /** When set, treats this as a multi-niche listicle. Producer runs the
     *  writer once per channel, merges the per-niche scripts into one
     *  ConcreteScript with niche_index 1..N, and renders as a single mp4. */
    channels?: string[];
    beat_id?: string;
    sync?: boolean;
  };

  let script: ConcreteScript | undefined;

  if (body.script) {
    script = body.script;
  } else if (body.channels && body.channels.length > 0 && body.beat_id) {
    // Multi-channel listicle path: per-channel writer call, merged script.
    const beat_id = body.beat_id;
    const channels = body.channels.slice(0, 16);   // safety cap
    const perNicheScripts: ConcreteScript[] = [];
    const failures: Array<{ channelId: string; reason: string }> = [];
    for (let i = 0; i < channels.length; i++) {
      const cid = channels[i];
      const ch = await loadChannel(cid);
      if (!ch) { failures.push({ channelId: cid, reason: 'not in DB' }); continue; }
      const beats = stubNarration(beat_id, ch);
      if (beats.length === 0) { failures.push({ channelId: cid, reason: `no stub narration for ${beat_id}` }); continue; }
      const input: ScriptWriterInput = {
        channel: ch,
        niche_index: i + 1,
        video_id: `listicle-${beat_id}-${cid.slice(-6)}`,
        beats,
        voice: 'money_groot',
        width: 1920, height: 1080,
      };
      const result = await writeScript(input);
      if (!result.ok || !result.script) {
        failures.push({ channelId: cid, reason: result.errors?.[0]?.message?.slice(0, 200) ?? 'writer failed' });
        continue;
      }
      perNicheScripts.push(result.script);
    }
    if (perNicheScripts.length === 0) {
      return NextResponse.json({ error: 'every channel failed to author', failures }, { status: 500 });
    }
    // Merge: take first script's context/final shape, concat all slots.
    const first = perNicheScripts[0];
    script = {
      schema_version: '1',
      context: {
        ...first.context,
        channelId: channels.join(','),   // marker — real channels are in slot_ids
        channel_name: `listicle-${channels.length}-niches`,
        video_id: `listicle-${Date.now()}`,
      },
      slots: perNicheScripts.flatMap(s => s.slots),
      final: {
        tool: 'video_compose',
        args: {
          slot_order: perNicheScripts.flatMap(s => s.slots.map(slot => slot.slot_id)),
          width: 1920, height: 1080, fps: 30,
          default_bg: 'dark_gray',
          music_token: 'bed',
        },
      },
    };
  } else if (body.channelId && body.beat_id) {
    // Vertical-slice path: auto-author a single-beat script via script-writer.
    const ch = await loadChannel(body.channelId);
    if (!ch) return NextResponse.json({ error: `channel ${body.channelId} not in DB` }, { status: 404 });
    const beats = stubNarration(body.beat_id, ch);
    if (beats.length === 0) return NextResponse.json({ error: `no stub narration for beat_id=${body.beat_id}` }, { status: 400 });
    const input: ScriptWriterInput = {
      channel: ch,
      niche_index: 1,
      video_id: `producer-${body.beat_id}-${ch.channelId.slice(-6)}`,
      beats,
      voice: 'money_groot',
      // Long-form 16:9 (MG videos are ~14-min YT long-form, not Shorts).
      width: 1920,
      height: 1080,
    };
    const result = await writeScript(input);
    if (!result.ok || !result.script) {
      return NextResponse.json({ error: 'script-writer failed', writer_errors: result.errors, raw_response: result.raw_response }, { status: 500 });
    }
    script = result.script;
  } else {
    return NextResponse.json({ error: 'one of: body.script | (channelId + beat_id) | (channels[] + beat_id) required' }, { status: 400 });
  }

  // Validate before we burn a job row.
  try { assertValidScript(script); }
  catch (e) { return NextResponse.json({ error: 'invalid script', detail: (e as Error).message }, { status: 400 }); }

  const job_id = await startJob({ script });

  if (body.sync) {
    const result = await runJob(job_id);
    return NextResponse.json({ ok: result.ok, job_id, ...result });
  }
  // Fire and forget — the GUI polls status.
  void runJob(job_id).catch((e: Error) => console.error(`[producer:${job_id}] runJob threw`, e));
  return NextResponse.json({ ok: true, job_id, mode: 'async', status_url: `/api/admin/content-gen/producer/status?id=${job_id}` });
}
