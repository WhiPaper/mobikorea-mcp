import test from 'node:test';
import assert from 'node:assert/strict';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { createServer } from '../dist/server.js';

function fixture(rows, service = 'fixture') {
  return { items: rows, totalCount: rows.length, observedAt: '2026-11-25T09:00:00.000Z', sourceService: service,
    sourceUrl: 'https://apis.data.go.kr/example', catalogUrl: 'https://www.data.go.kr/example' };
}

test('name-based workflows resolve IDs and return data through MCP', async () => {
  const calls = [];
  let failRouteStops = false;
  let routeHasMoreVehicles = false;
  let routeHasMoreStops = false;
  let arrivalsHaveMore = false;
  const arrivalPages = [];
  const trainPages = [];
  const flightPages = [];
  let subwayHasMore = false;
  const responses = {
    list_bus_cities: fixture([{ citycode: '22', cityname: '대구광역시' }]),
    find_bus_stops: fixture([{ nodeid: 'A', nodenm: '동대구역', nodeno: '12345' }]),
    get_bus_arrivals: args => {
      arrivalPages.push(args.page);
      if (!arrivalsHaveMore) return fixture([{ routeno: '401', arrtime: 180, arrprevstationcnt: 2 }], 'arrival');
      return { ...fixture(Array.from({ length: args.page === 1 ? 100 : 1 }, (_, index) => ({ routeno: `R${index}`, arrtime: index, arrprevstationcnt: 2 })), 'arrival'), totalCount: 101 };
    },
    list_train_cities: fixture([{ citycode: '11', cityname: '서울특별시' }, { citycode: '22', cityname: '대구광역시' }]),
    list_train_stations: args => fixture(args.cityCode === '11' ? [{ nodeid: 'SEOUL', nodename: '서울' }] : [{ nodeid: 'DONGDAEGU', nodename: '동대구' }]),
    find_train_departures: args => {
      trainPages.push(args.page);
      return { ...fixture(Array.from({ length: args.page === 1 ? 100 : 50 }, (_, index) => ({ trainno: `T${index}`, depplandtime: '20261125090000', adultcharge: '39000' })), 'train'), totalCount: 150 };
    },
    list_airports: fixture([{ airportId: 'GMP', airportNm: '김포' }, { airportId: 'CJU', airportNm: '제주' }]),
    find_domestic_flights: args => {
      flightPages.push(args.page);
      return { ...fixture(Array.from({ length: args.page === 1 ? 100 : 50 }, (_, index) => ({ vihicleId: `KE${index}`, economyCharge: 61900 })), 'flight'), totalCount: 150 };
    },
    list_route_cities: fixture([{ citycode: '22', cityname: '대구광역시' }], 'route'),
    find_bus_routes: fixture([{ routeid: 'R401', routeno: '401' }], 'route'),
    get_bus_route: fixture([{ routeno: '401', startnodenm: '동대구역', endnodenm: '월성동' }], 'route'),
    list_route_stops: args => {
      if (failRouteStops) throw new Error('temporary route stop failure');
      if (routeHasMoreStops) return { ...fixture(Array.from({ length: args.page === 1 ? 100 : 50 }, (_, index) => ({ nodeid: `N${index}`, nodenm: '동대구역', nodeord: index, gpslati: '35.88', gpslong: '128.63' })), 'route'), totalCount: 150 };
      return fixture([{ nodeid: 'N1', nodenm: '동대구역', nodeord: 1, gpslati: '35.88', gpslong: '128.63' }], 'route');
    },
    get_route_bus_locations: () => fixture(routeHasMoreVehicles
      ? Array.from({ length: 25 }, (_, index) => ({ vehicleno: `BUS${index + 1}`, gpslati: '35.88', gpslong: '128.63' }))
      : [{ vehicleno: 'BUS1', gpslati: '35.88', gpslong: '128.63' }], 'location'),
    find_subway_stations: fixture([{ subwayStationId: 'S1', stationName: '반월당역' }], 'subway'),
    list_subway_exit_bus_routes: fixture([{ exitNo: '1', routeNo: '401' }], 'subway'),
    list_subway_exit_facilities: fixture([{ exitNo: '1', facilityName: '약령시' }], 'subway'),
    get_subway_schedule: () => subwayHasMore
      ? { ...fixture(Array.from({ length: 100 }, (_, index) => ({ departureTime: String(index) })), 'subway'), totalCount: 150 }
      : fixture([{ departureTime: '0600' }], 'subway'),
    list_express_terminals: args => fixture([{ terminalId: 'E1', terminalNm: '동대구' }, { terminalId: 'E2', terminalNm: '서울경부' }], 'express'),
    find_express_bus_departures: args => ({ ...fixture(Array.from({ length: args.page === 1 ? 100 : 50 }, (_, index) => ({ depPlandTime: `202611251${String(index).padStart(2, '0')}`, gradeNm: '우등', charge: 20000 })), 'express'), totalCount: 150 }),
  };
  const server = createServer(async (name, args) => {
    calls.push({ name, args });
    const response = responses[name];
    assert.ok(response, `unexpected operation ${name}`);
    return typeof response === 'function' ? response(args) : response;
  });
  const client = new Client({ name: 'workflow-test', version: '0.5.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const bus = await client.callTool({ name: 'bus_arrivals_by_stop_name', arguments: { cityName: '대구', stopName: '동대구역' } });
    assert.equal(bus.structuredContent.status, 'ok');
    assert.equal(bus.structuredContent.resolved.nodeId, 'A');
    assert.equal(bus.structuredContent.data.items[0].routeno, '401');
    assert.equal(bus.structuredContent.summary[0].arrivalSeconds, 180);
    assert.deepEqual(calls.slice(0, 3).map(call => call.name), ['list_bus_cities', 'find_bus_stops', 'get_bus_arrivals']);
    arrivalsHaveMore = true;
    const allArrivals = await client.callTool({ name: 'bus_arrivals_by_stop_name', arguments: { cityName: '대구', stopName: '동대구역' } });
    assert.equal(allArrivals.structuredContent.status, 'ok');
    assert.equal(allArrivals.structuredContent.summary.length, 101);
    assert.equal(allArrivals.structuredContent.data.items.length, 101);
    assert.deepEqual(arrivalPages, [1, 1, 2]);
    arrivalsHaveMore = false;

    const train = await client.callTool({ name: 'train_departures_by_station_name', arguments: {
      departureCity: '서울', departureStation: '서울', arrivalCity: '대구', arrivalStation: '동대구', date: '20261125',
    } });
    assert.equal(train.structuredContent.status, 'ok');
    assert.equal(calls.at(-1).args.depPlaceId, 'SEOUL');
    assert.equal(calls.at(-1).args.arrPlaceId, 'DONGDAEGU');
    assert.equal(calls.at(-1).args.depPlandTime, '20261125');
    assert.equal(train.structuredContent.summary[0].adultFareKRW, '39000');
    assert.equal(train.structuredContent.summary.length, 150);
    assert.deepEqual(trainPages, [1, 2]);

    const flights = await client.callTool({ name: 'domestic_flights_by_airport_name', arguments: { departureAirport: '김포', arrivalAirport: '제주' } });
    assert.equal(flights.structuredContent.status, 'ok');
    assert.equal(calls.at(-1).args.depAirportId, 'GMP');
    assert.equal(calls.at(-1).args.arrAirportId, 'CJU');
    assert.equal(flights.structuredContent.summary[0].flightNumber, 'KE0');
    assert.equal(flights.structuredContent.summary.length, 150);
    assert.deepEqual(flightPages, [1, 2]);

    const route = await client.callTool({ name: 'get_bus_route_status', arguments: { cityName: '대구', routeNumber: '401', includeMap: false } });
    assert.equal(route.structuredContent.status, 'ok');
    assert.equal(route.structuredContent.resolved.routeId, 'R401');
    assert.equal(route.structuredContent.details.vehicles[0].vehicleId, 'BUS1');
    routeHasMoreVehicles = true;
    routeHasMoreStops = true;
    const routeWithoutMap = await client.callTool({ name: 'get_bus_route_status', arguments: { cityName: '대구', routeNumber: '401', includeMap: false } });
    assert.equal(routeWithoutMap.structuredContent.details.vehicles.length, 25);
    assert.equal(routeWithoutMap.structuredContent.details.vehicles[24].mapIndex, null);
    assert.equal(routeWithoutMap.structuredContent.details.routeStops.length, 150);
    routeHasMoreVehicles = false;
    routeHasMoreStops = false;
    failRouteStops = true;
    const partialRoute = await client.callTool({ name: 'get_bus_route_status', arguments: { cityName: '대구', routeNumber: '401', includeMap: false } });
    assert.equal(partialRoute.structuredContent.status, 'partial');
    assert.equal(partialRoute.structuredContent.details.vehicles.length, 1);
    assert.equal(partialRoute.structuredContent.details.partialErrors[0].stage, 'route_stops');
    failRouteStops = false;

    const subway = await client.callTool({ name: 'get_subway_station_info', arguments: { stationName: '반월당역', dayType: '01', direction: 'U' } });
    assert.equal(subway.structuredContent.status, 'ok');
    assert.equal(subway.structuredContent.resolved.subwayStationId, 'S1');
    assert.equal(subway.structuredContent.details.schedule.length, 1);
    subwayHasMore = true;
    const partialSubway = await client.callTool({ name: 'get_subway_station_info', arguments: { stationName: '반월당역', dayType: '01', direction: 'U' } });
    assert.equal(partialSubway.structuredContent.status, 'partial');
    assert.equal(partialSubway.structuredContent.details.schedule.length, 100);
    assert.equal(partialSubway.structuredContent.details.resultCounts.schedule.omittedCount, 50);
    assert.ok(partialSubway.structuredContent.details.partialErrors.some(error => error.stage === 'schedule' && error.code === 'RESULT_LIMIT'));

    const departures = await client.callTool({ name: 'find_intercity_departures_by_terminal_name', arguments: { departureTerminal: '동대구', arrivalTerminal: '서울경부', serviceType: 'express', date: '20261125' } });
    assert.equal(departures.structuredContent.status, 'ok');
    assert.equal(departures.structuredContent.resolved.depTerminalId, 'E1');
    assert.equal(departures.structuredContent.summary[0].fareKRW, 20000);
    assert.equal(departures.structuredContent.summary.length, 150);
    assert.equal(departures.structuredContent.details.departures.length, 150);
    assert.deepEqual(calls.filter(call => call.name === 'find_express_bus_departures').map(call => call.args.page), [1, 2]);
  } finally { await client.close(); await server.close(); }
});

test('ambiguous names return candidates without calling live endpoint', async () => {
  const calls = [];
  let noStopMatches = false;
  const server = createServer(async (name) => {
    calls.push(name);
    if (name === 'list_bus_cities') return fixture([{ citycode: '22', cityname: '대구광역시' }]);
    if (name === 'find_bus_stops') return fixture(noStopMatches ? [] : [
      { nodeid: 'A', nodenm: '동대구역', nodeno: '100' },
      { nodeid: 'B', nodenm: '동대구역', nodeno: '200' },
    ]);
    if (name === 'get_bus_arrivals') return fixture([{ routeno: '401' }], 'arrival');
    throw new Error('Unexpected call');
  });
  const client = new Client({ name: 'workflow-test', version: '0.5.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const result = await client.callTool({ name: 'bus_arrivals_by_stop_name', arguments: { cityName: '대구광역시', stopName: '동대구역' } });
    assert.equal(result.structuredContent.status, 'ambiguous');
    assert.equal(result.structuredContent.candidates.length, 2);
    assert.deepEqual(calls, ['list_bus_cities', 'find_bus_stops']);
    const selected = await client.callTool({ name: 'bus_arrivals_by_stop_name', arguments: { cityName: '대구광역시', stopName: '동대구역', stopNumber: '200' } });
    assert.equal(selected.structuredContent.status, 'ok');
    assert.equal(selected.structuredContent.resolved.nodeId, 'B');
    assert.equal(calls.at(-1), 'get_bus_arrivals');
    noStopMatches = true;
    const missing = await client.callTool({ name: 'bus_arrivals_by_stop_name', arguments: { cityName: '대구광역시', stopName: '존재하지 않는 정류장' } });
    assert.equal(missing.structuredContent.status, 'not_found');
    assert.equal(calls.at(-1), 'find_bus_stops');
  } finally { await client.close(); await server.close(); }
});
