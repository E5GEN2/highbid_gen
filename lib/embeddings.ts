/**
 * Google Text Embedding API client.
 * Uses gemini-embedding-001 model (3072 dimensions).
 * Rotates across multiple API keys for quota distribution.
 * Routes through xgodo proxy via Python subprocess (same as yt-dlp proxy support).
 */

import { getPool } from './db';
import { getProxy } from './xgodo-proxy';
import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';

const execFileAsync = promisify(execFile);
const SCRIPTS_DIR = path.join(process.cwd(), 'scripts');

let cachedKeys: string[] = [];
let keyIndex = 0;
let lastKeyFetch = 0;
const KEY_CACHE_TTL = 5 * 60 * 1000;

async function getApiKeys(): Promise<string[]> {
  if (Date.now() - lastKeyFetch < KEY_CACHE_TTL && cachedKeys.length > 0) return cachedKeys;
  const pool = await getPool();
  const res = await pool.query("SELECT value FROM admin_config WHERE key = 'niche_google_api_keys'");
  const raw = res.rows[0]?.value || '';
  cachedKeys = raw.split('\n').map((k: string) => k.trim()).filter((k: string) => k.length > 10);
  lastKeyFetch = Date.now();
  return cachedKeys;
}

async function getNextKey(): Promise<string> {
  const keys = await getApiKeys();
  if (keys.length === 0) throw new Error('No Google API keys configured. Add them in Admin > Niche Explorer.');
  const key = keys[keyIndex % keys.length];
  keyIndex++;
  return key;
}

async function getModel(): Promise<string> {
  const pool = await getPool();
  const res = await pool.query("SELECT value FROM admin_config WHERE key = 'niche_embedding_model'");
  return res.rows[0]?.value || 'gemini-embedding-001';
}

/**
 * Batch embed multiple texts (up to 100 per call).
 * Uses Python subprocess with urllib proxy support — same approach that works for yt-dlp.
 */
export async function batchEmbed(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  if (texts.length > 100) throw new Error('Batch limit is 100 texts');

  const key = await getNextKey();
  const model = await getModel();
  const proxy = await getProxy();

  const fs = await import('fs');
  const os = await import('os');
  const inputData = JSON.stringify({ texts, key, model, proxy: proxy?.url || '' });
  const tmpFile = path.join(os.tmpdir(), `embed_input_${Date.now()}.json`);
  fs.writeFileSync(tmpFile, inputData);

  let rawOut: string | Buffer, rawErr: string | Buffer;
  try {
    const result = await execFileAsync(
      'python3',
      [path.join(SCRIPTS_DIR, 'embed-batch.py'), tmpFile],
      { timeout: 45000, maxBuffer: 50 * 1024 * 1024 }
    );
    rawOut = result.stdout;
    rawErr = result.stderr;
  } catch (err) {
    fs.unlinkSync(tmpFile);
    const e = err as { stderr?: string; stdout?: string; message?: string };
    const detail = e.stdout?.substring(0, 300) || e.stderr?.substring(0, 300) || e.message?.substring(0, 300);
    throw new Error(`Python embed failed: ${detail}`);
  }
  fs.unlinkSync(tmpFile);
  const stdout = String(rawOut);
  const stderr = String(rawErr);

  if (stderr) console.log('[embedding] stderr:', stderr.substring(0, 200));

  let result: number[][] | { error: string };
  try {
    result = JSON.parse(stdout);
  } catch {
    throw new Error(`Failed to parse embedding output: ${stdout.substring(0, 200)}`);
  }

  if (!Array.isArray(result)) {
    throw new Error((result as { error: string }).error || 'Unknown embedding error');
  }

  return result;
}

/**
 * Generate embedding for a single text.
 */
export async function embedText(text: string): Promise<number[]> {
  const results = await batchEmbed([text]);
  return results[0] || [];
}

/**
 * Get embedding stats.
 */
export async function getEmbeddingStats(): Promise<{
  totalVideos: number;
  embedded: number;
  notEmbedded: number;
  apiKeysConfigured: number;
  model: string;
}> {
  const pool = await getPool();
  const [statsRes, keys, model] = await Promise.all([
    pool.query(`
      SELECT
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE title_embedding IS NOT NULL) as embedded,
        COUNT(*) FILTER (WHERE title_embedding IS NULL AND title IS NOT NULL AND title != '') as not_embedded
      FROM niche_spy_videos
    `),
    getApiKeys(),
    getModel(),
  ]);

  return {
    totalVideos: parseInt(statsRes.rows[0].total),
    embedded: parseInt(statsRes.rows[0].embedded),
    notEmbedded: parseInt(statsRes.rows[0].not_embedded),
    apiKeysConfigured: keys.length,
    model,
  };
}
