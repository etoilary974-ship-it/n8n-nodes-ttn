# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Data and gateway operations no longer duplicate output when the workflow passes multiple input items (e.g. **List Applications**, **Get Gateway Status**).
- Gateway **uptime** is computed again when `connected_at` is missing but the gateway is online (fallback to latest activity after `disconnected_at`; supports protobuf timestamps).

### Changed

- Harmonized legacy node display names: `TTN: Downlink (legacy)`, `TTN: Uplink Trigger (legacy)`.
- Translated remaining French comments and UI strings to English.
- Filled documentation URLs in `ttn.node.json`.
- Downlink handling simplified to **push only** via `ttnExecuteDownlinkPush` (main TTN node and legacy downlink node).
- Data and gateway operations always run once per execution (only **Devices · Send Downlink** may run per input item).

### Removed

- Send Downlink command preview notice from the main TTN node.
- `ttnExecuteDownlinkQueue` and **Replace Queue** / **Clear Queue** options from the legacy downlink node.
- `README_TEMPLATE.md`, unused icons (`TheThingsNetwork-logo-vector`, `github`), `.prettierrc.js`.
- Legacy `webhookPayloadOutput` branch in `ttnWebhookOutputMapper.ts`.

## [0.2.0] - 2026-06-07

### Added

- Unified operation labels in the node picker and subtitle (e.g. `Data · Get Last Uplink`, `Devices · Send Downlink`).
- Dynamic downlink preview notice when configuring **Devices · Send Downlink**.
- Hidden `Event` field on **TTN Trigger** so it appears correctly under **TTN → Triggers** in the node picker (versions 2.2–2.4).
- `dev`, `lint`, `lint:fix`, and `release` scripts via `@n8n/node-cli`.
- ESLint setup (`eslint-plugin-n8n-nodes-base`, `typescript-eslint`).
- Node.js `>=22.0.0` engine requirement.

### Changed

- Renamed the webhook trigger from **Receive Sensor Data** to **Webhook · Receive Events**.
- Standardized UI labels to Title Case and renamed ID fields to **Name or ID** with expression links.
- Renamed status mode **Online / Offline** to **Summary**, with richer output (`last_seen`, `uptime`, `since_last_uplink`).
- Aligned the deprecated downlink node with TTS terminology (Hex/JSON payload types, default priority `NORMAL`).
- Replaced static Storage/Downlink notice fields with the dynamic send-command preview.
- Set `n8n.strict` to `false` for community linter compatibility.
- CI workflows updated to run on Node 22.

### Removed

- Unused `xml2js` dependency.

## [0.1.0] - 2026-06-07

First release of **n8n-nodes-ttn** — an n8n community node package for [The Things Stack](https://www.thethingsindustries.com/) (TTN / TTS).

### Added

#### Credentials

- **The Things Stack API** (`ttnApi`): server URL, Application Server API key (Bearer), credential test via `GET /api/v3/applications`.

#### Nodes

- **TTN** — unified main node with **Data**, **Devices**, and **Gateways** resources:
  - **Get Last Uplink**: Storage stream (`text/event-stream`) with `last` window, application or device scope, configurable output shapes.
  - **List Devices** / **Get Device Info** / **Get Device Status**: list, details, and online/offline status (configurable threshold).
  - **List Applications**: list applications visible to the API key.
  - **Send Command (Downlink)**: push downlink to the device queue.
  - **List Gateways**: list by scope (all, user, organization) with summary or detailed mode and optional location.
  - **Get Gateway Status**: last activity and online/offline status.
  - Dynamic dropdowns for applications, devices, and gateways.
  - Enriched TTS API error messages (gRPC codes, actionable guidance).

- **TTN Trigger** — webhook trigger **Receive Sensor Data**:
  - Real-time TTS events (uplink, join, downlink, location, etc.).
  - Filter by application and allowed devices.
  - Output formats: Sensor Data, Sensor Values Only, Event Summary, Full Event.
  - Configurable behavior when the event type does not match (skip or run with full JSON).

- **TTN Uplink Trigger** — dedicated uplink webhook variant (kept for existing workflows).

- **TTN: Downlink (deprecated)** — hidden from the node picker, kept for backward compatibility.

#### Tooling & CI

- GitHub Actions workflows for CI (build) and npm publishing with OIDC provenance.
- Custom build and deploy scripts (`scripts/build-package.cjs`, `scripts/deploy.cjs`).

[Unreleased]: https://github.com/etoilary974-ship-it/TTN_Node/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/etoilary974-ship-it/TTN_Node/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/etoilary974-ship-it/TTN_Node/releases/tag/v0.1.0
