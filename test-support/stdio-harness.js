import { PassThrough } from 'node:stream';
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { createServer } from '../dist/server.js';

export function createStdioHarness() {
  const previousEnv = Object.fromEntries(
    ['TAGO_SERVICE_KEY', 'NAVER_MAPS_CLIENT_ID', 'NAVER_MAPS_CLIENT_SECRET']
      .map(key => [key, process.env[key]]),
  );
  process.env.TAGO_SERVICE_KEY = '';
  delete process.env.NAVER_MAPS_CLIENT_ID;
  delete process.env.NAVER_MAPS_CLIENT_SECRET;
  const requests = new PassThrough();
  const responses = new PassThrough();
  const handle = serveStdio(
    () => createServer(),
    { transport: new StdioServerTransport(requests, responses) },
  );
  let buffer = '';
  const pending = new Map();
  const notifications = [];
  let nextId = 0;
  const transport = {
    onclose: undefined,
    onerror: undefined,
    onmessage: undefined,
    async start() {
      responses.setEncoding('utf8');
      responses.on('data', chunk => {
        buffer += chunk;
        for (let end = buffer.indexOf('\n'); end !== -1; end = buffer.indexOf('\n')) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          try {
            const message = JSON.parse(line);
            if (message.method) notifications.push(message);
            if (pending.has(message.id)) {
              const resolve = pending.get(message.id);
              pending.delete(message.id);
              resolve(message);
            } else {
              transport.onmessage?.(message);
            }
          } catch (error) {
            transport.onerror?.(error);
          }
        }
      });
      responses.on('error', error => transport.onerror?.(error));
      responses.on('end', () => transport.onclose?.());
    },
    async send(message) {
      requests.write(`${JSON.stringify(message)}\n`);
    },
    requestRaw(method, params = {}) {
      const id = `raw-${++nextId}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${method} timed out`));
        }, 3000);
        pending.set(id, message => {
          clearTimeout(timer);
          resolve(message);
        });
        requests.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    },
    async close() {
      requests.end();
      await handle.close();
      for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
    setProtocolVersion() {},
  };
  return { transport, notifications, close: () => transport.close() };
}
