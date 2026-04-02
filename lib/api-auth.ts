/**
 * API authentication — supports both NextAuth sessions and API tokens.
 *
 * Usage in API routes:
 *   const user = await getApiUser(req);
 *   if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
 *   // user.id is the user ID
 */

import { NextRequest } from 'next/server';
import { auth } from './auth';
import { pool, getPool } from './db';
import crypto from 'crypto';

export interface ApiUser {
  id: string;
  email?: string;
  name?: string;
  tokenId?: string; // Set if authenticated via API token
}

/**
 * Authenticate a request via session or Bearer token.
 * Returns the user if authenticated, null otherwise.
 */
export async function getApiUser(req: NextRequest): Promise<ApiUser | null> {
  // Try session auth first (NextAuth)
  const session = await auth();
  if (session?.user?.id) {
    return {
      id: session.user.id as string,
      email: session.user.email || undefined,
      name: session.user.name || undefined,
    };
  }

  // Try Bearer token
  const authHeader = req.headers.get('authorization');
  if (!authHeader?.startsWith('Bearer ')) return null;

  const token = authHeader.slice(7);
  if (!token || token.length < 20) return null;

  try {
    const result = await pool.query(
      `SELECT t.id as token_id, t.user_id, t.scopes, u.email, u.name
       FROM api_tokens t
       LEFT JOIN users u ON u.id = t.user_id
       WHERE t.token = $1`,
      [token]
    );

    if (result.rows.length === 0) return null;

    const row = result.rows[0];

    // Update last_used_at (fire-and-forget)
    pool.query(`UPDATE api_tokens SET last_used_at = NOW() WHERE id = $1`, [row.token_id]).catch(() => {});

    return {
      id: row.user_id,
      email: row.email || undefined,
      name: row.name || undefined,
      tokenId: row.token_id,
    };
  } catch {
    return null;
  }
}

/**
 * Generate a new API token for a user.
 */
export async function createApiToken(userId: string | null, name: string = 'default'): Promise<{ id: string; token: string }> {
  await getPool(); // Ensure schema is initialized
  const token = 'hb_' + crypto.randomBytes(32).toString('hex');

  const result = await pool.query(
    `INSERT INTO api_tokens (user_id, name, token) VALUES ($1, $2, $3) RETURNING id`,
    [userId, name, token]
  );

  return { id: result.rows[0].id, token };
}

/**
 * List all tokens for a user (without revealing full token values).
 */
export async function listApiTokens(userId?: string): Promise<Array<{ id: string; name: string; tokenPreview: string; lastUsedAt: string | null; createdAt: string }>> {
  const query = userId
    ? `SELECT id, name, token, last_used_at, created_at FROM api_tokens WHERE user_id = $1 ORDER BY created_at DESC`
    : `SELECT id, name, token, user_id, last_used_at, created_at FROM api_tokens ORDER BY created_at DESC`;
  const params = userId ? [userId] : [];

  const result = await pool.query(query, params);
  return result.rows.map(r => ({
    id: r.id,
    name: r.name,
    userId: r.user_id,
    tokenPreview: r.token.substring(0, 7) + '...' + r.token.substring(r.token.length - 4),
    lastUsedAt: r.last_used_at,
    createdAt: r.created_at,
  }));
}

/**
 * Delete an API token.
 */
export async function deleteApiToken(tokenId: string): Promise<boolean> {
  const result = await pool.query(`DELETE FROM api_tokens WHERE id = $1`, [tokenId]);
  return (result.rowCount || 0) > 0;
}
