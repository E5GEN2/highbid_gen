/**
 * Google Text Embedding API client.
 * Uses text-embedding-004 model (768 dimensions).
 * Rotates across multiple API keys for quota distribution.
 * Supports batch embedding (up to 100 texts per call).
 */

import { getPool } from './db';

const EMBED_API_BASE = 'https://generativelanguage.googleapis.com/v1/models';

let cachedKeys: string[] = [];
let keyIndex = 0;
let lastKeyFetch = 0;
const KEY_CACHE_TTL = 5 * 60 * 1000; // 5 min

/** Load Google API keys from admin config (one per line) */
async function getApiKeys(): Promise<string[]> {
  if (Date.now() - lastKeyFetch < KEY_CACHE_TTL && cachedKeys.length > 0) return cachedKeys;

  const pool = await getPool();
  const res = await pool.query("SELECT value FROM admin_config WHERE key = 'niche_google_api_keys'");
  const raw = res.rows[0]?.value || '';
  cachedKeys = raw.split('\n').map((k: string) => k.trim()).filter((k: string) => k.length > 10);
  lastKeyFetch = Date.now();
  return cachedKeys;
}

/** Get next API key (round-robin) */
async function getNextKey(): Promise<string> {
  const keys = await getApiKeys();
  if (keys.length === 0) throw new Error('No Google API keys configured. Add them in Admin > Niche Explorer.');
  const key = keys[keyIndex % keys.length];
  keyIndex++;
  return key;
}

/** Get embedding model from config */
async function getModel(): Promise<string> {
  const pool = await getPool();
  const res = await pool.query("SELECT value FROM admin_config WHERE key = 'niche_embedding_model'");
  return res.rows[0]?.value || 'text-embedding-004';
}

export interface EmbeddingResult {
  text: string;
  embedding: number[];
  dimensions: number;
}

/**
 * Generate embedding for a single text.
 */
export async function embedText(text: string): Promise<number[]> {
  const key = await getNextKey();
  const model = await getModel();

  const res = await fetch(
    `${EMBED_API_BASE}/${model}:embedContent?key=${key}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: `models/${model}`,
        content: { parts: [{ text }] },
      }),
    }
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Embedding API ${res.status}: ${err.substring(0, 200)}`);
  }

  const data = await res.json();
  return data.embedding?.values || [];
}

/**
 * Batch embed multiple texts (up to 100 per call).
 */
export async function batchEmbed(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  if (texts.length > 100) throw new Error('Batch limit is 100 texts');

  const key = await getNextKey();
  const model = await getModel();

  const res = await fetch(
    `${EMBED_API_BASE}/${model}:batchEmbedContents?key=${key}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: texts.map(text => ({
          model: `models/${model}`,
          content: { parts: [{ text }] },
        })),
      }),
    }
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Batch embedding API ${res.status}: ${err.substring(0, 200)}`);
  }

  const data = await res.json();
  return (data.embeddings || []).map((e: { values: number[] }) => e.values);
}

/**
 * Get embedding stats
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
