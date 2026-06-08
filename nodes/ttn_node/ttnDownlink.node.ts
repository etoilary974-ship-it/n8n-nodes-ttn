import { NodeConnectionType, NodeOperationError } from 'n8n-workflow';
import type {
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import {
	ttnExecuteDownlinkPush,
	ttnEnrichNodeOperationErrorWithTtnContext,
	ttnExecutionErrorToCleanJson,
	ttnFormatTtnApiErrorDescription,
	ttnGetApplications,
	ttnGetDevices,
	TtnApiError,
} from './ttnShared.js';

const description: INodeTypeDescription = {
	displayName: 'TTN: Downlink (legacy)',
	name: 'ttnDownlink',
	icon: 'file:ttnNodeIcon.svg',
	group: ['transform'],
	version: 1.3,
	hidden: true,
	subtitle:
		'={{$parameter["applicationId"] + " · " + $parameter["deviceId"]}}',
	description:
		'Legacy: use the **TTN** node → **Devices** → **Send Downlink**. Kept for existing workflows (push only).',
	defaults: {
		name: 'TTN: Downlink (legacy)',
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
				'This node is hidden in the picker. Use **TTN** → **Devices** → **Send Downlink** instead.',
			name: 'legacyNotice',
			type: 'notice',
			default: '',
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
			description: 'Listed via GET /api/v3/applications (API key rights required). Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
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
			description: 'Target device for the downlink queue (GET …/applications/{ID}/devices). Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
		},
		{
			displayName: 'FPort',
			name: 'fPort',
			type: 'number',
			typeOptions: { minValue: 1, maxValue: 223 },
			default: 1,
			required: true,
			description: 'LoRaWAN application port (1–223)',
		},
		{
			displayName: 'Payload Type',
			name: 'payloadFormat',
			type: 'options',
			noDataExpression: true,
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
			description: 'Hex (no 0x) or JSON object depending on payload type',
		},
		{
			displayName: 'Priority',
			name: 'priority',
			type: 'options',
			noDataExpression: true,
			options: [
				{ name: 'HIGH', value: 'HIGH' },
				{ name: 'HIGHEST', value: 'HIGHEST' },
				{ name: 'LOW', value: 'LOW' },
				{ name: 'LOWEST', value: 'LOWEST' },
				{ name: 'NORMAL', value: 'NORMAL' },
			],
			default: 'NORMAL',
			description: 'Priority in the downlink queue',
		},
		{
			displayName: 'Confirmed Downlink',
			name: 'confirmed',
			type: 'boolean',
			default: false,
			description:
				'Whether the device must acknowledge the downlink (confirmed downlink)',
		},
		{
			displayName: 'Correlation IDs (JSON)',
			name: 'correlationIdsJson',
			type: 'string',
			typeOptions: {
				rows: 2,
			},
			default: '',
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

				const json = await ttnExecuteDownlinkPush(
					this,
					i,
					applicationId,
					deviceId,
				);

				out.push({ json, pairedItem: { item: i } });
			} catch (error) {
				if (this.continueOnFail()) {
					out.push({
						json: ttnExecutionErrorToCleanJson(error),
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
				throw new NodeOperationError(
					this.getNode(),
					error instanceof Error ? error : new Error(String(error)),
					{
						itemIndex: i,
						description:
							'HTTP response from the TTS API (see message for detail). An error here can still coincide with a “Receive downlink” event in the console.',
					},
				);
			}
		}

		return [out];
	}
}

export { TtnDownlink as ttnDownlink };
