import http from 'node:http';
import https from 'node:https';
import type { IncomingMessage } from 'node:http';
import { NodeOperationError } from 'n8n-workflow';
import type {
	ICredentialDataDecryptedObject,
	IDataObject,
	IExecuteFunctions,
	ILoadOptionsFunctions,
	INodePropertyOptions,
} from 'n8n-workflow';

export function ttnBaseUrl(credentials: ICredentialDataDecryptedObject): string {
	return String(credentials.serverUrl ?? '').replace(/\/+$/, '');
}

/** Application Server bearer: app/device lists, JSON GET (non-Storage), downlinks. */
export function ttnApplicationServerBearerToken(credentials: ICredentialDataDecryptedObject): string {
	return String(credentials.apiKey ?? '').trim();
}

/**
 * Bearer for Storage `GET …/packages/storage/uplink_message` (same Application Server API key).
 */
export function ttnStorageBearerToken(credentials: ICredentialDataDecryptedObject): string {
	return ttnApplicationServerBearerToken(credentials);
}

export async function ttnRequestJsonForLoadOptions(
	this: ILoadOptionsFunctions,
	relativePath: string,
): Promise<IDataObject> {
	const credentials = await this.getCredentials('ttnApi');
	const baseUrl = ttnBaseUrl(credentials);
	if (!baseUrl) {
		throw new Error('Set the The Things Stack server URL in credentials.');
	}
	return (await this.helpers.httpRequest({
		method: 'GET',
		url: `${baseUrl}${relativePath}`,
		headers: {
			Accept: 'application/json',
			Authorization: `Bearer ${ttnApplicationServerBearerToken(credentials)}`,
		},
		json: true,
	})) as IDataObject;
}

export async function ttnGetApplications(
	this: ILoadOptionsFunctions,
): Promise<INodePropertyOptions[]> {
	const body = await ttnRequestJsonForLoadOptions.call(this, '/api/v3/applications');
	const apps = (body.applications as IDataObject[] | undefined) ?? [];
	const options: INodePropertyOptions[] = [];
	for (const app of apps) {
		const ids = app.ids as IDataObject | undefined;
		const id = ids?.application_id as string | undefined;
		if (id) {
			options.push({ name: id, value: id });
		}
	}
	return options;
}

export async function ttnGetDevices(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
	const applicationId = this.getCurrentNodeParameter('applicationId') as string | undefined;
	if (!applicationId) {
		return [];
	}
	const path = `/api/v3/applications/${encodeURIComponent(applicationId)}/devices`;
	const body = await ttnRequestJsonForLoadOptions.call(this, path);
	const devices =
		(body.end_devices as IDataObject[] | undefined) ??
		(body.devices as IDataObject[] | undefined) ??
		[];
	const options: INodePropertyOptions[] = [];
	for (const dev of devices) {
		const ids = dev.ids as IDataObject | undefined;
		const id = ids?.device_id as string | undefined;
		if (id) {
			options.push({ name: id, value: id });
		}
	}
	return options;
}

export async function ttnGetGateways(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
	const q = new URLSearchParams({ field_mask: 'ids,name' });
	const body = await ttnRequestJsonForLoadOptions.call(this, `/api/v3/gateways?${q.toString()}`);
	const gateways = (body.gateways as IDataObject[] | undefined) ?? [];
	const options: INodePropertyOptions[] = [];
	for (const gw of gateways) {
		const ids = gw.ids as IDataObject | undefined;
		const id = typeof ids?.gateway_id === 'string' ? ids.gateway_id : undefined;
		const name = typeof gw.name === 'string' ? gw.name : undefined;
		if (id) {
			options.push({ name: name ? `${id} (${name})` : id, value: id });
		}
	}
	return options;
}

/**
 * Reshape an ApplicationUp (Storage or webhook uplink) for n8n.
 * Same shape: end_device_ids, received_at, uplink_message.decoded_payload, …
 * @see https://www.thethingsindustries.com/docs/integrations/storage/retrieve/
 */
export function ttnShapeApplicationUplinkOutput(
	record: IDataObject,
	mode: 'full' | 'decodedOnly' | 'decodedWithMeta',
): IDataObject {
	if (mode === 'full') {
		return record;
	}

	const uplinkMessage = record.uplink_message as IDataObject | undefined;
	const hasDecodedKey =
		uplinkMessage !== undefined &&
		Object.prototype.hasOwnProperty.call(uplinkMessage, 'decoded_payload');
	const decodedPayload = uplinkMessage?.decoded_payload as
		| IDataObject
		| IDataObject[]
		| string
		| number
		| boolean
		| null
		| undefined;

	if (mode === 'decodedOnly') {
		if (!hasDecodedKey) {
			return {
				warning: true,
				message:
					'No decoded_payload on this uplink (formatter missing/disabled, or field not stored). Use the API field_mask or full output to inspect the structure.',
			};
		}
		if (
			decodedPayload !== null &&
			typeof decodedPayload === 'object' &&
			!Array.isArray(decodedPayload)
		) {
			return { ...decodedPayload };
		}
		return {
			decoded_payload: decodedPayload ?? null,
		};
	}

	/* decodedWithMeta */
	return {
		decoded_payload: hasDecodedKey ? (decodedPayload ?? null) : null,
		received_at: record.received_at,
		end_device_ids: record.end_device_ids,
		...(uplinkMessage?.f_port !== undefined ? { f_port: uplinkMessage.f_port } : {}),
	};
}

/** All Storage uplinks found in the body (NDJSON/SSE, multiple `{"result":…}` lines). */
function parseAllStorageUplinkRecords(body: string): IDataObject[] {
	const out: IDataObject[] = [];
	for (const raw of body.split(/\r?\n/)) {
		let line = raw.trim();
		if (!line) {
			continue;
		}
		if (/^event:\s*/i.test(line) || /^id:\s*/i.test(line) || line.startsWith(':')) {
			continue;
		}
		if (/^data:\s*/i.test(line)) {
			line = line.replace(/^data:\s*/i, '').trim();
		}
		if (!line || (!line.startsWith('{') && !line.startsWith('['))) {
			continue;
		}
		try {
			const parsed = JSON.parse(line) as IDataObject;
			const wrapped = parsed.result as IDataObject | undefined;
			const rec = wrapped ?? parsed;
			if (rec === null || typeof rec !== 'object' || Array.isArray(rec)) {
				continue;
			}
			if (typeof rec.code === 'number' && typeof rec.message === 'string') {
				continue;
			}
			if (
				rec.received_at === undefined &&
				rec.uplink_message === undefined &&
				rec.end_device_ids === undefined
			) {
				continue;
			}
			out.push(rec);
		} catch {
			continue;
		}
	}
	return out;
}

/**
 * GET Storage `text/event-stream` without `helpers.httpRequest` or `limit`: read until the server closes the stream (no node-side timeout or byte cap).
 */
function ttnFetchStorageUplinkRawBody(urlString: string, bearerToken: string): Promise<string> {
	return new Promise((resolve, reject) => {
		let acc = Buffer.alloc(0);
		let settled = false;

		const finishOk = (body: string) => {
			if (settled) {
				return;
			}
			settled = true;
			resolve(body);
		};
		const finishErr = (err: Error) => {
			if (settled) {
				return;
			}
			settled = true;
			reject(err);
		};

		let parsed: URL;
		try {
			parsed = new URL(urlString);
		} catch {
			finishErr(new Error(`Invalid Storage URL: ${urlString}`));
			return;
		}

		const isHttps = parsed.protocol === 'https:';
		const mod = isHttps ? https : http;

		const req = mod.request(
			{
				hostname: parsed.hostname,
				port: parsed.port || undefined,
				path: `${parsed.pathname}${parsed.search}`,
				method: 'GET',
				headers: {
					Authorization: `Bearer ${bearerToken}`,
					Accept: 'text/event-stream',
					'User-Agent': 'n8n-nodes-ttn/storage',
				},
			},
			(res: IncomingMessage) => {
				const status = res.statusCode ?? 0;

				res.on('data', (chunk: Buffer) => {
					if (settled) {
						return;
					}
					acc = Buffer.concat([acc, chunk]);
				});

				res.on('end', () => {
					if (settled) {
						return;
					}
					const text = acc.toString('utf8');
					if (status >= 200 && status < 300) {
						finishOk(text);
					} else {
						finishErr(new Error(`Storage HTTP ${status} : ${text.slice(0, 900)}`));
					}
				});
			},
		);

		req.on('error', finishErr);

		req.end();
	});
}

export async function ttnExecuteJsonGet(
	ctx: IExecuteFunctions,
	relativePath: string,
): Promise<IDataObject> {
	const credentials = await ctx.getCredentials('ttnApi');
	const baseUrl = ttnBaseUrl(credentials);
	if (!baseUrl) {
		throw new Error('Set the The Things Stack server URL in credentials.');
	}
	const res = (await ctx.helpers.httpRequest({
		method: 'GET',
		url: `${baseUrl}${relativePath}`,
		headers: {
			Accept: 'application/json',
			Authorization: `Bearer ${ttnApplicationServerBearerToken(credentials)}`,
		},
		json: true,
		returnFullResponse: true,
		ignoreHttpStatusErrors: true,
	})) as { statusCode?: number; body?: unknown };

	const status = typeof res.statusCode === 'number' ? res.statusCode : 0;
	const responseBody = res.body;

	if (status >= 200 && status < 300) {
		if (responseBody === null || responseBody === undefined || responseBody === '') {
			return {};
		}
		if (
			typeof responseBody === 'object' &&
			!Buffer.isBuffer(responseBody) &&
			!Array.isArray(responseBody)
		) {
			return responseBody as IDataObject;
		}
		return {};
	}

	const clean = ttnParseAndMapTtnApiError(status, responseBody);
	throw new TtnApiError(clean);
}

/** Read `last_seen_at` from the TTS device GET response (root or `status`). */
export function ttnPickLastSeenAtFromDeviceJson(device: IDataObject): string | undefined {
	const asStr = (v: unknown): string | undefined =>
		typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
	return (
		asStr(device.last_seen_at) ??
		asStr((device.status as IDataObject | undefined)?.last_seen_at)
	);
}

export type TtnDeviceOnlineStatus = 'online' | 'offline' | 'unknown';
export type TtnDeviceStatusMode = 'onlineOffline' | 'detailed';
export type TtnDurationUnit = 'minutes' | 'hours' | 'days';

const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3600;
const SECONDS_PER_DAY = 86400;
const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = 1440;

/** Convert a user-facing duration to minutes (used for offline threshold logic). */
export function ttnDurationToMinutes(value: number, unit: TtnDurationUnit): number {
	const amount = Math.floor(value);
	if (amount < 1) {
		return 1;
	}
	switch (unit) {
		case 'hours':
			return amount * MINUTES_PER_HOUR;
		case 'days':
			return amount * MINUTES_PER_DAY;
		default:
			return amount;
	}
}

/**
 * Pick the largest readable unit (days → hours → minutes) for a duration in seconds.
 */
export function ttnFormatSinceLastSeen(seconds: number | null): {
	since_last_seen: number;
	since_last_seen_unit: TtnDurationUnit;
} | null {
	if (seconds === null) {
		return null;
	}
	const totalSeconds = Math.max(0, seconds);

	if (totalSeconds >= SECONDS_PER_DAY) {
		const days = totalSeconds / SECONDS_PER_DAY;
		return {
			since_last_seen: Number.isInteger(days) ? days : Math.round(days * 10) / 10,
			since_last_seen_unit: 'days',
		};
	}
	if (totalSeconds >= SECONDS_PER_HOUR) {
		const hours = totalSeconds / SECONDS_PER_HOUR;
		return {
			since_last_seen: Number.isInteger(hours) ? hours : Math.round(hours * 10) / 10,
			since_last_seen_unit: 'hours',
		};
	}
	const minutes =
		totalSeconds < SECONDS_PER_MINUTE
			? totalSeconds > 0
				? 1
				: 0
			: Math.ceil(totalSeconds / SECONDS_PER_MINUTE);
	return {
		since_last_seen: minutes,
		since_last_seen_unit: 'minutes',
	};
}

/**
 * Compare `last_seen_at` (ISO 8601) to now: online if last seen within `offlineAfterMinutes`.
 */
export function ttnDeriveDeviceOnlineStatus(
	lastSeenAtIso: string | undefined,
	offlineAfterMinutes: number,
): { online_status: TtnDeviceOnlineStatus; seconds_since_last_seen: number | null } {
	if (!lastSeenAtIso) {
		return { online_status: 'unknown', seconds_since_last_seen: null };
	}
	const t = Date.parse(lastSeenAtIso);
	if (Number.isNaN(t)) {
		return { online_status: 'unknown', seconds_since_last_seen: null };
	}
	const secondsSince = Math.floor((Date.now() - t) / 1000);
	const thresholdSec = Math.max(1, Math.floor(offlineAfterMinutes * 60));
	if (secondsSince < 0) {
		return { online_status: 'online', seconds_since_last_seen: secondsSince };
	}
	return {
		online_status: secondsSince <= thresholdSec ? 'online' : 'offline',
		seconds_since_last_seen: secondsSince,
	};
}

/**
 * GET device + fields for status (last activity = TTS `last_seen_at`).
 * @see https://www.thethingsindustries.com/docs/api/reference/http/end_device/
 */
export async function ttnExecuteGetDeviceStatus(
	ctx: IExecuteFunctions,
	applicationId: string,
	deviceId: string,
	offlineThreshold: number,
	offlineThresholdUnit: TtnDurationUnit,
	statusMode: TtnDeviceStatusMode = 'detailed',
): Promise<IDataObject> {
	const offlineAfterMinutes = ttnDurationToMinutes(offlineThreshold, offlineThresholdUnit);
	const q = new URLSearchParams({ field_mask: 'ids,last_seen_at' });
	const rel = `/api/v3/applications/${encodeURIComponent(applicationId)}/devices/${encodeURIComponent(deviceId)}?${q.toString()}`;
	const device = await ttnExecuteJsonGet(ctx, rel);
	const lastSeen = ttnPickLastSeenAtFromDeviceJson(device);
	const { online_status, seconds_since_last_seen } = ttnDeriveDeviceOnlineStatus(
		lastSeen,
		offlineAfterMinutes,
	);
	const ids = device.ids as IDataObject | undefined;
	const appIds = ids?.application_ids as IDataObject | undefined;
	const resolvedDeviceId = (ids?.device_id as string | undefined) ?? deviceId;

	if (statusMode === 'onlineOffline') {
		return {
			device_id: resolvedDeviceId,
			online: online_status === 'online',
		};
	}

	const sinceLastSeen = ttnFormatSinceLastSeen(seconds_since_last_seen);

	return {
		application_id: (appIds?.application_id as string | undefined) ?? applicationId,
		device_id: resolvedDeviceId,
		/* last_seen_at / last_uplink_at: TTS registry activity, not Storage. */
		last_seen_at: lastSeen ?? null,
		last_uplink_at: lastSeen ?? null,
		online_status,
		offline_threshold: Math.floor(offlineThreshold),
		offline_threshold_unit: offlineThresholdUnit,
		since_last_seen: sinceLastSeen?.since_last_seen ?? null,
		since_last_seen_unit: sinceLastSeen?.since_last_seen_unit ?? null,
		source: 'device_registry',
	};
}

function ttnPickValidIsoTimestamp(v: unknown): string | undefined {
	if (typeof v !== 'string' || !v.trim()) {
		return undefined;
	}
	const trimmed = v.trim();
	if (trimmed.startsWith('0001-01-01')) {
		return undefined;
	}
	if (Number.isNaN(Date.parse(trimmed))) {
		return undefined;
	}
	return trimmed;
}

/** Most recent activity from Gateway Server connection stats. */
function ttnPickLastSeenAtFromGatewayConnectionStats(stats: IDataObject): string | undefined {
	const candidates = [
		ttnPickValidIsoTimestamp(stats.last_uplink_received_at),
		ttnPickValidIsoTimestamp(stats.last_status_received_at),
	].filter((t): t is string => !!t);
	if (candidates.length === 0) {
		return undefined;
	}
	return candidates.reduce((latest, cur) => (Date.parse(cur) > Date.parse(latest) ? cur : latest));
}

/**
 * GET gateway connection stats (last activity monitored by Gateway Server).
 * @see https://www.thethingsindustries.com/docs/api/reference/grpc/gateway_server/
 */
export async function ttnExecuteGetGatewayStatus(
	ctx: IExecuteFunctions,
	gatewayId: string,
	offlineThreshold: number,
	offlineThresholdUnit: TtnDurationUnit,
	statusMode: TtnDeviceStatusMode = 'detailed',
): Promise<IDataObject> {
	const offlineAfterMinutes = ttnDurationToMinutes(offlineThreshold, offlineThresholdUnit);
	const rel = `/api/v3/gs/gateways/${encodeURIComponent(gatewayId)}/connection/stats`;
	const stats = await ttnExecuteJsonGet(ctx, rel);
	const lastSeen = ttnPickLastSeenAtFromGatewayConnectionStats(stats);
	const { online_status, seconds_since_last_seen } = ttnDeriveDeviceOnlineStatus(
		lastSeen,
		offlineAfterMinutes,
	);

	if (statusMode === 'onlineOffline') {
		return {
			gateway_id: gatewayId,
			online: online_status === 'online',
		};
	}

	const sinceLastSeen = ttnFormatSinceLastSeen(seconds_since_last_seen);

	return {
		gateway_id: gatewayId,
		last_seen_at: lastSeen ?? null,
		last_uplink_received_at: ttnPickValidIsoTimestamp(stats.last_uplink_received_at) ?? null,
		last_status_received_at: ttnPickValidIsoTimestamp(stats.last_status_received_at) ?? null,
		connected_at: ttnPickValidIsoTimestamp(stats.connected_at) ?? null,
		disconnected_at: ttnPickValidIsoTimestamp(stats.disconnected_at) ?? null,
		online_status,
		offline_threshold: Math.floor(offlineThreshold),
		offline_threshold_unit: offlineThresholdUnit,
		since_last_seen: sinceLastSeen?.since_last_seen ?? null,
		since_last_seen_unit: sinceLastSeen?.since_last_seen_unit ?? null,
		protocol: typeof stats.protocol === 'string' && stats.protocol ? stats.protocol : null,
		uplink_count: stats.uplink_count ?? null,
		source: 'gateway_server',
	};
}

export type TtnGatewayListScope = 'all' | 'user' | 'organization';
export type TtnGatewayListOutputMode = 'detailed' | 'summary';

function ttnPickGatewayId(gateway: IDataObject): string | undefined {
	const ids = gateway.ids as IDataObject | undefined;
	return typeof ids?.gateway_id === 'string' ? ids.gateway_id : undefined;
}

function ttnPickGatewayName(gateway: IDataObject): string | undefined {
	return typeof gateway.name === 'string' ? gateway.name : undefined;
}

/** TTS Gateway has no root `location`; placement is on `antennas[].location`. */
export function ttnPickGatewayLocation(gateway: IDataObject): IDataObject | null {
	const antennas = gateway.antennas;
	if (!Array.isArray(antennas) || antennas.length === 0) {
		return null;
	}
	const first = antennas[0] as IDataObject;
	const loc = first.location as IDataObject | undefined;
	if (!loc || typeof loc !== 'object') {
		return null;
	}
	const out: IDataObject = {};
	if (loc.latitude !== undefined) out.latitude = loc.latitude;
	if (loc.longitude !== undefined) out.longitude = loc.longitude;
	if (loc.altitude !== undefined) out.altitude = loc.altitude;
	if (loc.source !== undefined) out.source = loc.source;
	return Object.keys(out).length > 0 ? out : null;
}

function ttnStripGatewayLocation(gateway: IDataObject): IDataObject {
	const { antennas: _antennas, ...rest } = gateway;
	return rest;
}

function ttnMapGatewaySummary(gateway: IDataObject, includeLocation: boolean): IDataObject {
	const row: IDataObject = {
		gateway_id: ttnPickGatewayId(gateway) ?? '',
		name: ttnPickGatewayName(gateway) ?? '',
	};
	if (includeLocation) {
		const location = ttnPickGatewayLocation(gateway);
		if (location) {
			row.location = location;
		}
	}
	return row;
}

/**
 * Shape List Gateways API output (detailed blob vs one summary item per gateway).
 */
export function ttnMapGatewayListResponse(
	raw: IDataObject,
	outputMode: TtnGatewayListOutputMode,
	includeLocation: boolean,
): IDataObject[] {
	const gateways = Array.isArray(raw.gateways) ? (raw.gateways as IDataObject[]) : [];

	if (outputMode === 'summary') {
		return gateways.map((gateway) => ttnMapGatewaySummary(gateway, includeLocation));
	}

	const mapped = gateways.map((gateway) =>
		includeLocation ? gateway : ttnStripGatewayLocation(gateway),
	);
	const out: IDataObject = { gateways: mapped };
	if (raw.next_page_token !== undefined) {
		out.next_page_token = raw.next_page_token;
	}
	return [out];
}

/**
 * List gateways visible to the API key (global, user, or organization scope).
 * @see https://www.thethingsindustries.com/docs/api/reference/grpc/gateway/
 */
export async function ttnExecuteListGateways(
	ctx: IExecuteFunctions,
	scope: TtnGatewayListScope,
	userId: string,
	orgId: string,
	includeLocation: boolean,
): Promise<IDataObject> {
	let path = '';
	const uid = userId.trim();
	const oid = orgId.trim();
	if (scope === 'all') {
		path = '/api/v3/gateways';
	} else if (scope === 'user') {
		if (!uid) {
			throw new Error(
				'User scope: set the user ID (TTS console profile).',
			);
		}
		path = `/api/v3/users/${encodeURIComponent(uid)}/gateways`;
	} else {
		if (!oid) {
			throw new Error('Organization scope: set the organization ID.');
		}
		path = `/api/v3/organizations/${encodeURIComponent(oid)}/gateways`;
	}
	const baseFields =
		'ids,name,description,status_public,location_public,version_ids,frequency_plan_ids,schedule_downlink_late';
	const fieldMask = includeLocation ? `${baseFields},antennas` : baseFields;
	const q = new URLSearchParams({ field_mask: fieldMask });
	return ttnExecuteJsonGet(ctx, `${path}?${q.toString()}`);
}

/** Readable error presentation (main message + context + action). */
export type TtnErrorPresentation = {
	main_message: string;
	reason: string;
	what_to_do: string;
};

/** Stable error JSON for n8n branches (e.g. Continue on Fail). */
export type TtnApiErrorJson = {
	ttn_error: true;
	http_status: number;
	code: number | string | null;
	/** Business key (e.g. invalid_argument, no_device_session). */
	type: string;
	/** Raw message from TTS / gRPC. */
	message: string;
	/** Short title (main message equivalent). */
	main_message: string;
	/** Business/technical explanation. */
	reason: string;
	/** Recommended action. */
	what_to_do: string;
};

/**
 * Map error type → main message, reason, what to do.
 * Keys follow gRPC / TTS patterns.
 * @see https://grpc.io/docs/guides/error/
 */
export const TTN_ERROR_PRESENTATION_MAP: Record<string, TtnErrorPresentation> = {
	no_device_session: {
		main_message: 'Device offline or not joined',
		reason: 'The device has no active LoRaWAN session.',
		what_to_do: 'Send an uplink first or make sure the device has joined the network.',
	},
	invalid_argument: {
		main_message: 'Invalid request (TTS)',
		reason:
			'The Things Stack rejected the request as invalid_argument: e.g. wrong JSON/body on writes, or invalid query/field_mask on GET (unknown field paths return HTTP 400).',
		what_to_do:
			'Downlinks: check hex vs base64 and FPort. List/read APIs: verify field_mask paths in TTS docs (Gateway has `antennas`, not a root `location`).',
	},
	permission_denied: {
		main_message: 'Invalid API key or rights',
		reason: 'This API key is not allowed to perform the requested operation.',
		what_to_do: 'Use an API key with rights for this application and downlink / application data.',
	},
	unauthenticated: {
		main_message: 'Invalid API key or rights',
		reason: 'Authentication failed: missing, invalid, or wrong cluster URL for this key.',
		what_to_do: 'Check the API key (NNSXS…) and that the credential server URL matches your TTS cluster (e.g. eu1.cloud.thethings.network).',
	},
	not_found: {
		main_message: 'Resource not found',
		reason: 'The application, device, or API path does not exist or is not visible with this key.',
		what_to_do: 'Verify application ID and device ID in the TTS console.',
	},
	failed_precondition: {
		main_message: 'Precondition not met',
		reason: 'The server refused the call because a required state or configuration is missing.',
		what_to_do: 'Read the raw `message` field and the TTS documentation for this endpoint.',
	},
	unavailable: {
		main_message: 'Service unavailable',
		reason: 'A The Things Stack component is temporarily unavailable or overloaded.',
		what_to_do: 'Retry after a short delay or check cluster status.',
	},
	deadline_exceeded: {
		main_message: 'Request deadline exceeded',
		reason: 'The upstream operation exceeded its deadline.',
		what_to_do: 'Retry with a lighter request or later.',
	},
	cancelled: {
		main_message: 'Request cancelled',
		reason: 'The operation was cancelled before it completed.',
		what_to_do: 'Retry if the operation is still needed.',
	},
	resource_exhausted: {
		main_message: 'Quota or rate limit exceeded',
		reason: 'A quota or rate limit was reached for this key or deployment.',
		what_to_do: 'Slow down requests or raise quotas where your hosting allows it.',
	},
	unknown: {
		main_message: 'The Things Stack API error',
		reason: '',
		what_to_do: 'Use the raw `message` field, verify credentials and cluster URL, and compare with the TTS API documentation.',
	},
};

const TTN_GRPC_CODE_TO_TYPE: Record<number, string> = {
	1: 'cancelled',
	2: 'unknown',
	3: 'invalid_argument',
	4: 'deadline_exceeded',
	5: 'not_found',
	7: 'permission_denied',
	8: 'resource_exhausted',
	9: 'failed_precondition',
	14: 'unavailable',
	16: 'unauthenticated',
};

export class TtnApiError extends Error {
	readonly clean: TtnApiErrorJson;

	constructor(clean: TtnApiErrorJson) {
		super(clean.main_message);
		this.name = 'TtnApiError';
		this.clean = clean;
		Object.setPrototypeOf(this, TtnApiError.prototype);
	}
}

function ttnCoerceApiErrorBody(body: unknown): IDataObject | undefined {
	if (body === null || body === undefined) {
		return undefined;
	}
	if (Buffer.isBuffer(body)) {
		const t = body.toString('utf8');
		try {
			return JSON.parse(t) as IDataObject;
		} catch {
			return t.trim() ? { message: t.slice(0, 800) } : undefined;
		}
	}
	if (typeof body === 'string') {
		const trim = body.trim();
		if (!trim) {
			return undefined;
		}
		try {
			return JSON.parse(trim) as IDataObject;
		} catch {
			return { message: trim.slice(0, 800) };
		}
	}
	if (typeof body === 'object' && !Array.isArray(body)) {
		return body as IDataObject;
	}
	return { message: String(body).slice(0, 400) };
}

function ttnReasonStringToType(reason: string): string {
	const r = reason.trim();
	if (!r) {
		return 'unknown';
	}
	if (r.includes('_') && r === r.toUpperCase()) {
		return r.toLowerCase();
	}
	return r
		.replace(/([a-z0-9])([A-Z])/g, '$1_$2')
		.replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
		.toLowerCase();
}

function ttnInferTtnErrorType(args: {
	httpStatus: number;
	message: string;
	grpcCode: number;
	errorInfoReason?: string;
}): string {
	const ml = args.message.toLowerCase();
	if (
		ml.includes('device session') ||
		ml.includes('not joined') ||
		ml.includes('no active session') ||
		ml.includes('not currently joined') ||
		ml.includes('no device session')
	) {
		return 'no_device_session';
	}
	if (args.errorInfoReason) {
		const fromReason = ttnReasonStringToType(args.errorInfoReason);
		if (Object.prototype.hasOwnProperty.call(TTN_ERROR_PRESENTATION_MAP, fromReason)) {
			return fromReason;
		}
	}
	if (!Number.isNaN(args.grpcCode) && TTN_GRPC_CODE_TO_TYPE[args.grpcCode]) {
		return TTN_GRPC_CODE_TO_TYPE[args.grpcCode];
	}
	if (args.httpStatus === 401 || args.httpStatus === 403) {
		return 'permission_denied';
	}
	return 'unknown';
}

function ttnCollectErrorInfoFromDetails(details: unknown): {
	reason?: string;
	detailTypes: string[];
} {
	const detailTypes: string[] = [];
	if (!Array.isArray(details)) {
		return { detailTypes };
	}
	let reason: string | undefined;
	for (const d of details) {
		if (d === null || typeof d !== 'object' || Array.isArray(d)) {
			continue;
		}
		const dd = d as IDataObject;
		const at = dd['@type'];
		if (typeof at === 'string') {
			detailTypes.push(at);
			if (at.includes('ErrorInfo') && typeof dd.reason === 'string') {
				reason = dd.reason;
			}
		}
	}
	return { reason, detailTypes };
}

/**
 * Parse the TTS error response and apply {@link TTN_ERROR_PRESENTATION_MAP}.
 */
export function ttnParseAndMapTtnApiError(httpStatus: number, body: unknown): TtnApiErrorJson {
	const raw = ttnCoerceApiErrorBody(body);
	const fromDetails = ttnCollectErrorInfoFromDetails(raw?.details);

	let message = typeof raw?.message === 'string' ? raw.message.trim() : '';
	if (!message && raw) {
		message = ttnExtractTtsErrorLines(raw).join(' | ').trim();
	}
	if (!message) {
		message = ttnFormatTtsHttpErrorBody(httpStatus, body).replace(/^\[HTTP \d+\]\s*/, '').trim();
	}
	if (!message) {
		message = '(no message)';
	}

	const rawCode = raw?.code;
	let code: number | string | null =
		typeof rawCode === 'number' || typeof rawCode === 'string' ? rawCode : null;
	let grpcNum = NaN;
	if (typeof code === 'number' && !Number.isNaN(code)) {
		grpcNum = code;
	} else if (typeof code === 'string' && /^\d+$/.test(code.trim())) {
		grpcNum = parseInt(code.trim(), 10);
		code = grpcNum;
	}

	const type = ttnInferTtnErrorType({
		httpStatus,
		message,
		grpcCode: grpcNum,
		errorInfoReason: fromDetails.reason,
	});

	const pres =
		TTN_ERROR_PRESENTATION_MAP[type] ?? TTN_ERROR_PRESENTATION_MAP.unknown;
	const reason = pres.reason.trim() ? pres.reason : message;
	const what_to_do = pres.what_to_do;

	return {
		ttn_error: true,
		http_status: httpStatus,
		code,
		type,
		message,
		main_message: pres.main_message,
		reason,
		what_to_do,
	};
}

function ttnOneLineForErrorUi(s: string): string {
	return s.replace(/\s+/g, ' ').trim().replace(/^[-*]\s+/, '');
}

/**
 * Text for the n8n description area.
 * The OUTPUT panel often turns `\n` into "-", which breaks lists/Markdown.
 * Use a **single line** with visible separators; readable detail goes to
 * {@link ttnEnrichNodeOperationErrorWithTtnContext} → Error details → Other info.
 */
export function ttnFormatTtnApiErrorDescription(clean: TtnApiErrorJson): string {
	const r = ttnOneLineForErrorUi(clean.reason);
	const w = ttnOneLineForErrorUi(clean.what_to_do);
	/* n8n often turns \n into "-" in this panel: keep one line + visible separator. */
	const sep = '  \u2014  ';
	const parts = [
		`Reason: ${r}`,
		`What to do: ${w}`,
		`TTN error: HTTP ${clean.http_status} · ${clean.type}`,
	];
	if (clean.type === 'unknown' && clean.message) {
		const m = ttnOneLineForErrorUi(
			clean.message.length > 220 ? `${clean.message.slice(0, 220)}…` : clean.message,
		);
		parts.push(`API: ${m}`);
	}
	parts.push('(Field-by-field detail: Error details → Other info)');
	return parts.join(sep);
}

/** Flat fields for the n8n Error details / Other info panel. */
export function ttnEnrichNodeOperationErrorWithTtnContext(
	err: NodeOperationError,
	clean: TtnApiErrorJson,
): void {
	err.context.ttn_main_message = clean.main_message;
	err.context.ttn_reason = clean.reason;
	err.context.ttn_what_to_do = clean.what_to_do;
	err.context.ttn_http_type = `HTTP ${clean.http_status} · ${clean.type}`;
	if (clean.message) {
		err.context.ttn_api_message = clean.message;
	}
	if (clean.code !== null && clean.code !== undefined) {
		err.context.ttn_api_code = clean.code;
	}
}

export function ttnExecutionErrorToCleanJson(error: unknown): TtnApiErrorJson {
	if (error instanceof TtnApiError) {
		return error.clean;
	}
	const msg = error instanceof Error ? error.message : String(error);
	const u = TTN_ERROR_PRESENTATION_MAP.unknown;
	return {
		ttn_error: true,
		http_status: 0,
		code: null,
		type: 'unknown',
		message: msg,
		main_message: u.main_message,
		reason: msg,
		what_to_do: u.what_to_do,
	};
}

/** Extract message / typical details from TTS JSON errors (gRPC style). */
function ttnExtractTtsErrorLines(o: IDataObject): string[] {
	const lines: string[] = [];
	const main = typeof o.message === 'string' ? o.message.trim() : '';
	if (main) {
		lines.push(main);
	}
	if (o.code !== undefined && o.code !== null && String(o.code) !== '') {
		lines.push(`code: ${String(o.code)}`);
	}
	const details = o.details;
	if (!Array.isArray(details)) {
		return lines;
	}
	for (const d of details) {
		if (d === null || typeof d !== 'object' || Array.isArray(d)) {
			continue;
		}
		const dd = d as IDataObject;
		const desc = typeof dd.description === 'string' ? dd.description.trim() : '';
		const reason = typeof dd.reason === 'string' ? dd.reason.trim() : '';
		const domain = typeof dd.domain === 'string' ? dd.domain.trim() : '';
		const debug = typeof dd.debug === 'string' ? dd.debug.trim() : '';
		const fieldViolations = dd.field_violations ?? dd.fieldViolations;
		if (desc) {
			lines.push(desc);
		} else if (reason && domain) {
			lines.push(`${domain}: ${reason}`);
		} else if (debug) {
			lines.push(debug);
		}
		if (Array.isArray(fieldViolations)) {
			for (const fv of fieldViolations) {
				if (fv && typeof fv === 'object' && !Array.isArray(fv)) {
					const f = fv as IDataObject;
					const field = typeof f.field === 'string' ? f.field : '';
					const descV = typeof f.description === 'string' ? f.description : '';
					if (field || descV) {
						lines.push([field, descV].filter(Boolean).join(' — '));
					}
				}
			}
		}
	}
	return lines;
}

/** Human-readable message from a TTS HTTP error response body. */
function ttnFormatTtsHttpErrorBody(statusCode: number, body: unknown): string {
	const prefix = `[HTTP ${statusCode}]`;
	if (body === null || body === undefined) {
		return `${prefix} (empty response body)`;
	}
	if (Buffer.isBuffer(body)) {
		const t = body.toString('utf8').slice(0, 1200);
		try {
			const o = JSON.parse(t) as IDataObject;
			const lines = ttnExtractTtsErrorLines(o);
			return lines.length > 0 ? `${prefix} ${lines.join(' | ')}` : `${prefix} ${t}`;
		} catch {
			return `${prefix} ${t}`;
		}
	}
	if (typeof body === 'string') {
		const trim = body.trim();
		if (!trim) {
			return `${prefix} (empty body)`;
		}
		try {
			const o = JSON.parse(trim) as IDataObject;
			const lines = ttnExtractTtsErrorLines(o);
			return lines.length > 0 ? `${prefix} ${lines.join(' | ')}` : `${prefix} ${trim.slice(0, 800)}`;
		} catch {
			return `${prefix} ${trim.slice(0, 800)}`;
		}
	}
	if (typeof body === 'object' && !Array.isArray(body)) {
		const lines = ttnExtractTtsErrorLines(body as IDataObject);
		if (lines.length > 0) {
			return `${prefix} ${lines.join(' | ')}`;
		}
		try {
			return `${prefix} ${JSON.stringify(body).slice(0, 800)}`;
		} catch {
			return prefix;
		}
	}
	return `${prefix} ${String(body).slice(0, 400)}`;
}

export async function ttnExecuteJsonPost(
	ctx: IExecuteFunctions,
	relativePath: string,
	body: IDataObject,
): Promise<IDataObject> {
	const credentials = await ctx.getCredentials('ttnApi');
	const baseUrl = ttnBaseUrl(credentials);
	if (!baseUrl) {
		throw new Error('Set the The Things Stack server URL in credentials.');
	}
	const res = (await ctx.helpers.httpRequest({
		method: 'POST',
		url: `${baseUrl}${relativePath}`,
		headers: {
			Accept: 'application/json',
			'Content-Type': 'application/json',
			Authorization: `Bearer ${credentials.apiKey}`,
		},
		body,
		json: true,
		returnFullResponse: true,
		ignoreHttpStatusErrors: true,
	})) as { statusCode?: number; body?: unknown };

	const status = typeof res.statusCode === 'number' ? res.statusCode : 0;
	const responseBody = res.body;

	if (status >= 200 && status < 300) {
		if (responseBody === null || responseBody === undefined || responseBody === '') {
			return {};
		}
		if (
			typeof responseBody === 'object' &&
			!Buffer.isBuffer(responseBody) &&
			!Array.isArray(responseBody)
		) {
			return responseBody as IDataObject;
		}
		return {};
	}

	const isDownlinkPath = relativePath.includes('/down/');
	const clean = ttnParseAndMapTtnApiError(status, responseBody);
	if (isDownlinkPath && status === 400 && clean.type === 'invalid_argument') {
		clean.what_to_do = [
			clean.what_to_do,
			'Payload: Base64 must be valid base64; use Hex for raw bytes (e.g. 3E01FE).',
		].join('\n\n');
	}
	throw new TtnApiError(clean);
}

export type TtnStorageScope = 'application' | 'device';

export type TtnStoredUplinkOptions = {
	applicationId: string;
	/** Required when scope === 'device' */
	deviceId?: string;
	scope: TtnStorageScope;
	/** e.g. `12h`, `2160h` — TTN API hour suffix `h` only. Empty string = omit `last`. */
	last?: string;
	outputMode: 'full' | 'decodedOnly' | 'decodedWithMeta';
};

export async function ttnExecuteLatestStoredUplink(
	ctx: IExecuteFunctions,
	opts: TtnStoredUplinkOptions,
): Promise<IDataObject[]> {
	const { applicationId, deviceId = '', scope, last = '', outputMode } = opts;

	const credentials = await ctx.getCredentials('ttnApi');
	const baseUrl = ttnBaseUrl(credentials);
	if (!baseUrl) {
		throw new Error('Set the The Things Stack server URL in credentials.');
	}
	const storageToken = ttnStorageBearerToken(credentials);
	if (!storageToken) {
		throw new Error('Set the Application Server API key in TTN credentials.');
	}

	if (scope === 'device' && !deviceId.trim()) {
		throw new Error(
			'Storage (device scope): set Device ID or switch scope to the whole application.',
		);
	}

	const path =
		scope === 'application'
			? `/api/v3/as/applications/${encodeURIComponent(applicationId)}/packages/storage/uplink_message`
			: `/api/v3/as/applications/${encodeURIComponent(applicationId)}/devices/${encodeURIComponent(deviceId.trim())}/packages/storage/uplink_message`;

	const fetchStorage = async (withDecodedMask: boolean): Promise<string> => {
		const root = baseUrl.replace(/\/+$/, '');
		const rel = path.startsWith('/') ? path : `/${path}`;
		const u = new URL(`${root}${rel}`);
		u.searchParams.set('order', '-received_at');
		const lastTrim = last.trim();
		if (lastTrim.length > 0) {
			u.searchParams.set('last', lastTrim);
		}
		if (withDecodedMask && outputMode !== 'full') {
			u.searchParams.set('field_mask', 'up.uplink_message.decoded_payload,up.uplink_message.f_port');
		}
		return ttnFetchStorageUplinkRawBody(u.toString(), storageToken);
	};

	let text = await fetchStorage(true);
	let records = parseAllStorageUplinkRecords(text);

	if (records.length === 0 && outputMode !== 'full') {
		text = await fetchStorage(false);
		records = parseAllStorageUplinkRecords(text);
	}

	if (records.length === 0) {
		return [
			{
				warning: true,
				message:
					'No uplinks in Storage for this request. Check the `last` window, scope (app vs device), Storage enablement, and that your Application Server API key can access Storage. See https://www.thethingsindustries.com/docs/integrations/storage/enable/',
				hint:
					`Equivalent: curl -G "${baseUrl}${path}" -H "Authorization: Bearer …" -H "Accept: text/event-stream" -d order=-received_at${last.trim() ? ` -d last=${last.trim()}` : ''} (no limit parameter).`,
				applicationId,
				...(scope === 'device' ? { deviceId } : {}),
				storageScope: scope,
			},
		];
	}
	return records.map((payload) => ttnShapeApplicationUplinkOutput(payload, outputMode));
}

export function ttnBuildDownlinkItem(i: number, ctx: IExecuteFunctions): IDataObject {
	const fPort = ctx.getNodeParameter('fPort', i) as number;
	const payloadFormat = ctx.getNodeParameter('payloadFormat', i) as string;
	const payloadRaw = ctx.getNodeParameter('payload', i) as string;
	const priority = ctx.getNodeParameter('priority', i) as string;
	const confirmed = ctx.getNodeParameter('confirmed', i) as boolean;
	const correlationRaw = (ctx.getNodeParameter('correlationIdsJson', i) as string).trim();

	const item: IDataObject = {
		f_port: fPort,
		priority,
	};
	if (confirmed) {
		item.confirmed = true;
	}

	if (payloadFormat === 'base64') {
		item.frm_payload = payloadRaw.trim();
	} else if (payloadFormat === 'hex') {
		const hex = payloadRaw.replace(/\s/g, '').replace(/^0x/i, '');
		if (hex.length % 2 !== 0) {
			throw new NodeOperationError(
				ctx.getNode(),
				'Hex payload: character count must be even',
				{ itemIndex: i },
			);
		}
		if (!/^[0-9a-fA-F]*$/.test(hex)) {
			throw new NodeOperationError(
				ctx.getNode(),
				'Hex payload: non-hexadecimal characters',
				{ itemIndex: i },
			);
		}
		item.frm_payload = Buffer.from(hex, 'hex').toString('base64');
	} else if (payloadFormat === 'decodedJson') {
		const t = payloadRaw.trim();
		if (!t) {
			item.decoded_payload = {};
		} else {
			try {
				item.decoded_payload = JSON.parse(t) as IDataObject;
			} catch {
				throw new NodeOperationError(
					ctx.getNode(),
					'Invalid JSON for decoded_payload',
					{ itemIndex: i },
				);
			}
		}
	}

	if (correlationRaw) {
		try {
			const parsed = JSON.parse(correlationRaw) as unknown;
			if (!Array.isArray(parsed)) {
				throw new Error('not array');
			}
			item.correlation_ids = parsed;
		} catch {
			throw new NodeOperationError(
				ctx.getNode(),
				'Correlation IDs: expected a JSON array of strings',
				{ itemIndex: i },
			);
		}
	}

	return item;
}

/** push — Application Server downlink API (`down/push` returns an empty body on success). */
export async function ttnExecuteDownlinkQueue(
	ctx: IExecuteFunctions,
	i: number,
	applicationId: string,
	deviceId: string,
	queueOp: 'push' | 'replace' | 'clear' = 'push',
): Promise<IDataObject> {
	const basePath = `/api/v3/as/applications/${encodeURIComponent(applicationId)}/devices/${encodeURIComponent(deviceId)}/down`;

	let body: IDataObject;
	let downlink: IDataObject | undefined;
	if (queueOp === 'clear') {
		body = { downlinks: [] };
	} else {
		downlink = ttnBuildDownlinkItem(i, ctx);
		body = { downlinks: [downlink] };
	}

	const suffix = queueOp === 'clear' || queueOp === 'replace' ? 'replace' : 'push';
	await ttnExecuteJsonPost(ctx, `${basePath}/${suffix}`, body);

	let queue: IDataObject | undefined;
	try {
		queue = await ttnExecuteJsonGet(ctx, basePath);
	} catch {
		queue = undefined;
	}

	const queueDownlinks = Array.isArray(queue?.downlinks)
		? (queue.downlinks as IDataObject[])
		: [];

	const out: IDataObject = {
		success: true,
		application_id: applicationId,
		device_id: deviceId,
		operation: queueOp,
		queue_count: queueDownlinks.length,
		queue_downlinks: queueDownlinks,
		source: 'application_server',
	};
	if (downlink) {
		out.downlink = downlink;
	}
	return out;
}
