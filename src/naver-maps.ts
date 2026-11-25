export class NaverMapsError extends Error {
  constructor(public readonly code: string, message: string, public readonly retryable = false) {
    super(message);
    this.name = 'NaverMapsError';
  }
}

export type GeoAddress = {
  roadAddress: string;
  jibunAddress: string;
  latitude: number;
  longitude: number;
};

export type MapMarker = { latitude: number; longitude: number; label: string };

export function mapMarkerLabel(index: number): string {
  if (!Number.isInteger(index) || index < 0 || index >= 34) throw new RangeError('Map marker index must be between 0 and 33.');
  return index < 9 ? String(index + 1) : String.fromCharCode(98 + index - 9);
}

const BASE = 'https://maps.apigw.ntruss.com';
const BODY_LIMIT = 4_000_000;
let nextRequestAt = 0;
let requestGate = Promise.resolve();

async function reserveSlot(signal?: AbortSignal) {
  const previous = requestGate;
  let release!: () => void;
  requestGate = new Promise<void>(resolve => { release = resolve; });
  await previous;
  try {
    if (signal?.aborted) throw new NaverMapsError('CANCELLED', 'Naver Maps request was cancelled.');
    const delay = Math.max(0, nextRequestAt - Date.now());
    if (delay) await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, delay);
      function onAbort() { clearTimeout(timer); reject(new NaverMapsError('CANCELLED', 'Naver Maps request was cancelled.')); }
      signal?.addEventListener('abort', onAbort, { once: true });
    });
    nextRequestAt = Date.now() + 250;
  } finally { release(); }
}

function credentials() {
  const id = process.env.NAVER_MAPS_CLIENT_ID;
  const secret = process.env.NAVER_MAPS_CLIENT_SECRET;
  if (!id || !secret) throw new NaverMapsError('MAPS_NOT_CONFIGURED', 'Naver Maps credentials are not configured.');
  return { id, secret };
}

async function request(path: string, params: Record<string, string | string[]>, signal?: AbortSignal, fetchImpl: typeof fetch = fetch): Promise<Response> {
  const auth = credentials();
  const url = new URL(path, BASE);
  for (const [key, value] of Object.entries(params)) {
    for (const part of Array.isArray(value) ? value : [value]) url.searchParams.append(key, part);
  }
  let response: Response;
  try {
    await reserveSlot(signal);
    response = await fetchImpl(url, {
      headers: { 'x-ncp-apigw-api-key-id': auth.id, 'x-ncp-apigw-api-key': auth.secret },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000),
    });
  } catch {
    if (signal?.aborted) throw new NaverMapsError('CANCELLED', 'Naver Maps request was cancelled.');
    throw new NaverMapsError('MAPS_NETWORK_ERROR', 'Naver Maps could not be reached.', true);
  }
  if (response.status === 401 || response.status === 403) throw new NaverMapsError('MAPS_FORBIDDEN', 'Naver Maps rejected the configured credentials or application permissions.');
  if (response.status === 429) throw new NaverMapsError('MAPS_QUOTA', 'Naver Maps request quota was exceeded.', true);
  if (response.status >= 500) throw new NaverMapsError('MAPS_UPSTREAM', `Naver Maps returned HTTP ${response.status}.`, true);
  if (!response.ok) throw new NaverMapsError('MAPS_BAD_REQUEST', `Naver Maps returned HTTP ${response.status}.`);
  return response;
}

export async function geocodeAddress(address: string, signal?: AbortSignal, fetchImpl: typeof fetch = fetch): Promise<GeoAddress[]> {
  const response = await request('/map-geocode/v2/geocode', { query: address, count: '5' }, signal, fetchImpl);
  let payload: any;
  try { payload = await response.json(); } catch { throw new NaverMapsError('MAPS_INVALID_RESPONSE', 'Naver Maps returned invalid geocoding data.', true); }
  if (payload.status !== 'OK' || !Array.isArray(payload.addresses)) {
    throw new NaverMapsError('MAPS_INVALID_RESPONSE', 'Naver Maps geocoding response did not contain addresses.', true);
  }
  const unique = new Map<string, GeoAddress>();
  for (const row of payload.addresses) {
    const latitude = Number(row.y);
    const longitude = Number(row.x);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;
    const item = { roadAddress: String(row.roadAddress ?? ''), jibunAddress: String(row.jibunAddress ?? ''), latitude, longitude };
    unique.set(`${latitude},${longitude}`, item);
  }
  return [...unique.values()].slice(0, 5);
}

export async function reverseGeocodeCoordinates(location: { latitude: number; longitude: number }, signal?: AbortSignal, fetchImpl: typeof fetch = fetch): Promise<{ city: string; district: string; dong: string; address: string } | null> {
  const response = await request('/map-reversegeocode/v2/gc', {
    coords: `${location.longitude},${location.latitude}`, sourcecrs: 'EPSG:4326', orders: 'admcode,roadaddr', output: 'json',
  }, signal, fetchImpl);
  let payload: any;
  try { payload = await response.json(); } catch { throw new NaverMapsError('MAPS_INVALID_RESPONSE', 'Naver Maps returned invalid reverse-geocoding data.', true); }
  if (payload.status?.code !== 0 || !Array.isArray(payload.results)) return null;
  const administrative = payload.results.find((item: any) => item.name === 'admcode') ?? payload.results[0];
  const road = payload.results.find((item: any) => item.name === 'roadaddr');
  return {
    city: String(administrative?.region?.area1?.name ?? ''),
    district: String(administrative?.region?.area2?.name ?? ''),
    dong: String(administrative?.region?.area3?.name ?? ''),
    address: String(road?.land?.name ? `${administrative?.region?.area1?.name ?? ''} ${administrative?.region?.area2?.name ?? ''} ${road.land.name} ${road.land.number1 ?? ''}`.trim() : ''),
  };
}

export async function directions5(input: { start: { latitude: number; longitude: number }; goal: { latitude: number; longitude: number }; waypoints?: Array<{ latitude: number; longitude: number }>; option?: string }, signal?: AbortSignal, fetchImpl: typeof fetch = fetch) {
  const params: Record<string, string> = {
    start: `${input.start.longitude},${input.start.latitude}`,
    goal: `${input.goal.longitude},${input.goal.latitude}`,
    option: input.option ?? 'traoptimal',
    lang: 'ko',
  };
  if (input.waypoints?.length) params.waypoints = input.waypoints.map(p => `${p.longitude},${p.latitude}`).join('|');
  const response = await request('/map-direction/v1/driving', params, signal, fetchImpl);
  let payload: any;
  try { payload = await response.json(); } catch { throw new NaverMapsError('MAPS_INVALID_RESPONSE', 'Naver Maps returned invalid driving directions.', true); }
  const route = payload.route?.[input.option ?? 'traoptimal']?.[0];
  if (payload.code !== 0 || !route?.summary) throw new NaverMapsError('ROUTE_NOT_FOUND', 'Naver Maps could not find a driving route.');
  return {
    observedAt: String(payload.currentDateTime ?? new Date().toISOString()),
    summary: {
      distanceMeters: Number(route.summary.distance), durationMilliseconds: Number(route.summary.duration),
      departureTime: route.summary.departureTime ?? null, tollFareKRW: route.summary.tollFare ?? null,
      taxiFareKRW: route.summary.taxiFare ?? null, fuelCostKRW: route.summary.fuelPrice ?? null,
    },
    majorRoads: Array.isArray(route.section) ? route.section.slice(0, 20).map((section: any) => ({ name: section.name, distanceMeters: section.distance, congestion: section.congestion, speedKmh: section.speed })) : [],
    guidance: Array.isArray(route.guide) ? route.guide.slice(0, 30).map((step: any) => ({ instruction: step.instructions, distanceMeters: step.distance, durationMilliseconds: step.duration })) : [],
    geometry: Array.isArray(route.path) ? route.path.filter((_: unknown, index: number) => index % Math.max(1, Math.ceil(route.path.length / 100)) === 0).slice(0, 100) : [],
  };
}

export async function staticMap(center: { latitude: number; longitude: number }, markers: MapMarker[], signal?: AbortSignal, fetchImpl: typeof fetch = fetch): Promise<Buffer> {
  if (markers.length > 20) throw new NaverMapsError('MAP_MARKER_LIMIT', 'Static Map supports at most 20 markers.');
  const params: Record<string, string | string[]> = {
    center: `${center.longitude},${center.latitude}`,
    level: '15',
    w: '640',
    h: '480',
    format: 'png',
  };
  if (markers.length) {
    params.markers = markers.map(marker => {
      const type = /^[1-9]$/.test(marker.label) ? 'n' : /^[a-z]$/.test(marker.label) ? 'a' : 'd';
      return `type:${type}|size:mid|pos:${marker.longitude} ${marker.latitude}|label:${marker.label}`;
    });
  }
  const response = await request('/map-static/v2/raster', params, signal, fetchImpl);
  const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  if (type !== 'image/png') throw new NaverMapsError('MAPS_INVALID_IMAGE', 'Naver Maps did not return a PNG image.', true);
  const declared = Number(response.headers.get('content-length'));
  if (declared > BODY_LIMIT) throw new NaverMapsError('IMAGE_TOO_LARGE', 'Map image exceeded the 4 MB limit.');
  if (!response.body) throw new NaverMapsError('MAPS_INVALID_IMAGE', 'Naver Maps returned an empty image body.', true);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > BODY_LIMIT) {
        await reader.cancel().catch(() => undefined);
        throw new NaverMapsError('IMAGE_TOO_LARGE', 'Map image exceeded the 4 MB limit.');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  if (!size) throw new NaverMapsError('MAPS_INVALID_IMAGE', 'Naver Maps returned an empty image body.', true);
  return Buffer.concat(chunks.map(chunk => Buffer.from(chunk)), size);
}
