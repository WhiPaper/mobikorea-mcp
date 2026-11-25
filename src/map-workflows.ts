import { TagoError, type TagoResult, type callTago } from './tago.js';
import { geocodeAddress, NaverMapsError, staticMap, mapMarkerLabel, type GeoAddress } from './naver-maps.js';

type Call = typeof callTago;
type Row = Record<string, unknown>;
type Location = { latitude: number; longitude: number };
type PartialError = { stage: string; code: string; message: string; stop?: Row };

export type MapWorkflowResult = {
  status: 'ok' | 'not_found' | 'ambiguous' | 'partial';
  query: Record<string, unknown>;
  resolved: Record<string, unknown>;
  stops: Row[];
  observedAt: string | null;
  sourceServices: Array<{ service: string; sourceUrl: string; catalogUrl: string }>;
  mapStatus: 'ok' | 'not_requested' | 'error';
  partialErrors: PartialError[];
  candidates?: Row[];
};

function text(row: Row, ...keys: string[]): string {
  for (const key of keys) if (row[key] !== undefined && row[key] !== null) return String(row[key]).trim();
  return '';
}

function haversine(a: Location, b: Location): number {
  const toRadians = (degrees: number) => degrees * Math.PI / 180;
  const dLat = toRadians(b.latitude - a.latitude);
  const dLon = toRadians(b.longitude - a.longitude);
  const v = Math.sin(dLat / 2) ** 2 + Math.cos(toRadians(a.latitude)) * Math.cos(toRadians(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(v), Math.sqrt(1 - v));
}

function geocodeSummary(address: GeoAddress) {
  return { roadAddress: address.roadAddress, jibunAddress: address.jibunAddress, latitude: address.latitude, longitude: address.longitude };
}

async function resolveAddress(input: { address?: string; selectedLocation?: Location }, signal?: AbortSignal) {
  if (input.selectedLocation) return { location: input.selectedLocation, label: '사용자가 선택한 좌표', candidate: null as GeoAddress | null, candidates: [] as GeoAddress[] };
  let candidates: GeoAddress[];
  try { candidates = await geocodeAddress(input.address!, signal); }
  catch (error) {
    if (error instanceof NaverMapsError && error.code === 'MAPS_INVALID_RESPONSE') return { error: mapsFailure(error) };
    throw error;
  }
  if (!candidates.length) return { error: { status: 'not_found' as const, query: { address: input.address }, resolved: {}, stops: [], observedAt: null, sourceServices: [], mapStatus: 'not_requested' as const, partialErrors: [] } };
  if (candidates.length > 1) return { error: { status: 'ambiguous' as const, query: { address: input.address }, resolved: {}, stops: [], observedAt: null, sourceServices: [{ service: 'Naver Maps Geocoding', sourceUrl: 'https://maps.apigw.ntruss.com/map-geocode/v2/geocode', catalogUrl: 'https://api.ncloud-docs.com/docs/en/application-maps-geocoding' }], mapStatus: 'not_requested' as const, partialErrors: [], candidates: candidates.map(geocodeSummary) } };
  const candidate = candidates[0];
  return { location: { latitude: candidate.latitude, longitude: candidate.longitude }, label: candidate.roadAddress || candidate.jibunAddress || input.address!, candidate, candidates };
}

function mapsFailure(error: NaverMapsError) {
  return { status: 'partial' as const, query: {}, resolved: {}, stops: [], observedAt: null, sourceServices: [{ service: 'Naver Maps Geocoding', sourceUrl: 'https://maps.apigw.ntruss.com/map-geocode/v2/geocode', catalogUrl: 'https://api.ncloud-docs.com/docs/en/application-maps-geocoding' }], mapStatus: 'error' as const, partialErrors: [{ stage: 'geocoding', code: error.code, message: error.message }] };
}

function source(result: TagoResult) {
  return { service: result.sourceService, sourceUrl: result.sourceUrl, catalogUrl: result.catalogUrl };
}

function stopIdentity(row: Row): string {
  return `${text(row, 'citycode', 'cityCode')}:${text(row, 'nodeid', 'nodeId')}`;
}

async function getNearby(call: Call, location: Location, signal?: AbortSignal): Promise<TagoResult> {
  return call('find_nearby_bus_stops', { gpsLati: location.latitude, gpsLong: location.longitude, page: 1, pageSize: 100 }, { signal });
}

export async function exploreBusStopsNearAddress(call: Call, input: { address?: string; selectedLocation?: Location; includeMap?: boolean; maxStops?: number }, signal?: AbortSignal) {
  const resolved = await resolveAddress(input, signal);
  if ('error' in resolved) return { result: resolved.error };
  const nearby = await getNearby(call, resolved.location, signal);
  const unique = new Map<string, Row>();
  for (const row of nearby.items) if (text(row, 'citycode', 'cityCode') && text(row, 'nodeid', 'nodeId')) unique.set(stopIdentity(row), row);
  const stops = [...unique.values()].map(row => ({
    cityCode: text(row, 'citycode', 'cityCode'),
    stopId: text(row, 'nodeid', 'nodeId'),
    stopName: text(row, 'nodenm', 'nodeNm'),
    stopNumber: text(row, 'nodeno', 'nodeNo'),
    latitude: Number(row.gpslati ?? row.gpsLati),
    longitude: Number(row.gpslong ?? row.gpsLong),
    distanceMeters: Math.round(haversine(resolved.location, { latitude: Number(row.gpslati ?? row.gpsLati), longitude: Number(row.gpslong ?? row.gpsLong) })),
  })).filter(stop => Number.isFinite(stop.latitude) && Number.isFinite(stop.longitude)).sort((a, b) => a.distanceMeters - b.distanceMeters).slice(0, input.maxStops ?? 10);
  const mappedStops = stops.slice(0, 19).map((stop, index) => ({ ...stop, mapIndex: index + 1, mapLabel: mapMarkerLabel(index) }));
  const returnedStops = stops.map((stop, index) => ({ ...stop, mapIndex: index < mappedStops.length ? index + 1 : null, mapLabel: index < mappedStops.length ? mapMarkerLabel(index) : null }));
  let image: Buffer | undefined;
  let mapStatus: MapWorkflowResult['mapStatus'] = 'not_requested';
  const partialErrors: PartialError[] = [];
  if (input.includeMap !== false) {
    try {
      image = await staticMap(resolved.location, [
        { ...resolved.location, label: 'a' },
        ...mappedStops.map(stop => ({ latitude: stop.latitude, longitude: stop.longitude, label: stop.mapLabel })),
      ], signal);
      mapStatus = 'ok';
    } catch (error) {
      const e = error instanceof NaverMapsError ? error : new NaverMapsError('MAPS_UPSTREAM', 'Map image could not be generated.', true);
      mapStatus = 'error';
      partialErrors.push({ stage: 'static_map', code: e.code, message: e.message });
    }
  }
  return {
    result: {
      status: partialErrors.length ? 'partial' as const : 'ok' as const,
      query: { address: input.address ?? null },
      resolved: { address: resolved.label, latitude: resolved.location.latitude, longitude: resolved.location.longitude, totalNearbyStops: nearby.totalCount, returnedStops: stops.length, resultOmittedCount: Math.max(0, nearby.totalCount - stops.length), mappedCount: mappedStops.length, mapOmittedCount: Math.max(0, stops.length - mappedStops.length) },
      stops: returnedStops,
      observedAt: nearby.observedAt,
      sourceServices: [
        ...(resolved.candidate ? [{ service: 'Naver Maps Geocoding', sourceUrl: 'https://maps.apigw.ntruss.com/map-geocode/v2/geocode', catalogUrl: 'https://api.ncloud-docs.com/docs/en/application-maps-geocoding' }] : []),
        source(nearby),
        ...(input.includeMap !== false ? [{ service: 'Naver Maps Static Map', sourceUrl: 'https://maps.apigw.ntruss.com/map-static/v2/raster', catalogUrl: 'https://api.ncloud-docs.com/docs/en/application-maps-static' }] : []),
      ],
      mapStatus,
      partialErrors,
    } satisfies MapWorkflowResult,
    image,
  };
}

export async function checkBusArrivalsNearAddress(call: Call, input: { address?: string; selectedLocation?: Location; includeMap?: boolean; maxStops?: number; maxArrivalsPerStop?: number }, signal?: AbortSignal) {
  const resolved = await resolveAddress(input, signal);
  if ('error' in resolved) return { result: resolved.error, image: undefined };
  const nearby = await getNearby(call, resolved.location, signal);
  const rows = [...new Map(nearby.items.filter(row => text(row, 'nodeid', 'nodeId')).map(row => [stopIdentity(row), row])).values()];
  const stops = rows.map(row => ({
    cityCode: text(row, 'citycode', 'cityCode'),
    stopId: text(row, 'nodeid', 'nodeId'),
    stopName: text(row, 'nodenm', 'nodeNm'),
    stopNumber: text(row, 'nodeno', 'nodeNo'),
    latitude: Number(row.gpslati ?? row.gpsLati),
    longitude: Number(row.gpslong ?? row.gpsLong),
  })).filter(stop => stop.cityCode && stop.stopId && Number.isFinite(stop.latitude) && Number.isFinite(stop.longitude))
    .map(stop => ({ ...stop, distanceMeters: Math.round(haversine(resolved.location, stop)) }))
    .sort((a, b) => a.distanceMeters - b.distanceMeters).slice(0, input.maxStops ?? 5);

  const arrivalResults = await Promise.all(stops.map(async stop => {
    try {
      const result = await call('get_bus_arrivals', { cityCode: stop.cityCode, nodeId: stop.stopId, page: 1, pageSize: 100 }, { signal });
      const arrivals = result.items.map(item => ({
        routeNumber: text(item, 'routeno', 'routeNo'),
        arrivalSeconds: item.arrtime ?? item.arrTime ?? null,
        stopsAway: item.arrprevstationcnt ?? item.arrPrevStationCnt ?? null,
        vehicleType: text(item, 'vehicletp', 'vehicleType'),
      })).sort((a, b) => Number(a.arrivalSeconds ?? Infinity) - Number(b.arrivalSeconds ?? Infinity)).slice(0, input.maxArrivalsPerStop ?? 3);
      return { stop: { ...stop, status: arrivals.length ? 'ok' : 'no_arrivals', arrivals }, source: source(result), observedAt: result.observedAt };
    } catch (error) {
      const e = error instanceof TagoError ? error : new TagoError('INTERNAL_ERROR', 'Arrival query failed.');
      return { stop: { ...stop, status: 'error', arrivals: [] }, error: { stage: 'arrivals', code: e.code, message: e.message, stop: { cityCode: stop.cityCode, stopId: stop.stopId, stopName: stop.stopName } } satisfies PartialError };
    }
  }));
  const successful = arrivalResults.flatMap(item => ('source' in item && item.source ? [item] : []));
  const partialErrors = arrivalResults.filter(item => 'error' in item).map(item => (item as { error: PartialError }).error);
  const mappedStops = stops.slice(0, 19).map((stop, index) => ({ ...stop, mapIndex: index + 1 }));
  let image: Buffer | undefined;
  let mapStatus: MapWorkflowResult['mapStatus'] = 'not_requested';
  if (input.includeMap !== false) {
    try {
      image = await staticMap(resolved.location, [
        { ...resolved.location, label: 'a' },
        ...mappedStops.map(stop => ({ latitude: stop.latitude, longitude: stop.longitude, label: String(stop.mapIndex) })),
      ], signal);
      mapStatus = 'ok';
    } catch (error) {
      const e = error instanceof NaverMapsError ? error : new NaverMapsError('MAPS_UPSTREAM', 'Map image could not be generated.', true);
      mapStatus = 'error';
      partialErrors.push({ stage: 'static_map', code: e.code, message: e.message });
    }
  }
  const result: MapWorkflowResult = {
    status: partialErrors.length ? 'partial' : 'ok',
    query: { address: input.address ?? null },
    resolved: { address: resolved.label, latitude: resolved.location.latitude, longitude: resolved.location.longitude, totalNearbyStops: nearby.totalCount, returnedStops: stops.length, resultOmittedCount: Math.max(0, nearby.totalCount - stops.length), mappedCount: mappedStops.length, mapOmittedCount: Math.max(0, stops.length - mappedStops.length) },
    stops: arrivalResults.map((item, index) => ({ ...item.stop, mapIndex: index < mappedStops.length ? index + 1 : null })),
    observedAt: successful.length ? successful.map(item => item.observedAt).sort().at(-1)! : nearby.observedAt,
    sourceServices: [
      ...(resolved.candidate ? [{ service: 'Naver Maps Geocoding', sourceUrl: 'https://maps.apigw.ntruss.com/map-geocode/v2/geocode', catalogUrl: 'https://api.ncloud-docs.com/docs/en/application-maps-geocoding' }] : []),
      source(nearby),
      ...successful.map(item => item.source),
      ...(input.includeMap !== false ? [{ service: 'Naver Maps Static Map', sourceUrl: 'https://maps.apigw.ntruss.com/map-static/v2/raster', catalogUrl: 'https://api.ncloud-docs.com/docs/en/application-maps-static' }] : []),
    ],
    mapStatus,
    partialErrors,
  };
  return { result, image };
}
