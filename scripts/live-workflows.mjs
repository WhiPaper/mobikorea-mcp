// Run with TAGO_SERVICE_KEY set. Prints only statuses, counts and resolved public IDs.
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { fileURLToPath } from 'node:url';

const client = new Client({ name: 'tago-workflow-check', version: '0.5.0' }, { versionNegotiation: { mode: 'auto' } });
const transport = new StdioClientTransport({ command: process.execPath,
  args: [fileURLToPath(new URL('../dist/server.js', import.meta.url))], env: { ...process.env } });
const cases = [
  ['bus_arrivals_by_stop_name', { cityName: '대구광역시', stopName: '동대구역' }],
  ['train_departures_by_station_name', { departureCity: '서울', departureStation: '서울', arrivalCity: '대구', arrivalStation: '동대구', date: '20261125' }],
  ['domestic_flights_by_airport_name', { departureAirport: '김포', arrivalAirport: '제주', date: '20261125' }],
];
try {
  await client.connect(transport);
  for (const [name, args] of cases) {
    const result = await client.callTool({ name, arguments: args });
    const value = result.structuredContent ?? JSON.parse(result.content[0].text);
    console.log(JSON.stringify({ name, isError: Boolean(result.isError), status: value.status,
      stage: value.stage, code: value.code, message: value.message, candidateCount: value.candidates?.length,
      resolved: value.resolved, count: value.data?.totalCount }));
  }
} finally { await client.close(); }
