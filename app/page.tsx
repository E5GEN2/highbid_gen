import { redirect } from 'next/navigation';
import { getPool } from '@/lib/db';
import { HomepageDashboard } from '@/components/HomepageDashboard';

/**
 * Bare-domain entry point. Server-renders so we can hit admin_config
 * before any HTML ships — that lets the admin "use /niche as homepage"
 * checkbox flip the destination with a 302 instead of a client-side
 * redirect flash. The product picker still lives at /welcome for cases
 * where admins want to see it even when the redirect is on.
 *
 * Defaults to dashboard on any DB hiccup so the bare domain never
 * 500s on a transient failure.
 */
export const dynamic = 'force-dynamic';

export default async function Home() {
  let redirectToNiche = false;
  try {
    const pool = await getPool();
    const r = await pool.query(
      "SELECT value FROM admin_config WHERE key = 'homepage_to_niche' LIMIT 1",
    );
    redirectToNiche = r.rows[0]?.value === 'true';
  } catch {
    // Stay on the dashboard if the DB lookup fails — preferable to a
    // 500 on the marketing surface.
  }
  if (redirectToNiche) redirect('/niche');
  return <HomepageDashboard />;
}
