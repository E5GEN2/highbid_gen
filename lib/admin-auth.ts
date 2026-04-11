/**
 * Admin API token authentication.
 * Admin tokens have prefix "hba_" and scope "admin".
 * Validated via the api_tokens table.
 */

import { NextRequest } from 'next/server';
import { pool, getPool } from './db';
import crypto from 'crypto';

/** Check if request has valid admin auth (token or cookie) */
export async function isAdmin(req: NextRequest): Promise<boolean> {
  // Check Bearer token first
  const authHeader = req.headers.get('authorization');
  if (authHeader?.startsWith('Bearer hba_')) {
    const token = authHeader.slice(7);
    await getPool(); // ensure schema
    const result = await pool.query(
      `SELECT id FROM api_tokens WHERE token = $1 AND scopes = 'admin'`,
      [token]
    );
    if (result.rows.length > 0) {
      // Update last_used_at
      pool.query(`UPDATE api_tokens SET last_used_at = NOW() WHERE token = $1`, [token]).catch(() => {});
      return true;
    }
  }

  // Check x-admin-token header
  const headerToken = req.headers.get('x-admin-token');
  if (headerToken?.startsWith('hba_')) {
    await getPool();
    const result = await pool.query(
      `SELECT id FROM api_tokens WHERE token = $1 AND scopes = 'admin'`,
      [headerToken]
    );
    if (result.rows.length > 0) {
      pool.query(`UPDATE api_tokens SET last_used_at = NOW() WHERE token = $1`, [headerToken]).catch(() => {});
      return true;
    }
  }

  // Fallback: admin cookie
  const cookies = req.headers.get('cookie') || '';
  const adminCookie = cookies.match(/admin_token=([^;]+)/)?.[1];
  if (adminCookie) {
    try {
      const decoded = Buffer.from(adminCookie, 'base64').toString();
      if (decoded.includes('rofe_admin_secret')) return true;
    } catch { /* invalid cookie */ }
  }

  return false;
}

/** Create an admin API token */
export async function createAdminToken(name: string = 'admin'): Promise<{ id: string; token: string }> {
  await getPool();
  const token = 'hba_' + crypto.randomBytes(32).toString('hex');
  const result = await pool.query(
    `INSERT INTO api_tokens (name, token, scopes) VALUES ($1, $2, 'admin') RETURNING id`,
    [name, token]
  );
  return { id: result.rows[0].id, token };
}

/** List admin tokens (masked) */
export async function listAdminTokens(): Promise<Array<{ id: string; name: string; tokenPreview: string; lastUsedAt: string | null; createdAt: string }>> {
  await getPool();
  const result = await pool.query(
    `SELECT id, name, token, last_used_at, created_at FROM api_tokens WHERE scopes = 'admin' ORDER BY created_at DESC`
  );
  return result.rows.map(r => ({
    id: r.id,
    name: r.name,
    tokenPreview: r.token.substring(0, 8) + '...' + r.token.substring(r.token.length - 4),
    lastUsedAt: r.last_used_at,
    createdAt: r.created_at,
  }));
}

/** Delete an admin token */
export async function deleteAdminToken(id: string): Promise<boolean> {
  const result = await pool.query(`DELETE FROM api_tokens WHERE id = $1 AND scopes = 'admin'`, [id]);
  return (result.rowCount || 0) > 0;
}
