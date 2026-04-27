/**
 * xgodo market-devices helper.
 *
 * Wraps GET /api/v2/devices/market — returns devices currently listed on
 * the market with payment_type='action' that are ALSO online right now.
 * The endpoint only returns `{ name, country }` per device — no UUID,
 * so we cross-reference back to our worker pool by `name`, which is the
 * same string that lands in vizard_clips.xgodo_device_name and in
 * job-bucket entries' `device_name` field.
 *
 * We use this as the "is this device alive" check before pinning a
 * planned task to it — if the device isn't in this list, xgodo will
 * happily keep the planned task in limbo forever (the docs explicitly
 * say "If the device is not available, the task will be retried later").
 */

const XGODO_API = 'https://xgodo.com/api/v2';

export interface MarketDevice {
  name: string;
  country: string;
}

export async function listMarketDevices(
  token: string,
  opts: { country?: string; sortDirection?: 'asc' | 'desc' } = {}
): Promise<MarketDevice[]> {
  const params = new URLSearchParams();
  if (opts.country) params.set('country', opts.country);
  if (opts.sortDirection) params.set('sortDirection', opts.sortDirection);

  const url = `${XGODO_API}/devices/market${params.toString() ? `?${params}` : ''}`;
  const r = await fetch(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`xgodo market devices ${r.status}: ${text.slice(0, 200)}`);
  }

  const body = await r.json();
  return Array.isArray(body) ? (body as MarketDevice[]) : [];
}

/** Quick `Set<deviceName>` for membership tests — the common case. */
export function marketDeviceNameSet(devices: MarketDevice[]): Set<string> {
  return new Set(devices.map(d => d.name).filter(Boolean));
}
