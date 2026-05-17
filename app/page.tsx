import { redirect } from 'next/navigation';
import { getPool } from '@/lib/db';
import { auth } from '@/lib/auth';
import { HomepageDashboard } from '@/components/HomepageDashboard';
import { LandingPage } from '@/components/LandingPage';

/**
 * Bare-domain entry point. Three audiences, decided server-side so
 * the right HTML ships on the first byte:
 *
 *   1. Not signed in        → marketing landing page (LandingPage)
 *   2. Signed in + flag on  → 302 to /niche (admin set
 *                             `homepage_to_niche=true`)
 *   3. Signed in + flag off → product picker dashboard
 *
 * The product picker stays reachable at /welcome regardless of (2)
 * so admins can always get back to it. Defaults to dashboard on any
 * DB hiccup so the bare domain never 500s on a transient failure.
 */
export const dynamic = 'force-dynamic';

export default async function Home() {
  // 1. Anonymous visitor → marketing landing. Returning early here
  //    means we never hit admin_config for signed-out traffic, which
  //    keeps the bare domain fast for first-time visitors.
  const session = await auth();
  if (!session?.user) return <LandingPage />;

  // 2. Signed in — decide between /niche redirect and the dashboard.
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
