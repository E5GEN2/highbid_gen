/**
 * GET /api/admin/content-gen/producer/frames?id=N[&count=8]
 *
 * Extracts N evenly-spaced frames from a finished producer job's mp4 and
 * returns their URLs. Implements the "cut frames out of it to inspect all
 * the important moments" loop from the user's original spec — so the
 * Producer GUI can show a visual strip of the rendered video.
 *
 * Frames are cached on disk next to the mp4 (producer_renders/frames/job-N/),
 * named frame_NN.png. Second call is a no-op fetch.
 */

import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import { promises as fs } from 'fs';
import { spawn } from 'child_process';
import { isAdmin } from '@/lib/admin-auth';
import { getPool } from '@/lib/db';
import { CLIPS_DIR } from '@/lib/clips-dir';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 120;

const RENDER_DIR = path.join(CLIPS_DIR, 'producer_renders');
const FRAMES_DIR = path.join(RENDER_DIR, 'frames');

function ffprobeDuration(file: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const p = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', file]);
    let out = '';
    p.stdout.on('data', d => { out += d.toString(); });
    p.on('close', c => c === 0 ? resolve(parseFloat(out.trim()) || 0) : reject(new Error('ffprobe failed')));
    p.on('error', reject);
  });
}

function ffextract(file: string, ts: number, outPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error',
      '-ss', ts.toFixed(2), '-i', file, '-frames:v', '1', '-y', outPath]);
    p.on('close', c => c === 0 ? resolve() : reject(new Error(`ffmpeg exit ${c}`)));
    p.on('error', reject);
  });
}

export async function GET(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin token required' }, { status: 403 });
  const sp = req.nextUrl.searchParams;
  const id = parseInt(sp.get('id') ?? '0', 10);
  const count = Math.max(2, Math.min(24, parseInt(sp.get('count') ?? '8', 10)));
  if (!Number.isFinite(id) || id <= 0) return NextResponse.json({ error: 'bad id' }, { status: 400 });

  const pool = await getPool();
  const r = await pool.query<{ final_video_url: string | null; script_jsonb: { slots?: Array<{ slot_id: string }> } | null }>(
    `SELECT final_video_url, script_jsonb FROM content_gen_producer_jobs WHERE id=$1`,
    [id],
  );
  if (r.rows.length === 0) return NextResponse.json({ error: 'job not found' }, { status: 404 });
  const final_video_url = r.rows[0].final_video_url;
  if (!final_video_url) return NextResponse.json({ error: 'job has no final_video_url (not done?)' }, { status: 400 });

  // Resolve mp4 local path from the URL (?path=…)
  const m = final_video_url.match(/path=([^&]+)/);
  if (!m) return NextResponse.json({ error: 'bad video url' }, { status: 500 });
  const mp4Path = path.join(RENDER_DIR, decodeURIComponent(m[1]));
  try { await fs.stat(mp4Path); }
  catch { return NextResponse.json({ error: 'mp4 missing on disk' }, { status: 410 }); }

  const dir = path.join(FRAMES_DIR, `job-${id}`);
  await fs.mkdir(dir, { recursive: true });

  // Resolve slot count for "important moments" sampling: 1 frame per slot
  // when slot count is reasonable; otherwise N evenly-spaced.
  const slotCount = r.rows[0].script_jsonb?.slots?.length ?? 0;
  const slotIds = (r.rows[0].script_jsonb?.slots ?? []).map(s => s.slot_id);

  const dur = await ffprobeDuration(mp4Path);
  if (dur <= 0) return NextResponse.json({ error: 'could not probe duration' }, { status: 500 });

  // Per-slot midpoint timestamps if we have slot data; else evenly-spaced.
  let timestamps: number[];
  let labels: string[];
  if (slotCount > 0 && slotCount <= count) {
    // Estimate each slot's midpoint by dividing duration evenly across slots
    // (we don't store per-slot durations in the job — only the script's
    // declared hold_s, which is a template ref. So approximation it is.)
    const step = dur / slotCount;
    timestamps = Array.from({ length: slotCount }, (_, i) => step * i + step / 2);
    labels = slotIds;
  } else {
    timestamps = Array.from({ length: count }, (_, i) => dur * ((i + 0.5) / count));
    labels = timestamps.map((t, i) => `t=${t.toFixed(1)}s (#${i + 1})`);
  }

  const frames: Array<{ index: number; ts: number; label: string; url: string }> = [];
  for (let i = 0; i < timestamps.length; i++) {
    const name = `frame_${String(i).padStart(2, '0')}.png`;
    const out = path.join(dir, name);
    try { await fs.stat(out); }
    catch { await ffextract(mp4Path, timestamps[i], out); }
    frames.push({
      index: i,
      ts: Math.round(timestamps[i] * 100) / 100,
      label: labels[i] ?? '',
      url: `/api/admin/content-gen/producer/file?path=${encodeURIComponent('frames/job-' + id + '/' + name)}`,
    });
  }

  return NextResponse.json({ ok: true, job_id: id, duration_s: dur, frame_count: frames.length, frames });
}
