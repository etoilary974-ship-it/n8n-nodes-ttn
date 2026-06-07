import type { IDataObject, IWebhookFunctions } from 'n8n-workflow';
import { ttnShapeApplicationUplinkOutput } from './ttnShared.js';

/** Root event keys (order = first match wins). */
const ROOT_EVENT_KEYS = [
	'uplink_message',
	'normalized_payload',
	'join_accept',
	'downlink_ack',
	'downlink_nack',
	'downlink_sent',
	'downlink_failed',
	'downlink_queued',
	'downlink_queue_invalidated',
	'location_solved',
	'service_data',
] as const;

const UPLINK_FORMATS = new Set(['sensorData', 'sensorValuesOnly', 'fullEvent']);
const SUMMARY_OR_FULL = new Set(['eventSummary', 'fullEvent']);

const EVENTS_WITH_DOWNLINK_DETAILS = new Set([
	'downlink_ack',
	'downlink_nack',
	'downlink_sent',
	'downlink_queued',
]);

const UPLINK_LIKE_EVENTS = new Set(['uplink_message', 'normalized_payload']);
const EVENT_FORMAT_FROM_TTN_OUTPUT_FORMAT_EVENT = new Set([
	'downlink_ack',
	'downlink_nack',
	'downlink_sent',
	'downlink_queued',
	'downlink_failed',
	'downlink_queue_invalidated',
	'join_accept',
	'location_solved',
	'service_data',
]);

function resolveTtnOutputFormat(ctx: IWebhookFunctions, outputEventType: string): string {
	if (UPLINK_LIKE_EVENTS.has(outputEventType)) {
		return ctx.getNodeParameter('ttnOutputFormat', 0) as string;
	}
	if (EVENT_FORMAT_FROM_TTN_OUTPUT_FORMAT_EVENT.has(outputEventType)) {
		try {
			return ctx.getNodeParameter('ttnOutputFormatEvent', 0) as string;
		} catch {
			return ctx.getNodeParameter('ttnOutputFormat', 0) as string;
		}
	}
	return 'fullEvent';
}

function asDataObject(v: unknown): IDataObject | undefined {
	if (v !== null && typeof v === 'object' && !Array.isArray(v) && !Buffer.isBuffer(v)) {
		return v as IDataObject;
	}
	return undefined;
}

/**
 * Detect the TTN root event type.
 * `normalized_payload` may be at the root or under `uplink_normalized` (TTS v3).
 */
export function detectRootEventKey(json: IDataObject): string | undefined {
	for (const key of ROOT_EVENT_KEYS) {
		if (Object.prototype.hasOwnProperty.call(json, key) && json[key] != null) {
			return key;
		}
	}
	const uplinkNorm = asDataObject(json.uplink_normalized);
	if (uplinkNorm?.normalized_payload != null) {
		return 'normalized_payload';
	}
	return undefined;
}

/** TTN device id in a webhook / storage body (`end_device_ids`). */
export function ttnWebhookPickDeviceId(root: IDataObject): string | undefined {
	const ed = asDataObject(root.end_device_ids);
	const id = ed?.device_id ?? ed?.deviceId;
	return typeof id === 'string' ? id : undefined;
}

/** TTN application id in a webhook body (`end_device_ids.application_ids`). */
export function ttnWebhookPickApplicationId(root: IDataObject): string | undefined {
	const ed = asDataObject(root.end_device_ids);
	if (!ed) {
		return undefined;
	}
	const appIds = asDataObject(ed.application_ids) ?? asDataObject(ed.applicationIds);
	const fromNested =
		(typeof appIds?.application_id === 'string' && appIds.application_id) ||
		(typeof appIds?.applicationId === 'string' && appIds.applicationId);
	if (fromNested) {
		return fromNested;
	}
	if (typeof ed.application_id === 'string') {
		return ed.application_id;
	}
	return undefined;
}

function pickReceivedAt(root: IDataObject, eventKey?: string): string | undefined {
	if (typeof root.received_at === 'string') {
		return root.received_at;
	}
	if (eventKey) {
		const ev = asDataObject(root[eventKey]);
		if (typeof ev?.received_at === 'string') {
			return ev.received_at;
		}
	}
	const um = asDataObject(root.uplink_message);
	if (typeof um?.received_at === 'string') {
		return um.received_at;
	}
	return undefined;
}

function buildFullEventOutput(json: IDataObject): IDataObject {
	return { ...json };
}

function isFormatAllowedForEvent(eventType: string, format: string): boolean {
	if (eventType === 'uplink_message' || eventType === 'normalized_payload') {
		return UPLINK_FORMATS.has(format);
	}
	if (
		eventType === 'join_accept' ||
		eventType === 'downlink_queue_invalidated' ||
		eventType === 'location_solved' ||
		eventType === 'service_data' ||
		EVENTS_WITH_DOWNLINK_DETAILS.has(eventType) ||
		eventType === 'downlink_failed'
	) {
		return SUMMARY_OR_FULL.has(format);
	}
	return false;
}

function mapUplinkMessage(root: IDataObject, format: string): IDataObject {
	if (format === 'fullEvent') {
		return buildFullEventOutput(root);
	}

	const uplink = asDataObject(root.uplink_message);
	const decodedRaw = uplink?.decoded_payload;
	let dataObj: IDataObject = {};
	if (decodedRaw !== null && decodedRaw !== undefined) {
		if (typeof decodedRaw === 'object' && !Array.isArray(decodedRaw) && !Buffer.isBuffer(decodedRaw)) {
			dataObj = { ...(decodedRaw as IDataObject) };
		}
	}

	if (format === 'sensorValuesOnly') {
		return { ...dataObj };
	}

	/* sensorData */
	const out: IDataObject = {
		event_type: 'uplink_message',
		data: dataObj,
	};
	const dev = ttnWebhookPickDeviceId(root);
	const app = ttnWebhookPickApplicationId(root);
	const ra = pickReceivedAt(root, 'uplink_message');
	const fp = uplink?.f_port;
	if (dev !== undefined) {
		out.device_id = dev;
	}
	if (app !== undefined) {
		out.application_id = app;
	}
	if (ra !== undefined) {
		out.received_at = ra;
	}
	if (fp !== undefined) {
		out.f_port = fp;
	}
	return out;
}

/** `normalized_payload` block (root or under `uplink_normalized`). */
function pickNormalizedPayloadBlock(root: IDataObject): IDataObject | undefined {
	const direct = asDataObject(root.normalized_payload);
	if (direct) {
		return direct;
	}
	const wrap = asDataObject(root.uplink_normalized);
	return asDataObject(wrap?.normalized_payload);
}

/** "Sensor" data: LoRa `decoded_payload` when present, else semantic fields of the normalized block. */
function normalizedPayloadDataObject(block: IDataObject | undefined): IDataObject {
	if (!block) {
		return {};
	}
	const decodedRaw = block.decoded_payload;
	if (decodedRaw !== null && decodedRaw !== undefined) {
		if (typeof decodedRaw === 'object' && !Array.isArray(decodedRaw) && !Buffer.isBuffer(decodedRaw)) {
			return { ...(decodedRaw as IDataObject) };
		}
	}
	/* TTS: temperature/humidity under `air`, `concentration`, etc. — no decoded_payload */
	const skip = new Set(['decoded_payload', 'received_at']);
	const out: IDataObject = {};
	for (const k of Object.keys(block)) {
		if (skip.has(k)) {
			continue;
		}
		const v = block[k];
		if (v !== null && v !== undefined) {
			out[k] = v;
		}
	}
	return out;
}

/** Same logic as `uplink_message`, but for `normalized_payload` (root or `uplink_normalized`). */
function mapNormalizedPayload(root: IDataObject, format: string): IDataObject {
	if (format === 'fullEvent') {
		return buildFullEventOutput(root);
	}

	const wrap = asDataObject(root.uplink_normalized);
	const block = pickNormalizedPayloadBlock(root);
	const dataObj = normalizedPayloadDataObject(block);

	if (format === 'sensorValuesOnly') {
		return { ...dataObj };
	}

	const out: IDataObject = {
		event_type: 'normalized_payload',
		data: dataObj,
	};
	const dev = ttnWebhookPickDeviceId(root);
	const app = ttnWebhookPickApplicationId(root);
	const ra =
		pickReceivedAt(root, 'normalized_payload') ??
		(typeof wrap?.received_at === 'string' ? wrap.received_at : undefined) ??
		(typeof block?.received_at === 'string' ? block.received_at : undefined);
	const fp = block?.f_port ?? wrap?.f_port;
	if (dev !== undefined) {
		out.device_id = dev;
	}
	if (app !== undefined) {
		out.application_id = app;
	}
	if (ra !== undefined) {
		out.received_at = ra;
	}
	if (fp !== undefined) {
		out.f_port = fp;
	}
	return out;
}

function pickDownlinkBlock(root: IDataObject, eventKey: string): IDataObject | undefined {
	return asDataObject(root[eventKey]);
}

function downlinkFportFrm(block: IDataObject | undefined): { f_port?: number; frm_payload?: string } {
	if (!block) {
		return {};
	}
	const inner =
		asDataObject(block.downlink) ??
		asDataObject(block.confirmed_downlink) ??
		asDataObject(block.request) ??
		block;
	const fPort = inner?.f_port ?? inner?.fPort;
	const frm = inner?.frm_payload ?? inner?.frmPayload;
	const out: { f_port?: number; frm_payload?: string } = {};
	if (typeof fPort === 'number') {
		out.f_port = fPort;
	}
	if (typeof frm === 'string') {
		out.frm_payload = frm;
	}
	return out;
}

function mapDownlinkWithStatus(
	root: IDataObject,
	eventKey: string,
	status: string,
	format: string,
	includeDownlink: boolean,
): IDataObject {
	if (format === 'fullEvent') {
		return buildFullEventOutput(root);
	}
	const out: IDataObject = {
		event_type: eventKey,
		status,
	};
	const dev = ttnWebhookPickDeviceId(root);
	const app = ttnWebhookPickApplicationId(root);
	const ra = pickReceivedAt(root, eventKey);
	if (dev !== undefined) {
		out.device_id = dev;
	}
	if (app !== undefined) {
		out.application_id = app;
	}
	if (ra !== undefined) {
		out.received_at = ra;
	}
	if (includeDownlink) {
		const dl = downlinkFportFrm(pickDownlinkBlock(root, eventKey));
		if (Object.keys(dl).length > 0) {
			out.downlink = dl;
		}
	}
	return out;
}

function mapDownlinkFailed(root: IDataObject, format: string): IDataObject {
	if (format === 'fullEvent') {
		return buildFullEventOutput(root);
	}
	const block = pickDownlinkBlock(root, 'downlink_failed');
	const out: IDataObject = {
		event_type: 'downlink_failed',
		status: 'failed',
	};
	const dev = ttnWebhookPickDeviceId(root);
	const app = ttnWebhookPickApplicationId(root);
	const ra = pickReceivedAt(root, 'downlink_failed');
	if (dev !== undefined) {
		out.device_id = dev;
	}
	if (app !== undefined) {
		out.application_id = app;
	}
	if (ra !== undefined) {
		out.received_at = ra;
	}
	const failed = asDataObject(block?.failed);
	const errFromFailed = typeof failed?.error === 'string' ? failed.error : undefined;
	const errMsg =
		(typeof block?.error === 'string' && block.error) ||
		(typeof block?.message === 'string' && block.message) ||
		errFromFailed ||
		(typeof block?.reason === 'string' && block.reason);
	if (typeof errMsg === 'string' && errMsg.length > 0) {
		out.error = errMsg;
	}
	return out;
}

function mapDownlinkQueueInvalidated(root: IDataObject, format: string): IDataObject {
	if (format === 'fullEvent') {
		return buildFullEventOutput(root);
	}
	const out: IDataObject = {
		event_type: 'downlink_queue_invalidated',
		status: 'queue_invalidated',
	};
	const dev = ttnWebhookPickDeviceId(root);
	const app = ttnWebhookPickApplicationId(root);
	const ra = pickReceivedAt(root, 'downlink_queue_invalidated');
	if (dev !== undefined) {
		out.device_id = dev;
	}
	if (app !== undefined) {
		out.application_id = app;
	}
	if (ra !== undefined) {
		out.received_at = ra;
	}
	return out;
}

function mapJoinAccept(root: IDataObject, format: string): IDataObject {
	if (format === 'fullEvent') {
		return buildFullEventOutput(root);
	}
	const out: IDataObject = {
		event_type: 'join_accept',
		status: 'joined',
	};
	const dev = ttnWebhookPickDeviceId(root);
	const app = ttnWebhookPickApplicationId(root);
	const ra = pickReceivedAt(root, 'join_accept');
	if (dev !== undefined) {
		out.device_id = dev;
	}
	if (app !== undefined) {
		out.application_id = app;
	}
	if (ra !== undefined) {
		out.received_at = ra;
	}
	return out;
}

function mapLocationSolved(root: IDataObject, format: string): IDataObject {
	if (format === 'fullEvent') {
		return buildFullEventOutput(root);
	}
	const block = pickDownlinkBlock(root, 'location_solved');
	const out: IDataObject = {
		event_type: 'location_solved',
	};
	const dev = ttnWebhookPickDeviceId(root);
	const app = ttnWebhookPickApplicationId(root);
	const ra = pickReceivedAt(root, 'location_solved');
	if (dev !== undefined) {
		out.device_id = dev;
	}
	if (app !== undefined) {
		out.application_id = app;
	}
	if (ra !== undefined) {
		out.received_at = ra;
	}
	const loc =
		asDataObject(block?.location) ??
		asDataObject(block?.solved_position) ??
		asDataObject(block?.position);
	const lat = loc?.latitude ?? loc?.lat;
	const lon = loc?.longitude ?? loc?.lng ?? loc?.lon;
	const alt = loc?.altitude ?? loc?.alt;
	const locOut: IDataObject = {};
	if (typeof lat === 'number') {
		locOut.latitude = lat;
	}
	if (typeof lon === 'number') {
		locOut.longitude = lon;
	}
	if (typeof alt === 'number') {
		locOut.altitude = alt;
	}
	if (Object.keys(locOut).length > 0) {
		out.location = locOut;
	}
	return out;
}

function mapServiceData(root: IDataObject, format: string): IDataObject {
	if (format === 'fullEvent') {
		return buildFullEventOutput(root);
	}
	const block = pickDownlinkBlock(root, 'service_data');
	const out: IDataObject = {
		event_type: 'service_data',
	};
	const dev = ttnWebhookPickDeviceId(root);
	const app = ttnWebhookPickApplicationId(root);
	const ra = pickReceivedAt(root, 'service_data');
	if (dev !== undefined) {
		out.device_id = dev;
	}
	if (app !== undefined) {
		out.application_id = app;
	}
	if (ra !== undefined) {
		out.received_at = ra;
	}
	const inner = asDataObject(block?.data) ?? block ?? {};
	if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
		out.data = { ...inner };
	} else {
		out.data = {};
	}
	return out;
}

function applyLegacyWebhookPayload(
	root: IDataObject,
	legacyMode: string,
): IDataObject {
	if (legacyMode === 'full') {
		return buildFullEventOutput(root);
	}
	const headers = root._webhookHeaders;
	const query = root._webhookQuery;
	const tag = root._ttnEvent;
	const shaped = ttnShapeApplicationUplinkOutput(
		root,
		legacyMode as 'decodedOnly' | 'decodedWithMeta' | 'full',
	);
	const merged: IDataObject = { ...shaped, _webhookHeaders: headers, _webhookQuery: query };
	if (tag !== undefined) {
		merged._ttnEvent = tag;
	}
	return merged;
}

/**
 * Apply the output shape from **Event type** and related formats.
 * @returns `null` if the body does not match the selected type and skip is enabled:
 * n8n does not run the workflow (`workflowData: undefined`).
 */
export function applyTtnWebhookOutputShape(ctx: IWebhookFunctions, json: IDataObject): IDataObject | null {
	const params = ctx.getNode().parameters as IDataObject;
	const hasNew = Object.prototype.hasOwnProperty.call(params, 'ttnOutputEventType');
	const legacyMode = params.webhookPayloadOutput as string | undefined;

	if (!hasNew && legacyMode !== undefined) {
		return applyLegacyWebhookPayload(json, legacyMode);
	}

	let outputEventType: string;
	try {
		outputEventType = ctx.getNodeParameter('ttnOutputEventType', 0) as string;
	} catch {
		if (legacyMode !== undefined) {
			return applyLegacyWebhookPayload(json, legacyMode);
		}
		outputEventType = 'uplink_message';
	}

	if (outputEventType === 'all') {
		return buildFullEventOutput(json);
	}

	const detected = detectRootEventKey(json);
	if (detected !== outputEventType) {
		let mismatchBehavior = 'skip';
		try {
			mismatchBehavior = ctx.getNodeParameter('ttnWebhookMismatchBehavior', 0) as string;
		} catch {
			mismatchBehavior = 'skip';
		}
		if (mismatchBehavior === 'fullEvent') {
			return buildFullEventOutput(json);
		}
		return null;
	}

	let format: string;
	try {
		format = resolveTtnOutputFormat(ctx, outputEventType);
	} catch {
		return buildFullEventOutput(json);
	}

	if (!isFormatAllowedForEvent(outputEventType, format)) {
		return buildFullEventOutput(json);
	}

	switch (outputEventType) {
		case 'uplink_message':
			return mapUplinkMessage(json, format);
		case 'normalized_payload':
			return mapNormalizedPayload(json, format);
		case 'downlink_ack':
			return mapDownlinkWithStatus(json, 'downlink_ack', 'acknowledged', format, true);
		case 'downlink_nack':
			return mapDownlinkWithStatus(json, 'downlink_nack', 'not_acknowledged', format, true);
		case 'downlink_sent':
			return mapDownlinkWithStatus(json, 'downlink_sent', 'sent', format, true);
		case 'downlink_queued':
			return mapDownlinkWithStatus(json, 'downlink_queued', 'queued', format, true);
		case 'downlink_failed':
			return mapDownlinkFailed(json, format);
		case 'downlink_queue_invalidated':
			return mapDownlinkQueueInvalidated(json, format);
		case 'join_accept':
			return mapJoinAccept(json, format);
		case 'location_solved':
			return mapLocationSolved(json, format);
		case 'service_data':
			return mapServiceData(json, format);
		default:
			return buildFullEventOutput(json);
	}
}
