/**
 * Azure OpenAI — OpenAI-compatible via the unified v1 endpoint.
 *   base URL:  https://<resource>.openai.azure.com/openai/v1   (account-specific)
 *   auth:      `api-key` HEADER (not Bearer)
 *   model:     the DEPLOYMENT name you created (arbitrary), not a public model id
 */
module.exports = {
	id: 'azure',
	label: 'Azure OpenAI',
	authStyle: 'api-key-header',         // api-key: <key>
	keyEnv: 'AZURE_OPENAI_API_KEY',
	resourceEnv: 'AZURE_OPENAI_ENDPOINT',// e.g. https://my-resource.openai.azure.com
	listModels: false,                   // "models" are your deployments — supply the name
	defaultModel: null,
	note: 'model = deployment name. v1 endpoint drops the old deployment-path + api-version dance.',

	resolveBaseURL: function (env) {
		env = env || process.env;
		const res = (env[this.resourceEnv] || '').replace(/\/+$/, '');
		if (!res) return { url: null, missing: this.resourceEnv };
		return { url: res + '/openai/v1' };
	}
};
