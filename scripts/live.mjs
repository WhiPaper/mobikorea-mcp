// Run explicitly with TAGO_SERVICE_KEY set; no credential is written to disk.
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { fileURLToPath } from 'node:url';
import { OPERATIONS } from '../dist/tago.js';

const client = new Client({ name: 'tago-live-check', version: '0.4.1' }, { versionNegotiation: { mode: 'auto' } });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL('../dist/server.js', import.meta.url))],
  env: { ...process.env },
});
const results = [];
const data = new Map();
const first = (name, pred = () => true) => data.get(name)?.items?.find(pred) ?? data.get(name)?.items?.[0] ?? {};
const pick = (item, ...keys) => keys.map(key => item[key]).find(value => value !== undefined);
async function run(name, args = {}) {
  try {
    const input = name === 'list_bus_cities' ? args : { ...args, pageSize: 100 };
    const result = await client.callTool({ name, arguments: input });
    if (result.isError) {
      let error;
      try { error = JSON.parse(result.content[0].text); }
      catch { error = { code: 'MCP_TOOL_ERROR', message: result.content[0].text }; }
      results.push({ name, status: 'error', code: error.code, message: error.message, args });
      return;
    }
    const value = result.structuredContent;
    data.set(name, value);
    results.push({ name, status: value.totalCount ? 'success' : 'empty', count: value.totalCount, args });
  } catch (error) {
    results.push({ name, status: 'mcp-error', message: error.message, args });
  }
}

try {
  await client.connect(transport);
  const discovery = client.getDiscoverResult();
  const protocol = client.getNegotiatedProtocolVersion();
  for (const name of [
    'list_bus_cities', 'list_route_cities', 'list_arrival_cities', 'list_location_cities',
    'list_express_arrival_terminals', 'list_express_terminals', 'list_express_bus_grades', 'list_express_cities',
    'list_intercity_terminals', 'list_intercity_cities', 'list_intercity_bus_grades',
    'list_train_types', 'list_train_cities', 'find_subway_stations',
    'list_airports', 'list_airlines', 'list_ports', 'list_passenger_ship_terminals', 'list_ship_types', 'list_pm_providers',
  ]) await run(name);

  const busCity = '22';
  await run('find_bus_stops', { cityCode: busCity, nodeNm: '동대구' });
  await run('find_nearby_bus_stops', { gpsLati: 35.8794, gpsLong: 128.6284 });
  await run('find_bus_routes', { cityCode: busCity, routeNo: '401' });
  const stop = first('find_bus_stops');
  const route = first('find_bus_routes');
  const nodeId = pick(stop, 'nodeid', 'nodeId');
  const routeId = pick(route, 'routeid', 'routeId');
  for (const [name,args] of [
    ['list_stop_routes',{cityCode:busCity,nodeid:nodeId}],
    ['get_bus_route',{cityCode:busCity,routeId}],
    ['list_route_stops',{cityCode:busCity,routeId}],
    ['get_bus_arrivals',{cityCode:busCity,nodeId}],
    ['get_route_bus_locations',{cityCode:busCity,routeId}],
    ['get_route_arrivals_at_stop',{cityCode:busCity,nodeId,routeId}],
    ['get_approaching_bus_location',{cityCode:busCity,nodeId,routeId}],
  ]) await run(name,args);

  const expressDepCode = pick(first('list_express_arrival_terminals'), 'tmnCd');
  await run('list_express_destinations',{depTmnCd:expressDepCode});
  await run('get_express_bus_arrival',{depTmnCd:expressDepCode,arrTmnCd:pick(first('list_express_destinations'),'tmnCd','arrTmnCd')});
  const expressDep = pick(first('list_express_terminals'),'terminalId');
  await run('list_express_terminals',{terminalNm:'동대구'});
  const expressArr = pick(first('list_express_terminals',i=>String(i.terminalNm).includes('동대구')),'terminalId') ?? expressDep;
  await run('find_express_bus_departures',{depTerminalId:expressDep,arrTerminalId:expressArr});

  await run('list_intercity_terminals',{terminalNm:'동대구'});
  const intercityDep = pick(first('list_intercity_terminals'),'terminalId');
  const intercityArr = pick(first('list_intercity_terminals',i=>String(i.terminalNm).includes('동대구')),'terminalId') ?? intercityDep;
  await run('find_intercity_bus_departures',{depTerminalId:intercityDep,arrTerminalId:intercityArr});

  await run('list_train_stations',{cityCode:'11'});
  const trainDep = pick(first('list_train_stations',i=>String(i.nodename).includes('서울')),'nodeid','nodeId');
  await run('list_train_stations',{cityCode:'22'});
  const trainArr = pick(first('list_train_stations',i=>String(i.nodename).includes('동대구')),'nodeid','nodeId');
  await run('find_train_departures',{depPlaceId:trainDep,arrPlaceId:trainArr});

  const subwayStationId = pick(first('find_subway_stations'),'subwayStationId');
  for (const name of ['list_subway_exit_bus_routes','list_subway_exit_facilities']) await run(name,{subwayStationId});
  await run('get_subway_schedule',{subwayStationId,dailyTypeCode:'01',upDownTypeCode:'U'});

  const airportA = pick(first('list_airports',i=>String(i.airportNm).includes('김포')),'airportId');
  const airportB = pick(first('list_airports',i=>String(i.airportNm).includes('제주')),'airportId');
  await run('find_domestic_flights',{depAirportId:airportA,arrAirportId:airportB});

  const port = pick(first('list_ports',i=>String(i.nodeNm).includes('인천')),'nodeId','nodeid');
  await run('find_domestic_ships',{depNodeId:port});
  await run('find_car_share_zones_by_name',{zoneName:'서울'});
  await run('find_car_share_zones_by_address',{zoneAddr:'서울'});
  await run('find_car_share_zones_nearby',{latitude:37.5665,longitude:126.978});
  const pm = first('list_pm_providers');
  await run('list_pm_vehicles',{providerName:pick(pm,'providername','providerName'),cityCode:pick(pm,'citycode','cityCode')});

  // TAGO occasionally returns code 99 for a valid request; recheck once before
  // classifying a tool as failed. Keep both attempts in the report.
  for (const failed of results.filter(result => result.status === 'error' && result.code === '99')) {
    await run(failed.name, failed.args);
  }

  const missing = Object.keys(OPERATIONS).filter(name => !results.some(result => result.name === name));
  console.log(JSON.stringify({ protocol, discovery: { supportedVersions: discovery?.supportedVersions, ttlMs: discovery?.ttlMs, cacheScope: discovery?.cacheScope }, uniqueOperations: Object.keys(OPERATIONS).length, missing, results },null,2));
} finally {
  await client.close();
}
