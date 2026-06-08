import type {
	IDataObject,
	INodeExecutionData,
	INodeProperties,
	IWebhookFunctions,
	IWebhookResponseData,
} from 'n8n-workflow';
import {
	applyTtnWebhookOutputShape,
	detectRootEventKey,
	ttnWebhookPickApplicationId,
	ttnWebhookPickDeviceId,
} from './ttnWebhookOutputMapper.js';
import { ttnGetApplications, ttnGetDevices } from './ttnShared.js';

/** Application / device lists (TTN credentials) for webhook triggers. */
export const ttnWebhookTriggerLoadOptions = {
	getApplications: ttnGetApplications,
	getDevices: ttnGetDevices,
};

/** Optional filter by application (API list) and by devices (uplink / other events with end_device_ids). */
export const ttnWebhookDeviceFilterProperties: INodeProperties[] = [
	{
		displayName: 'Application (API) Name or ID',
		name: 'applicationId',
		type: 'options',
		typeOptions: {
			loadOptionsMethod: 'getApplications',
		},
		default: '',
		description: 'Loads the device list via the API. If set with a device filter, the webhook application_id must match. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
	},
	{
		displayName: 'Allowed Device Names or IDs',
		name: 'ttnWebhookDeviceIds',
		type: 'multiOptions',
		typeOptions: {
			loadOptionsMethod: 'getDevices',
			loadOptionsDependsOn: ['applicationId'],
		},
		default: [],
		description: 'Leave empty: all devices. Otherwise only events whose device_id is in the list start the workflow (HTTP 200 with no run otherwise). Choose from the list, or specify IDs using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
	},
];

function normalizeWebhookDeviceIdFilter(raw: unknown): string[] {
	if (raw === undefined || raw === null) {
		return [];
	}
	if (Array.isArray(raw)) {
		return raw.filter((x): x is string => typeof x === 'string' && x.length > 0);
	}
	if (typeof raw === 'string' && raw.length > 0) {
		return [raw];
	}
	return [];
}

/**
 * Filter by device_id (and optionally application_id) before shaping the output.
 * @returns `true` to skip execution (same as mismatch skip).
 */
export function ttnWebhookShouldSkipForDeviceFilter(
	ctx: IWebhookFunctions,
	json: IDataObject,
): boolean {
	let allowed: string[] = [];
	try {
		allowed = normalizeWebhookDeviceIdFilter(ctx.getNodeParameter('ttnWebhookDeviceIds', 0));
	} catch {
		return false;
	}
	if (allowed.length === 0) {
		return false;
	}
	const dev = ttnWebhookPickDeviceId(json);
	if (dev === undefined || !allowed.includes(dev)) {
		return true;
	}
	let appParam = '';
	try {
		appParam = String(ctx.getNodeParameter('applicationId', 0) ?? '').trim();
	} catch {
		appParam = '';
	}
	if (appParam.length > 0) {
		const appPayload = ttnWebhookPickApplicationId(json);
		if (appPayload !== appParam) {
			return true;
		}
	}
	return false;
}

/** Output shape by TTN event type (triggers). */
export const ttnWebhookOutputFormatProperties: INodeProperties[] = [
	{
		displayName: 'Event Type',
		name: 'ttnOutputEventType',
		type: 'options',
		noDataExpression: true,
		options: [
			{ name: 'Uplink Message', value: 'uplink_message' },
			{
				name: 'Normalized Uplink',
				value: 'normalized_payload',
				description:
					'TTS normalized payload: root `normalized_payload` or `uplink_normalized.normalized_payload`',
			},
			{ name: 'Join Accept', value: 'join_accept' },
			{ name: 'Downlink Ack', value: 'downlink_ack' },
			{ name: 'Downlink Nack', value: 'downlink_nack' },
			{ name: 'Downlink Sent', value: 'downlink_sent' },
			{ name: 'Downlink Failed', value: 'downlink_failed' },
			{ name: 'Downlink Queued', value: 'downlink_queued' },
			{ name: 'Downlink Queue Invalidated', value: 'downlink_queue_invalidated' },
			{ name: 'Location Solved', value: 'location_solved' },
			{ name: 'Service Data', value: 'service_data' },
			{
				name: 'All',
				value: 'all',
				description:
					'Raw webhook JSON only — output format is forced to Full event',
			},
		],
		default: 'uplink_message',
		description:
			'Event you configure the output format for. If the received webhook does not match, output falls back to Full event automatically.',
	},
	{
		displayName: 'Output Format',
		name: 'ttnOutputFormat',
		type: 'options',
		noDataExpression: true,
		displayOptions: {
			show: {
				ttnOutputEventType: ['uplink_message', 'normalized_payload'],
			},
		},
		options: [
			{
				name: 'Sensor Data',
				value: 'sensorData',
				description: 'Device_id, application_id, received_at, f_port, data (decoded_payload)',
			},
			{
				name: 'Sensor Values Only',
				value: 'sensorValuesOnly',
				description: 'Only decoded_payload fields at the root',
			},
			{ name: 'Full Event', value: 'fullEvent', description: 'Full TTN webhook body' },
		],
		default: 'sensorData',
	},
	{
		displayName: 'Output Format',
		/** Distinct name from `ttnOutputFormat`: duplicate names break n8n resolution. */
		name: 'ttnOutputFormatEvent',
		type: 'options',
		noDataExpression: true,
		displayOptions: {
			show: {
				ttnOutputEventType: [
					'downlink_ack',
					'downlink_nack',
					'downlink_sent',
					'downlink_queued',
					'downlink_failed',
					'downlink_queue_invalidated',
					'join_accept',
					'location_solved',
					'service_data',
				],
			},
		},
		options: [
			{
				name: 'Event Summary',
				value: 'eventSummary',
				description: 'Structured summary by event type',
			},
			{ name: 'Full Event', value: 'fullEvent', description: 'Full TTN webhook body' },
		],
		default: 'eventSummary',
	},
	{
		displayName: 'When JSON Does Not Match Event Type',
		name: 'ttnWebhookMismatchBehavior',
		type: 'options',
		noDataExpression: true,
		displayOptions: {
			hide: {
				ttnOutputEventType: ['all'],
			},
		},
		options: [
			{
				name: 'Do Not Start Workflow (Recommended)',
				value: 'skip',
				description: 'Respond 200 without running — avoids a “ghost” run when TTS sends several messages (e.g. uplink + normalized) to the same URL',
			},
			{
				name: 'Run with Full Webhook JSON',
				value: 'fullEvent',
				description: 'Legacy behavior: one execution with the full body even when the type does not match',
			},
		],
		default: 'skip',
	},
];

export async function ttnRunWebhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
	let json: IDataObject = {};

	try {
		const req = this.getRequestObject();
		let rawBody: unknown = req.body;

		if (typeof rawBody === 'string' && rawBody.trim() !== '') {
			try {
				rawBody = JSON.parse(rawBody) as unknown;
			} catch {
				// non-JSON body, keep raw
			}
		}

		if (
			rawBody !== null &&
			typeof rawBody === 'object' &&
			!Buffer.isBuffer(rawBody) &&
			!Array.isArray(rawBody)
		) {
			json = { ...(rawBody as IDataObject) };
			json._webhookHeaders = req.headers as unknown as IDataObject;
			json._webhookQuery = (req.query ?? {}) as IDataObject;
		} else {
			json = {
				payload: rawBody as IDataObject | IDataObject[] | string | number | boolean | null,
				_webhookHeaders: req.headers as unknown as IDataObject,
				_webhookQuery: (req.query ?? {}) as IDataObject,
			};
		}

		if (ttnWebhookShouldSkipForDeviceFilter(this, json)) {
			return {
				workflowData: undefined,
				webhookResponse: {
					statusCode: 200,
					body: '',
				},
			};
		}

		const detectedKey = detectRootEventKey(json);
		if (detectedKey !== undefined) {
			json._ttnEvent = detectedKey;
		}

		const shaped = applyTtnWebhookOutputShape(this, json);
		if (shaped === null) {
			return {
				workflowData: undefined,
				webhookResponse: {
					statusCode: 200,
					body: '',
				},
			};
		}
		json = shaped;
	} catch (error) {
		json = {
			_ttnError: true,
			message: error instanceof Error ? error.message : 'Unknown webhook parsing error',
		};
	}

	const item: INodeExecutionData = { json };

	return {
		workflowData: [[item]],
		webhookResponse: {
			statusCode: 200,
			body: '',
		},
	};
}
