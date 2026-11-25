import test from 'node:test';
import assert from 'node:assert/strict';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { createServer } from '../dist/server.js';

const png = Buffer.from('89504e470d0a1a0a', 'hex');
function fixture(items, sourceService = 'fixture') {
  return { items, totalCount: items.length, observedAt: '2026-11-25T09:00:00.000Z', sourceService,
    sourceUrl: `https://apis.data.go.kr/${sourceService}`, catalogUrl: `https://www.data.go.kr/${sourceService}` };
}

test('address map workflows register conditionally and return a combined list, arrivals, and PNG', async () => {
  const previous = { id: process.env.NAVER_MAPS_CLIENT_ID, secret: process.env.NAVER_MAPS_CLIENT_SECRET, fetch: globalThis.fetch };
  process.env.NAVER_MAPS_CLIENT_ID = 'test-id';
  process.env.NAVER_MAPS_CLIENT_SECRET = 'test-secret';
  const naverRequests = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(input);
    naverRequests.push({ url, headers: new Headers(init?.headers) });
    if (url.pathname.includes('geocode')) return Response.json({ status: 'OK', addresses: [
      { roadAddress: '대구 동구 동대구로 550', jibunAddress: '대구 동구 신암동 294', x: '128.6284', y: '35.8794' },
    ] });
    if (url.pathname.includes('map-static')) return new Response(png, { headers: { 'content-type': 'image/png', 'content-length': String(png.length) } });
    throw new Error(`Unexpected Naver endpoint ${url.pathname}`);
  };
  let stopRows = [
    { citycode: '22', nodeid: 'A', nodenm: '동대구역', nodeno: '100', gpslati: '35.8800', gpslong: '128.6284' },
    { citycode: '37100', nodeid: 'B', nodenm: '동대구역', nodeno: '200', gpslati: '35.8810', gpslong: '128.6284' },
  ];
  const calls = [];
  const server = createServer(async (name, args) => {
    calls.push({ name, args });
    if (name === 'find_nearby_bus_stops') return fixture(stopRows, 'stop');
    if (name === 'get_bus_arrivals') return fixture([{ routeno: args.nodeId === 'A' ? '401' : '급행1', arrtime: args.nodeId === 'A' ? 90 : 240, arrprevstationcnt: 2 }], 'arrival');
    throw new Error(`Unexpected TAGO operation ${name}`);
  });
  const client = new Client({ name: 'map-workflow-test', version: '0.1.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const { tools } = await client.listTools();
    assert.equal(tools.length, 55);
    assert.ok(tools.some(tool => tool.name === 'explore_bus_stops_near_address'));
    assert.ok(tools.some(tool => tool.name === 'check_bus_arrivals_near_address'));
    assert.ok(tools.some(tool => tool.name === 'find_shared_mobility_near_address'));
    assert.ok(tools.some(tool => tool.name === 'get_driving_route'));

    const explore = await client.callTool({ name: 'explore_bus_stops_near_address', arguments: { address: '동대구역' } });
    assert.equal(explore.structuredContent.status, 'ok');
    assert.equal(explore.structuredContent.stops.length, 2);
    assert.deepEqual(explore.structuredContent.stops.map(stop => stop.stopId), ['A', 'B']);
    assert.equal(explore.content.at(-1).type, 'image');
    assert.equal(explore.content.at(-1).mimeType, 'image/png');
    assert.equal(Buffer.from(explore.content.at(-1).data, 'base64').toString('hex'), png.toString('hex'));
    const staticUrl = naverRequests.find(request => request.url.pathname.includes('map-static')).url;
    assert.equal(staticUrl.searchParams.getAll('markers').length, 3, 'center and two distinct stop markers');
    assert.equal(staticUrl.searchParams.get('center'), '128.6284,35.8794', 'map coordinates use longitude,latitude order');
    assert.equal(naverRequests.find(request => request.url.pathname.includes('geocode')).url.searchParams.get('query'), '동대구역');
    assert.equal(JSON.stringify(explore.structuredContent).includes('test-secret'), false, 'credentials do not appear in tool output');

    const arrivals = await client.callTool({ name: 'check_bus_arrivals_near_address', arguments: { address: '동대구역', includeMap: false } });
    assert.equal(arrivals.structuredContent.stops.length, 2);
    assert.deepEqual(arrivals.structuredContent.stops.map(stop => stop.arrivals[0].routeNumber), ['401', '급행1']);
    assert.equal(arrivals.structuredContent.mapStatus, 'not_requested');
    assert.equal(calls.filter(call => call.name === 'get_bus_arrivals').length, 2);
    assert.equal(naverRequests.every(request => request.headers.get('x-ncp-apigw-api-key') === 'test-secret'), true);

    stopRows = Array.from({ length: 20 }, (_, index) => ({ citycode: '22', nodeid: `S${index}`, nodenm: `Stop ${index}`, nodeno: String(index), gpslati: String(35.88 + index / 100000), gpslong: '128.6284' }));
    const stopsWithoutMap = await client.callTool({ name: 'explore_bus_stops_near_address', arguments: { address: '동대구역', maxStops: 20, includeMap: false } });
    assert.equal(stopsWithoutMap.structuredContent.stops.length, 20);
    assert.equal(stopsWithoutMap.structuredContent.resolved.returnedStops, 20);
    assert.equal(stopsWithoutMap.structuredContent.resolved.resultOmittedCount, 0);
    assert.equal(stopsWithoutMap.structuredContent.resolved.mapOmittedCount, 1);
    assert.equal(stopsWithoutMap.structuredContent.stops[19].mapIndex, null);
    assert.equal(stopsWithoutMap.structuredContent.mapStatus, 'not_requested');
    const twentyStopMap = await client.callTool({ name: 'explore_bus_stops_near_address', arguments: { address: '동대구역', maxStops: 20 } });
    assert.equal(twentyStopMap.structuredContent.stops[9].mapLabel, 'b');
    const twentyStopMarkers = naverRequests.filter(request => request.url.pathname.includes('map-static')).at(-1).url.searchParams.getAll('markers');
    assert.ok(twentyStopMarkers.some(marker => marker.includes('type:a') && marker.includes('label:b')));
  } finally {
    await client.close();
    await server.close();
    if (previous.id === undefined) delete process.env.NAVER_MAPS_CLIENT_ID; else process.env.NAVER_MAPS_CLIENT_ID = previous.id;
    if (previous.secret === undefined) delete process.env.NAVER_MAPS_CLIENT_SECRET; else process.env.NAVER_MAPS_CLIENT_SECRET = previous.secret;
    globalThis.fetch = previous.fetch;
  }
});

test('map failure preserves stop data and reports a partial result', async () => {
  const previous = { id: process.env.NAVER_MAPS_CLIENT_ID, secret: process.env.NAVER_MAPS_CLIENT_SECRET, fetch: globalThis.fetch };
  process.env.NAVER_MAPS_CLIENT_ID = 'test-id';
  process.env.NAVER_MAPS_CLIENT_SECRET = 'test-secret';
  globalThis.fetch = async input => {
    const url = new URL(input);
    if (url.pathname.includes('geocode')) return Response.json({ status: 'OK', addresses: [
      { roadAddress: '대구 동구 동대구로 550', x: '128.6284', y: '35.8794' },
    ] });
    return Response.json({ error: 'not allowed' }, { status: 403 });
  };
  const server = createServer(async name => {
    assert.equal(name, 'find_nearby_bus_stops');
    return fixture([{ citycode: '22', nodeid: 'A', nodenm: '동대구역', nodeno: '100', gpslati: '35.8800', gpslong: '128.6284' }], 'stop');
  });
  const client = new Client({ name: 'map-error-test', version: '0.1.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const result = await client.callTool({ name: 'explore_bus_stops_near_address', arguments: { address: '동대구역' } });
    assert.notEqual(result.isError, true);
    assert.equal(result.structuredContent.status, 'partial');
    assert.equal(result.structuredContent.mapStatus, 'error');
    assert.equal(result.structuredContent.partialErrors[0].code, 'MAPS_FORBIDDEN');
    assert.equal(result.structuredContent.stops[0].stopId, 'A');
    assert.equal(result.content.at(-1).type, 'text');
  } finally {
    await client.close();
    await server.close();
    if (previous.id === undefined) delete process.env.NAVER_MAPS_CLIENT_ID; else process.env.NAVER_MAPS_CLIENT_ID = previous.id;
    if (previous.secret === undefined) delete process.env.NAVER_MAPS_CLIENT_SECRET; else process.env.NAVER_MAPS_CLIENT_SECRET = previous.secret;
    globalThis.fetch = previous.fetch;
  }
});

test('ambiguous address returns candidates without querying TAGO or Static Map', async () => {
  const previous = { id: process.env.NAVER_MAPS_CLIENT_ID, secret: process.env.NAVER_MAPS_CLIENT_SECRET, fetch: globalThis.fetch };
  process.env.NAVER_MAPS_CLIENT_ID = 'test-id';
  process.env.NAVER_MAPS_CLIENT_SECRET = 'test-secret';
  let mapCalls = 0;
  let noAddressMatches = false;
  globalThis.fetch = async input => {
    const url = new URL(input);
    if (url.pathname.includes('map-static')) mapCalls++;
    if (noAddressMatches) return Response.json({ status: 'OK', addresses: [] });
    return Response.json({ status: 'OK', addresses: [
      { roadAddress: '대구 동구 1', x: '128.6', y: '35.8' },
      { roadAddress: '서울 중구 1', x: '126.9', y: '37.5' },
    ] });
  };
  const calls = [];
  const server = createServer(async name => { calls.push(name); return fixture([]); });
  const client = new Client({ name: 'map-ambiguity-test', version: '0.1.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const result = await client.callTool({ name: 'explore_bus_stops_near_address', arguments: { address: '중앙로' } });
    assert.equal(result.structuredContent.status, 'ambiguous');
    assert.equal(result.structuredContent.candidates.length, 2);
    assert.deepEqual(calls, []);
    assert.equal(mapCalls, 0);
    noAddressMatches = true;
    const missing = await client.callTool({ name: 'explore_bus_stops_near_address', arguments: { address: '주소 미확인' } });
    assert.equal(missing.structuredContent.status, 'not_found');
    assert.deepEqual(calls, []);
    assert.equal(mapCalls, 0);
  } finally {
    await client.close();
    await server.close();
    if (previous.id === undefined) delete process.env.NAVER_MAPS_CLIENT_ID; else process.env.NAVER_MAPS_CLIENT_ID = previous.id;
    if (previous.secret === undefined) delete process.env.NAVER_MAPS_CLIENT_SECRET; else process.env.NAVER_MAPS_CLIENT_SECRET = previous.secret;
    globalThis.fetch = previous.fetch;
  }
});

test('shared mobility and driving workflows combine Maps and TAGO responses', async () => {
  const previous = { id: process.env.NAVER_MAPS_CLIENT_ID, secret: process.env.NAVER_MAPS_CLIENT_SECRET, fetch: globalThis.fetch };
  process.env.NAVER_MAPS_CLIENT_ID = 'test-id';
  process.env.NAVER_MAPS_CLIENT_SECRET = 'test-secret';
  const requests = [];
  const zonePageCalls = [];
  let mobilityHasMore = false;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input);
    requests.push(url);
    if (url.pathname.includes('reversegeocode')) return Response.json({ status: { code: 0 }, results: [
      { name: 'admcode', region: { area1: { name: '대구광역시' }, area2: { name: '동구' }, area3: { name: '신암동' } } },
      { name: 'roadaddr', land: { name: '동대구로', number1: '550' } },
    ] });
    if (url.pathname.includes('geocode')) return Response.json({ status: 'OK', addresses: [{ roadAddress: '대구 동구 동대구로 550', x: '128.6284', y: '35.8794' }] });
    if (url.pathname.includes('map-direction')) return Response.json({ code: 0, currentDateTime: '2026-11-25T10:00:00', route: { traoptimal: [{
      summary: { distance: 12000, duration: 900000, tollFare: 0, taxiFare: 15000, fuelPrice: 1200 },
      section: [{ name: '동대구로', distance: 12000, congestion: 1, speed: 45 }],
      guide: [{ instructions: '목적지 방향으로 이동', distance: 12000, duration: 900000 }],
      path: [[128.6284, 35.8794], [128.7, 35.9]],
    }] } });
    if (url.pathname.includes('map-static')) return new Response(png, { headers: { 'content-type': 'image/png', 'content-length': String(png.length) } });
    throw new Error(`Unexpected Naver endpoint ${url.pathname}`);
  };
  const vehiclePageCalls = [];
  const server = createServer(async (name, args) => {
    if (name === 'find_car_share_zones_nearby') {
      zonePageCalls.push(args.page);
      if (mobilityHasMore) return { ...fixture(Array.from({ length: args.page === 1 ? 100 : 1 }, (_, index) => ({ zoneName: `Zone ${args.page}-${index}`, latitude: 35.88, longitude: 128.628 })), 'carSharing'), totalCount: 101 };
      return fixture([{ zoneName: '동대구역 존', latitude: 35.88, longitude: 128.628 }], 'carSharing');
    }
    if (name === 'list_pm_providers') return fixture([{ providerName: 'GBIKE', citycode: '22' }], 'personalMobility');
    if (name === 'list_pm_vehicles') {
      assert.equal(args.cityCode, '22');
      assert.equal(args.cityName, undefined);
      vehiclePageCalls.push(args.page);
      if (args.page === 1) return { ...fixture(Array.from({ length: 100 }, (_, index) => ({ deviceId: `F${index}`, latitude: mobilityHasMore ? 35.881 : 37.5, longitude: 128.628, battery: 80 })), 'personalMobility'), totalCount: 101 };
      return { ...fixture([{ deviceId: 'S1', latitude: 35.881, longitude: 128.628, battery: 80 }], 'personalMobility'), totalCount: 101 };
    }
    throw new Error(`Unexpected TAGO operation ${name}`);
  });
  const client = new Client({ name: 'map-routing-test', version: '0.1.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const shared = await client.callTool({ name: 'find_shared_mobility_near_address', arguments: { address: '동대구로 550' } });
    assert.equal(shared.structuredContent.status, 'ok');
    assert.equal(shared.structuredContent.details.carSharingZones[0].zoneName, '동대구역 존');
    assert.equal(shared.structuredContent.details.personalMobility[0].deviceId, 'S1');
    assert.deepEqual(vehiclePageCalls, [1, 2]);
    assert.equal(shared.structuredContent.details.vehicleCounts[0].checkedCount, 101);
    assert.equal(shared.content.at(-1).type, 'image');

    mobilityHasMore = true;
    const crowded = await client.callTool({ name: 'find_shared_mobility_near_address', arguments: { address: '동대구로 550', includeMap: false } });
    assert.equal(crowded.structuredContent.status, 'partial');
    assert.equal(crowded.structuredContent.details.personalMobility.length, 100);
    assert.equal(crowded.structuredContent.details.vehicleOmittedCount, 1);
    assert.equal(crowded.structuredContent.details.carSharingZones.length, 101);
    assert.equal(crowded.structuredContent.details.carSharingZoneCounts.omittedCount, 0);
    assert.equal(crowded.structuredContent.details.providersQueried[0].cityCode, '22');
    assert.deepEqual(zonePageCalls, [1, 1, 2]);
    assert.deepEqual(vehiclePageCalls, [1, 2, 1, 2]);

    const route = await client.callTool({ name: 'get_driving_route', arguments: { start: '대구 동구 동대구로 550', goal: '대구 동구 동촌로 1' } });
    assert.equal(route.structuredContent.status, 'ok');
    assert.equal(route.structuredContent.details.summary.distanceMeters, 12000);
    assert.equal(route.structuredContent.details.guidance[0].instruction, '목적지 방향으로 이동');
    assert.equal(requests.find(url => url.pathname.includes('map-direction')).searchParams.get('start'), '128.6284,35.8794');
    assert.equal(JSON.stringify(route.structuredContent).includes('test-secret'), false);
  } finally {
    await client.close();
    await server.close();
    if (previous.id === undefined) delete process.env.NAVER_MAPS_CLIENT_ID; else process.env.NAVER_MAPS_CLIENT_ID = previous.id;
    if (previous.secret === undefined) delete process.env.NAVER_MAPS_CLIENT_SECRET; else process.env.NAVER_MAPS_CLIENT_SECRET = previous.secret;
    globalThis.fetch = previous.fetch;
  }
});
