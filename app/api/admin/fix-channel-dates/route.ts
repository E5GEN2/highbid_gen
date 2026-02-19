import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';

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
    return new NextResponse('Unauthorized', { status: 401 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      function send(event: string, data: unknown) {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      }

      try {
        const pool = await getPool();

        const configRes = await pool.query(
          "SELECT value FROM admin_config WHERE key = 'youtube_api_key'"
        );
        const YT_API_KEY = configRes.rows[0]?.value;
        if (!YT_API_KEY) {
          send('error', { error: 'YouTube API key not configured' });
          controller.close();
          return;
        }

        // Only fetch channels with NULL, future, or obviously bad dates
        const channelsRes = await pool.query(`
          SELECT channel_id, channel_url FROM shorts_channels
          WHERE channel_creation_date IS NULL
             OR channel_creation_date > NOW()
             OR channel_creation_date < '2005-01-01'
        `);

        const channels = channelsRes.rows as { channel_id: string; channel_url: string }[];

        if (channels.length === 0) {
          send('done', { total: 0, updated: 0, failed: 0, resolved: 0 });
          controller.close();
          return;
        }

        send('progress', { message: `Found ${channels.length} channels needing date fix`, total: channels.length, processed: 0, updated: 0, failed: 0 });

        // Separate @handle IDs from real UC... IDs
        const handleChannels: { handle: string; channel_url: string; original_id: string }[] = [];
        const realIds: string[] = [];

        for (const ch of channels) {
          if (ch.channel_id.startsWith('@')) {
            const handle = ch.channel_id.slice(1);
            handleChannels.push({ handle, channel_url: ch.channel_url, original_id: ch.channel_id });
          } else {
            realIds.push(ch.channel_id);
          }
        }

        // Resolve @handles to UC... IDs via YouTube API
        let resolved = 0;
        const handleToUC = new Map<string, string>();

        if (handleChannels.length > 0) {
          send('progress', { message: `Resolving ${handleChannels.length} @handle IDs...`, total: channels.length, processed: 0, updated: 0, failed: 0 });

          for (const hc of handleChannels) {
            try {
              const res = await fetch(
                `https://www.googleapis.com/youtube/v3/channels?part=id,snippet&forHandle=${encodeURIComponent(hc.handle)}&key=${YT_API_KEY}`
              );
              if (res.ok) {
                const data = await res.json();
                const item = data.items?.[0];
                if (item?.id) {
                  handleToUC.set(hc.original_id, item.id);
                  const publishedAt = item.snippet?.publishedAt;

                  // Update channel_id and creation_date in one go
                  await pool.query(
                    `UPDATE shorts_channels SET channel_id = $1, channel_creation_date = COALESCE($2, channel_creation_date) WHERE channel_id = $3`,
                    [item.id, publishedAt || null, hc.original_id]
                  );
                  resolved++;
                }
              }
            } catch { /* skip */ }
          }

          send('progress', { message: `Resolved ${resolved}/${handleChannels.length} handles`, total: channels.length, processed: resolved, updated: resolved, failed: 0 });
        }

        // Process real UC... IDs in batches of 50
        let updated = resolved;
        let failed = 0;
        let processed = resolved + (handleChannels.length - resolved); // handles done

        for (let i = 0; i < realIds.length; i += 50) {
          const batch = realIds.slice(i, i + 50);
          try {
            const ytRes = await fetch(
              `https://www.googleapis.com/youtube/v3/channels?part=snippet&id=${batch.join(',')}&key=${YT_API_KEY}`
            );
            if (!ytRes.ok) {
              failed += batch.length;
              processed += batch.length;
              send('progress', { message: `YouTube API error: ${ytRes.status}`, total: channels.length, processed, updated, failed });
              continue;
            }
            const ytData = await ytRes.json();
            const foundIds = new Set<string>();
            for (const item of ytData.items || []) {
              const publishedAt = item.snippet?.publishedAt;
              if (publishedAt) {
                await pool.query(
                  'UPDATE shorts_channels SET channel_creation_date = $1 WHERE channel_id = $2',
                  [publishedAt, item.id]
                );
                updated++;
                foundIds.add(item.id);
              }
            }
            // Count channels not returned by API as failed
            failed += batch.length - foundIds.size;
          } catch (err) {
            console.error('Batch failed:', err);
            failed += batch.length;
          }

          processed += batch.length;
          send('progress', {
            message: `${processed}/${channels.length} processed`,
            total: channels.length,
            processed,
            updated,
            failed,
          });
        }

        send('done', { total: channels.length, updated, failed, resolved });
      } catch (error) {
        console.error('Fix channel dates error:', error);
        send('error', { error: error instanceof Error ? error.message : 'Failed' });
      } finally {
        controller.close();
      }
    },
  });

  return new NextResponse(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}
