import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const serverPath = fileURLToPath(new URL('../../dist/server.js', import.meta.url));

function connect(mode) {
  const client = new Client(
    { name: 'mobikorea-stdio-e2e', version: '1.0.0' },
    { versionNegotiation: { mode } },
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: {
      ...process.env,
      TAGO_SERVICE_KEY: '',
      NAVER_MAPS_CLIENT_ID: '',
      NAVER_MAPS_CLIENT_SECRET: '',
    },
    stderr: 'pipe',
  });
  return { client, transport };
}

test('real stdio subprocess negotiates modern MCP and serves tools', { timeout: 20_000 }, async () => {
  const { client, transport } = connect('auto');
  try {
    await client.connect(transport, { timeout: 10_000 });
    assert.equal(client.getProtocolEra(), 'modern');
    assert.equal(client.getNegotiatedProtocolVersion(), '2026-07-28');
    assert.equal(client.getDiscoverResult()?.ttlMs, 3600000);
    const { tools } = await client.listTools();
    assert.equal(tools.length, 51);
    const result = await client.callTool({ name: 'list_bus_cities', arguments: {} });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /MISSING_KEY/);
  } finally {
    await client.close();
  }
});

test('real stdio subprocess still serves legacy MCP clients', { timeout: 20_000 }, async () => {
  const { client, transport } = connect('legacy');
  try {
    await client.connect(transport, { timeout: 10_000 });
    assert.equal(client.getProtocolEra(), 'legacy');
    assert.ok(client.getNegotiatedProtocolVersion());
    const { tools } = await client.listTools();
    assert.equal(tools.length, 51);
  } finally {
    await client.close();
  }
});

test('stdio server exits cleanly after the client closes stdin', { timeout: 12_000 }, async t => {
  const child = spawn(process.execPath, [serverPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      TAGO_SERVICE_KEY: '',
      NAVER_MAPS_CLIENT_ID: '',
      NAVER_MAPS_CLIENT_SECRET: '',
    },
  });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  child.stdout.setEncoding('utf8');
  let buffer = '';
  const response = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('initialize timed out')), 8_000);
    child.stdout.on('data', chunk => {
      buffer += chunk;
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      clearTimeout(timer);
      try { resolve(JSON.parse(buffer.slice(0, end))); }
      catch (error) { reject(error); }
    });
    child.stdout.on('error', error => { clearTimeout(timer); reject(error); });
  });
  const exited = new Promise((resolve, reject) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
    child.once('error', reject);
  });
  child.stdin.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'stdio-eof-test', version: '1.0.0' },
    },
  })}\n`);
  const initialized = await response;
  assert.equal(initialized.result.serverInfo.name, 'mobikorea-mcp');
  child.stdin.end('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  const exit = await exited;
  assert.deepEqual(exit, { code: 0, signal: null });
});
