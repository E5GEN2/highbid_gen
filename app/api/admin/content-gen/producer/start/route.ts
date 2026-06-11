/**
 * POST /api/admin/content-gen/producer/start
 *
 * Body: { script: ConcreteScript }
 *   OR  { channels: string[], beat_id, intro_logos_channels? }  — multi-niche
 *       listicle (full MG beat sequence per channel; one merged mp4)
 *   OR  { channelId, beat_id }  — single-channel vertical slice (writer's
 *       proof beats only; testing convenience)
 *
 * Returns { job_id }. Job runs ASYNC — poll /producer/status?id=N.
 *
 * All listicle-assembly logic lives in lib/content-gen/listicle-builder.ts
 * (shared with the local CLI runner — scripts/local/render.mts).
 */

import { NextRequest, NextResponse } from 'next/server';
import { isAdmin } from '@/lib/admin-auth';
import { startJob, runJob } from '@/lib/content-gen/producer';
import { writeScript, type ScriptWriterInput } from '@/lib/content-gen/script-writer';
import { assertValidScript, type ConcreteScript } from '@/lib/content-gen/concrete-script';
import {
  buildListicleScript,
  loadChannel,
  stubNarration,
  forceProofKind,
  swapMostPopularCallout,
  injectCropTargets,
  type ChannelEvent,
} from '@/lib/content-gen/listicle-builder';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 600;

export async function POST(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin token required' }, { status: 403 });
  const body = await req.json().catch(() => ({})) as {
    script?: ConcreteScript;
    channelId?: string;
    channels?: string[];
    intro_logos_channels?: string[];
    beat_id?: string;
    sync?: boolean;
  };

  let script: ConcreteScript | undefined;
  let channelEvents: ChannelEvent[] = [];

  if (body.script) {
    script = body.script;
  } else if (body.channels && body.channels.length > 0 && body.beat_id) {
    // Multi-channel listicle — full beat sequence per channel.
    const built = await buildListicleScript({
      channels: body.channels,
      beat_id: body.beat_id,
      intro_logos_channels: body.intro_logos_channels,
    });
    if (!built.script) {
      return NextResponse.json({ error: built.error ?? 'listicle build failed', failures: built.failures }, { status: 500 });
    }
    script = built.script;
    channelEvents = built.channelEvents;
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
    // Same post-writer transforms as the listicle path. DO NOT call
    // swapChannelProof — task #65's animated L→R highlight depends on the
    // about_page screenshot crop path.
    const proofSwapped = forceProofKind(result.script.slots);
    const callouttSwapped = await swapMostPopularCallout(proofSwapped, ch);
    result.script.slots = injectCropTargets(callouttSwapped);
    script = result.script;
  } else {
    return NextResponse.json({ error: 'one of: body.script | (channelId + beat_id) | (channels[] + beat_id) required' }, { status: 400 });
  }

  // Validate before we burn a job row.
  try { assertValidScript(script); }
  catch (e) { return NextResponse.json({ error: 'invalid script', detail: (e as Error).message }, { status: 400 }); }

  const job_id = await startJob({ script });

  // Retroactively log writer + db_save graph nodes so the Execution
  // panel shows the first events of the render BEFORE any gem starts.
  void (async () => {
    try {
      const { upsertNode, addEdge, nodeKey } = await import('@/lib/content-gen/exec-graph');
      const events = channelEvents;
      if (events.length === 0 && body.channelId) {
        const wKey = `writer:${body.channelId}`;
        await upsertNode({
          jobId: job_id, nodeKey: wKey, nodeType: 'writer',
          label: `writer · ${body.channelId.slice(-6)}`, status: 'done',
          payload: { channelId: body.channelId, beat_id: body.beat_id, slot_count: script.slots.length },
        });
        if (script.slots[0]) {
          await addEdge(job_id, wKey, nodeKey.slot(script.slots[0].slot_id), 'sequence');
        }
        return;
      }
      for (const ev of events) {
        const wKey = `writer:${ev.channelId}`;
        await upsertNode({
          jobId: job_id, nodeKey: wKey, nodeType: 'writer',
          label: `writer · niche ${ev.niche_index} · ${ev.channel_label?.slice(0, 16) ?? ev.channelId.slice(-6)}`,
          status: ev.writer.ok ? 'done' : 'failed',
          payload: {
            channelId: ev.channelId, niche_index: ev.niche_index,
            slot_count: ev.writer.slot_count, beats: ev.writer.beats,
            error: ev.writer.error,
          },
        });
        const dbKey = `db:${ev.channelId}:niche_spy_channels`;
        await upsertNode({
          jobId: job_id, nodeKey: dbKey, nodeType: 'db_save',
          label: `niche_spy_channels · ${ev.channelId.slice(-6)}`, status: 'done',
          payload: { table: 'niche_spy_channels', channelId: ev.channelId, note: 'refreshChannelStats' },
        });
        await addEdge(job_id, dbKey, wKey, 'sequence');
        if (ev.writer.ok && ev.writer.first_slot_id) {
          await addEdge(job_id, wKey, nodeKey.slot(ev.writer.first_slot_id), 'sequence');
        }
      }
    } catch (e) {
      console.warn(`[producer:${job_id}] graph backfill failed:`, (e as Error).message.slice(0, 200));
    }
  })();

  if (body.sync) {
    const result = await runJob(job_id);
    return NextResponse.json({ ok: result.ok, job_id, ...result });
  }
  // Fire and forget — the GUI polls status.
  void runJob(job_id).catch((e: Error) => console.error(`[producer:${job_id}] runJob threw`, e));
  return NextResponse.json({ ok: true, job_id, mode: 'async', status_url: `/api/admin/content-gen/producer/status?id=${job_id}` });
}
