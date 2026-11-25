import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import { createStdioHarness } from '../test-support/stdio-harness.js';

test('2026-07-28 stdio wire includes required discovery, result, cache and error fields', async () => {
  const { transport, notifications } = createStdioHarness();
  const client = new Client({ name: 'wire-audit', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
  const meta = {
    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientInfo': { name: 'wire-audit', version: '1.0.0' },
    'io.modelcontextprotocol/clientCapabilities': {},
  };
  const request = (method, params = {}, metadata = {}) =>
    transport.requestRaw(method, { ...params, _meta: { ...meta, ...metadata } });

  try {
    await client.connect(transport);
    const discovery = client.getDiscoverResult();
    assert.ok(discovery.supportedVersions.includes('2026-07-28'));
    assert.equal(discovery._meta['io.modelcontextprotocol/serverInfo'].name, 'mobikorea-mcp');
    assert.equal(discovery.ttlMs, 3600000);
    assert.equal(discovery.cacheScope, 'public');
    assert.ok(discovery.capabilities.tools);
    assert.ok(discovery.capabilities.resources);
    assert.ok(discovery.capabilities.prompts);

    for (const [method, field, count] of [
      ['tools/list', 'tools', 51],
      ['resources/list', 'resources', 14],
      ['resources/templates/list', 'resourceTemplates', 1],
      ['prompts/list', 'prompts', 1],
    ]) {
      const response = await request(method);
      assert.equal(response.result.resultType, 'complete', method);
      assert.equal(response.result[field].length, count, method);
      assert.equal(response.result.ttlMs, 3600000, method);
      assert.equal(response.result.cacheScope, 'public', method);
    }

    const catalog = await request('resources/read', { uri: 'tago://catalog/services' });
    assert.equal(catalog.result.resultType, 'complete');
    assert.equal(catalog.result.ttlMs, 3600000);
    assert.equal(catalog.result.cacheScope, 'public');
    assert.equal(JSON.parse(catalog.result.contents[0].text).services.length, 13);

    const unknown = await request('resources/read', { uri: 'tago://catalog/services/unknown' });
    assert.equal(unknown.error.code, -32602);

    const tool = await request('tools/call', { name: 'list_bus_cities', arguments: {} });
    assert.equal(tool.result.resultType, 'complete');
    assert.equal(tool.result.isError, true);
    assert.equal(JSON.parse(tool.result.content[0].text).code, 'MISSING_KEY');
    assert.equal(notifications.filter(note => note.method === 'notifications/message').length, 0,
      'modern requests without logLevel must not receive log notifications');

    const logged = await request('tools/call', { name: 'list_bus_cities', arguments: {} },
      { 'io.modelcontextprotocol/logLevel': 'info' });
    assert.equal(logged.result.isError, true);
    assert.equal(notifications.filter(note => note.method === 'notifications/message').length, 1);
  } finally {
    await client.close();
  }
});
