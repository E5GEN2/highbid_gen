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
      try {
        await updateJob(jobId, { status: 'processing', progress: 5 });

        // Download clips if channelIds provided
        let clipPaths: Record<string, string[]> = {};
        if (channelIds && channelIds.length > 0) {
          await updateJob(jobId, { progress: 10 });

          // Get video IDs for each channel
          const pool = await getPool();
          const channelVideoMap: Record<string, string[]> = {};

          for (const channelId of channelIds) {
            const result = await pool.query(
              `SELECT DISTINCT video_id FROM shorts_videos WHERE channel_id = $1 ORDER BY video_id LIMIT 3`,
              [channelId]
            );
            channelVideoMap[channelId] = result.rows.map((r: { video_id: string }) => r.video_id);
          }

          const clipResults = await downloadClipsForChannels(
            channelVideoMap,
            3,
            3,
            (done, total) => {
              const clipProgress = 10 + Math.round((done / total) * 20);
              updateJob(jobId, { progress: clipProgress }).catch(() => {});
            }
          );

          // Convert to path arrays
          for (const [chId, results] of Object.entries(clipResults)) {
            clipPaths[chId] = results.map(r => r.filePath);
          }

          // Inject clip paths into input props
          if (inputProps.clipPaths !== undefined) {
            // For single-channel compositions (ChannelSpotlightVideo)
            const firstChannelClips = Object.values(clipPaths)[0] || [];
            inputProps.clipPaths = firstChannelClips;
          }
        }

        await updateJob(jobId, { progress: 30 });

        // Render the composition
        const outputPath = await renderComposition(
          compositionId,
          inputProps,
          jobId,
          (progress) => {
            // Map render progress 0-100 to job progress 30-95
            const jobProgress = 30 + Math.round(progress * 0.65);
            updateJob(jobId, { progress: jobProgress }).catch(() => {});
          }
        );

        await updateJob(jobId, {
          status: 'completed',
          progress: 100,
          videoUrl: `/api/admin/x-posts/render-download/${jobId}`,
        });

        console.log(`Render complete: ${outputPath}`);
      } catch (err) {
        console.error(`Render failed for job ${jobId}:`, err);
        await updateJob(jobId, {
          status: 'failed',
          error: err instanceof Error ? err.message : 'Render failed',
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
