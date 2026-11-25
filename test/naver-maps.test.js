import test from 'node:test';
import assert from 'node:assert/strict';
import { directions5, geocodeAddress, mapMarkerLabel, NaverMapsError, reverseGeocodeCoordinates, staticMap } from '../dist/naver-maps.js';

function withMapsCredentials(run) {
  const previous = { id: process.env.NAVER_MAPS_CLIENT_ID, secret: process.env.NAVER_MAPS_CLIENT_SECRET };
  process.env.NAVER_MAPS_CLIENT_ID = 'test-id';
  process.env.NAVER_MAPS_CLIENT_SECRET = 'test-secret';
  return Promise.resolve().then(run).finally(() => {
    if (previous.id === undefined) delete process.env.NAVER_MAPS_CLIENT_ID; else process.env.NAVER_MAPS_CLIENT_ID = previous.id;
    if (previous.secret === undefined) delete process.env.NAVER_MAPS_CLIENT_SECRET; else process.env.NAVER_MAPS_CLIENT_SECRET = previous.secret;
  });
}

test('maps HTTP status and network failures map to stable error codes', () => withMapsCredentials(async () => {
  for (const [status, code] of [[401, 'MAPS_FORBIDDEN'], [403, 'MAPS_FORBIDDEN'], [429, 'MAPS_QUOTA'], [503, 'MAPS_UPSTREAM'], [400, 'MAPS_BAD_REQUEST']]) {
    await assert.rejects(
      geocodeAddress('서울역', undefined, async () => new Response('', { status })),
      error => error instanceof NaverMapsError && error.code === code,
    );
  }
  await assert.rejects(
    geocodeAddress('서울역', undefined, async () => { throw new Error('offline'); }),
    error => error instanceof NaverMapsError && error.code === 'MAPS_NETWORK_ERROR' && error.retryable,
  );
}));

test('maps rejects invalid payloads and reports missing reverse-geocode results', () => withMapsCredentials(async () => {
  await assert.rejects(geocodeAddress('서울역', undefined, async () => new Response('{bad json')),
    error => error.code === 'MAPS_INVALID_RESPONSE');
  await assert.rejects(reverseGeocodeCoordinates({ latitude: 37.5, longitude: 127 }, undefined,
    async () => new Response('{bad json')),
  error => error.code === 'MAPS_INVALID_RESPONSE');
  await assert.rejects(geocodeAddress('서울역', undefined, async () => Response.json({ status: 'ERROR', addresses: [] })),
    error => error.code === 'MAPS_INVALID_RESPONSE');
  const addresses = await geocodeAddress('서울역', undefined, async () => Response.json({ status: 'OK', addresses: [
    { roadAddress: 'A', x: '127', y: '37' },
    { roadAddress: 'duplicate', x: '127', y: '37' },
    { roadAddress: 'invalid', x: 'not-a-coordinate', y: '37' },
  ] }));
  assert.equal(addresses.length, 1);
  assert.equal(addresses[0].roadAddress, 'duplicate');
  assert.equal(await reverseGeocodeCoordinates({ latitude: 37.5, longitude: 127 }, undefined,
    async () => Response.json({ status: { code: 1 }, results: [] })), null);
  await assert.rejects(directions5({ start: { latitude: 37, longitude: 127 }, goal: { latitude: 38, longitude: 128 } }, undefined,
    async () => new Response('{bad json')),
  error => error.code === 'MAPS_INVALID_RESPONSE');
  await assert.rejects(directions5({ start: { latitude: 37, longitude: 127 }, goal: { latitude: 38, longitude: 128 } }, undefined,
    async () => Response.json({ code: 0, route: {} })),
  error => error.code === 'ROUTE_NOT_FOUND');
}));

test('map marker labels stay within the supported range', () => {
  assert.equal(mapMarkerLabel(0), '1');
  assert.equal(mapMarkerLabel(8), '9');
  assert.equal(mapMarkerLabel(9), 'b');
  assert.equal(mapMarkerLabel(33), 'z');
  assert.throws(() => mapMarkerLabel(-1), RangeError);
  assert.throws(() => mapMarkerLabel(34), RangeError);
});

test('static maps reject invalid and empty image responses', () => withMapsCredentials(async () => {
  await assert.rejects(staticMap({ latitude: 37, longitude: 127 }, Array.from({ length: 21 }, (_, index) => ({ latitude: 37, longitude: 127, label: String(index) }))),
    error => error.code === 'MAP_MARKER_LIMIT');
  await assert.rejects(staticMap({ latitude: 37, longitude: 127 }, [], undefined,
    async () => new Response('not an image', { headers: { 'content-type': 'text/plain' } })),
  error => error.code === 'MAPS_INVALID_IMAGE');
  await assert.rejects(staticMap({ latitude: 37, longitude: 127 }, [], undefined,
    async () => new Response(new ReadableStream({ start(controller) { controller.close(); } }), { headers: { 'content-type': 'image/png' } })),
  error => error.code === 'MAPS_INVALID_IMAGE');
}));

test('driving route exposes the upstream departure time without mislabeling it as arrival', async () => {
  const previous = { id: process.env.NAVER_MAPS_CLIENT_ID, secret: process.env.NAVER_MAPS_CLIENT_SECRET };
  process.env.NAVER_MAPS_CLIENT_ID = 'test-id';
  process.env.NAVER_MAPS_CLIENT_SECRET = 'test-secret';
  try {
    const route = await directions5({ start: { latitude: 35, longitude: 128 }, goal: { latitude: 36, longitude: 129 } }, undefined, async () => Response.json({
      code: 0,
      currentDateTime: '2026-11-25T12:00:00',
      route: { traoptimal: [{ summary: { distance: 1000, duration: 900000, departureTime: '2026-11-25T12:00:00' } }] },
    }));
    assert.equal(route.summary.departureTime, '2026-11-25T12:00:00');
    assert.equal('estimatedArrival' in route.summary, false);
  } finally {
    if (previous.id === undefined) delete process.env.NAVER_MAPS_CLIENT_ID; else process.env.NAVER_MAPS_CLIENT_ID = previous.id;
    if (previous.secret === undefined) delete process.env.NAVER_MAPS_CLIENT_SECRET; else process.env.NAVER_MAPS_CLIENT_SECRET = previous.secret;
  }
});

test('static map cancels an oversized stream as soon as it exceeds the body limit', async () => {
  const previous = { id: process.env.NAVER_MAPS_CLIENT_ID, secret: process.env.NAVER_MAPS_CLIENT_SECRET };
  process.env.NAVER_MAPS_CLIENT_ID = 'test-id';
  process.env.NAVER_MAPS_CLIENT_SECRET = 'test-secret';
  let cancelled = false;
  try {
    await assert.rejects(staticMap({ latitude: 35, longitude: 128 }, [], undefined, async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(4_000_001)); },
      cancel() { cancelled = true; },
    }), { headers: { 'content-type': 'image/png' } })), error => error.code === 'IMAGE_TOO_LARGE');
    assert.equal(cancelled, true);
  } finally {
    if (previous.id === undefined) delete process.env.NAVER_MAPS_CLIENT_ID; else process.env.NAVER_MAPS_CLIENT_ID = previous.id;
    if (previous.secret === undefined) delete process.env.NAVER_MAPS_CLIENT_SECRET; else process.env.NAVER_MAPS_CLIENT_SECRET = previous.secret;
  }
});
