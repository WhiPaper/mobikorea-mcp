import test from 'node:test';
import assert from 'node:assert/strict';
import { callTago, parseTagoResponse, TagoError } from '../dist/tago.js';
import { EXTRA_TOOLS } from '../dist/extra.js';
import { SERVICES } from '../dist/tago.js';

test('normalizes JSON and XML item shapes', () => {
  assert.deepEqual(parseTagoResponse('{"response":{"header":{"resultCode":"00"},"body":{"items":{"item":{"nodeid":"A"}},"totalCount":1}}}'), {
    items: [{ nodeid: 'A' }], totalCount: 1,
  });
  assert.deepEqual(parseTagoResponse('<response><header><resultCode>00</resultCode></header><body><items/><totalCount>0</totalCount></body></response>'), {
    items: [], totalCount: 0,
  });
  assert.deepEqual(parseTagoResponse('<response><header><resultCode>00</resultCode></header><body><items><item><terminalId>010</terminalId><nodeNo>00123</nodeNo></item></items><totalCount>1</totalCount></body></response>'), {
    items: [{ terminalId: '010', nodeNo: '00123' }], totalCount: 1,
  });
  assert.deepEqual(parseTagoResponse('{"response":{"header":{"resultCode":"00"},"body":{"items":{},"totalCount":0}}}'), {
    items: [], totalCount: 0,
  });
  assert.throws(() => parseTagoResponse('<html><body>Gateway failure</body></html>'),
    error => error instanceof TagoError && error.code === 'INVALID_RESPONSE');
});

test('maps TAGO authorization errors with recovery hints and without leaking credentials', () => {
  assert.throws(() => parseTagoResponse('<OpenAPI_ServiceResponse><cmmMsgHeader><returnReasonCode>30</returnReasonCode><errMsg>secret-key-here</errMsg></cmmMsgHeader></OpenAPI_ServiceResponse>'),
    error => error instanceof TagoError && error.code === '30' && !error.message.includes('secret-key-here') && Boolean(error.hint));
  assert.throws(() => parseTagoResponse('{"response":{"header":{"resultCode":"22","resultMsg":"quota"}}}'),
    error => error instanceof TagoError && error.code === '22' && error.retryable === false && Boolean(error.hint));
});

test('rejects oversized upstream responses before parsing', async () => {
  await assert.rejects(() => callTago('list_bus_cities', {}, {
    serviceKey: 'size-test-key', cache: false, throttle: false,
    fetchImpl: async () => new Response('x'.repeat(2_000_001)),
  }), error => error instanceof TagoError && error.code === 'RESPONSE_TOO_LARGE');
});

test('honors AbortSignal cancellation before and during fetch', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => callTago('list_bus_cities', {}, {
    serviceKey: 'abort-test-key', cache: false, throttle: false, signal: controller.signal,
  }), error => error instanceof TagoError && error.code === 'CANCELLED');
});

test('maps fetch, HTTP and response-stream failures to TAGO errors', async () => {
  await assert.rejects(() => callTago('list_bus_cities', {}, {
    serviceKey: 'network-test-key', cache: false, throttle: false,
    fetchImpl: async () => { throw new Error('offline'); },
  }), error => error instanceof TagoError && error.code === 'NETWORK_ERROR' && error.retryable);

  await assert.rejects(() => callTago('list_bus_cities', {}, {
    serviceKey: 'http-test-key', cache: false, throttle: false,
    fetchImpl: async () => new Response('gateway failure', { status: 503 }),
  }), error => error instanceof TagoError && error.code === 'HTTP_503' && error.retryable);

  await assert.rejects(() => callTago('list_bus_cities', {}, {
    serviceKey: 'body-test-key', cache: false, throttle: false,
    fetchImpl: async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error('stream failed')); } })),
  }), error => error instanceof TagoError && error.code === 'NETWORK_ERROR');
});

test('cancels a throttled request while it waits for its request slot', async () => {
  let releaseFirstFetch;
  const firstFetchStarted = new Promise(resolve => { releaseFirstFetch = resolve; });
  const first = callTago('list_bus_cities', {}, {
    serviceKey: 'throttle-first-key', cache: false,
    fetchImpl: async () => {
      releaseFirstFetch();
      return new Response('{"response":{"header":{"resultCode":"00"},"body":{"items":[],"totalCount":0}}}');
    },
  });
  await firstFetchStarted;
  const controller = new AbortController();
  const waiting = callTago('find_bus_stops', { cityCode: 22 }, {
    serviceKey: 'throttle-second-key', cache: false, signal: controller.signal,
    fetchImpl: async () => new Response('{"response":{"header":{"resultCode":"00"},"body":{"items":[],"totalCount":0}}}'),
  });
  setTimeout(() => controller.abort(), 10);
  await first;
  await assert.rejects(waiting, error => error instanceof TagoError && error.code === 'CANCELLED');
});

test('builds documented endpoint and public provenance without secret', async () => {
  let requested;
  const result = await callTago('find_bus_stops', { cityCode: '22', nodeNm: '동대구', page: 2, pageSize: 5 }, {
    serviceKey: 'private/key+value',
    fetchImpl: async url => {
      requested = new URL(url);
      return new Response(JSON.stringify({ response: { header: { resultCode: '00' }, body: { items: { item: [{ nodeid: 'A' }] }, totalCount: 1 } } }), { status: 200 });
    },
  });
  assert.equal(requested.pathname, '/1613000/BusSttnInfoInqireService/getSttnNoList');
  assert.equal(requested.searchParams.get('serviceKey'), 'private/key+value');
  assert.equal(requested.searchParams.get('cityCode'), '22');
  assert.equal(requested.searchParams.get('pageNo'), '2');
  assert.equal(result.items[0].nodeid, 'A');
  assert.ok(!JSON.stringify(result).includes('private/key+value'));
});

test('decodes portal URL-encoded keys exactly once', async () => {
  let actualKey;
  await callTago('list_bus_cities', {}, {
    serviceKey: 'abc%2Bdef%2Fghi%3D',
    fetchImpl: async url => {
      actualKey = new URL(url).searchParams.get('serviceKey');
      return new Response('{"response":{"header":{"resultCode":"00"},"body":{"items":{"item":[]},"totalCount":0}}}');
    },
  });
  assert.equal(actualKey, 'abc+def/ghi=');
  await callTago('list_bus_cities', {}, {
    serviceKey: 'abc%2F%ZZ', cache: false, throttle: false,
    fetchImpl: async url => {
      assert.equal(new URL(url).searchParams.get('serviceKey'), 'abc%2F%ZZ');
      return new Response('{"response":{"header":{"resultCode":"00"},"body":{"items":[],"totalCount":0}}}');
    },
  });
});

test('constructs every added operation URL and query without exposing its key', async () => {
  for (const tool of EXTRA_TOOLS) {
    let requested;
    const args = Object.fromEntries([...tool.required, ...(tool.optional ?? [])].map(name => [name, name === 'latitude' ? 35.8 : name === 'longitude' ? 128.6 : 'sample']));
    args.page = 2;
    args.pageSize = 3;
    const result = await callTago(tool.name, args, {
      serviceKey: 'private/key+value', cache: false, throttle: false,
      fetchImpl: async url => {
        requested = new URL(url);
        return new Response('{"response":{"header":{"resultCode":"00"},"body":{"items":{},"totalCount":0}}}');
      },
    });
    assert.equal(requested.pathname, `/1613000/${SERVICES[tool.service].base}/${tool.path}`, tool.name);
    assert.equal(requested.searchParams.get('_type'), 'json', tool.name);
    assert.equal(requested.searchParams.get('pageNo'), '2', tool.name);
    assert.equal(requested.searchParams.get('numOfRows'), '3', tool.name);
    for (const [name, value] of Object.entries(args)) {
      if (name !== 'page' && name !== 'pageSize') assert.equal(requested.searchParams.get(name), String(value), `${tool.name}: ${name}`);
    }
    assert.equal(result.sourceUrl, requested.origin + requested.pathname, tool.name);
    assert.ok(!JSON.stringify(result).includes('private/key+value'), tool.name);
  }
});

test('caches successful code lists but expires live arrivals quickly', async () => {
  const cacheStore = new Map();
  let now = 1_000_000;
  let calls = 0;
  const options = {
    serviceKey: 'cache-test-key', cacheStore, now: () => now,
    fetchImpl: async () => {
      calls++;
      return new Response('{"response":{"header":{"resultCode":"00"},"body":{"items":{"item":[]},"totalCount":0}}}');
    },
  };
  await callTago('list_bus_cities', {}, options);
  await callTago('list_bus_cities', {}, options);
  assert.equal(calls, 1);
  await callTago('get_bus_arrivals', { cityCode: 22, nodeId: 'A' }, options);
  now += 4_000;
  await callTago('get_bus_arrivals', { cityCode: 22, nodeId: 'A' }, options);
  assert.equal(calls, 2);
  now += 2_000;
  await callTago('get_bus_arrivals', { cityCode: 22, nodeId: 'A' }, options);
  assert.equal(calls, 3);
});

test('bounds the response cache by evicting its oldest entry', async () => {
  const cacheStore = new Map();
  let oldestKey;
  for (let index = 0; index < 257; index++) {
    await callTago('find_bus_stops', { cityCode: '22', nodeNm: `stop-${index}` }, {
      serviceKey: 'bounded-cache-test-key', cacheStore, throttle: false,
      fetchImpl: async () => new Response('{"response":{"header":{"resultCode":"00"},"body":{"items":[],"totalCount":0}}}'),
    });
    if (index === 0) oldestKey = cacheStore.keys().next().value;
  }
  assert.equal(cacheStore.size, 256);
  assert.equal(cacheStore.has(oldestKey), false);
});
