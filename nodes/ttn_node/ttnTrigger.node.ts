import type { INodeType, INodeTypeDescription, IWebhookFunctions, IWebhookResponseData } from 'n8n-workflow';
import { NodeConnectionType } from 'n8n-workflow';
import {
	ttnRunWebhook,
	ttnWebhookDeviceFilterProperties,
	ttnWebhookOutputFormatProperties,
	ttnWebhookTriggerLoadOptions,
} from './ttnWebhookTrigger.shared.js';

/**
 * Technical name `ttnTrigger`: n8n strips the "Trigger" suffix to merge
 * this trigger with the `ttn` action node in the same picker (like Google Sheets).
 */
const description: INodeTypeDescription = {
	displayName: 'TTN Trigger',
	name: 'ttnTrigger',
	icon: 'file:ttnNodeIcon.svg',
	group: ['trigger'],
	/** Include 1.9 for existing workflows (otherwise n8n shows "node not installed"). */
	version: [1.9, 2, 2.1],
	defaultVersion: 2.1,
	description:
		'**Triggers · Receive Sensor Data**: TTS webhook (real-time uplink, not Storage). Pick this entry under **TTN** → Triggers. HTTP method: POST (fixed).',
	defaults: {
		name: 'Receive Sensor Data',
		ttnOutputEventType: 'uplink_message',
		ttnOutputFormat: 'sensorData',
		ttnOutputFormatEvent: 'eventSummary',
		ttnWebhookMismatchBehavior: 'skip',
	},
	eventTriggerDescription: 'Waiting for calls on the test URL',
	activationMessage:
		'Active workflow: paste the production URL in TTS → Webhooks → Base URL. Requests whose JSON does not match **Event type** are ignored by default (no run, HTTP 200) — useful when TTS sends uplink + normalized on the same URL. To always run with the raw body, set **When JSON does not match event type** to **Run with full webhook JSON**.',
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
			displayName: 'Webhook path',
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

export class TtnTrigger implements INodeType {
	description: INodeTypeDescription = description;

	methods = {
		loadOptions: ttnWebhookTriggerLoadOptions,
	};

	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		return ttnRunWebhook.call(this);
	}
}

export { TtnTrigger as ttnTrigger };
