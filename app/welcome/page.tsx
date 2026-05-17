import { HomepageDashboard } from '@/components/HomepageDashboard';

/**
 * Permanent home for the product-picker dashboard. The bare-domain
 * route (/) may redirect to /niche when the admin config flag
 * `homepage_to_niche` is on — this route always renders the
 * dashboard so it stays reachable in that case.
 */
export default function Welcome() {
  return <HomepageDashboard />;
}
