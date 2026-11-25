#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { callTago } from './tago.js';
import { registerTools } from './tools.js';
import { registerResources } from './resources.js';
import { registerPrompts } from './prompts.js';

const SERVER_INSTRUCTIONS = [
  'TAGO MCP provides purpose-oriented workflows and low-level read-only tools across 13 data.go.kr services. Route by user task first: use arrival workflows for live bus predictions; schedule workflows for train, flight, express, and intercity departures; network/station workflows for current bus route locations or subway station information; nearby workflows for stops and shared mobility; and driving workflows for car routes. Then use low-level tools grouped by transport service when the user needs a specific endpoint or already has its IDs. Read tago://catalog/services for workflow-to-purpose and low-level service groupings. Maps-backed workflows are available only when NAVER_MAPS_CLIENT_ID and NAVER_MAPS_CLIENT_SECRET are configured.',
  'Never guess internal IDs (cityCode, nodeId, routeId, depTerminalId, depTmnCd, depPlaceId, subwayStationId, depAirportId, depNodeId, providerName). Fetch them from the matching city, stop, route, terminal, station, airport, port, or provider list tool first.',
  'observedAt is the query timestamp rather than upstream vehicle telemetry freshness. An empty items array with totalCount 0 is a valid result when no services or vehicles match.',
].join(' ');

export function createServer(call: typeof callTago = callTago) {
  const server = new McpServer(
    { name: 'mobikorea-mcp', version: '0.1.0' },
    {
      instructions: SERVER_INSTRUCTIONS,
      capabilities: { logging: {} },
      cacheHints: {
        'server/discover': { ttlMs: 3600000, cacheScope: 'public' },
        'tools/list': { ttlMs: 3600000, cacheScope: 'public' },
        'prompts/list': { ttlMs: 3600000, cacheScope: 'public' },
        'resources/list': { ttlMs: 3600000, cacheScope: 'public' },
        'resources/templates/list': { ttlMs: 3600000, cacheScope: 'public' },
        'resources/read': { ttlMs: 3600000, cacheScope: 'public' },
      },
    },
  );

  registerTools(server, call);
  registerResources(server);
  registerPrompts(server);
  return server;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    serveStdio(() => createServer());
  } catch {
    process.stderr.write('Failed to start TAGO MCP server\n');
    process.exitCode = 1;
  }
}
