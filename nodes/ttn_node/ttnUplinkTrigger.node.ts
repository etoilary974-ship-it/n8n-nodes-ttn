import type { INodeType, INodeTypeDescription, IWebhookFunctions, IWebhookResponseData } from 'n8n-workflow';
import { NodeConnectionType } from 'n8n-workflow';
import {
	ttnRunWebhook,
	ttnWebhookDeviceFilterProperties,
	ttnWebhookOutputFormatProperties,
	ttnWebhookTriggerLoadOptions,
} from './ttnWebhookTrigger.shared.js';

/**
 * Legacy node type (`ttnUplinkTrigger`): kept for existing workflows.
 * The unified TTN picker uses **ttnTrigger** (`ttn` + Trigger suffix).
 */
const description: INodeTypeDescription = {
	displayName: 'TTN Uplink Trigger (legacy) Trigger',
	name: 'ttnUplinkTrigger',
	icon: 'file:ttnNodeIcon.svg',
	group: ['trigger'],
	version: [1.9, 2, 2.1],
	defaultVersion: 2.1,
	hidden: true,
	description:
		'Deprecated: same as **TTN Trigger** / **TTN** picker → Triggers. HTTP method: POST (fixed).',
	defaults: {
		name: 'TTN Uplink (legacy)',
		ttnOutputEventType: 'uplink_message',
		ttnOutputFormat: 'sensorData',
		ttnOutputFormatEvent: 'eventSummary',
		ttnWebhookMismatchBehavior: 'skip',
	},
	eventTriggerDescription: 'Waiting for calls on the test URL',
	activationMessage:
		'Active workflow: paste the production URL in TTS → Webhooks → Base URL. By default, requests outside **Event type** do not start the workflow (HTTP 200). For the legacy behavior (run + full JSON), use **Run with full webhook JSON**.',
	triggerPanel: {
		header: '',
		executionsHelp: {
			inactive:
				'Test mode: click Listen, then test from TTS (Live data) or curl. If no box is checked under Enabled messages in the TTS console, no calls are sent.',
			active:
				'TTS must call the production URL (HTTPS). Same full URL as the webhook Base URL, with the right events enabled in TTS.',
		},
		activationHint:
			'TTS → Application → Integrations → Webhooks: Base URL = n8n URL, JSON format, POST. Enabled messages: at least Uplink message for standard uplinks.',
	},
	inputs: [],
	outputs: [NodeConnectionType.Main],
	credentials: [
		{
			name: 'ttnApi',
			required: false,
		},
	],
	webhooks: [
		{
			name: 'default',
			httpMethod: 'POST',
			path: '={{$parameter["path"]}}',
			responseMode: 'onReceived',
			responseData: 'noData',
			responseContentType: 'text/plain',
			isFullPath: true,
		},
	],
	properties: [
		{
			displayName: 'Webhook Path',
			name: 'path',
			type: 'string',
			default: 'ttn-uplink',
			placeholder: 'ttn-uplink',
			description:
				'Path suffix (after the n8n base URL), same as configured in TTS → Webhooks for this workflow',
		},
		...ttnWebhookDeviceFilterProperties,
		...ttnWebhookOutputFormatProperties,
	],
};

export class TtnUplinkTrigger implements INodeType {
	description: INodeTypeDescription = description;

	methods = {
		loadOptions: ttnWebhookTriggerLoadOptions,
	};

	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		return ttnRunWebhook.call(this);
	}
}

export { TtnUplinkTrigger as ttnUplinkTrigger };
