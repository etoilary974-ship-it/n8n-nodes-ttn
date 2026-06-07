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

const ttnDescription: INodeTypeDescription = {
	displayName: 'TTN',
	name: 'ttn',
	icon: 'file:ttnNodeIcon.svg',
	group: ['transform'],
	version: 1.92,
	subtitle: '={{$parameter["resource"] + " · " + $parameter["operation"]}}',
	description:
		'The Things Stack (TTN / TTS). **Data**, **Devices**, **Gateways**; **Triggers** → **Receive Sensor Data** (webhook) from the node picker.',
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
						'Storage, device list, device details, online/offline status, applications',
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
					action: 'Get Last Uplink',
					description:
						'GET …/packages/storage/uplink_message — Storage required; no `limit` parameter (one n8n item per uplink received in the stream)',
				},
				{
					name: 'List Devices',
					value: 'listDevices',
					action: 'List Devices',
					description: 'GET /api/v3/applications/{application_id}/devices',
				},
				{
					name: 'Get Device Info',
					value: 'getDeviceInfo',
					action: 'Get Device Info',
					description:
						'GET /api/v3/applications/{application_id}/devices/{device_id}',
				},
				{
					name: 'Get Device Status',
					value: 'getDeviceStatus',
					action: 'Get Device Status',
					description:
						'Latest `last_seen_at` + online/offline status (configurable threshold, TTS registry)',
				},
				{
					name: 'List Applications',
					value: 'listApplications',
					action: 'List Applications',
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
					name: 'Send Command (Downlink)',
					value: 'sendCommand',
					action: 'Send Command (Downlink)',
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
					action: 'List Gateways',
					description:
						'GET /api/v3/gateways ou …/users/{id}/gateways ou …/organizations/{id}/gateways',
				},
				{
					name: 'Get Gateway Status',
					value: 'getGatewayStatus',
					action: 'Get Gateway Status',
					description:
						'GET /api/v3/gs/gateways/{gateway_id}/connection/stats — last activity and online/offline',
				},
			],
			default: 'listGateways',
		},
		{
			displayName: 'Gateway IDs',
			name: 'gatewayStatusIds',
			type: 'multiOptions',
			typeOptions: {
				loadOptionsMethod: 'getGateways',
			},
			required: true,
			default: [],
			description:
				'One or more gateways (visible to the API key). Outputs one item per gateway.',
			displayOptions: {
				show: {
					resource: ['gateways'],
					operation: ['getGatewayStatus'],
				},
			},
		},
		{
			displayName: 'Status mode',
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
					name: 'Online / Offline',
					value: 'onlineOffline',
					description: 'One item per gateway: `{ gateway_id, online }`',
				},
				{
					name: 'Detailed',
					value: 'detailed',
					description:
						'Full status: last_seen_at, online_status, threshold, connection stats, etc.',
				},
			],
			default: 'detailed',
		},
		{
			displayName: 'Offline threshold',
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
			description:
				'If last activity is older than this window → **offline**; otherwise **online**.',
		},
		{
			displayName: 'Offline threshold unit',
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
			displayName: 'List gateways — scope',
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
					name: 'All (visible to the key)',
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
			displayName: 'User ID (console TTS)',
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
			displayName: 'Include location',
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
			displayName:
				'**Storage**: `curl -G …/packages/storage/uplink_message` with `Accept: text/event-stream` and the **Application Server** API key from credentials. Cluster URL = console host (e.g. eu1.cloud.thethings.network). **Device scope**: `…/applications/{app}/devices/{dev}/packages/storage/…`. **Lists** apps/devices use the same key.',
			name: 'storageIntegrationNotice',
			type: 'notice',
			default: '',
			displayOptions: {
				show: {
					resource: ['data'],
					operation: ['getLastUplink'],
				},
			},
		},
		{
			displayName:
				'**Downlink**: Bearer authentication only; the API key must allow application traffic (downlinks). No webhook required.',
			name: 'downlinkApiNotice',
			type: 'notice',
			default: '',
			displayOptions: {
				show: {
					resource: ['devices'],
				},
			},
		},
		{
			displayName: 'Storage scope',
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
					name: 'One device',
					value: 'device',
					description:
						'…/applications/{app}/devices/{device}/packages/storage/uplink_message',
				},
				{
					name: 'Whole application',
					value: 'application',
					description:
						'…/applications/{app}/packages/storage/uplink_message',
				},
			],
			default: 'device',
			description: 'Application-wide or single device',
		},
		{
			displayName: '`last` window (same as TTN console)',
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
				{ name: 'None (omit last)', value: '' },
				{ name: 'Last hour', value: '1h' },
				{ name: 'Last 3 hours', value: '3h' },
				{ name: 'Last 6 hours', value: '6h' },
				{ name: 'Last 12 hours', value: '12h' },
				{ name: 'Last 24 hours', value: '24h' },
				{ name: 'Last 2 days', value: '48h' },
				{ name: 'Last 7 days', value: '168h' },
				{ name: 'Last 30 days', value: '720h' },
				{ name: 'Last 90 days', value: '2160h' },
			],
			default: '12h',
			description:
				'Sent to the API as `last=1h`, `last=2160h`, etc. (duration in hours + `h` suffix, same as The Things Stack).',
		},
		{
			displayName: 'Application ID',
			name: 'applicationId',
			type: 'options',
			typeOptions: {
				loadOptionsMethod: 'getApplications',
			},
			required: true,
			default: '',
			description: 'GET /api/v3/applications',
			displayOptions: {
				show: {
					resource: ['data'],
					operation: ['getLastUplink', 'listDevices', 'getDeviceInfo', 'getDeviceStatus'],
				},
			},
		},
		{
			displayName: 'Application ID',
			name: 'applicationId',
			type: 'options',
			typeOptions: {
				loadOptionsMethod: 'getApplications',
			},
			required: true,
			default: '',
			description: 'GET /api/v3/applications',
			displayOptions: {
				show: {
					resource: ['devices'],
				},
			},
		},
		{
			displayName: 'Device ID (storage)',
			name: 'storageDeviceId',
			type: 'options',
			typeOptions: {
				loadOptionsMethod: 'getDevices',
				loadOptionsDependsOn: ['applicationId'],
			},
			required: true,
			default: '',
			description: 'Required when Storage scope is a single device',
			displayOptions: {
				show: {
					resource: ['data'],
					operation: ['getLastUplink'],
					storageScope: ['device'],
				},
			},
		},
		{
			displayName: 'Device ID',
			name: 'deviceId',
			type: 'options',
			typeOptions: {
				loadOptionsMethod: 'getDevices',
				loadOptionsDependsOn: ['applicationId'],
			},
			required: true,
			default: '',
			description: 'Target device',
			displayOptions: {
				show: {
					resource: ['data'],
					operation: ['getDeviceInfo'],
				},
			},
		},
		{
			displayName: 'Device IDs',
			name: 'deviceStatusIds',
			type: 'multiOptions',
			typeOptions: {
				loadOptionsMethod: 'getDevices',
				loadOptionsDependsOn: ['applicationId'],
			},
			required: true,
			default: [],
			description: 'One or more devices. Outputs one item per device.',
			displayOptions: {
				show: {
					resource: ['data'],
					operation: ['getDeviceStatus'],
				},
			},
		},
		{
			displayName: 'Status mode',
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
					name: 'Online / Offline',
					value: 'onlineOffline',
					description: 'One item per device: `{ device_id, online }`',
				},
				{
					name: 'Detailed',
					value: 'detailed',
					description:
						'Full status: last_seen_at, online_status, threshold, etc.',
				},
			],
			default: 'detailed',
		},
		{
			displayName: 'Offline threshold',
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
			description:
				'If `last_seen_at` is older than this window → **offline**; otherwise **online**.',
		},
		{
			displayName: 'Offline threshold unit',
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
			displayName: 'Device ID',
			name: 'deviceId',
			type: 'options',
			typeOptions: {
				loadOptionsMethod: 'getDevices',
				loadOptionsDependsOn: ['applicationId'],
			},
			required: true,
			default: '',
			description: 'Target device for the downlink',
			displayOptions: {
				show: {
					resource: ['devices'],
				},
			},
		},
		{
			displayName: 'Uplink output shape',
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
					name: 'Decoded payload + meta',
					value: 'decodedWithMeta',
					description:
						'decoded_payload, received_at, end_device_ids, f_port',
				},
				{
					name: 'Decoded payload only (root)',
					value: 'decodedOnly',
					description: 'Formatter fields at the root',
				},
				{
					name: 'Full storage record',
					value: 'full',
					description: 'Structure brute uplink_message, frm_payload, etc.',
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
			displayName: 'Payload format',
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
					name: 'Base64 (frm_payload)',
					value: 'base64',
					description:
						'Valid base64 string for frm_payload (not raw hex bytes — use Hex for e.g. 3E01FE)',
				},
				{
					name: 'Hex',
					value: 'hex',
					description: 'Hex without 0x; converted to binary then base64 for the API',
				},
				{
					name: 'JSON (decoded_payload)',
					value: 'decodedJson',
					description: 'JSON object for decoded_payload',
				},
			],
			default: 'base64',
			description: 'How the downlink message is built',
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
			description: 'Base64, hex (no 0x), or JSON depending on format',
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
			displayName: 'Confirmed downlink',
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
			displayName: 'Correlation IDs (JSON)',
			name: 'correlationIdsJson',
			type: 'string',
			typeOptions: {
				rows: 2,
			},
			default: '',
			displayOptions: {
				show: {
					resource: ['devices'],
				},
			},
			description: 'Optional: JSON array of strings',
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
				(norm0.resource === 'data' && norm0.operation === 'getDeviceStatus')
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
