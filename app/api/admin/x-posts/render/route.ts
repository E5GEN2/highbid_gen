import { NextRequest, NextResponse } from 'next/server';
import { createJob, updateJob } from '../../../../../lib/videoQueue';
import { renderComposition } from '../../../../../lib/remotion/renderOrchestrator';
import { downloadClipsForChannels } from '../../../../../lib/remotion/clipDownloader';
import { getPool } from '../../../../../lib/db';

function checkAuth(req: NextRequest): boolean {
  const token = req.cookies.get('admin_token')?.value;
  if (!token) return false;
  try {
    const decoded = Buffer.from(token, 'base64').toString();
    return decoded.startsWith('admin:') && decoded.endsWith(':rofe_admin_secret');
  } catch {
    return false;
  }
}

// We store stage logs in the video_url column while processing (overwritten on complete)
// Format: newline-separated timestamped log lines
function appendLog(existing: string | undefined, msg: string): string {
  const ts = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const line = `[${ts}] ${msg}`;
  return existing ? `${existing}\n${line}` : line;
}

export async function POST(req: NextRequest) {
  if (!checkAuth(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { compositionId, inputProps, channelIds } = await req.json();

    if (!compositionId || !inputProps) {
      return NextResponse.json({ error: 'compositionId and inputProps required' }, { status: 400 });
    }

    const jobId = `render-${compositionId}-${Date.now()}`;
    await createJob(jobId);

    // Start background render
    (async () => {
      let logs = '';
      const log = async (msg: string, progress?: number) => {
        logs = appendLog(logs, msg);
        const updates: Record<string, unknown> = { videoUrl: logs };
        if (progress !== undefined) updates.progress = progress;
        await updateJob(jobId, updates as any).catch(() => {});
      };

      try {
        await updateJob(jobId, { status: 'processing', progress: 2 });
        await log('Starting render job...', 2);

        // Download clips if channelIds provided
        if (channelIds && channelIds.length > 0) {
          await log(`Fetching video IDs for ${channelIds.length} channel(s)...`, 5);

          const pool = await getPool();
          const channelVideoMap: Record<string, string[]> = {};

          for (const channelId of channelIds) {
            const result = await pool.query(
              `SELECT DISTINCT video_id FROM shorts_videos WHERE channel_id = $1 ORDER BY video_id LIMIT 3`,
              [channelId]
            );
            channelVideoMap[channelId] = result.rows.map((r: { video_id: string }) => r.video_id);
          }

          const totalClips = Object.values(channelVideoMap).flat().length;
          await log(`Downloading ${totalClips} clip(s)...`, 8);

          const clipResults = await downloadClipsForChannels(
            channelVideoMap,
            3,
            3,
            (done, total) => {
              const clipProgress = 8 + Math.round((done / total) * 20);
              log(`Downloaded clip ${done}/${total}`, clipProgress).catch(() => {});
            }
          );

          // Inject clip paths into input props
          if (inputProps.clipPaths !== undefined) {
            const firstChannelClips = Object.values(clipResults)[0]?.map(r => r.filePath) || [];
            inputProps.clipPaths = firstChannelClips;
            await log(`Clips ready: ${firstChannelClips.length} video(s)`, 28);
          } else {
            await log('Clips downloaded', 28);
          }
        } else {
          await log('No clips to download, skipping', 28);
        }

        await log('Bundling Remotion compositions (webpack)...', 30);

        const outputPath = await renderComposition(
          compositionId,
          inputProps,
          jobId,
          (renderProgress) => {
            const jobProgress = 35 + Math.round(renderProgress * 0.60);
            const phase = renderProgress < 5 ? 'Launching browser...'
              : renderProgress < 15 ? 'Capturing frames...'
              : renderProgress < 90 ? `Rendering frames... ${renderProgress}%`
              : 'Encoding MP4...';
            log(phase, jobProgress).catch(() => {});
          }
        );

        await log('Render complete!', 98);
        await log(`Output: ${outputPath.split('/').pop()}`, 100);

        await updateJob(jobId, {
          status: 'completed',
          progress: 100,
          videoUrl: `/api/admin/x-posts/render-download/${jobId}`,
        });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : 'Render failed';
        console.error(`Render failed for job ${jobId}:`, err);
        await log(`ERROR: ${errMsg}`);
        await updateJob(jobId, {
          status: 'failed',
          error: `${errMsg}\n\n--- Log ---\n${logs}`,
        });
      }
    })();

    return NextResponse.json({ jobId });
  } catch (error) {
    console.error('Render API error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to start render' },
      { status: 500 }
    );
  }
}
