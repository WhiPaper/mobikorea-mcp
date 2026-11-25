# MobiKorea MCP

[![CI](https://github.com/WhiPaper/mobikorea-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/WhiPaper/mobikorea-mcp/actions/workflows/ci.yml)

MobiKorea MCP is released under the [MIT License](LICENSE). See the
[changelog](CHANGELOG.md), [contributing guide](CONTRIBUTING.md), and
[security policy](SECURITY.md).

MobiKorea connects an MCP-compatible AI assistant to public transportation and mobility information in South Korea. It can look up bus arrivals, schedules, stations, routes, nearby shared mobility, and driving directions.

The server runs locally and communicates with your MCP host over standard input and output. Public transit data comes from the Korean Ministry of Land, Infrastructure and Transport's TAGO services. Optional address search, map images, and driving directions use NAVER Cloud Maps.

## What you can ask

Examples:

- “When will the next bus arrive at Dongdaegu Station?”
- “Show the current status of bus route 401 in Daegu.”
- “What facilities and bus routes serve this subway station?”
- “Find express or intercity buses between these terminals.”
- “Find bus stops near this address.”
- “What shared mobility services are near this address?”
- “Give me driving directions between these addresses.”

The assistant can also look up trains, domestic flights, ships, bus stops, routes, airports, ports, car-sharing zones, and personal mobility vehicles. A compatible assistant may show a map image when the host supports MCP image results.

## Before you start

- Node.js 20 or newer and npm
- A TAGO service key from [data.go.kr](https://www.data.go.kr/). Each TAGO service may require its own usage application and approval.
- Optional: a current NAVER Cloud **Maps** application with Geocoding, Reverse Geocoding, Static Map, and Directions 5 enabled.

Maps use may incur charges depending on your account's free allowance and usage. Check the [current Maps pricing](https://www.ncloud.com/charge/price/ko) before enabling it. Use credentials from the current Maps product; legacy AI·NAVER API map credentials are not supported by the replacement service. See the [official migration notice](https://www.ncloud.com/support/notice/all/2200).

## Install and run

After the package is published, run it directly with `npx`:

```sh
npx -y mobikorea-mcp
```

For local development, clone this project and run these commands in its folder:

```sh
npm ci
npm run build
npm start
```

Copy `.env.example` to `.env` and add your TAGO key before starting the server locally. `.env` is ignored by Git.

The server needs credentials supplied by your MCP host. Do not put real keys in source files or commit them to GitHub.

## Connect an MCP host

Add a server entry to your MCP host's configuration. The exact configuration file and restart steps depend on the host.

```json
{
  "mcpServers": {
    "tago-transit": {
      "command": "npx",
      "args": ["-y", "mobikorea-mcp"],
      "env": {
        "TAGO_SERVICE_KEY": "set-this-in-your-host's-secret-settings",
        "NAVER_MAPS_CLIENT_ID": "optional-client-id",
        "NAVER_MAPS_CLIENT_SECRET": "optional-client-secret"
      }
    }
  }
}
```

Replace the example values with your own. Store credentials in your MCP host's secret or environment settings where possible. If you do not configure both NAVER Maps values, the Maps-based tools are not shown.

## Available information

The server includes tools for:

- City bus stops, routes, arrivals, and vehicle locations
- Express and intercity bus terminals, schedules, and arrivals
- Train stations, types, and schedules
- Subway stations, exits, facilities, and schedules
- Domestic airports, airlines, and flights
- Ports, passenger ship terminals, and domestic ship schedules
- Car-sharing zones and personal mobility providers and vehicles
- Optional address lookup, nearby bus stops and arrivals, shared mobility near an address, map images, and driving routes

When a place name is ambiguous, the assistant may show matching choices so you can specify the right one. Many detailed searches need a city, station, stop, terminal, or route identifier; the assistant can usually find it from a name first.

## What to expect

- Results reflect information returned by the source service at query time. Schedules and arrival predictions can change; they are not reservations or guarantees.
- Nearby distances are straight-line distances, not walking directions. A listed shared vehicle or zone does not guarantee that a vehicle is available to rent.
- Driving directions are for cars and are not walking or public transit directions.
- Map images are returned as MCP image content. Whether you can see them depends on image support in your MCP host.
- Missing service approval, invalid credentials, unavailable source data, or service limits can result in an error or an empty result.

## Keep your keys private

Give keys only to your MCP host's local secret or environment settings. Never add them to this repository, commit history, issue reports, or screenshots. The server reads keys at runtime and does not include them in its normal results.

## Data sources

- [TAGO public transportation services](https://www.data.go.kr/)
- [NAVER Cloud Maps documentation](https://guide.ncloud-docs.com/docs/maps-overview)
