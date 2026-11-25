import { XMLParser } from 'fast-xml-parser';
import { createHash } from 'node:crypto';
import { EXTRA_TOOLS } from './extra.js';

export interface TagoResult {
  items: Record<string, unknown>[];
  totalCount: number;
  observedAt: string;
  sourceService: string;
  sourceUrl: string;
  catalogUrl: string;
}
export interface TagoCallOptions {
  serviceKey?: string;
  signal?: AbortSignal;
  cacheStore?: Map<string, { result: TagoResult; expiresAt: number }>;
  now?: () => number;
  cache?: boolean;
  throttle?: boolean;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}
type TagoArgs = Record<string, string | number | undefined>;
type Service = { base: string; catalog: string; label: string };
type Operation = { service: string; path: string; params: string[]; ttlMs?: number };

export const SERVICES: Readonly<Record<string, Service>> = Object.freeze({
  stop: { base: 'BusSttnInfoInqireService', catalog: '15098534', label: 'City Bus Stops' },
  route: { base: 'BusRouteInfoInqireService', catalog: '15098529', label: 'City Bus Routes' },
  arrival: { base: 'ArvlInfoInqireService', catalog: '15098530', label: 'City Bus Arrivals' },
  location: { base: 'BusLcInfoInqireService', catalog: '15098533', label: 'City Bus Locations' },
  expressArrival: { base: 'ExpBusArrInfo', catalog: '15098516', label: 'Express Bus Arrivals' },
  express: { base: 'ExpBusInfo', catalog: '15098522', label: 'Express Bus Information' },
  intercity: { base: 'SuburbsBusInfo', catalog: '15098541', label: 'Intercity Bus Information' },
  train: { base: 'TrainInfo', catalog: '15098552', label: 'Train Information' },
  subway: { base: 'SubwayInfo', catalog: '15098554', label: 'Subway Information' },
  flight: { base: 'DmstcFlightNvgInfo', catalog: '15098526', label: 'Domestic Flight Information' },
  ship: { base: 'DmstcShipNvgInfo', catalog: '15098523', label: 'Domestic Ship Information' },
  carSharing: { base: 'CarSharingInfo', catalog: '15098557', label: 'Car Sharing Zones' },
  personalMobility: { base: 'PersonalMobilityInfo', catalog: '15117668', label: 'Personal Mobility' },
});

export const OPERATIONS: Readonly<Record<string, Operation>> = Object.freeze({
  list_bus_cities: { service: 'stop', path: 'getCtyCodeList', params: [] },
  find_bus_stops: { service: 'stop', path: 'getSttnNoList', params: ['cityCode', 'nodeNm', 'nodeNo'] },
  find_nearby_bus_stops: { service: 'stop', path: 'getCrdntPrxmtSttnList', params: ['gpsLati', 'gpsLong'] },
  list_stop_routes: { service: 'stop', path: 'getSttnThrghRouteList', params: ['cityCode', 'nodeid'] },
  find_bus_routes: { service: 'route', path: 'getRouteNoList', params: ['cityCode', 'routeNo'] },
  get_bus_route: { service: 'route', path: 'getRouteInfoIem', params: ['cityCode', 'routeId'] },
  list_route_stops: { service: 'route', path: 'getRouteAcctoThrghSttnList', params: ['cityCode', 'routeId'] },
  get_bus_arrivals: { service: 'arrival', path: 'getSttnAcctoArvlPrearngeInfoList', params: ['cityCode', 'nodeId'] },
  get_route_bus_locations: { service: 'location', path: 'getRouteAcctoBusLcList', params: ['cityCode', 'routeId'] },
  ...Object.fromEntries(EXTRA_TOOLS.map(tool => [tool.name, {
    service: tool.service, path: tool.path, params: [...tool.required, ...(tool.optional ?? [])], ttlMs: tool.ttlMs,
  }])),
});

const parser = new XMLParser({ ignoreAttributes: false, trimValues: true, parseTagValue: false });
const MAX_BODY = 2_000_000;
const MAX_CACHE_ENTRIES = 256;
const responseCache = new Map<string, { result: TagoResult; expiresAt: number }>();
let nextRequestAt = 0;
let requestGate = Promise.resolve();
const cacheTtlMs: Readonly<Record<string, number>> = Object.freeze({
  list_bus_cities: 24 * 60 * 60 * 1000,
  find_bus_stops: 5 * 60 * 1000,
  find_nearby_bus_stops: 5 * 60 * 1000,
  list_stop_routes: 5 * 60 * 1000,
  find_bus_routes: 5 * 60 * 1000,
  get_bus_route: 5 * 60 * 1000,
  list_route_stops: 5 * 60 * 1000,
  get_bus_arrivals: 5 * 1000,
  get_route_bus_locations: 5 * 1000,
});
const errorMessages: Readonly<Record<string, string>> = Object.freeze({
  '01': 'TAGO service error',
  '04': 'TAGO gateway HTTP error',
  '05': 'TAGO service timed out',
  '10': 'TAGO rejected the request parameters',
  '12': 'TAGO operation is unavailable',
  '20': 'TAGO access is denied for this service',
  '22': 'TAGO daily request quota exceeded',
  '23': 'TAGO per-second request quota exceeded',
  '29': 'TAGO blocked this client IP',
  '30': 'TAGO service key is not registered for this service',
  '31': 'TAGO service key has expired',
});
const errorHints: Readonly<Record<string, string>> = Object.freeze({
  '10': 'Verify IDs using the matching city/stop/route/terminal/station/airport/port/provider lookup tool and format dates as YYYYMMDD.',
  '20': 'Verify utilization approval for this TAGO service on data.go.kr.',
  '22': 'Daily traffic quota reached for this service key; wait for quota reset or switch keys.',
  '23': 'Per-second request limit reached; retry shortly.',
  '30': 'The TAGO service key is not approved for this service on data.go.kr.',
  '31': 'Renew or update the data.go.kr service key.',
  MISSING_KEY: 'Set TAGO_SERVICE_KEY in the MCP server environment.',
});

export class TagoError extends Error {
  code: string;
  retryable: boolean;
  hint?: string;
  constructor(code: string, message: string, retryable = false, hint = errorHints[code]) {
    super(message);
    this.name = 'TagoError';
    this.code = code;
    this.retryable = retryable;
    if (hint) this.hint = hint;
  }
}

function normalizePayload(raw: any): { items: Record<string, unknown>[]; totalCount: number } {
  const response = raw?.response ?? raw;
  const header = response?.header ?? raw?.cmmMsgHeader ?? raw?.OpenAPI_ServiceResponse?.cmmMsgHeader ?? {};
  if (header.resultCode === undefined && header.returnReasonCode === undefined) {
    throw new TagoError('INVALID_RESPONSE', 'TAGO response is missing a result code', true);
  }
  const code = String(header.resultCode ?? header.returnReasonCode ?? '00');
  if (code !== '00' && code !== '0') {
    const retryable = ['01', '04', '05', '23'].includes(code);
    throw new TagoError(code, errorMessages[code] ?? `TAGO error ${code}`, retryable);
  }
  const body = response?.body ?? {};
  const item = body?.items?.item ?? (body?.items && Object.keys(body.items).length ? body.items : []);
  const items = item == null || item === '' ? [] : Array.isArray(item) ? item : [item];
  const count = Number(body?.totalCount ?? items.length);
  return { items, totalCount: Number.isFinite(count) ? count : items.length };
}

export function parseTagoResponse(body: string) {
  const trimmed = body.trim();
  if (!trimmed) throw new TagoError('EMPTY_RESPONSE', 'TAGO returned an empty response', true);
  let parsed;
  try {
    parsed = trimmed.startsWith('<') ? parser.parse(trimmed) : JSON.parse(trimmed);
  } catch {
    throw new TagoError('INVALID_RESPONSE', 'TAGO returned invalid JSON or XML', true);
  }
  return normalizePayload(parsed);
}

function decodedServiceKey(key: string) {
  // The portal distributes both decoded and URL-encoded versions of a key.
  if (!/%[0-9a-fA-F]{2}/.test(key)) return key;
  try { return decodeURIComponent(key); } catch { return key; }
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new TagoError('CANCELLED', 'TAGO request was cancelled', false);
}

async function reserveRequestSlot(signal?: AbortSignal) {
  throwIfAborted(signal);
  const prior = requestGate;
  let release!: () => void;
  requestGate = new Promise<void>(resolve => { release = resolve; });
  await prior;
  try {
    throwIfAborted(signal);
    const delay = Math.max(0, nextRequestAt - Date.now());
    if (delay) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        }, delay);
        function onAbort() {
          clearTimeout(timer);
          reject(new TagoError('CANCELLED', 'TAGO request was cancelled', false));
        }
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    }
    nextRequestAt = Date.now() + 250;
  } finally {
    release();
  }
}

async function readLimitedResponse(response: Response) {
  const claimedSize = Number(response.headers.get('content-length'));
  if (claimedSize > MAX_BODY) throw new TagoError('RESPONSE_TOO_LARGE', 'TAGO response exceeds 2 MB', true);
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY) {
        await reader.cancel();
        throw new TagoError('RESPONSE_TOO_LARGE', 'TAGO response exceeds 2 MB', true);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof TagoError) throw error;
    throw new TagoError('NETWORK_ERROR', 'TAGO response could not be read', true);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

export async function callTago(operationName: string, args: TagoArgs = {}, options: TagoCallOptions = {}): Promise<TagoResult> {
  const operation = OPERATIONS[operationName];
  if (!operation) throw new TagoError('UNKNOWN_OPERATION', 'Unsupported TAGO operation');
  throwIfAborted(options.signal);
  const service = SERVICES[operation.service];
  const key = options.serviceKey ?? process.env.TAGO_SERVICE_KEY;
  if (!key) throw new TagoError('MISSING_KEY', 'TAGO service key is not configured');
  const cache = options.cacheStore ?? responseCache;
  const now = options.now?.() ?? Date.now();
  const cacheKey = createHash('sha256').update(key).digest('hex') + ':' + operationName + ':' + JSON.stringify(Object.keys(args).sort().map(name => [name, args[name]]));
  if (options.cache !== false) {
    const hit = cache.get(cacheKey);
    if (hit && hit.expiresAt > now) return structuredClone(hit.result);
    if (hit) cache.delete(cacheKey);
  }
  const sourceUrl = `https://apis.data.go.kr/1613000/${service.base}/${operation.path}`;
  const url = new URL(sourceUrl);
  url.searchParams.set('serviceKey', decodedServiceKey(key));
  url.searchParams.set('_type', 'json');
  if (args.page !== undefined) url.searchParams.set('pageNo', String(args.page));
  if (args.pageSize !== undefined) url.searchParams.set('numOfRows', String(args.pageSize));
  for (const name of operation.params) {
    if (args[name] !== undefined && args[name] !== '') url.searchParams.set(name, String(args[name]));
  }
  let response;
  try {
    if (options.throttle !== false) await reserveRequestSlot(options.signal);
    const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? 8000);
    const signal = options.signal ? AbortSignal.any([timeoutSignal, options.signal]) : timeoutSignal;
    response = await (options.fetchImpl ?? fetch)(url, { signal });
  } catch (error) {
    if (error instanceof TagoError) throw error;
    if (options.signal?.aborted) throw new TagoError('CANCELLED', 'TAGO request was cancelled', false);
    throw new TagoError('NETWORK_ERROR', 'TAGO request timed out or failed', true);
  }
  const body = await readLimitedResponse(response);
  if (!response.ok) {
    try { parseTagoResponse(body); } catch (error) { if (error instanceof TagoError && error.code !== 'INVALID_RESPONSE') throw error; }
    throw new TagoError(`HTTP_${response.status}`, `TAGO returned HTTP ${response.status}`, response.status >= 500 || response.status === 429);
  }
  const result = parseTagoResponse(body);
  const output = {
    ...result,
    observedAt: new Date().toISOString(),
    sourceService: operation.service,
    sourceUrl,
    catalogUrl: `https://www.data.go.kr/data/${service.catalog}/openapi.do`,
  };
  if (options.cache !== false) {
    cache.set(cacheKey, { result: structuredClone(output), expiresAt: now + (operation.ttlMs ?? cacheTtlMs[operationName] ?? 5 * 60_000) });
    if (cache.size > MAX_CACHE_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
  }
  return output;
}
