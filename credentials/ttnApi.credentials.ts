import type {
	IAuthenticateGeneric,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class TtnApi implements ICredentialType {
	name = 'ttnApi';
	displayName = 'The Things Stack API';
	documentationUrl =
		'https://www.thethingsindustries.com/docs/reference/api/authentication/';
	properties: INodeProperties[] = [
		{
			displayName: 'Server URL',
			name: 'serverUrl',
			type: 'string',
			placeholder: 'https://eu1.cloud.thethings.network',
			description:
				'Base URL of your The Things Stack deployment (public cloud, Cloud Hosted, or self-hosted), without an /api path.',
			required: true,
			default: '',
		},
		{
			displayName: 'API key (Application Server)',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			description:
				'**Application Server** key (NNSXS… format), `Authorization: Bearer` header: applications, devices, status, downlinks, and **Storage** (`GET …/packages/storage/uplink_message`) when your key has the right rights.',
			required: true,
			default: '',
		},
	];
	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{ $credentials.apiKey }}',
			},
		},
	};
	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.serverUrl}}',
			method: 'GET',
			url: '/api/v3/applications',
			headers: {
				Accept: 'application/json',
			},
		},
	};
}

// Same rule as nodes: ttnApi.credentials.js must export "ttnApi".
export { TtnApi as ttnApi };
