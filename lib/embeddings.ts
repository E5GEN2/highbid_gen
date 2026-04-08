/**
 * Google Text Embedding API client.
 * Uses gemini-embedding-001 model (3072 dimensions).
 * Rotates across multiple API keys for quota distribution.
 * Routes through xgodo proxy via curl subprocess to avoid Railway IP rate limits.
 */

import { getPool } from './db';
import { getProxy } from './xgodo-proxy';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const EMBED_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

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

export interface EmbeddingResult {
  text: string;
  embedding: number[];
  dimensions: number;
}

/**
 * Batch embed multiple texts (up to 100 per call).
 * Uses curl with proxy to avoid Railway IP rate limits.
 */
export async function batchEmbed(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  if (texts.length > 100) throw new Error('Batch limit is 100 texts');

  const key = await getNextKey();
  const model = await getModel();
  const proxy = await getProxy();

  const url = `${EMBED_API_BASE}/${model}:batchEmbedContents?key=${key}`;
  const bodyJson = JSON.stringify({
    requests: texts.map(text => ({
      model: `models/${model}`,
      content: { parts: [{ text }] },
    })),
  });

  // Write body to temp file to avoid arg escaping issues
  const fs = await import('fs');
  const os = await import('os');
  const path = await import('path');
  const tmpFile = path.join(os.tmpdir(), `embed_${Date.now()}.json`);
  fs.writeFileSync(tmpFile, bodyJson);

  // Use curl subprocess — try with proxy, fallback to direct on failure
  const args = ['-s', '--max-time', '30', '-X', 'POST', url, '-H', 'Content-Type: application/json', '-d', `@${tmpFile}`];
  if (proxy) {
    args.push('--proxy', proxy.url);
  }

  let stdout: string;
  try {
    const result = await execFileAsync('curl', args, { timeout: 45000, maxBuffer: 50 * 1024 * 1024 });
    stdout = result.stdout;
  } catch (proxyErr) {
    // If proxy failed, retry without proxy
    if (proxy) {
      console.log('[embedding] Proxy failed, retrying direct...');
      const directArgs = args.filter(a => a !== '--proxy' && a !== proxy.url);
      try {
        const result = await execFileAsync('curl', directArgs, { timeout: 45000, maxBuffer: 50 * 1024 * 1024 });
        stdout = result.stdout;
      } catch (directErr) {
        fs.unlinkSync(tmpFile);
        const e = directErr as { stderr?: string; message?: string };
        throw new Error(`curl direct failed: ${e.stderr?.substring(0, 200) || e.message?.substring(0, 200)}`);
      }
    } else {
      fs.unlinkSync(tmpFile);
      const e = proxyErr as { stderr?: string; message?: string };
      throw new Error(`curl failed: ${e.stderr?.substring(0, 200) || e.message?.substring(0, 200)}`);
    }
  }
  fs.unlinkSync(tmpFile);

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(stdout);
  } catch {
    throw new Error(`Failed to parse embedding response: ${stdout.substring(0, 200)}`);
  }

  if ((data as { error?: { message?: string } }).error) {
    const err = data as { error: { code?: number; message?: string } };
    throw new Error(`Embedding API ${err.error.code}: ${err.error.message?.substring(0, 150)}`);
  }

  return ((data as { embeddings?: Array<{ values: number[] }> }).embeddings || []).map(e => e.values);
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
