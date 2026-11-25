import { McpServer, completable } from '@modelcontextprotocol/server';
import { z } from 'zod';

const TRANSIT_MODES = Object.freeze([
  'city-bus', 'express-bus', 'intercity-bus', 'train', 'subway',
  'flight', 'ship', 'car-sharing', 'personal-mobility',
]);

export function registerPrompts(server: McpServer) {

  server.registerPrompt(
    'tago_transit_lookup',
    {
      title: 'TAGO transit lookup workflow',
      description: 'Build a structured lookup request using TAGO tools for a Korean public transit mode.',
      argsSchema: {
        mode: completable(
          z.string().describe('Transit mode (city-bus, express-bus, intercity-bus, train, subway, flight, ship, car-sharing, personal-mobility)'),
          value => TRANSIT_MODES.filter(item => item.startsWith(value.toLowerCase())),
        ),
        query: z.string().describe('Origin, destination, station, stop, or region to look up'),
      },
    },
    ({ mode, query }) => ({
      description: `Lookup guide for ${mode}`,
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: `Look up Korean public transit (${mode}) information for: ${query}\nUse the TAGO lookup tools first to resolve official IDs (city, stop, route, terminal, station, airport, port, or provider) before calling schedule or live arrival tools, and report observedAt and empty results accurately.`,
        },
      }],
    }),
  );

}
