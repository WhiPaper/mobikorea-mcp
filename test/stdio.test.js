import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import { createStdioHarness } from '../test-support/stdio-harness.js';

test('stdio transport initializes, exposes primitives, and keeps the wire clean', async () => {
  const client = new Client(
    { name: 'stdio-smoke-test', version: '0.4.1' },
    { versionNegotiation: { mode: 'auto' } },
  );
  const { transport } = createStdioHarness();
  try {
    await client.connect(transport);
    assert.equal(client.getProtocolEra(), 'modern');
    assert.equal(client.getNegotiatedProtocolVersion(), '2026-07-28');
    const discovery = client.getDiscoverResult();
    assert.ok(discovery?.supportedVersions.includes('2026-07-28'));
    assert.equal(discovery.ttlMs, 3600000);
    assert.equal(discovery.cacheScope, 'public');
    assert.ok(client.getInstructions());
    const { tools } = await client.listTools();
    assert.equal(tools.length, 51);
    const { resources } = await client.listResources();
    assert.equal(resources.length, 14);
    const catalog = await client.readResource({ uri: 'tago://catalog/services' });
    assert.equal(JSON.parse(catalog.contents[0].text).services.length, 13);
    await assert.rejects(() => client.readResource({ uri: 'tago://catalog/services/unknown' }), /-32602|Unknown TAGO service/);
    const { prompts } = await client.listPrompts();
    assert.equal(prompts.length, 1);
    const prompt = await client.getPrompt({ name: 'tago_transit_lookup', arguments: { mode: 'train', query: '동대구 서울' } });
    assert.match(prompt.messages[0].content.text, /동대구 서울/);
    const completion = await client.complete({
      ref: { type: 'ref/prompt', name: 'tago_transit_lookup' },
      argument: { name: 'mode', value: 'tr' },
    });
    assert.deepEqual(completion.completion.values, ['train']);
    const result = await client.callTool({ name: 'list_bus_cities', arguments: {} });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /MISSING_KEY/);
    assert.match(result.content[0].text, /TAGO_SERVICE_KEY/);
  } finally {
    await client.close();
  }
});
