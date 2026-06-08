import { NodeConnectionType, NodeOperationError } from 'n8n-workflow';
import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import {
	ttnExecuteDownlinkQueue,
	ttnExecuteGetDeviceStatus,
	ttnExecuteGetGatewayStatus,
	ttnExecuteListGateways,
	ttnMapGatewayListResponse,
	ttnExecuteJsonGet,
	ttnExecuteLatestStoredUplink,
	ttnEnrichNodeOperationErrorWithTtnContext,
	ttnExecutionErrorToCleanJson,
	ttnFormatTtnApiErrorDescription,
	ttnGetApplications,
	ttnGetDevices,
	ttnGetGateways,
	ttnSendCommandPreviewNoticeExpression,
	TtnApiError,
	type TtnGatewayListScope,
} from './ttnShared.js';

type TtnResource = 'data' | 'devices' | 'applications' | 'device' | 'lastUplink' | 'gateways';
type TtnDataOperation =
	| 'getLastUplink'
	| 'listDevices'
	| 'getDeviceInfo'
	| 'getDeviceStatus'
	| 'listApplications';
type TtnGatewaysOperation = 'listGateways' | 'getGatewayStatus';

function normalizeResourceOperation(
	resource: string,
	operation: string,
): { resource: TtnResource; operation: string } {
	if (resource === 'data' || resource === 'devices') {
		return { resource: resource as TtnResource, operation };
	}
	if (resource === 'applications' && operation === 'list') {
		return { resource: 'data', operation: 'listApplications' };
	}
	if (resource === 'device') {
		if (operation === 'list') {
			return { resource: 'data', operation: 'listDevices' };
		}
		if (operation === 'get') {
			return { resource: 'data', operation: 'getDeviceInfo' };
		}
	}
	if (resource === 'lastUplink' && operation === 'getLatest') {
		return { resource: 'data', operation: 'getLastUplink' };
	}
	if (resource === 'gateways') {
		return { resource: 'gateways', operation };
	}
	return { resource: resource as TtnResource, operation };
}

function ttnNormalizeMultiSelectIds(raw: unknown): string[] {
	if (Array.isArray(raw)) {
		return raw.filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
	}
	if (typeof raw === 'string' && raw.trim()) {
		return [raw.trim()];
	}
	return [];
}

const ttnOperationLabels: Record<string, Record<string, string>> = {
	data: {
		getLastUplink: 'Data · Get Last Uplink',
		listDevices: 'Data · List Devices',
		getDeviceInfo: 'Data · Get Device Info',
		getDeviceStatus: 'Data · Get Device Status',
		listApplications: 'Data · List Applications',
	},
	devices: {
		sendCommand: 'Devices · Send Downlink',
	},
	gateways: {
		listGateways: 'Gateways · List Gateways',
		getGatewayStatus: 'Gateways · Get Gateway Status',
	},
};

function ttnNodeSubtitleExpression(): string {
	const mapJson = JSON.stringify(ttnOperationLabels);
	return `={{ (${mapJson})[$parameter.resource]?.[$parameter.operation] ?? $parameter.resource + " · " + $parameter.operation }}`;
}

const ttnDescription: INodeTypeDescription = {
	displayName: 'TTN',
	name: 'ttn',
	icon: 'file:ttnNodeIcon.svg',
	group: ['transform'],
	version: 1.92,
	subtitle: ttnNodeSubtitleExpression(),
	description:
		'The Things Stack (TTN / TTS). **Data**, **Devices**, **Gateways**; **Triggers** → **Webhook · Receive Events** from the node picker.',
	defaults: {
		name: 'TTN',
	},
	inputs: [NodeConnectionType.Main],
	outputs: [NodeConnectionType.Main],
	credentials: [
		{
			name: 'ttnApi',
			required: true,
		},
	],
	properties: [
		{
			displayName: 'Resource',
			name: 'resource',
			type: 'options',
			noDataExpression: true,
			options: [
				{
					name: 'Data',
					value: 'data',
					description:
						'Storage (Get Last Uplink), device list, device details, online/offline status, applications',
				},
				{
					name: 'Devices',
					value: 'devices',
					description: 'Send downlink commands (POST …/down/push)',
				},
				{
					name: 'Gateways',
					value: 'gateways',
					description:
						'List gateways (API); get gateway online/offline status (Gateway Server connection stats)',
				},
			],
			default: 'data',
		},
		{
			displayName: 'Operation',
			name: 'operation',
			type: 'options',
			noDataExpression: true,
			displayOptions: {
				show: {
					resource: ['data'],
				},
			},
			options: [
				{
					name: 'Get Last Uplink',
					value: 'getLastUplink',
					action: ttnOperationLabels.data.getLastUplink,
					description:
						'GET …/packages/storage/uplink_message — Storage required; no `limit` parameter (one n8n item per uplink received in the stream)',
				},
				{
					name: 'List Devices',
					value: 'listDevices',
					action: ttnOperationLabels.data.listDevices,
					description: 'GET /api/v3/applications/{application_id}/devices',
				},
				{
					name: 'Get Device Info',
					value: 'getDeviceInfo',
					action: ttnOperationLabels.data.getDeviceInfo,
					description:
						'GET /api/v3/applications/{application_id}/devices/{device_id}',
				},
				{
					name: 'Get Device Status',
					value: 'getDeviceStatus',
					action: ttnOperationLabels.data.getDeviceStatus,
					description:
						'Latest `last_seen_at` + online/offline status (configurable threshold, TTS registry)',
				},
				{
					name: 'List Applications',
					value: 'listApplications',
					action: ttnOperationLabels.data.listApplications,
					description: 'GET /api/v3/applications',
				},
			],
			default: 'getLastUplink',
		},
		{
			displayName: 'Operation',
			name: 'operation',
			type: 'options',
			noDataExpression: true,
			displayOptions: {
				show: {
					resource: ['devices'],
				},
			},
			options: [
				{
					name: 'Send Downlink',
					value: 'sendCommand',
					action: ttnOperationLabels.devices.sendCommand,
					description: 'POST …/down/push',
				},
			],
			default: 'sendCommand',
		},
		{
			displayName: 'Operation',
			name: 'operation',
			type: 'options',
			noDataExpression: true,
			displayOptions: {
				show: {
					resource: ['gateways'],
				},
			},
			options: [
				{
					name: 'List Gateways',
					value: 'listGateways',
					action: ttnOperationLabels.gateways.listGateways,
					description: 'GET /api/v3/gateways or …/users/{ID}/gateways or …/organizations/{id}/gateways',
				},
				{
					name: 'Get Gateway Status',
					value: 'getGatewayStatus',
					action: ttnOperationLabels.gateways.getGatewayStatus,
					description:
						'GET /api/v3/gs/gateways/{gateway_id}/connection/stats — last activity and online/offline',
				},
			],
			default: 'listGateways',
		},
		{
			displayName: 'Gateway ID Names or IDs',
			name: 'gatewayStatusIds',
			type: 'multiOptions',
			typeOptions: {
				loadOptionsMethod: 'getGateways',
			},
			required: true,
			default: [],
			description: 'One or more gateways (visible to the API key). Outputs one item per gateway. Choose from the list, or specify IDs using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			displayOptions: {
				show: {
					resource: ['gateways'],
					operation: ['getGatewayStatus'],
				},
			},
		},
		{
			displayName: 'Status Mode',
			name: 'gatewayStatusMode',
			type: 'options',
			noDataExpression: true,
			displayOptions: {
				show: {
					resource: ['gateways'],
					operation: ['getGatewayStatus'],
				},
			},
			options: [
				{
					name: 'Summary',
					value: 'onlineOffline',
					description:
						'One item per gateway: `{ gateway_id, online, uptime: "5.1 hours" }`',
				},
				{
					name: 'Detailed',
					value: 'detailed',
					description: 'Full status: last_seen_at, uptime, since_last_uplink (auto minutes/hours/days), online_status, etc',
				},
			],
			default: 'detailed',
		},
		{
			displayName: 'Offline Threshold',
			name: 'gatewayStatusOfflineThreshold',
			type: 'number',
			typeOptions: { minValue: 1 },
			default: 24,
			required: true,
			displayOptions: {
				show: {
					resource: ['gateways'],
					operation: ['getGatewayStatus'],
				},
			},
			description: 'If last activity is older than this window → **offline**; otherwise **online**',
		},
		{
			displayName: 'Offline Threshold Unit',
			name: 'gatewayStatusOfflineThresholdUnit',
			type: 'options',
			noDataExpression: true,
			options: [
				{ name: 'Minutes', value: 'minutes' },
				{ name: 'Hours', value: 'hours' },
				{ name: 'Days', value: 'days' },
			],
			default: 'hours',
			required: true,
			displayOptions: {
				show: {
					resource: ['gateways'],
					operation: ['getGatewayStatus'],
				},
			},
		},
		{
			displayName: 'List Gateways — Scope',
			name: 'gatewayListScope',
			type: 'options',
			noDataExpression: true,
			displayOptions: {
				show: {
					resource: ['gateways'],
					operation: ['listGateways'],
				},
			},
			options: [
				{
					name: 'All (Visible to the Key)',
					value: 'all',
					description: 'GET /api/v3/gateways',
				},
				{
					name: 'User',
					value: 'user',
					description: 'GET /api/v3/users/{user_id}/gateways',
				},
				{
					name: 'Organization',
					value: 'organization',
					description: 'GET /api/v3/organizations/{org_id}/gateways',
				},
			],
			default: 'all',
		},
		{
			displayName: 'User ID (Console TTS)',
			name: 'gatewayListUserId',
			type: 'string',
			placeholder: 'jane-doe',
			default: '',
			displayOptions: {
				show: {
					resource: ['gateways'],
					operation: ['listGateways'],
					gatewayListScope: ['user'],
				},
			},
			description: 'User ID (console profile); required when scope is User',
		},
		{
			displayName: 'Organization ID',
			name: 'gatewayListOrgId',
			type: 'string',
			placeholder: 'my-org',
			default: '',
			displayOptions: {
				show: {
					resource: ['gateways'],
					operation: ['listGateways'],
					gatewayListScope: ['organization'],
				},
			},
			description: 'TTS organization ID; required when scope is Organization',
		},
		{
			displayName: 'Output',
			name: 'gatewayListOutput',
			type: 'options',
			noDataExpression: true,
			displayOptions: {
				show: {
					resource: ['gateways'],
					operation: ['listGateways'],
				},
			},
			options: [
				{
					name: 'Detailed',
					value: 'detailed',
					description: 'Full gateway objects from TTS (`gateways` array)',
				},
				{
					name: 'Summary',
					value: 'summary',
					description: 'One item per gateway: `gateway_id`, `name`',
				},
			],
			default: 'detailed',
		},
		{
			displayName: 'Include Location',
			name: 'gatewayListIncludeLocation',
			type: 'boolean',
			default: true,
			displayOptions: {
				show: {
					resource: ['gateways'],
					operation: ['listGateways'],
				},
			},
			description:
				'When enabled, includes antenna location (`latitude`, `longitude`, `altitude`). In Summary mode, adds a `location` field when available.',
		},
		{
			displayName: 'Storage Scope',
			name: 'storageScope',
			type: 'options',
			noDataExpression: true,
			displayOptions: {
				show: {
					resource: ['data'],
					operation: ['getLastUplink'],
				},
			},
			options: [
				{
					name: 'One Device',
					value: 'device',
					description:
						'…/applications/{app}/devices/{device}/packages/storage/uplink_message',
				},
				{
					name: 'Whole Application',
					value: 'application',
					description:
						'…/applications/{app}/packages/storage/uplink_message',
				},
			],
			default: 'device',
			description: 'Application-wide or single device',
		},
		{
			displayName: '`Last` Window (Same as TTN Console)',
			name: 'storageLast',
			type: 'options',
			noDataExpression: true,
			displayOptions: {
				show: {
					resource: ['data'],
					operation: ['getLastUplink'],
				},
			},
			options: [
				{ name: 'None (Omit Last)', value: '' },
				{ name: 'Last Hour', value: '1h' },
				{ name: 'Last 3 Hours', value: '3h' },
				{ name: 'Last 6 Hours', value: '6h' },
				{ name: 'Last 12 Hours', value: '12h' },
				{ name: 'Last 24 Hours', value: '24h' },
				{ name: 'Last 2 Days', value: '48h' },
				{ name: 'Last 7 Days', value: '168h' },
				{ name: 'Last 30 Days', value: '720h' },
				{ name: 'Last 90 Days', value: '2160h' },
			],
			default: '12h',
			description:
				'Sent to the API as `last=1h`, `last=2160h`, etc. (duration in hours + `h` suffix, same as The Things Stack).',
		},
		{
			displayName: 'Application Name or ID',
			name: 'applicationId',
			type: 'options',
			typeOptions: {
				loadOptionsMethod: 'getApplications',
			},
			required: true,
			default: '',
			description: 'GET /api/v3/applications. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			displayOptions: {
				show: {
					resource: ['data'],
					operation: ['getLastUplink', 'listDevices', 'getDeviceInfo', 'getDeviceStatus'],
				},
			},
		},
		{
			displayName: 'Application Name or ID',
			name: 'applicationId',
			type: 'options',
			typeOptions: {
				loadOptionsMethod: 'getApplications',
			},
			required: true,
			default: '',
			description: 'GET /api/v3/applications. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			displayOptions: {
				show: {
					resource: ['devices'],
				},
			},
		},
		{
			displayName: 'Device ID (Storage) Name or ID',
			name: 'storageDeviceId',
			type: 'options',
			typeOptions: {
				loadOptionsMethod: 'getDevices',
				loadOptionsDependsOn: ['applicationId'],
			},
			required: true,
			default: '',
			description: 'Required when Storage scope is a single device. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			displayOptions: {
				show: {
					resource: ['data'],
					operation: ['getLastUplink'],
					storageScope: ['device'],
				},
			},
		},
		{
			displayName: 'Device Name or ID',
			name: 'deviceId',
			type: 'options',
			typeOptions: {
				loadOptionsMethod: 'getDevices',
				loadOptionsDependsOn: ['applicationId'],
			},
			required: true,
			default: '',
			description: 'Target device. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			displayOptions: {
				show: {
					resource: ['data'],
					operation: ['getDeviceInfo'],
				},
			},
		},
		{
			displayName: 'Device ID Names or IDs',
			name: 'deviceStatusIds',
			type: 'multiOptions',
			typeOptions: {
				loadOptionsMethod: 'getDevices',
				loadOptionsDependsOn: ['applicationId'],
			},
			required: true,
			default: [],
			description: 'One or more devices. Outputs one item per device. Choose from the list, or specify IDs using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			displayOptions: {
				show: {
					resource: ['data'],
					operation: ['getDeviceStatus'],
				},
			},
		},
		{
			displayName: 'Status Mode',
			name: 'deviceStatusMode',
			type: 'options',
			noDataExpression: true,
			displayOptions: {
				show: {
					resource: ['data'],
					operation: ['getDeviceStatus'],
				},
			},
			options: [
				{
					name: 'Summary',
					value: 'onlineOffline',
					description:
						'One item per device: `{ device_id, online, last_seen: "3 minutes ago" }`',
				},
				{
					name: 'Detailed',
					value: 'detailed',
					description: 'Full status: last_seen_at, online_status, threshold, etc',
				},
			],
			default: 'detailed',
		},
		{
			displayName: 'Offline Threshold',
			name: 'deviceStatusOfflineThreshold',
			type: 'number',
			typeOptions: { minValue: 1 },
			default: 24,
			required: true,
			displayOptions: {
				show: {
					resource: ['data'],
					operation: ['getDeviceStatus'],
				},
			},
			description: 'If `last_seen_at` is older than this window → **offline**; otherwise **online**',
		},
		{
			displayName: 'Offline Threshold Unit',
			name: 'deviceStatusOfflineThresholdUnit',
			type: 'options',
			noDataExpression: true,
			options: [
				{ name: 'Minutes', value: 'minutes' },
				{ name: 'Hours', value: 'hours' },
				{ name: 'Days', value: 'days' },
			],
			default: 'hours',
			required: true,
			displayOptions: {
				show: {
					resource: ['data'],
					operation: ['getDeviceStatus'],
				},
			},
		},
		{
			displayName: 'Device Name or ID',
			name: 'deviceId',
			type: 'options',
			typeOptions: {
				loadOptionsMethod: 'getDevices',
				loadOptionsDependsOn: ['applicationId'],
			},
			required: true,
			default: '',
			description: 'Target device for the downlink. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			displayOptions: {
				show: {
					resource: ['devices'],
				},
			},
		},
		{
			displayName: 'Uplink Output Shape',
			name: 'storageOutput',
			type: 'options',
			noDataExpression: true,
			displayOptions: {
				show: {
					resource: ['data'],
					operation: ['getLastUplink'],
				},
			},
			options: [
				{
					name: 'Decoded Payload + Meta',
					value: 'decodedWithMeta',
					description: 'Decoded_payload, received_at, end_device_ids, f_port',
				},
				{
					name: 'Decoded Payload only (Root)',
					value: 'decodedOnly',
					description: 'Formatter fields at the root',
				},
				{
					name: 'Full Storage Record',
					value: 'full',
					description: 'Raw uplink_message structure, frm_payload, etc.',
				},
			],
			default: 'full',
			description: 'Shape of each Storage record (one n8n item per uplink)',
		},
		{
			displayName: 'FPort',
			name: 'fPort',
			type: 'number',
			typeOptions: { minValue: 1, maxValue: 223 },
			default: 1,
			required: true,
			displayOptions: {
				show: {
					resource: ['devices'],
				},
			},
			description: 'LoRaWAN application port (1–223)',
		},
		{
			displayName: 'Payload Type',
			name: 'payloadFormat',
			type: 'options',
			noDataExpression: true,
			displayOptions: {
				show: {
					resource: ['devices'],
				},
			},
			options: [
				{
					name: 'Hex',
					value: 'hex',
					description:
						'Hex without 0x prefix; even length; uppercase 0-9 and A-F only',
				},
				{
					name: 'JSON (Decoded_payload)',
					value: 'decodedJson',
					description: 'Valid JSON object for decoded_payload',
				},
			],
			default: 'hex',
			description: 'Downlink payload type (same terminology as The Things Stack)',
		},
		{
			displayName: 'Payload',
			name: 'payload',
			type: 'string',
			typeOptions: {
				rows: 4,
			},
			default: '',
			displayOptions: {
				show: {
					resource: ['devices'],
				},
			},
			description: 'Hex (no 0x) or JSON object depending on payload type',
		},
		{
			displayName: 'Priority',
			name: 'priority',
			type: 'options',
			noDataExpression: true,
			displayOptions: {
				show: {
					resource: ['devices'],
				},
			},
			options: [
				{ name: 'LOWEST', value: 'LOWEST' },
				{ name: 'LOW', value: 'LOW' },
				{ name: 'NORMAL', value: 'NORMAL' },
				{ name: 'HIGH', value: 'HIGH' },
				{ name: 'HIGHEST', value: 'HIGHEST' },
			],
			default: 'NORMAL',
			description: 'Downlink queue priority',
		},
		{
			displayName: 'Confirmed Downlink',
			name: 'confirmed',
			type: 'boolean',
			default: false,
			displayOptions: {
				show: {
					resource: ['devices'],
				},
			},
			description: 'Device must ACK (confirmed downlink)',
		},
		{
			displayName: ttnSendCommandPreviewNoticeExpression(),
			name: 'sendCommandPreview',
			type: 'notice',
			default: '',
			displayOptions: {
				show: {
					resource: ['devices'],
				},
			},
		},
	],
};

export class Ttn implements INodeType {
	description: INodeTypeDescription = ttnDescription;

	methods = {
		loadOptions: {
			getApplications: ttnGetApplications,
			getDevices: ttnGetDevices,
			getGateways: ttnGetGateways,
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		let items = this.getInputData();
		const rawR0 = this.getNodeParameter('resource', 0) as string;
		const rawO0 = this.getNodeParameter('operation', 0) as string;
		const norm0 = normalizeResourceOperation(rawR0, rawO0);

		if (items.length === 0) {
			if (
				(norm0.resource === 'gateways' &&
					(norm0.operation === 'listGateways' || norm0.operation === 'getGatewayStatus')) ||
				(norm0.resource === 'data' &&
					(norm0.operation === 'getDeviceStatus' || norm0.operation === 'getLastUplink'))
			) {
				items = [{ json: {} }];
			}
		}

		const out: INodeExecutionData[] = [];

		for (let i = 0; i < items.length; i++) {
			let ttnExecuteResource: 'data' | 'devices' | 'gateways' | 'other' = 'other';
			try {
				const rawResource = this.getNodeParameter('resource', i) as string;
				const rawOperation = this.getNodeParameter('operation', i) as string;
				const { resource, operation } = normalizeResourceOperation(
					rawResource,
					rawOperation,
				);

				let json: IDataObject | IDataObject[];

				if (resource === 'data') {
					ttnExecuteResource = 'data';
					const op = operation as TtnDataOperation;
					if (op === 'listApplications') {
						json = await ttnExecuteJsonGet(this, '/api/v3/applications');
					} else if (op === 'listDevices') {
						const applicationId = this.getNodeParameter('applicationId', i) as string;
						json = await ttnExecuteJsonGet(
							this,
							`/api/v3/applications/${encodeURIComponent(applicationId)}/devices`,
						);
					} else if (op === 'getDeviceInfo') {
						const applicationId = this.getNodeParameter('applicationId', i) as string;
						const deviceId = this.getNodeParameter('deviceId', i) as string;
						json = await ttnExecuteJsonGet(
							this,
							`/api/v3/applications/${encodeURIComponent(applicationId)}/devices/${encodeURIComponent(deviceId)}`,
						);
					} else if (op === 'getDeviceStatus') {
						const applicationId = this.getNodeParameter('applicationId', i) as string;
						const deviceIds = ttnNormalizeMultiSelectIds(
							this.getNodeParameter('deviceStatusIds', i),
						);
						if (deviceIds.length === 0) {
							throw new NodeOperationError(
								this.getNode(),
								'Select at least one device.',
								{ itemIndex: i },
							);
						}
						const offlineThreshold = this.getNodeParameter(
							'deviceStatusOfflineThreshold',
							i,
						) as number;
						const offlineThresholdUnit = this.getNodeParameter(
							'deviceStatusOfflineThresholdUnit',
							i,
						) as 'minutes' | 'hours' | 'days';
						const statusMode = this.getNodeParameter('deviceStatusMode', i) as
							| 'onlineOffline'
							| 'detailed';
						for (const deviceId of deviceIds) {
							const row = await ttnExecuteGetDeviceStatus(
								this,
								applicationId,
								deviceId,
								offlineThreshold,
								offlineThresholdUnit,
								statusMode,
							);
							out.push({ json: row, pairedItem: { item: i } });
						}
						continue;
					} else if (op === 'getLastUplink') {
						const applicationId = this.getNodeParameter('applicationId', i) as string;
						const storageScope = (this.getNodeParameter('storageScope', i) as string) as
							| 'application'
							| 'device';
						const storageLast = this.getNodeParameter('storageLast', i) as string;
						const storageOutput = (this.getNodeParameter('storageOutput', i) as string) as
							| 'full'
							| 'decodedOnly'
							| 'decodedWithMeta';
						let deviceId = '';
						if (storageScope === 'device') {
							try {
								deviceId = this.getNodeParameter('storageDeviceId', i) as string;
							} catch {
								deviceId = '';
							}
							if (!deviceId?.trim()) {
								try {
									deviceId = this.getNodeParameter('deviceId', i) as string;
								} catch {
									deviceId = '';
								}
							}
						}
						const storageRows = await ttnExecuteLatestStoredUplink(this, {
							applicationId,
							deviceId,
							scope: storageScope,
							last: storageLast,
							outputMode: storageOutput,
						});
						for (const row of storageRows) {
							out.push({ json: row, pairedItem: { item: i } });
						}
						continue;
					} else {
						throw new NodeOperationError(
							this.getNode(),
							`Unhandled Data operation: ${op}`,
							{ itemIndex: i },
						);
					}
				} else if (resource === 'devices') {
					ttnExecuteResource = 'devices';
					const applicationId = this.getNodeParameter('applicationId', i) as string;
					const deviceId = this.getNodeParameter('deviceId', i) as string;
					json = await ttnExecuteDownlinkQueue(
						this,
						i,
						applicationId,
						deviceId,
						'push',
					);
				} else if (resource === 'gateways') {
					ttnExecuteResource = 'gateways';
					const op = operation as TtnGatewaysOperation;
					if (op === 'listGateways') {
						const scope = this.getNodeParameter('gatewayListScope', i) as TtnGatewayListScope;
						// Hidden by displayOptions: reading them here causes "Could not get parameter" (n8n).
						let userId = '';
						let orgId = '';
						if (scope === 'user') {
							userId = (this.getNodeParameter('gatewayListUserId', i) as string) ?? '';
						} else if (scope === 'organization') {
							orgId = (this.getNodeParameter('gatewayListOrgId', i) as string) ?? '';
						}
						const outputMode = this.getNodeParameter('gatewayListOutput', i) as
							| 'detailed'
							| 'summary';
						const includeLocation = this.getNodeParameter(
							'gatewayListIncludeLocation',
							i,
						) as boolean;
						const raw = await ttnExecuteListGateways(
							this,
							scope,
							userId,
							orgId,
							includeLocation,
						);
						const rows = ttnMapGatewayListResponse(raw, outputMode, includeLocation);
						for (const row of rows) {
							out.push({ json: row, pairedItem: { item: i } });
						}
						continue;
					} else if (op === 'getGatewayStatus') {
						const gatewayIds = ttnNormalizeMultiSelectIds(
							this.getNodeParameter('gatewayStatusIds', i),
						);
						if (gatewayIds.length === 0) {
							throw new NodeOperationError(
								this.getNode(),
								'Select at least one gateway.',
								{ itemIndex: i },
							);
						}
						const offlineThreshold = this.getNodeParameter(
							'gatewayStatusOfflineThreshold',
							i,
						) as number;
						const offlineThresholdUnit = this.getNodeParameter(
							'gatewayStatusOfflineThresholdUnit',
							i,
						) as 'minutes' | 'hours' | 'days';
						const statusMode = this.getNodeParameter('gatewayStatusMode', i) as
							| 'onlineOffline'
							| 'detailed';
						for (const gatewayId of gatewayIds) {
							const row = await ttnExecuteGetGatewayStatus(
								this,
								gatewayId,
								offlineThreshold,
								offlineThresholdUnit,
								statusMode,
							);
							out.push({ json: row, pairedItem: { item: i } });
						}
						continue;
					} else {
						throw new NodeOperationError(
							this.getNode(),
							`Unhandled Gateways operation: ${String(op)}`,
							{ itemIndex: i },
						);
					}
				} else {
					throw new NodeOperationError(
						this.getNode(),
						`Unhandled resource / operation pair: ${rawResource} / ${rawOperation}`,
						{ itemIndex: i },
					);
				}

				out.push({ json, pairedItem: { item: i } });
			} catch (error) {
				if (this.continueOnFail()) {
					out.push({
						json: ttnExecutionErrorToCleanJson(error),
						error,
						pairedItem: { item: i },
					});
					continue;
				}
				if (error instanceof NodeOperationError) {
					throw error;
				}
				if (error instanceof TtnApiError) {
					const opErr = new NodeOperationError(this.getNode(), error, {
						message: error.clean.main_message,
						itemIndex: i,
						description: ttnFormatTtnApiErrorDescription(error.clean),
					});
					ttnEnrichNodeOperationErrorWithTtnContext(opErr, error.clean);
					throw opErr;
				}
				throw new NodeOperationError(this.getNode(), error as Error, {
					itemIndex: i,
					...(ttnExecuteResource === 'devices'
						? {
								description:
									'Downlink: the response comes from the Application Server API (POST …/as/…/down/push or …/replace). It may be a 4xx/5xx error while the TTS console still shows the application payload was received.',
							}
						: ttnExecuteResource === 'gateways'
							? {
									description:
										'Gateways: calls the Gateway Registry (GET /api/v3/gateways…). Check the API key rights and scope (global / user / organization).',
								}
							: {}),
				});
			}
		}

		return [out];
	}
}

export { Ttn as ttn };
