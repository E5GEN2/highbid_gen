import { pool } from './db';

/**
 * Get a config value from admin_config DB table, with env var fallback.
 */
export async function getConfigKey(key: string, envFallback?: string): Promise<string | null> {
  const result = await pool.query(
    `SELECT value FROM admin_config WHERE key = $1`,
    [key]
  );
  return result.rows[0]?.value || (envFallback ? process.env[envFallback] : null) || null;
}

export async function getPapaiApiKey(): Promise<string | null> {
  return getConfigKey('papai_api_key', 'PAPAI_API_KEY');
}
