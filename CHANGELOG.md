# Changelog

Notable changes to this project are documented here.

## [0.1.1] - 2026-11-26

### Fixed

- Start the MCP server when launched through npm's executable symlink.

## [0.1.0] - 2026-11-25

### Added

- Purpose-oriented workflows for bus arrivals, route status, subway stations,
  intercity departures, nearby stops and mobility, and driving directions.
- Optional NAVER Cloud Maps support for address search, nearby results, maps,
  and driving routes.
- MCP resources, prompts, source provenance, and structured workflow results.
- Automated tests for TAGO, Maps, workflows, MCP protocol, and stdio behavior.

### Security

- API credentials are read from environment variables and are not included in
  normal tool results.
