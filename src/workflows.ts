import { TagoError, type TagoResult, type callTago } from './tago.js';
import { geocodeAddress, reverseGeocodeCoordinates, staticMap, directions5, mapMarkerLabel, NaverMapsError } from './naver-maps.js';

type Call = typeof callTago;
type Row = Record<string, unknown>;
type Args = Record<string, string | number | undefined>;

export type WorkflowResult = {
  status: 'ok' | 'not_found' | 'ambiguous' | 'partial';
  stage: string;
  message: string;
  resolved: Record<string, string>;
  candidates: Row[];
  summary: Row[];
  data: TagoResult | null;
  details?: Record<string, unknown>;
  sourceServices?: Array<{ service: string; sourceUrl: string; catalogUrl: string }>;
  observedAt?: string | null;
};

function field(row: Row, keys: string[]): string {
  for (const key of keys) {
    const value = row[key];
    if (value !== undefined && value !== null) return String(value).trim();
  }
  return '';
}

function candidate(row: Row, nameKeys: string[], idKeys: string[]): Row {
  return { name: field(row, nameKeys), id: field(row, idKeys), ...row };
}

function normalize(value: string): string { return value.trim().replace(/\s+/g, '').toLocaleLowerCase('ko-KR'); }
function haversine(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }) {
  const radians = (degrees: number) => degrees * Math.PI / 180;
  const dLat = radians(b.latitude - a.latitude);
  const dLon = radians(b.longitude - a.longitude);
  const v = Math.sin(dLat / 2) ** 2 + Math.cos(radians(a.latitude)) * Math.cos(radians(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(v), Math.sqrt(1 - v));
}

function choose(rows: Row[], query: string, nameKeys: string[], idKeys: string[], stage: string, resolved: Record<string, string>) {
  const sought = normalize(query);
  const exact = rows.filter(row => normalize(field(row, nameKeys)) === sought);
  const matches = exact.length ? exact : rows.filter(row => normalize(field(row, nameKeys)).includes(sought));
  const unique = new Map(matches.map(row => [field(row, idKeys), row]));
  const candidates = [...unique.values()].slice(0, 20).map(row => candidate(row, nameKeys, idKeys));
  if (unique.size === 1) return { item: [...unique.values()][0], result: null };
  const status = unique.size ? 'ambiguous' : 'not_found';
  return { item: null, result: {
    status, stage,
    message: unique.size ? `${query}: ${unique.size} matches; supply a more specific name or use a low-level lookup tool to select an ID.` : `${query}: no matching ${stage} found.`,
    resolved, candidates, summary: [], data: null,
  } as WorkflowResult };
}

async function pages(call: Call, operation: string, args: Args, signal?: AbortSignal): Promise<Row[]> {
  const rows: Row[] = [];
  for (let page = 1; page <= 5; page++) {
    const result = await call(operation, { ...args, page, pageSize: 100 }, { signal });
    rows.push(...result.items);
    if (rows.length >= result.totalCount || result.items.length === 0) return rows;
  }
  throw new TagoError('LOOKUP_LIMIT', `${operation} exceeded the five-page lookup limit; use a more specific name or the low-level lookup tool.`);
}

async function pagedResult(call: Call, operation: string, args: Args, signal?: AbortSignal) {
  const items: Row[] = [];
  let first: TagoResult | null = null;
  let totalCount = 0;
  for (let page = 1; page <= 5; page++) {
    const result = await call(operation, { ...args, page, pageSize: 100 }, { signal });
    first ??= result;
    items.push(...result.items);
    totalCount = result.totalCount;
    if (items.length >= totalCount || result.items.length === 0) break;
  }
  return { result: first!, items, totalCount, incomplete: items.length < totalCount };
}

function selectedId(item: Row, keys: string[], label: string) {
  const id = field(item, keys);
  if (!id) throw new TagoError('INVALID_RESPONSE', `TAGO ${label} lookup omitted its ID.`, true);
  return id;
}

export async function busArrivalsByStop(call: Call, input: { cityName: string; stopName: string; stopNumber?: string }, signal?: AbortSignal): Promise<WorkflowResult> {
  const cities = await pages(call, 'list_bus_cities', {}, signal);
  const city = choose(cities, input.cityName, ['cityname', 'cityName'], ['citycode', 'cityCode'], 'city', {});
  if (city.result) return city.result;
  const cityCode = selectedId(city.item!, ['citycode', 'cityCode'], 'city');
  const resolved = { cityName: field(city.item!, ['cityname', 'cityName']), cityCode };
  const stops = await pages(call, 'find_bus_stops', { cityCode, nodeNm: input.stopName, nodeNo: input.stopNumber }, signal);
  const matchingStops = input.stopNumber
    ? stops.filter(stop => field(stop, ['nodeno', 'nodeNo']) === input.stopNumber)
    : stops;
  const stop = choose(matchingStops, input.stopName, ['nodenm', 'nodeNm'], ['nodeid', 'nodeId'], 'stop', resolved);
  if (stop.result) return stop.result;
  const nodeId = selectedId(stop.item!, ['nodeid', 'nodeId'], 'stop');
  const pageData = await pagedResult(call, 'get_bus_arrivals', { cityCode, nodeId }, signal);
  const data = { ...pageData.result, items: pageData.items, totalCount: pageData.totalCount };
  return { status: pageData.incomplete ? 'partial' : 'ok', stage: 'arrivals', message: pageData.incomplete ? `Live bus arrivals; only ${pageData.items.length} of ${pageData.totalCount} predictions were retrieved.` : 'Live bus arrival predictions at the selected stop.',
    resolved: { ...resolved, stopName: field(stop.item!, ['nodenm', 'nodeNm']), stopNumber: field(stop.item!, ['nodeno', 'nodeNo']), nodeId }, candidates: [],
    summary: data.items.map(item => ({ routeNumber: field(item, ['routeno', 'routeNo']), arrivalSeconds: item.arrtime ?? null, stopsAway: item.arrprevstationcnt ?? null, vehicleType: field(item, ['vehicletp', 'vehicleType']) })), data };
}

export async function trainDeparturesByName(call: Call, input: { departureCity: string; departureStation: string; arrivalCity: string; arrivalStation: string; date?: string }, signal?: AbortSignal): Promise<WorkflowResult> {
  const cities = await pages(call, 'list_train_cities', {}, signal);
  const resolved: Record<string, string> = {};
  async function station(cityQuery: string, stationQuery: string, side: string) {
    const city = choose(cities, cityQuery, ['cityname', 'cityName'], ['citycode', 'cityCode'], `${side} city`, resolved);
    if (city.result) return { id: null, result: city.result };
    const cityCode = selectedId(city.item!, ['citycode', 'cityCode'], 'city');
    resolved[`${side}City`] = field(city.item!, ['cityname', 'cityName']);
    const stations = await pages(call, 'list_train_stations', { cityCode }, signal);
    const match = choose(stations, stationQuery, ['nodename', 'nodeName', 'nodeNm'], ['nodeid', 'nodeId'], `${side} station`, resolved);
    if (match.result) return { id: null, result: match.result };
    resolved[`${side}Station`] = field(match.item!, ['nodename', 'nodeName', 'nodeNm']);
    return { id: selectedId(match.item!, ['nodeid', 'nodeId'], 'station'), result: null };
  }
  const departure = await station(input.departureCity, input.departureStation, 'departure');
  if (departure.result) return departure.result;
  const arrival = await station(input.arrivalCity, input.arrivalStation, 'arrival');
  if (arrival.result) return arrival.result;
  resolved.depPlaceId = departure.id!;
  resolved.arrPlaceId = arrival.id!;
  const pageData = await pagedResult(call, 'find_train_departures', { depPlaceId: departure.id!, arrPlaceId: arrival.id!, depPlandTime: input.date }, signal);
  const data = { ...pageData.result, items: pageData.items, totalCount: pageData.totalCount };
  return { status: pageData.incomplete ? 'partial' : 'ok', stage: 'departures', message: pageData.incomplete ? `Scheduled train departures; only ${pageData.items.length} of ${pageData.totalCount} results were retrieved.` : 'Scheduled train departures for the selected stations.', resolved, candidates: [],
    summary: pageData.items.map(item => ({ trainNumber: field(item, ['trainno', 'trainNo']), trainType: field(item, ['traingradename', 'trainGradeName']), departureTime: field(item, ['depplandtime', 'depPlandTime']), arrivalTime: field(item, ['arrplandtime', 'arrPlandTime']), adultFareKRW: item.adultcharge ?? null })), data };
}

export async function domesticFlightsByName(call: Call, input: { departureAirport: string; arrivalAirport: string; date?: string }, signal?: AbortSignal): Promise<WorkflowResult> {
  const airports = await pages(call, 'list_airports', {}, signal);
  const resolved: Record<string, string> = {};
  const departure = choose(airports, input.departureAirport, ['airportNm', 'airportnm', 'airportName'], ['airportId', 'airportid'], 'departure airport', resolved);
  if (departure.result) return departure.result;
  const arrival = choose(airports, input.arrivalAirport, ['airportNm', 'airportnm', 'airportName'], ['airportId', 'airportid'], 'arrival airport', resolved);
  if (arrival.result) return arrival.result;
  const depAirportId = selectedId(departure.item!, ['airportId', 'airportid'], 'airport');
  const arrAirportId = selectedId(arrival.item!, ['airportId', 'airportid'], 'airport');
  Object.assign(resolved, { departureAirport: field(departure.item!, ['airportNm', 'airportnm', 'airportName']), arrivalAirport: field(arrival.item!, ['airportNm', 'airportnm', 'airportName']), depAirportId, arrAirportId });
  const pageData = await pagedResult(call, 'find_domestic_flights', { depAirportId, arrAirportId, depPlandTime: input.date }, signal);
  const data = { ...pageData.result, items: pageData.items, totalCount: pageData.totalCount };
  return { status: pageData.incomplete ? 'partial' : 'ok', stage: 'flights', message: pageData.incomplete ? `Scheduled domestic flights; only ${pageData.items.length} of ${pageData.totalCount} results were retrieved.` : 'Scheduled domestic flights for the selected airports.', resolved, candidates: [],
    summary: pageData.items.map(item => ({ flightNumber: field(item, ['vihicleId', 'vehicleId']), airline: field(item, ['airlineNm', 'airlineName']), departureTime: field(item, ['depPlandTime', 'depplandtime']), arrivalTime: field(item, ['arrPlandTime', 'arrplandtime']), economyFareKRW: item.economyCharge ?? null })), data };
}

function sourceFor(result: TagoResult) { return { service: result.sourceService, sourceUrl: result.sourceUrl, catalogUrl: result.catalogUrl }; }
function failure(error: unknown, stage: string): Row {
  return { stage, code: error instanceof TagoError || error instanceof NaverMapsError ? error.code : 'INTERNAL_ERROR', message: error instanceof Error ? error.message : 'Upstream request failed.' };
}
function workflow(status: WorkflowResult['status'], stage: string, message: string, resolved: Record<string, string> = {}, candidates: Row[] = [], summary: Row[] = [], details?: Record<string, unknown>, sourceServices: WorkflowResult['sourceServices'] = [], observedAt: string | null = null): WorkflowResult {
  return { status, stage, message, resolved, candidates, summary, data: null, ...(details ? { details } : {}), sourceServices, observedAt };
}
function nameMatches(rows: Row[], query: string, nameKeys: string[], idKeys: string[], stage: string, resolved: Record<string, string>) {
  return choose(rows, query, nameKeys, idKeys, stage, resolved);
}

export async function busRouteStatusByName(call: Call, input: { cityName: string; routeNumber: string; includeMap?: boolean }, signal?: AbortSignal) {
  const cities = await pages(call, 'list_route_cities', {}, signal);
  const city = nameMatches(cities, input.cityName, ['cityname', 'cityName'], ['citycode', 'cityCode'], 'city', {});
  if (city.result) return { result: city.result };
  const cityCode = selectedId(city.item!, ['citycode', 'cityCode'], 'city');
  const resolved = { cityName: field(city.item!, ['cityname', 'cityName']), cityCode };
  const routes = await pages(call, 'find_bus_routes', { cityCode, routeNo: input.routeNumber }, signal);
  const route = nameMatches(routes, input.routeNumber, ['routeno', 'routeNo'], ['routeid', 'routeId'], 'route', resolved);
  if (route.result) return { result: route.result };
  const routeId = selectedId(route.item!, ['routeid', 'routeId'], 'route');
  const [infoResult, stopsResult, locationsResult] = await Promise.allSettled([
    call('get_bus_route', { cityCode, routeId }, { signal }),
    pagedResult(call, 'list_route_stops', { cityCode, routeId }, signal),
    pagedResult(call, 'get_route_bus_locations', { cityCode, routeId }, signal),
  ]);
  const info = infoResult.status === 'fulfilled' ? infoResult.value : null;
  const stopsData = stopsResult.status === 'fulfilled' ? stopsResult.value : null;
  const locationsData = locationsResult.status === 'fulfilled' ? locationsResult.value : null;
  const stops = stopsData?.result ?? null;
  const locations = locationsData?.result ?? null;
  if (!info && !stops && !locations) throw infoResult.status === 'rejected' ? infoResult.reason : stopsResult.status === 'rejected' ? stopsResult.reason : locationsResult.status === 'rejected' ? locationsResult.reason : new TagoError('UPSTREAM_FAILURE', 'All route detail requests failed.');
  const vehicles = (locationsData?.items ?? []).map(row => ({ vehicleId: field(row, ['vehicleno', 'vehicleNo', 'vehId']), latitude: Number(row.gpslati ?? row.gpsLati), longitude: Number(row.gpslong ?? row.gpsLong), stopName: field(row, ['nodenm', 'nodeNm']), stopSequence: row.nodeord ?? row.nodeOrd ?? null }))
    .filter(v => Number.isFinite(v.latitude) && Number.isFinite(v.longitude));
  const routeStops = (stopsData?.items ?? []).map(row => ({ stopName: field(row, ['nodenm', 'nodeNm']), stopNumber: field(row, ['nodeno', 'nodeNo']), nodeId: field(row, ['nodeid', 'nodeId']), sequence: row.nodeord ?? row.nodeOrd ?? null, latitude: Number(row.gpslati ?? row.gpsLati), longitude: Number(row.gpslong ?? row.gpsLong) }));
  const mappedVehicles = vehicles.slice(0, 19).map((v, i) => ({ ...v, mapIndex: i + 1, mapLabel: mapMarkerLabel(i) }));
  const returnedVehicles = vehicles.map((vehicle, index) => ({ ...vehicle, mapIndex: index < mappedVehicles.length ? index + 1 : null, mapLabel: index < mappedVehicles.length ? mapMarkerLabel(index) : null }));
  let image: Buffer | undefined;
  let mapStatus: 'ok' | 'not_requested' | 'error' = 'not_requested';
  const errors: Row[] = [
    ...(infoResult.status === 'rejected' ? [failure(infoResult.reason, 'route_info')] : []),
    ...(stopsResult.status === 'rejected' ? [failure(stopsResult.reason, 'route_stops')] : []),
    ...(locationsResult.status === 'rejected' ? [failure(locationsResult.reason, 'vehicle_locations')] : []),
    ...(stopsData?.incomplete ? [{ stage: 'route_stops', code: 'RESULT_LIMIT', message: `Only ${stopsData.items.length} of ${stopsData.totalCount} route stops were returned; the five-page limit was reached.` }] : []),
    ...(locationsData?.incomplete ? [{ stage: 'vehicle_locations', code: 'RESULT_LIMIT', message: `Only ${locationsData.items.length} of ${locationsData.totalCount} vehicles were returned; the five-page limit was reached.` }] : []),
  ];
  if (input.includeMap !== false && mappedVehicles.length) {
    try {
      image = await staticMap(mappedVehicles[0], mappedVehicles.map(v => ({ latitude: v.latitude, longitude: v.longitude, label: v.mapLabel })), signal);
      mapStatus = 'ok';
    } catch (error) {
      mapStatus = 'error';
      errors.push({ stage: 'static_map', code: error instanceof NaverMapsError ? error.code : 'MAPS_UPSTREAM', message: error instanceof Error ? error.message : 'Map image could not be generated.' });
    }
  } else if (input.includeMap !== false) mapStatus = 'not_requested';
  const sources = [info, stops, locations].filter((result): result is TagoResult => result !== null).map(sourceFor);
  const timestamps = [info, stops, locations].filter((result): result is TagoResult => result !== null).map(result => result.observedAt).sort();
  const result = workflow(errors.length ? 'partial' : 'ok', 'route_status', vehicles.length ? 'Route schedule and current vehicle locations.' : 'Route details found; no current vehicle locations were returned.', { ...resolved, routeNumber: field(route.item!, ['routeno', 'routeNo']), routeId }, [], [], {
    routeInfo: info?.items[0] ?? null, routeStops, vehicles: returnedVehicles, mapStatus,
    ...(input.includeMap !== false && !mappedVehicles.length ? { mapNotAvailableReason: 'No current vehicle coordinates were returned.' } : {}), partialErrors: errors,
  }, sources, timestamps.at(-1) ?? null);
  return { result, image };
}

export async function subwayStationInfo(call: Call, input: { stationName: string; dayType?: string; direction?: string }, signal?: AbortSignal): Promise<WorkflowResult> {
  const stations = await pages(call, 'find_subway_stations', { subwayStationName: input.stationName }, signal);
  const station = nameMatches(stations, input.stationName, ['subwayStationName', 'subwayStationNm', 'stationName', 'sttnNm'], ['subwayStationId', 'subwayStationID', 'stationId'], 'subway station', {});
  if (station.result) return station.result;
  const id = selectedId(station.item!, ['subwayStationId', 'subwayStationID', 'stationId'], 'subway station');
  const resolved = { stationName: field(station.item!, ['subwayStationName', 'subwayStationNm', 'stationName', 'sttnNm']), subwayStationId: id };
  const [busResult, facilityResult, scheduleResult] = await Promise.allSettled([
    call('list_subway_exit_bus_routes', { subwayStationId: id, page: 1, pageSize: 100 }, { signal }),
    call('list_subway_exit_facilities', { subwayStationId: id, page: 1, pageSize: 100 }, { signal }),
    input.dayType && input.direction ? call('get_subway_schedule', { subwayStationId: id, dailyTypeCode: input.dayType, upDownTypeCode: input.direction, page: 1, pageSize: 100 }, { signal }) : Promise.resolve(null),
  ]);
  const busRoutes = busResult.status === 'fulfilled' ? busResult.value : null;
  const facilities = facilityResult.status === 'fulfilled' ? facilityResult.value : null;
  const schedule = scheduleResult.status === 'fulfilled' ? scheduleResult.value : null;
  if (!busRoutes && !facilities && !schedule) throw busResult.status === 'rejected' ? busResult.reason : facilityResult.status === 'rejected' ? facilityResult.reason : scheduleResult.status === 'rejected' ? scheduleResult.reason : new TagoError('UPSTREAM_FAILURE', 'All station detail requests failed.');
  const errors = [
    ...(busResult.status === 'rejected' ? [failure(busResult.reason, 'exit_bus_routes')] : []),
    ...(facilityResult.status === 'rejected' ? [failure(facilityResult.reason, 'exit_facilities')] : []),
    ...(scheduleResult.status === 'rejected' ? [failure(scheduleResult.reason, 'schedule')] : []),
  ];
  for (const [stage, result] of [['exit_bus_routes', busRoutes], ['exit_facilities', facilities], ['schedule', schedule]] as const) {
    if (result && result.totalCount > result.items.length) errors.push({ stage, code: 'RESULT_LIMIT', message: `Only ${result.items.length} of ${result.totalCount} results were returned; ${result.totalCount - result.items.length} omitted.` });
  }
  const sources = [busRoutes, facilities, schedule].filter((result): result is TagoResult => result !== null).map(sourceFor);
  return workflow(errors.length ? 'partial' : 'ok', 'subway_station_info', 'Exit bus routes and nearby facilities for the selected station.', resolved, [], [], {
    exitBusRoutes: busRoutes?.items ?? [], exitFacilities: facilities?.items ?? [], schedule: schedule?.items ?? null,
    resultCounts: {
      exitBusRoutes: busRoutes ? { totalCount: busRoutes.totalCount, returnedCount: busRoutes.items.length, omittedCount: Math.max(0, busRoutes.totalCount - busRoutes.items.length) } : null,
      exitFacilities: facilities ? { totalCount: facilities.totalCount, returnedCount: facilities.items.length, omittedCount: Math.max(0, facilities.totalCount - facilities.items.length) } : null,
      schedule: schedule ? { totalCount: schedule.totalCount, returnedCount: schedule.items.length, omittedCount: Math.max(0, schedule.totalCount - schedule.items.length) } : null,
    },
    scheduleRequested: Boolean(input.dayType && input.direction), serviceDateType: input.dayType ?? null, direction: input.direction ?? null,
    partialErrors: errors,
  }, sources, schedule?.observedAt ?? busRoutes?.observedAt ?? facilities?.observedAt ?? null);
}

export async function intercityDeparturesByTerminalName(call: Call, input: { departureTerminal: string; arrivalTerminal: string; serviceType: 'express' | 'intercity'; date?: string }, signal?: AbortSignal): Promise<WorkflowResult> {
  const express = input.serviceType === 'express';
  const listOperation = express ? 'list_express_terminals' : 'list_intercity_terminals';
  const query = (terminal: string, side: string) => pages(call, listOperation, { terminalNm: terminal }, signal).then(rows => nameMatches(rows, terminal, ['terminalNm', 'terminalName', 'tmnNm'], ['terminalId'], `${side} terminal`, {}));
  const dep = await query(input.departureTerminal, 'departure');
  if (dep.result) return dep.result;
  const arr = await query(input.arrivalTerminal, 'arrival');
  if (arr.result) return arr.result;
  const depId = selectedId(dep.item!, ['terminalId'], 'departure terminal');
  const arrId = selectedId(arr.item!, ['terminalId'], 'arrival terminal');
  const resolved = { serviceType: input.serviceType, departureTerminal: field(dep.item!, ['terminalNm', 'terminalName', 'tmnNm']), arrivalTerminal: field(arr.item!, ['terminalNm', 'terminalName', 'tmnNm']), depTerminalId: depId, arrTerminalId: arrId, ...(input.date ? { serviceDate: input.date } : {}) };
  const pageData = await pagedResult(call, express ? 'find_express_bus_departures' : 'find_intercity_bus_departures', { depTerminalId: depId, arrTerminalId: arrId, depPlandTime: input.date }, signal);
  const partialErrors = pageData.incomplete ? [{ stage: 'departures', code: 'RESULT_LIMIT', message: `Only ${pageData.items.length} of ${pageData.totalCount} departures were returned; the five-page limit was reached.` }] : [];
  return workflow(pageData.incomplete ? 'partial' : 'ok', 'bus_departures', `Scheduled ${input.serviceType} bus departures.`, resolved, [], pageData.items.map(row => ({ departureTime: row.depPlandTime ?? row.depplandtime ?? null, arrivalTime: row.arrPlandTime ?? row.arrplandtime ?? null, busGrade: field(row, ['gradeNm', 'busGradeNm', 'busGradeName']), fareKRW: row.charge ?? row.adultcharge ?? null })), { departures: pageData.items, resultCounts: { totalCount: pageData.totalCount, returnedCount: pageData.items.length, omittedCount: Math.max(0, pageData.totalCount - pageData.items.length) }, partialErrors }, [sourceFor(pageData.result)], pageData.result.observedAt);
}

export async function sharedMobilityNearAddress(call: Call, input: { address: string; radiusKm?: number; includeMap?: boolean; maxProviders?: number }, signal?: AbortSignal) {
  const addresses = await geocodeAddress(input.address, signal);
  if (!addresses.length) return { result: workflow('not_found', 'address', 'No address match was found.') };
  if (addresses.length > 1) return { result: workflow('ambiguous', 'address', 'Address matches multiple locations; narrow the address before searching.', {}, addresses.map(candidate => geocodeSummary(candidate))) };
  const location = { latitude: addresses[0].latitude, longitude: addresses[0].longitude };
  const region = await reverseGeocodeCoordinates(location, signal);
  if (!region?.city) return { result: workflow('not_found', 'city', 'Could not resolve a city for the address; personal mobility lookup requires a city name.', { address: addresses[0].roadAddress || addresses[0].jibunAddress }) };
  const radiusKm = input.radiusKm ?? 2;
  const failures: Row[] = [];
  let zones: TagoResult | null = null;
  let zoneData: Awaited<ReturnType<typeof pagedResult>> | null = null;
  let providerResult: TagoResult | null = null;
  try {
    zoneData = await pagedResult(call, 'find_car_share_zones_nearby', { latitude: location.latitude, longitude: location.longitude, radius: radiusKm }, signal);
    zones = zoneData.result;
    if (zoneData.incomplete) failures.push({ stage: 'car_sharing', code: 'RESULT_LIMIT', message: `Only ${zoneData.items.length} of ${zoneData.totalCount} car-sharing zones were returned; the five-page limit was reached.` });
  }
  catch (error) { failures.push({ stage: 'car_sharing', code: error instanceof TagoError ? error.code : 'INTERNAL_ERROR', message: error instanceof Error ? error.message : 'Car-sharing zone lookup failed.' }); }
  try { providerResult = await call('list_pm_providers', { cityName: region.city, page: 1, pageSize: 100 }, { signal }); }
  catch (error) { failures.push({ stage: 'pm_providers', code: error instanceof TagoError ? error.code : 'INTERNAL_ERROR', message: error instanceof Error ? error.message : 'Provider lookup failed.' }); }
  const providerRecords = new Map<string, { providerName: string; cityCode: string }>();
  for (const row of providerResult?.items ?? []) {
    const providerName = field(row, ['providerName', 'providername', 'providerNm', 'provider']);
    const cityCode = field(row, ['citycode', 'cityCode']);
    if (providerName && cityCode) providerRecords.set(`${providerName}:${cityCode}`, { providerName, cityCode });
  }
  const allProviders = [...providerRecords.values()];
  const providers = allProviders.slice(0, input.maxProviders ?? 5);
  const vehicleResults = await Promise.all(providers.map(async ({ providerName, cityCode }) => {
    try {
      const pageData = await pagedResult(call, 'list_pm_vehicles', { providerName, cityCode }, signal);
      if (pageData.incomplete) failures.push({ stage: 'pm_vehicles', providerName, code: 'RESULT_LIMIT', message: `Only ${pageData.items.length} of ${pageData.totalCount} vehicles were checked; the five-page limit was reached.` });
      const vehicles = pageData.items.map(row => ({ providerName, deviceId: field(row, ['deviceId', 'deviceid', 'vehicleId', 'vehicleid']), latitude: Number(row.latitude ?? row.lat ?? row.gpsLati ?? row.gpslati), longitude: Number(row.longitude ?? row.lng ?? row.gpsLong ?? row.gpslong), battery: row.battery ?? row.batteryLevel ?? row.batteryLevelPercent ?? null }))
        .filter(vehicle => Number.isFinite(vehicle.latitude) && Number.isFinite(vehicle.longitude) && haversine(location, vehicle) <= radiusKm * 1000);
      return { providerName, vehicles, source: sourceFor(pageData.result), totalCount: pageData.totalCount, checkedCount: pageData.items.length, matchingCount: vehicles.length, incomplete: pageData.incomplete };
    } catch (error) {
      failures.push({ stage: 'pm_vehicles', providerName, code: error instanceof TagoError ? error.code : 'INTERNAL_ERROR', message: error instanceof Error ? error.message : 'Vehicle lookup failed.' });
      return { providerName, vehicles: [], source: null, totalCount: 0, checkedCount: 0, matchingCount: 0, incomplete: false };
    }
  }));
  const sources = [
    ...(zones ? [sourceFor(zones)] : []), ...(providerResult ? [sourceFor(providerResult)] : []),
    ...vehicleResults.flatMap(entry => entry.source ? [entry.source] : []),
  ];
  if (!sources.length) throw new TagoError('UPSTREAM_FAILURE', 'All nearby mobility lookups failed.');
  const matchingVehicles = vehicleResults.flatMap(entry => entry.vehicles);
  const vehicles = matchingVehicles.slice(0, 100);
  const omittedVehicleCount = Math.max(0, matchingVehicles.length - vehicles.length);
  if (omittedVehicleCount) failures.push({ stage: 'pm_vehicles', code: 'RESULT_LIMIT', message: `Only 100 of ${matchingVehicles.length} matching vehicles were returned.` });
  const zoneRows = zoneData?.items ?? [];
  let image: Buffer | undefined;
  let mapStatus: 'ok' | 'not_requested' | 'error' = 'not_requested';
  if (input.includeMap !== false) {
    try {
      const markers = [
        { ...location, label: 'a' },
        ...zoneRows.slice(0, 9).map((row, index) => ({ latitude: Number(row.latitude ?? row.gpsLati ?? row.gpslati), longitude: Number(row.longitude ?? row.gpsLong ?? row.gpslong), label: String(index + 1) })),
        ...vehicles.slice(0, 10).map((vehicle, index) => ({ latitude: vehicle.latitude, longitude: vehicle.longitude, label: String.fromCharCode(98 + index) })),
      ].filter(marker => Number.isFinite(marker.latitude) && Number.isFinite(marker.longitude));
      image = await staticMap(location, markers, signal);
      mapStatus = 'ok';
    } catch (error) {
      mapStatus = 'error';
      failures.push({ stage: 'static_map', code: error instanceof NaverMapsError ? error.code : 'MAPS_UPSTREAM', message: error instanceof Error ? error.message : 'Map image could not be generated.' });
    }
  }
  const status = failures.length ? (sources.length ? 'partial' : 'not_found') : 'ok';
  const result = workflow(status, 'nearby_shared_mobility', 'Car-sharing zones and shared personal mobility devices are listed separately; the data does not guarantee availability for rental.', {
    address: addresses[0].roadAddress || addresses[0].jibunAddress, cityName: region.city, district: region.district, latitude: String(location.latitude), longitude: String(location.longitude), radiusKm: String(radiusKm),
  }, [], [], { carSharingZones: zoneRows, carSharingZoneCounts: zoneData ? { totalCount: zoneData.totalCount, returnedCount: zoneRows.length, omittedCount: Math.max(0, zoneData.totalCount - zoneRows.length) } : null, personalMobility: vehicles, providersQueried: providers, providerCount: allProviders.length, providerOmittedCount: Math.max(0, allProviders.length - providers.length), vehicleCountReturned: vehicles.length, vehicleOmittedCount: omittedVehicleCount, vehicleCounts: vehicleResults.map(({ providerName, totalCount, checkedCount, matchingCount, incomplete }) => ({ providerName, totalCount, checkedCount, omittedCount: Math.max(0, totalCount - checkedCount), matchingCount, incomplete })), mapStatus, partialErrors: failures }, sources, new Date().toISOString());
  return { result, image };
}

async function resolveUniqueAddress(query: string, stage: string, resolved: Record<string, string>, signal?: AbortSignal) {
  const addresses = await geocodeAddress(query, signal);
  if (!addresses.length) return { result: workflow('not_found', stage, `No ${stage} address match was found.`, resolved) };
  if (addresses.length > 1) return { result: workflow('ambiguous', stage, `${stage} matches multiple addresses; use a more specific street address.`, resolved, addresses.map(item => geocodeSummary(item))) };
  return { location: { latitude: addresses[0].latitude, longitude: addresses[0].longitude }, label: addresses[0].roadAddress || addresses[0].jibunAddress || query };
}

export async function drivingRouteByAddress(input: { start: string; goal: string; waypoints?: string[]; option?: string }, signal?: AbortSignal): Promise<WorkflowResult> {
  const resolved: Record<string, string> = {};
  const start = await resolveUniqueAddress(input.start, 'start', resolved, signal);
  if ('result' in start) return start.result!;
  const goal = await resolveUniqueAddress(input.goal, 'goal', resolved, signal);
  if ('result' in goal) return goal.result!;
  const waypoints: Array<{ latitude: number; longitude: number }> = [];
  for (let i = 0; i < (input.waypoints ?? []).length; i++) {
    const point = await resolveUniqueAddress(input.waypoints![i], `waypoint ${i + 1}`, resolved, signal);
    if ('result' in point) return point.result!;
    waypoints.push(point.location);
  }
  const result = await directions5({ start: start.location, goal: goal.location, waypoints, option: input.option }, signal);
  const source = { service: 'Naver Maps Directions 5', sourceUrl: 'https://maps.apigw.ntruss.com/map-direction/v1/driving', catalogUrl: 'https://api.ncloud-docs.com/docs/en/application-maps-directions5' };
  return workflow('ok', 'driving_route', 'Driving route based on current traffic; not public transit or walking directions.', {
    start: start.label, goal: goal.label, ...(input.waypoints?.length ? { waypoints: input.waypoints.join(' → ') } : {}), option: input.option ?? 'traoptimal',
  }, [], [], result, [
    { service: 'Naver Maps Geocoding', sourceUrl: 'https://maps.apigw.ntruss.com/map-geocode/v2/geocode', catalogUrl: 'https://api.ncloud-docs.com/docs/en/application-maps-geocoding' }, source,
  ], result.observedAt);
}

function geocodeSummary(address: { roadAddress: string; jibunAddress: string; latitude: number; longitude: number }): Row {
  return { roadAddress: address.roadAddress, jibunAddress: address.jibunAddress, latitude: address.latitude, longitude: address.longitude };
}
