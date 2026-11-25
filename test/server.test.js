import test from 'node:test';
import assert from 'node:assert/strict';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { createServer } from '../dist/server.js';
import { TagoError } from '../dist/tago.js';
import { EXTRA_TOOLS } from '../dist/extra.js';

test('MCP handshake, capabilities, tool metadata, resources, prompts, completions, logging and errors', async () => {
  const calls = [];
  const logs = [];
  const server = createServer(async (name, args) => {
    calls.push({ name, args });
    if (name === 'get_bus_arrivals') throw new TagoError('22', 'Daily quota exceeded', false);
    return {
      items: [{ citycode: '22', cityname: '대구광역시' }],
      totalCount: 1,
      observedAt: '2026-11-25T00:00:00.000Z',
      sourceService: 'stop',
      sourceUrl: 'https://apis.data.go.kr/example',
      catalogUrl: 'https://www.data.go.kr/example',
    };
  });
  const client = new Client({ name: 'tago-test', version: '0.2.0' });
  client.setNotificationHandler('notifications/message', note => {
    logs.push(note.params);
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const caps = client.getServerCapabilities();
    assert.ok(caps?.tools);
    assert.ok(caps?.resources);
    assert.ok(caps?.prompts);
    assert.ok(caps?.completions);
    assert.ok(caps?.logging);
    assert.match(client.getInstructions() ?? '', /purpose-oriented workflows/);

    const { tools } = await client.listTools();
    assert.equal(tools.length, 51);
    assert.equal(new Set(tools.map(tool => tool.name)).size, 51);
    for (const tool of tools) {
      assert.ok(tool.name.length <= 64, `${tool.name} <= 64 chars`);
      assert.ok(tool.title && tool.description, `${tool.name} has title and description`);
      assert.ok(!tool.description.includes('Read TAGO '), `${tool.name} has specific description`);
      assert.ok(tool.inputSchema && tool.outputSchema, `${tool.name} has schemas`);
      assert.deepEqual(tool.annotations, {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      }, `${tool.name} annotations`);
      for (const [param, schema] of Object.entries(tool.inputSchema.properties ?? {})) {
        assert.ok(schema.description && schema.description.length > 5, `${tool.name}.${param} has description`);
      }
    }

    const listCities = tools.find(tool => tool.name === 'list_bus_cities');
    assert.equal(listCities?.inputSchema?.additionalProperties, false);

    for (const expected of EXTRA_TOOLS) {
      const actual = tools.find(tool => tool.name === expected.name);
      assert.ok(actual, `${expected.name} is registered`);
      assert.deepEqual(actual.inputSchema.required ?? [], expected.required, `${expected.name} required arguments`);
      for (const name of [...expected.required, ...(expected.optional ?? []), 'page', 'pageSize']) {
        assert.ok(actual.inputSchema.properties[name], `${expected.name} exposes ${name}`);
      }
    }
    const pmVehicles = tools.find(tool => tool.name === 'list_pm_vehicles');
    assert.deepEqual(pmVehicles?.inputSchema?.required, ['providerName', 'cityCode']);

    await client.setLoggingLevel('info');
    const success = await client.callTool({ name: 'list_bus_cities', arguments: {} });
    assert.equal(success.structuredContent.items[0].citycode, '22');
    assert.equal(calls[0].name, 'list_bus_cities');

    const failure = await client.callTool({ name: 'get_bus_arrivals', arguments: { cityCode: '22', nodeId: 'A' } });
    assert.equal(failure.isError, true);
    const parsedErr = JSON.parse(failure.content[0].text);
    assert.equal(parsedErr.code, '22');
    assert.match(parsedErr.message, /Daily quota exceeded/);
    assert.ok(parsedErr.hint);
    assert.ok(logs.some(entry => entry.data?.operation === 'list_bus_cities' && entry.data?.status === 'ok'));
    assert.ok(logs.some(entry => entry.data?.operation === 'get_bus_arrivals' && entry.data?.code === '22'));

    const { resources } = await client.listResources();
    assert.equal(resources.length, 14);
    const { resourceTemplates } = await client.listResourceTemplates();
    assert.equal(resourceTemplates[0].uriTemplate, 'tago://catalog/services/{service}');
    const catalog = await client.readResource({ uri: 'tago://catalog/services' });
    const catalogData = JSON.parse(catalog.contents[0].text);
    assert.equal(catalogData.services.length, 13);
    const workflowTools = catalogData.toolRouting.workflowsByPurpose.flatMap(group => group.tools);
    assert.ok(workflowTools.includes('get_bus_route_status'));
    assert.ok(workflowTools.includes('find_intercity_departures_by_terminal_name'));
    assert.ok(workflowTools.every(name => tools.some(tool => tool.name === name)), 'purpose catalog only lists registered workflows');
    assert.equal(catalogData.toolRouting.lowLevelToolsByService.reduce((count, group) => count + group.tools.length, 0), 45);
    const pmRes = await client.readResource({ uri: 'tago://catalog/services/personalMobility' });
    assert.equal(JSON.parse(pmRes.contents[0].text).tools.length, 2);
    await assert.rejects(() => client.readResource({ uri: 'tago://catalog/services/unknown' }), /-32602|Unknown TAGO service/);

    const { prompts } = await client.listPrompts();
    assert.equal(prompts[0].name, 'tago_transit_lookup');
    const promptRes = await client.getPrompt({ name: 'tago_transit_lookup', arguments: { mode: 'train', query: '동대구 -> 서울' } });
    assert.match(promptRes.messages[0].content.text, /동대구 -> 서울/);

    const promptComp = await client.complete({
      ref: { type: 'ref/prompt', name: 'tago_transit_lookup' },
      argument: { name: 'mode', value: 'tr' },
    });
    assert.deepEqual(promptComp.completion.values, ['train']);

    const resourceComp = await client.complete({
      ref: { type: 'ref/resource', uri: 'tago://catalog/services/{service}' },
      argument: { name: 'service', value: 'express' },
    });
    assert.deepEqual(resourceComp.completion.values, ['expressArrival', 'express']);
  } finally {
    await client.close();
    await server.close();
  }
});
