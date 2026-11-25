import { McpServer, ResourceTemplate, ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';
import { OPERATIONS, SERVICES } from './tago.js';

const SERVICE_KEYS = Object.keys(SERVICES);
function serviceSummary(serviceKey: string) {
  const info = SERVICES[serviceKey];
  if (!info) return null;
  const tools = Object.entries(OPERATIONS)
    .filter(([, op]) => op.service === serviceKey)
    .map(([name, op]) => ({ name, path: op.path, params: op.params }));
  return {
    service: serviceKey,
    label: info.label,
    basePath: info.base,
    catalogUrl: `https://www.data.go.kr/data/${info.catalog}/openapi.do`,
    tools,
  };
}

export function registerResources(server: McpServer) {

  server.registerResource(
    'tago-services-catalog',
    'tago://catalog/services',
    {
      title: 'TAGO services catalog',
      description: 'Overview of all 13 Korean TAGO public transport services, official data.go.kr catalog links, and tool mappings.',
      mimeType: 'application/json',
    },
    async uri => ({
      contents: [{
        uri: uri.href,
        mimeType: 'application/json',
        text: JSON.stringify({
          toolRouting: {
            strategy: 'Choose a high-level workflow by user purpose first; use low-level tools grouped by TAGO service/transport mode for specific data or known IDs.',
            workflowsByPurpose: [
      { purpose: 'live_bus_arrivals', tools: ['bus_arrivals_by_stop_name', ...(process.env.NAVER_MAPS_CLIENT_ID && process.env.NAVER_MAPS_CLIENT_SECRET ? ['check_bus_arrivals_near_address'] : [])] },
              { purpose: 'scheduled_departures', tools: ['train_departures_by_station_name', 'domestic_flights_by_airport_name', 'find_intercity_departures_by_terminal_name'] },
              { purpose: 'network_and_station_info', tools: ['get_bus_route_status', 'get_subway_station_info'] },
              { purpose: 'nearby_stops_and_mobility', tools: [...(process.env.NAVER_MAPS_CLIENT_ID && process.env.NAVER_MAPS_CLIENT_SECRET ? ['explore_bus_stops_near_address', 'find_shared_mobility_near_address'] : [])] },
              { purpose: 'driving_directions', tools: [...(process.env.NAVER_MAPS_CLIENT_ID && process.env.NAVER_MAPS_CLIENT_SECRET ? ['get_driving_route'] : [])] },
            ],
            lowLevelToolsByService: SERVICE_KEYS.map(key => ({ service: key, tools: (serviceSummary(key)?.tools ?? []).map(tool => tool.name) })),
            unavailablePlannedWorkflows: [],
          },
          services: SERVICE_KEYS.map(serviceSummary),
        }, null, 2),
      }],
    }),
  );

  server.registerResource(
    'tago-service-detail',
    new ResourceTemplate('tago://catalog/services/{service}', {
      list: async () => ({
        resources: SERVICE_KEYS.map(key => ({
          uri: `tago://catalog/services/${key}`,
          name: `tago-service-${key}`,
          title: SERVICES[key].label,
          description: `Tool and endpoint catalog for TAGO ${SERVICES[key].label} (${SERVICES[key].base})`,
          mimeType: 'application/json',
        })),
      }),
      complete: {
        service: value => SERVICE_KEYS.filter(key => key.toLowerCase().startsWith(value.toLowerCase())),
      },
    }),
    {
      title: 'TAGO service detail',
      description: 'Tools, upstream paths, and official catalog URL for a single TAGO service.',
      mimeType: 'application/json',
    },
    async (uri, { service }) => {
      const summary = serviceSummary(String(service));
      if (!summary) {
        throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Unknown TAGO service: ${service}`);
      }
      return {
        contents: [{
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(summary, null, 2),
        }],
      };
    },
  );

}
