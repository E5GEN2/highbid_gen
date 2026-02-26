import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '../../../../lib/db';

async function getConfig(pool: import('pg').Pool): Promise<Record<string, string>> {
  const result = await pool.query('SELECT key, value FROM admin_config');
  const config: Record<string, string> = {};
  for (const row of result.rows) config[row.key] = row.value;
  return config;
}

async function saveConfig(pool: import('pg').Pool, entries: Record<string, string>) {
  for (const [key, value] of Object.entries(entries)) {
    await pool.query(
      `INSERT INTO admin_config (key, value, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
      [key, value]
    );
  }
}

export async function GET(req: NextRequest) {
  try {
    const pool = await getPool();
    const config = await getConfig(pool);

    // Auth: Bearer token must match cron_secret
    const authHeader = req.headers.get('authorization');
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
    const cronSecret = config.cron_secret;

    if (!cronSecret || !token || token !== cronSecret) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Check if auto-sync is enabled
    if (config.auto_sync_enabled !== 'true') {
      return NextResponse.json({ skipped: true, reason: 'disabled' });
    }

    const taskLimit = parseInt(config.auto_sync_task_limit) || 200;

    // Build absolute URL for internal sync call
    const proto = req.headers.get('x-forwarded-proto') || 'https';
    const host = req.headers.get('host') || 'localhost:3000';
    const syncUrl = `${proto}://${host}/api/feed-spy/sync`;

    // Forward the admin cookie for auth — build one from the secret
    const adminToken = Buffer.from('admin:cron:rofe_admin_secret').toString('base64');

    const syncRes = await fetch(syncUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': `admin_token=${adminToken}`,
      },
      body: JSON.stringify({ limit: taskLimit }),
    });

    if (!syncRes.ok) {
      const errText = await syncRes.text();
      const errorResult = { synced: 0, skipped: 0, confirmed: 0, videos: 0, error: `Sync HTTP ${syncRes.status}: ${errText}` };
      await saveConfig(pool, {
        last_auto_sync_at: new Date().toISOString(),
        last_auto_sync_result: JSON.stringify(errorResult),
      });
      return NextResponse.json({ success: false, ...errorResult }, { status: 502 });
    }

    // Read the SSE stream to completion
    const reader = syncRes.body?.getReader();
    if (!reader) {
      return NextResponse.json({ success: false, error: 'No stream' }, { status: 502 });
    }

    const decoder = new TextDecoder();
    let buffer = '';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let doneData: any = null;
    let streamError: string | null = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      let eventType = '';
      for (const line of lines) {
        if (line.startsWith('event: ')) {
          eventType = line.slice(7);
        } else if (line.startsWith('data: ') && eventType) {
          try {
            const data = JSON.parse(line.slice(6));
            if (eventType === 'done') doneData = data;
            if (eventType === 'error') streamError = data.error || 'Sync failed';
          } catch { /* skip malformed */ }
          eventType = '';
        }
      }
    }

    const now = new Date().toISOString();

    if (streamError) {
      const errorResult = { synced: 0, skipped: 0, confirmed: 0, videos: 0, error: streamError };
      await saveConfig(pool, {
        last_auto_sync_at: now,
        last_auto_sync_result: JSON.stringify(errorResult),
      });
      return NextResponse.json({ success: false, ...errorResult });
    }

    const result = {
      synced: doneData?.synced ?? 0,
      skipped: doneData?.skipped ?? 0,
      confirmed: doneData?.confirmed ?? 0,
      videos: doneData?.videos ?? 0,
    };

    await saveConfig(pool, {
      last_auto_sync_at: now,
      last_auto_sync_result: JSON.stringify(result),
    });

    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    console.error('Cron sync error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Cron sync failed' },
      { status: 500 }
    );
  }
}
