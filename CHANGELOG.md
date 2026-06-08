# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-06-08

First public release of [`@loewencreville/n8n-nodes-ttn`](https://www.npmjs.com/package/@loewencreville/n8n-nodes-ttn) — n8n community nodes for [The Things Stack](https://www.thethingsindustries.com/) (TTN / TTS).

### Added

#### Credentials

- **The Things Stack API** (`ttnApi`): server URL, Application Server API key (Bearer), credential test via `GET /api/v3/applications`.

#### Nodes

- **TTN** — unified main node with **Data**, **Devices**, and **Gateways** resources:
  - **Get Last Uplink** — Storage stream with configurable `last` window, scope, and output shapes.
  - **List Devices** / **Get Device Info** / **Get Device Status** — registry access and online/offline status.
  - **List Applications** — applications visible to the API key.
  - **Send Downlink** — push downlink to the device queue.
  - **List Gateways** / **Get Gateway Status** — gateway list and connection stats with uptime.
  - Dynamic dropdowns for applications, devices, and gateways.
  - Enriched TTS API error messages (gRPC codes, actionable guidance).

- **TTN Trigger** — **Webhook · Receive Events** for real-time TTS webhooks (uplink, join, downlink, location, etc.) with application/device filters and configurable output formats.

- **TTN: Uplink Trigger (legacy)** and **TTN: Downlink (legacy)** — hidden from the picker, kept for backward compatibility.

#### Tooling

- GitHub Actions CI (lint + build on Node 22) and npm publish workflow with OIDC provenance.
- `@n8n/node-cli` scripts: `dev`, `lint`, `release`.
- Project README with TTS documentation links.

### Changed

- Package published as `@loewencreville/n8n-nodes-ttn` (public npm).
- Unified operation labels (e.g. `Data · Get Last Uplink`, `Devices · Send Downlink`).
- Legacy node display names harmonized (`TTN: … (legacy)`).
- Downlink handling simplified to **push only** on main and legacy nodes.
- Data and gateway operations run once per execution (no duplicate items on multi-input workflows).

### Fixed

- **List Applications** and **Get Gateway Status** no longer duplicate output when multiple input items are passed.
- Gateway **uptime** computed when `connected_at` is missing but the gateway is online (protobuf timestamp support).

### Removed

- Send Downlink command preview notice.
- Legacy downlink **Replace Queue** / **Clear Queue** options.
- Unused assets (`README_TEMPLATE.md`, extra icons, `.prettierrc.js`) and dead webhook mapper code.

[1.0.0]: https://github.com/etoilary974-ship-it/TTN_Node/releases/tag/1.0.0
