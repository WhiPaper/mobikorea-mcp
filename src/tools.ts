import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { callTago, OPERATIONS, TagoError } from './tago.js';
import { EXTRA_TOOLS, type ExtraTool } from './extra.js';
import { busArrivalsByStop, trainDeparturesByName, domesticFlightsByName, busRouteStatusByName, subwayStationInfo, intercityDeparturesByTerminalName, sharedMobilityNearAddress, drivingRouteByAddress } from './workflows.js';
import { checkBusArrivalsNearAddress, exploreBusStopsNearAddress } from './map-workflows.js';
import { NaverMapsError } from './naver-maps.js';

const READ_ONLY_ANNOTATIONS = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
});

const cityCode = z.union([z.string().min(1).max(9), z.number().int().nonnegative()]).describe('TAGO city code from a city-list tool, including list_pm_providers for personal mobility');
const nodeId = z.string().min(1).max(30).describe('City bus stop ID (nodeid) returned by find_bus_stops or find_nearby_bus_stops');
const routeId = z.string().min(1).max(30).describe('City bus route ID (routeid) returned by find_bus_routes or list_stop_routes');
const paging = {
  page: z.number().int().min(1).max(1000).optional().describe('Page number (1-1000); defaults to 1'),
  pageSize: z.number().int().min(1).max(100).optional().describe('Maximum items per page (1-100); defaults to 10'),
};
const day = z.string().regex(/^\d{8}$/, 'Use YYYYMMDD').describe('Planned departure date in YYYYMMDD format (e.g. 20261125)');
const parameterSchemas: Record<string, z.ZodType> = {
  cityCode,
  nodeId,
  routeId,
  depPlandTime: day,
  latitude: z.number().min(-90).max(90).describe('WGS84 latitude in decimal degrees'),
  longitude: z.number().min(-180).max(180).describe('WGS84 longitude in decimal degrees'),
  radius: z.number().positive().max(10).describe('Search radius in km (max 10); TAGO defaults to 2 km'),
  dailyTypeCode: z.enum(['01', '02', '03']).describe('Day type: 01 weekday, 02 Saturday, 03 Sunday'),
  upDownTypeCode: z.enum(['U', 'D']).describe('Direction code: U upbound, D downbound'),
  depTmnCd: z.string().min(1).max(30).describe('Express arrival departure terminal code (tmnCd) from list_express_arrival_terminals'),
  arrTmnCd: z.string().min(1).max(30).describe('Express arrival destination terminal code (tmnCd) from list_express_destinations'),
  tmnNm: z.string().min(1).max(100).describe('Partial express terminal name to filter list_express_arrival_terminals'),
  depTerminalId: z.string().min(1).max(30).describe('Departure terminal ID (terminalId) from list_express_terminals or list_intercity_terminals'),
  arrTerminalId: z.string().min(1).max(30).describe('Arrival terminal ID (terminalId) from list_express_terminals or list_intercity_terminals'),
  terminalNm: z.string().min(1).max(100).describe('Partial terminal name to search'),
  busGradeId: z.string().min(1).max(20).describe('Express bus grade ID from list_express_bus_grades'),
  depPlaceId: z.string().min(1).max(30).describe('Departure train station ID (nodeid) from list_train_stations'),
  arrPlaceId: z.string().min(1).max(30).describe('Arrival train station ID (nodeid) from list_train_stations'),
  trainGradeCode: z.string().min(1).max(20).describe('Train type code from list_train_types'),
  subwayStationId: z.string().min(1).max(30).describe('Subway station ID from find_subway_stations'),
  subwayStationName: z.string().min(1).max(100).describe('Korean subway station name keyword to search'),
  depAirportId: z.string().min(1).max(20).describe('Departure airport ID from list_airports'),
  arrAirportId: z.string().min(1).max(20).describe('Arrival airport ID from list_airports'),
  airlineId: z.string().min(1).max(20).describe('Airline ID from list_airlines'),
  depNodeId: z.string().min(1).max(30).describe('Departure port or passenger terminal ID from list_ports or list_passenger_ship_terminals'),
  nodeNm: z.string().min(1).max(100).describe('Partial port name to filter list_ports'),
  zoneName: z.string().min(1).max(100).describe('Car-sharing zone name keyword'),
  zoneAddr: z.string().min(1).max(100).describe('Car-sharing zone address substring'),
  providerName: z.string().min(1).max(50).describe('Personal mobility operator name (e.g. GBIKE) from list_pm_providers'),
  cityName: z.string().min(1).max(50).describe('Korean city or region name (e.g. 세종) from list_pm_providers'),
};

function schemaFor(tool: ExtraTool) {
  const schema: Record<string, z.ZodType> = {};
  for (const name of tool.required) schema[name] = parameterSchemas[name] ?? z.string().min(1).max(100).describe(`TAGO parameter ${name}`);
  for (const name of tool.optional ?? []) schema[name] = (parameterSchemas[name] ?? z.string().min(1).max(100).describe(`Optional TAGO parameter ${name}`)).optional();
  return z.object({ ...schema, ...paging });
}

const outputSchema = z.object({
  items: z.array(z.unknown()),
  totalCount: z.number().int().nonnegative(),
  observedAt: z.string(),
  sourceService: z.string(),
  sourceUrl: z.string(),
  catalogUrl: z.string(),
});
const workflowOutputSchema = z.object({
  status: z.enum(['ok', 'not_found', 'ambiguous', 'partial']),
  stage: z.string(),
  message: z.string(),
  resolved: z.record(z.string(), z.string()),
  candidates: z.array(z.record(z.string(), z.unknown())),
  summary: z.array(z.record(z.string(), z.unknown())),
  data: outputSchema.nullable(),
  details: z.record(z.string(), z.unknown()).optional(),
  sourceServices: z.array(z.object({ service: z.string(), sourceUrl: z.string(), catalogUrl: z.string() })).optional(),
  observedAt: z.string().nullable().optional(),
});
const mapWorkflowOutputSchema = z.object({
  status: z.enum(['ok', 'not_found', 'ambiguous', 'partial']),
  query: z.record(z.string(), z.unknown()),
  resolved: z.record(z.string(), z.unknown()),
  stops: z.array(z.record(z.string(), z.unknown())),
  observedAt: z.string().nullable(),
  sourceServices: z.array(z.object({ service: z.string(), sourceUrl: z.string(), catalogUrl: z.string() })),
  mapStatus: z.enum(['ok', 'not_requested', 'error']),
  partialErrors: z.array(z.record(z.string(), z.unknown())),
  candidates: z.array(z.record(z.string(), z.unknown())).optional(),
});

export function registerTools(server: McpServer, call: typeof callTago) {
  function register(name: string, title: string, description: string, inputSchema: z.ZodObject<z.ZodRawShape>) {
    server.registerTool(
      name,
      { title, description, inputSchema, outputSchema, annotations: READ_ONLY_ANNOTATIONS },
      async (args, extra) => {
        const service = OPERATIONS[name]?.service ?? 'unknown';
        try {
          const result = await call(name, args as Record<string, string | number | undefined>, { signal: extra.mcpReq.signal });
          try {
            await extra.mcpReq.log('info', { operation: name, service, status: 'ok', totalCount: result.totalCount }, 'mobikorea-mcp');
          } catch { /* Logging must not change the tool result. */ }
          return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
        } catch (error) {
          const code = error instanceof TagoError ? error.code : 'INTERNAL_ERROR';
          const retryable = error instanceof TagoError ? error.retryable : false;
          const message = error instanceof TagoError ? error.message : 'Unexpected server error';
          const hint = error instanceof TagoError ? error.hint : undefined;
          try {
            await extra.mcpReq.log('warning', { operation: name, service, status: 'error', code, retryable }, 'mobikorea-mcp');
          } catch { /* Logging must not change the tool result. */ }
          const payload = hint ? { code, message, retryable, hint } : { code, message, retryable };
          return { content: [{ type: 'text', text: JSON.stringify(payload) }], isError: true };
        }
      },
    );
  }

  register('list_bus_cities', 'List bus cities', 'List TAGO city codes supported by the city bus stop APIs. Pass returned cityCode to find_bus_stops or find_bus_routes.', z.strictObject({}));
  register('find_bus_stops', 'Find bus stops', 'Find city bus stops in a city by stop name or public stop number. For GPS coordinate search, use find_nearby_bus_stops. Use returned nodeid with get_bus_arrivals or list_stop_routes.', z.object({
    cityCode,
    nodeNm: z.string().min(1).max(30).optional().describe('Bus stop name substring to search'),
    nodeNo: z.string().min(1).max(10).optional().describe('Public bus stop number displayed on the stop sign'),
    ...paging,
  }));
  register('find_nearby_bus_stops', 'Find nearby bus stops', 'Find city bus stops within TAGO fixed 500 m radius of WGS84 coordinates. For name or stop-number search in a city, use find_bus_stops.', z.object({
    gpsLati: z.number().min(-90).max(90).describe('WGS84 latitude in decimal degrees'),
    gpsLong: z.number().min(-180).max(180).describe('WGS84 longitude in decimal degrees'),
    ...paging,
  }));
  register('list_stop_routes', 'List routes at stop', 'List city bus routes serving a specific stop. Obtain cityCode and nodeid from find_bus_stops first.', z.object({
    cityCode, nodeid: nodeId, ...paging,
  }));
  register('find_bus_routes', 'Find bus routes', 'Find city bus route numbers and IDs in a city. Use returned routeid with get_bus_route, list_route_stops, or get_route_bus_locations.', z.object({
    cityCode, routeNo: z.string().min(1).max(30).optional().describe('Bus route number to filter (e.g. 401, 순환2)'), ...paging,
  }));
  register('get_bus_route', 'Get bus route', 'Get first and last bus times and basic city bus route metadata. Returns schedule data, not live locations (use get_route_bus_locations for live positions).', z.object({
    cityCode, routeId,
  }));
  register('list_route_stops', 'List route stops', 'List ordered stops along a city bus route. Obtain routeId from find_bus_routes or list_stop_routes.', z.object({
    cityCode, routeId, ...paging,
  }));
  register('get_bus_arrivals', 'Get bus arrivals', 'Get current predicted arrivals for all city bus routes at a stop. For a single route at a stop, use get_route_arrivals_at_stop. observedAt is query time.', z.object({
    cityCode, nodeId, ...paging,
  }));
  register('get_route_bus_locations', 'Get route bus locations', 'Get current reported GPS locations of all buses on a city bus route. For buses approaching one stop, use get_approaching_bus_location. observedAt is query time.', z.object({
    cityCode, routeId, ...paging,
  }));
  for (const tool of EXTRA_TOOLS) {
    register(tool.name, tool.title, tool.description, schemaFor(tool));
  }

  function registerWorkflow(name: string, title: string, description: string, inputSchema: z.ZodObject<z.ZodRawShape>, run: (args: any, signal?: AbortSignal) => Promise<unknown>) {
    server.registerTool(name, { title, description, inputSchema, outputSchema: workflowOutputSchema, annotations: READ_ONLY_ANNOTATIONS }, async (args, extra) => {
      try {
        const raw = await run(args, extra.mcpReq.signal);
        const envelope = raw && typeof raw === 'object' && 'result' in raw ? raw as { result: Record<string, unknown>; image?: Buffer } : null;
        const result = envelope ? envelope.result : raw as Record<string, unknown>;
        const content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [{ type: 'text', text: JSON.stringify(result) }];
        if (envelope?.image) content.push({ type: 'image', data: envelope.image.toString('base64'), mimeType: 'image/png' });
        return { content, structuredContent: result };
      } catch (error) {
        const payload = error instanceof TagoError
          ? { code: error.code, message: error.message, retryable: error.retryable, ...(error.hint ? { hint: error.hint } : {}) }
          : error instanceof NaverMapsError
            ? { code: error.code, message: error.message, retryable: error.retryable }
            : { code: 'INTERNAL_ERROR', message: 'Unexpected server error', retryable: false };
        return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }], isError: true };
      }
    });
  }

  registerWorkflow('bus_arrivals_by_stop_name', 'Bus arrivals by stop name',
    'Answer a city bus arrival question using Korean city and stop names. Resolves IDs and returns live predictions in one call. Ambiguous names return candidates without selecting a stop.',
    z.object({ cityName: z.string().min(1).max(50).describe('Korean city name, e.g. 대구광역시'), stopName: z.string().min(1).max(50).describe('Bus stop name as displayed, e.g. 동대구역'), stopNumber: z.string().min(1).max(10).optional().describe('Public stop number to distinguish stops with the same name') }),
    (args, signal) => busArrivalsByStop(call, args, signal));
  registerWorkflow('train_departures_by_station_name', 'Train departures by station name',
    'Find scheduled trains from city and station names in one call. Exact names are preferred; ambiguous names return candidates. date is YYYYMMDD and defaults to the TAGO API behavior when omitted.',
    z.object({ departureCity: z.string().min(1).max(50).describe('Korean departure city name'), departureStation: z.string().min(1).max(50).describe('Departure station name'), arrivalCity: z.string().min(1).max(50).describe('Korean arrival city name'), arrivalStation: z.string().min(1).max(50).describe('Arrival station name'), date: day.optional() }),
    (args, signal) => trainDeparturesByName(call, args, signal));
  registerWorkflow('domestic_flights_by_airport_name', 'Domestic flights by airport name',
    'Find scheduled domestic flights from airport names in one call. Ambiguous names return candidates. date is YYYYMMDD and defaults to the TAGO API behavior when omitted.',
    z.object({ departureAirport: z.string().min(1).max(50).describe('Departure airport name, e.g. 김포'), arrivalAirport: z.string().min(1).max(50).describe('Arrival airport name, e.g. 제주'), date: day.optional() }),
    (args, signal) => domesticFlightsByName(call, args, signal));

  registerWorkflow('get_bus_route_status', 'Get bus route status',
    'Resolve a city and route number, then return route metadata, ordered stops, and current vehicle locations in one call. Duplicate route numbers return candidates. Vehicles may be empty when none are currently reported. Optionally returns a static map of vehicle locations.',
    z.object({ cityName: z.string().min(1).max(50).describe('Korean city or region name, e.g. 대구광역시'), routeNumber: z.string().min(1).max(30).describe('Bus route number as displayed, e.g. 401'), includeMap: z.boolean().default(Boolean(process.env.NAVER_MAPS_CLIENT_ID && process.env.NAVER_MAPS_CLIENT_SECRET)).describe('Include a static vehicle map when Maps credentials are configured') }),
    (args, signal) => busRouteStatusByName(call, args, signal));
  registerWorkflow('get_subway_station_info', 'Get subway station information',
    'Resolve a station name, then return exit-linked bus routes and nearby facilities. Supply both dayType and direction to include the station timetable; timetable data is not live arrivals. Ambiguous station names return candidates.',
    z.object({ stationName: z.string().min(1).max(60).describe('Korean subway station name'), dayType: z.enum(['01', '02', '03']).optional().describe('Schedule day type: 01 weekday, 02 Saturday, 03 Sunday'), direction: z.enum(['U', 'D']).optional().describe('Schedule direction: U upbound, D downbound; supply with dayType') }),
    (args, signal) => {
      if (Boolean(args.dayType) !== Boolean(args.direction)) throw new TagoError('INVALID_INPUT', 'Provide both dayType and direction to include a subway schedule.');
      return subwayStationInfo(call, args, signal);
    });
  registerWorkflow('find_intercity_departures_by_terminal_name', 'Find bus departures by terminal name',
    'Resolve departure and arrival terminals, then return scheduled express or intercity departures. serviceType is required because both datasets have separate terminal IDs and schedules. Ambiguous terminal names return candidates.',
    z.object({ departureTerminal: z.string().min(1).max(80).describe('Departure terminal name'), arrivalTerminal: z.string().min(1).max(80).describe('Arrival terminal name'), serviceType: z.enum(['express', 'intercity']).describe('Select the separate express or intercity bus dataset'), date: day.optional().describe('Departure service date in YYYYMMDD') }),
    (args, signal) => intercityDeparturesByTerminalName(call, args, signal));

  if (process.env.NAVER_MAPS_CLIENT_ID && process.env.NAVER_MAPS_CLIENT_SECRET) {
    const registerMapWorkflow = (
      name: string,
      title: string,
      description: string,
      inputSchema: z.ZodObject<z.ZodRawShape>,
      run: (args: any, signal?: AbortSignal) => Promise<{ result: any; image?: Buffer }>,
    ) => {
      server.registerTool(name, { title, description, inputSchema, outputSchema: mapWorkflowOutputSchema, annotations: READ_ONLY_ANNOTATIONS }, async (args, extra) => {
        try {
          const { result, image } = await run(args, extra.mcpReq.signal);
          const content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [
            { type: 'text', text: JSON.stringify(result) },
          ];
          if (image) content.push({ type: 'image', data: image.toString('base64'), mimeType: 'image/png' });
          return { content, structuredContent: result };
        } catch (error) {
          const payload = error instanceof TagoError || error instanceof NaverMapsError
            ? { code: error.code, message: error.message, retryable: error.retryable }
            : { code: 'INTERNAL_ERROR', message: 'Unexpected server error', retryable: false };
          return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }], isError: true };
        }
      });
    };
    const locationInput = {
      address: z.string().min(3).max(200).optional().describe('Korean road or lot-number street address; facility and business names are not searched'),
      selectedLocation: z.object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) }).optional().describe('Coordinates selected from an ambiguous geocoding result; provide this or address'),
      includeMap: z.boolean().default(true).describe('Return a static PNG map when true'),
    };
    const locationSchema = <T extends z.ZodRawShape>(extra: T) => z.object({
      ...locationInput,
      ...extra,
    }).refine((args: any) => Boolean(args.address) !== Boolean(args.selectedLocation), 'Provide exactly one of address or selectedLocation');
    registerMapWorkflow('explore_bus_stops_near_address', 'Explore bus stops near address',
      'Resolve a Korean street address, find TAGO city bus stops within its fixed 500 m search radius, sort them by straight-line distance, and optionally return a static map image. Ambiguous addresses return candidates; choose one by passing selectedLocation. Does not query arrivals.',
      locationSchema({ maxStops: z.number().int().min(1).max(20).default(10).describe('Maximum nearby stops to include (1-20)') }),
      (args, signal) => exploreBusStopsNearAddress(call, args, signal));
    registerMapWorkflow('check_bus_arrivals_near_address', 'Check bus arrivals near address',
      'Resolve a Korean street address, find nearby TAGO city bus stops within a fixed 500 m radius, and return arrival predictions per stop with straight-line distance. Includes a static map by default. This is not walking distance or a transit route. Ambiguous addresses return candidates; choose one by passing selectedLocation.',
      locationSchema({ maxStops: z.number().int().min(1).max(5).default(5).describe('Maximum stops to query (1-5)'), maxArrivalsPerStop: z.number().int().min(1).max(3).default(3).describe('Maximum predictions per stop (1-3)') }),
      (args, signal) => checkBusArrivalsNearAddress(call, args, signal));
    registerWorkflow('find_shared_mobility_near_address', 'Find shared mobility near address',
      'Resolve an address, then find nearby car-sharing pickup zones and personal mobility devices in separate groups. Device locations are filtered by straight-line radius. Results do not guarantee rental availability. Requires Maps and TAGO credentials.',
      z.object({ address: z.string().min(3).max(200).describe('Korean road or lot-number address; facility names are not searched'), radiusKm: z.number().positive().max(10).default(2).describe('Straight-line search radius in km (1-10)'), includeMap: z.boolean().default(true).describe('Return a static PNG map when true'), maxProviders: z.number().int().min(1).max(10).default(5).describe('Maximum personal mobility providers to query (1-10)') }),
      (args, signal) => sharedMobilityNearAddress(call, args, signal));
    registerWorkflow('get_driving_route', 'Get driving route',
      'Resolve Korean street addresses and return a traffic-aware Naver Maps Directions 5 car route with distance, duration, cost estimates, key roads, and limited guidance. This is not public-transit or walking navigation. Ambiguous addresses return candidates.',
      z.object({ start: z.string().min(3).max(200).describe('Korean road or lot-number departure address'), goal: z.string().min(3).max(200).describe('Korean road or lot-number destination address'), waypoints: z.array(z.string().min(3).max(200)).max(5).optional().describe('Up to five Korean street addresses to pass through in order'), option: z.enum(['trafast', 'tracomfort', 'traoptimal', 'traavoidtoll', 'traavoidcaronly']).optional().describe('Route option; defaults to real-time optimal') }),
      (args, signal) => drivingRouteByAddress(args, signal));
  }

}
