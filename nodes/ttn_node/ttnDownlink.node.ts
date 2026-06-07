import { NodeConnectionType, NodeOperationError } from 'n8n-workflow';
import type {
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import {
	ttnExecuteDownlinkQueue,
	ttnEnrichNodeOperationErrorWithTtnContext,
	ttnExecutionErrorToCleanJson,
	ttnFormatTtnApiErrorDescription,
	ttnGetApplications,
	ttnGetDevices,
	TtnApiError,
} from './ttnShared.js';

const description: INodeTypeDescription = {
	displayName: 'TTN: Downlink (deprecated)',
	name: 'ttnDownlink',
	icon: 'file:ttnNodeIcon.svg',
	group: ['transform'],
	version: 1.3,
	hidden: true,
	subtitle:
		'={{$parameter["applicationId"] + " · " + $parameter["deviceId"]}}',
	description:
		'Deprecated: use the **TTN** node → **Devices** resource (Send Command, Clear Queue, Replace Queue). Kept for existing workflows.',
	defaults: {
		name: 'TTN: Downlink',
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
			displayName:
				'This node is hidden in the picker. Use **TTN** → **Devices** for the same operations.',
			name: 'deprecatedNotice',
			type: 'notice',
			default: '',
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
			description:
				'Listed via GET /api/v3/applications (API key rights required)',
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
			description:
				'Target device for the downlink queue (GET …/applications/{id}/devices)',
		},
		{
			displayName: 'Operation',
			name: 'operation',
			type: 'options',
			noDataExpression: true,
			options: [
				{
					name: 'Enqueue (push)',
					value: 'push',
					description:
						'Append message to the queue (POST …/down/push)',
				},
				{
					name: 'Replace queue',
					value: 'replace',
					description:
						'Replace the whole queue with this message (POST …/down/replace)',
				},
				{
					name: 'Clear queue',
					value: 'clear',
					description:
						'Sends downlinks: [] (POST …/down/replace)',
				},
			],
			default: 'push',
			description: 'Push, full replace, or empty queue',
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
					operation: ['push', 'replace'],
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
					operation: ['push', 'replace'],
				},
			},
			options: [
				{
					name: 'Base64 (frm_payload)',
					value: 'base64',
					description: 'Base64-encoded value for the API frm_payload field',
				},
				{
					name: 'Hex',
					value: 'hex',
					description: 'Converted to binary then base64 for frm_payload',
				},
				{
					name: 'JSON (decoded_payload)',
					value: 'decodedJson',
					description:
						'JSON object (e.g. {"bytes":[1,2,3]}) encrypted on the server if a formatter is configured',
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
					operation: ['push', 'replace'],
				},
			},
			description:
				'Base64, hex (no 0x), or JSON depending on format',
		},
		{
			displayName: 'Priority',
			name: 'priority',
			type: 'options',
			noDataExpression: true,
			displayOptions: {
				show: {
					operation: ['push', 'replace'],
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
			description: 'Priority in the downlink queue',
		},
		{
			displayName: 'Confirmed downlink',
			name: 'confirmed',
			type: 'boolean',
			default: false,
			displayOptions: {
				show: {
					operation: ['push', 'replace'],
				},
			},
			description:
				'If enabled, the device must acknowledge (confirmed downlink)',
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
					operation: ['push', 'replace'],
				},
			},
			description:
				'Optional: JSON array of strings, e.g. ["n8n","run-1"]',
		},
	],
};

export class TtnDownlink implements INodeType {
	description: INodeTypeDescription = description;

	methods = {
		loadOptions: {
			getApplications: ttnGetApplications,
			getDevices: ttnGetDevices,
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const out: INodeExecutionData[] = [];

		for (let i = 0; i < items.length; i++) {
			try {
				const applicationId = this.getNodeParameter('applicationId', i) as string;
				const deviceId = this.getNodeParameter('deviceId', i) as string;
				const operation = this.getNodeParameter('operation', i) as
					| 'push'
					| 'replace'
					| 'clear';

				const json = await ttnExecuteDownlinkQueue(
					this,
					i,
					applicationId,
					deviceId,
					operation,
				);

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
					description:
						'HTTP response from the TTS API (see message for detail). An error here can still coincide with a “Receive downlink” event in the console.',
				});
			}
		}

		return [out];
	}
}

export { TtnDownlink as ttnDownlink };
