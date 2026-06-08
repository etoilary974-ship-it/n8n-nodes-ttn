# @loewencreville/n8n-nodes-ttn

Community [n8n](https://n8n.io/) nodes for [The Things Stack](https://www.thethingsindustries.com/) (TTS) — also known as **The Things Network (TTN)** on the public cloud.

Connect your LoRaWAN applications to n8n workflows: receive real-time uplinks via webhooks, read stored messages, send downlinks, and monitor devices and gateways through the TTS API.

## Table of contents

- [Installation](#installation)
- [Credentials](#credentials)
- [Nodes](#nodes)
  - [TTN (main node)](#ttn-main-node)
  - [TTN Trigger (webhook)](#ttn-trigger-webhook)
- [Usage examples](#usage-examples)
- [Compatibility](#compatibility)
- [Development](#development)
- [Resources](#resources)
- [Version history](#version-history)
- [License](#license)

## Installation

Follow the [n8n community nodes installation guide](https://docs.n8n.io/integrations/community-nodes/installation/).

**npm package:** [`@loewencreville/n8n-nodes-ttn`](https://www.npmjs.com/package/@loewencreville/n8n-nodes-ttn)

```bash
# In n8n: Settings → Community Nodes → Install → enter "@loewencreville/n8n-nodes-ttn"
```

For self-hosted n8n with a custom nodes folder (Docker volume, etc.):

```bash
git clone https://github.com/etoilary974-ship-it/n8n-nodes-ttn.git
cd n8n-nodes-ttn
npm install
npm run build
# Copy dist/ + package.json to your n8n custom nodes directory, then restart n8n.
# Or use: npm run deploy
```

## Credentials

### The Things Stack API (`ttnApi`)

| Field | Description |
|-------|-------------|
| **Server URL** | Base URL of your TTS deployment, **without** `/api`. Examples: `https://eu1.cloud.thethings.network`, `https://<tenant>.thethings.industries`, or your self-hosted URL. See [TTS deployments](https://www.thethingsindustries.com/docs/getting-started/cloud-hosted/). |
| **API key (Application Server)** | An **Application Server** API key (`NNSXS…` format). Sent as `Authorization: Bearer`. Must have rights for the applications, devices, and operations you use. |

**Create an API key** in the TTS console: *User settings → API keys*, or per application under *API keys*. See the official guides:

- [API authentication](https://www.thethingsindustries.com/docs/reference/api/authentication/)
- [API key rights](https://www.thethingsindustries.com/docs/reference/api/using-terraform-provider/#generate-api-key)

**Required rights by operation:**

| Operation | Typical API key rights |
|-----------|------------------------|
| List applications / devices | `applications:list`, `applications.devices:list` |
| Get device info / status | `applications.devices:get`, `applications.devices:read` |
| Send downlink | `applications.devices:downlink` |
| Storage (Get Last Uplink) | Application Server key with Storage access on the target application |
| List / status gateways | `gateways:list`, `gateways:read` (Gateway Server) |

The credential test calls `GET /api/v3/applications` to verify connectivity.

> **Storage vs webhooks:** [Storage](https://www.thethingsindustries.com/docs/integrations/storage/) reads historical uplinks from the TTS database. [Webhooks](https://www.thethingsindustries.com/docs/integrations/webhooks/) push events to n8n in real time. Enable Storage on your application in TTS if you use **Get Last Uplink**.

## Nodes

All TTN nodes share the same icon and appear grouped in the n8n node picker under **TTN**.

### TTN (main node)

Unified action node with three resources.

#### Data

| Operation | TTS API | Description |
|-----------|---------|-------------|
| **Get Last Uplink** | `GET …/packages/storage/uplink_message` | Reads the [Storage integration](https://www.thethingsindustries.com/docs/integrations/storage/) uplink stream (`Accept: text/event-stream`). One n8n item per uplink received. Requires Storage enabled on the application. |
| **List Devices** | `GET /api/v3/applications/{app}/devices` | Lists devices in an application. |
| **Get Device Info** | `GET /api/v3/applications/{app}/devices/{device}` | Full device registry object. |
| **Get Device Status** | Registry + `last_seen_at` | Online/offline status with configurable threshold. **Summary** returns `{ device_id, online, last_seen }`; **Detailed** includes timestamps and threshold settings. |
| **List Applications** | `GET /api/v3/applications` | Applications visible to the API key. |

**Get Last Uplink options:**

- **Storage scope** — single device or whole application.
- **`Last` window** — same duration format as the TTS console (`1h`, `24h`, `168h`, …). See [Storage API](https://www.thethingsindustries.com/docs/integrations/storage/).
- **Uplink output shape** — Decoded Payload + Meta, Decoded Payload only, or Full Storage record.

#### Devices

| Operation | TTS API | Description |
|-----------|---------|-------------|
| **Send Downlink** | `POST …/down/push` | Enqueues a downlink on the device queue. |

Downlink parameters match [The Things Stack downlink fields](https://www.thethingsindustries.com/docs/reference/api/application_server/#message-types):

- **FPort** (1–223)
- **Payload type** — Hex (`frm_payload`, base64-encoded by the node) or JSON (`decoded_payload`)
- **Priority** — `LOWEST` … `HIGHEST`
- **Confirmed downlink** — requires device ACK

#### Gateways

| Operation | TTS API | Description |
|-----------|---------|-------------|
| **List Gateways** | `GET /api/v3/gateways` (or per user / organization) | Scope: all gateways visible to the key, a specific user, or an organization. Optional antenna location. |
| **Get Gateway Status** | `GET /api/v3/gs/gateways/{id}/connection/stats` | Last activity, uptime, `since_last_uplink`, online/offline (configurable threshold). |

Dynamic dropdowns (applications, devices, gateways) support [n8n expressions](https://docs.n8n.io/code/expressions/) for dynamic IDs.

API errors from TTS are mapped to readable messages with gRPC codes and suggested actions.

---

### TTN Trigger (webhook)

Pick **TTN → Triggers → Webhook · Receive Events** in the node picker.

Receives real-time POST webhooks from TTS — the recommended way to react to uplinks and other events. HTTP method is fixed to **POST**.

#### TTS console setup

1. Open your application in [TTS Console](https://console.cloud.thethings.network/).
2. Go to **Integrations → Webhooks**.
3. Set **Base URL** to your n8n webhook URL (test or production).
4. Format: **JSON**. Method: **POST**.
5. Under **Enabled event types**, check the events you need (e.g. **Uplink message**).

Full guide: [TTS Webhooks integration](https://www.thethingsindustries.com/docs/integrations/webhooks/)

#### Node parameters

| Parameter | Description |
|-----------|-------------|
| **Webhook path** | Path suffix after the n8n base URL (default: `ttn-uplink`). Must match the path configured in TTS. |
| **Application (API)** | Optional filter: loads devices via API; webhook `application_id` must match when set. |
| **Allowed devices** | Optional: only matching `device_id` values start the workflow (others get HTTP 200, no run). |
| **Event type** | Uplink message, Normalized uplink, Join accept, Downlink ack/nack/sent/failed/queued, Location solved, Service data, or All. |
| **Output format** | For uplinks: Sensor Data, Sensor Values Only, Full Event. For other events: Event Summary or Full Event. |
| **When JSON does not match event type** | **Do not start workflow** (recommended) — avoids duplicate runs when TTS sends uplink + normalized payload to the same URL. |

Credentials are optional on the trigger (only needed for the application/device filter dropdowns).

> **Legacy nodes:** `TTN: Uplink Trigger (legacy)` and `TTN: Downlink (legacy)` remain installed for backward compatibility but are hidden from the picker. New workflows should use **TTN** and **TTN Trigger**.

## Usage examples

### Real-time sensor data (webhook)

```
TTN Trigger (Webhook · Receive Events)
  → Event type: Uplink message
  → Output format: Sensor Data
  → [your logic: Slack, database, etc.]
```

Output shape (`Sensor Data`):

```json
{
  "device_id": "my-sensor",
  "application_id": "my-app",
  "received_at": "2026-06-07T12:00:00.000Z",
  "f_port": 1,
  "data": { "temperature": 22.5, "humidity": 60 }
}
```

### Send a downlink command

```
TTN → Devices → Send Downlink
  → Application: my-app
  → Device: my-sensor
  → FPort: 10
  → Payload type: Hex
  → Payload: 0102FF
```

See [Scheduling downlinks](https://www.thethingsindustries.com/docs/reference/api/application_server/#downlinkmessage) in the TTS docs.

### Read recent uplinks from Storage

```
TTN → Data → Get Last Uplink
  → Storage scope: One Device
  → Last window: Last 12 Hours
  → Uplink output shape: Decoded Payload + Meta
```

Requires [Storage integration](https://www.thethingsindustries.com/docs/integrations/storage/) enabled on the application.

### Monitor device connectivity

```
TTN → Data → Get Device Status
  → Status mode: Summary
  → Offline threshold: 24 hours
```

### Check gateway health

```
TTN → Gateways → Get Gateway Status
  → Gateway IDs: [your-gateway]
  → Status mode: Detailed
```

## Compatibility

| Requirement | Version |
|-------------|---------|
| n8n | Community nodes supported (tested with recent self-hosted releases) |
| Node.js | ≥ 22 (development / CI) |
| The Things Stack | v3 API (`/api/v3/…`) — public TTN cloud, Cloud Hosted, and self-hosted |

No runtime npm dependencies — only `n8n-workflow` as a peer dependency.

## Development

```bash
npm install
npm run dev      # Start n8n with hot reload
npm run lint     # ESLint (n8n node rules)
npm run build    # Compile to dist/
npm run deploy   # Build + copy to custom n8n folder
npm run release  # Lint, build, version bump, tag — triggers publish.yml on push
```

Requires Node.js 22+. See [n8n node development](https://docs.n8n.io/integrations/creating-nodes/).

**Publishing:** configure an [npm Trusted Publisher](https://docs.npmjs.com/trusted-publishers) on the package (owner `etoilary974-ship-it`, repo `n8n-nodes-ttn`, workflow `publish.yml`), then run `npm run release`. The GitHub Actions workflow publishes to npm with provenance (required for n8n community verification since May 2026).

## Resources

### n8n

- [Community nodes documentation](https://docs.n8n.io/integrations/community-nodes/)
- [Install community nodes](https://docs.n8n.io/integrations/community-nodes/installation/)
- [Building custom nodes](https://docs.n8n.io/integrations/creating-nodes/)

### The Things Stack / TTN

- [The Things Stack documentation](https://www.thethingsindustries.com/docs/)
- [TTS Console (public cloud)](https://console.cloud.thethings.network/)
- [API authentication](https://www.thethingsindustries.com/docs/reference/api/authentication/)
- [Webhooks integration](https://www.thethingsindustries.com/docs/integrations/webhooks/)
- [Storage integration](https://www.thethingsindustries.com/docs/integrations/storage/)
- [Application Server API (devices, downlinks)](https://www.thethingsindustries.com/docs/reference/api/application_server/)
- [Gateway Server API](https://www.thethingsindustries.com/docs/reference/api/gateway_server/)
- [LoRaWAN concepts](https://www.thethingsindustries.com/docs/concepts/lorawan/)

### This project

- [npm package](https://www.npmjs.com/package/@loewencreville/n8n-nodes-ttn)
- [GitHub repository](https://github.com/etoilary974-ship-it/n8n-nodes-ttn)
- [Changelog](CHANGELOG.md)
- [Report an issue](https://github.com/etoilary974-ship-it/n8n-nodes-ttn/issues)

## Version history

See [CHANGELOG.md](CHANGELOG.md) for the full release history.

| Version | Highlights |
|---------|------------|
| **1.0.0** | First public release: TTN node, webhook trigger, credentials, push-only downlink, CI/CD + npm provenance |

## License

[MIT](LICENSE.md) — Copyright Loewen Creville
