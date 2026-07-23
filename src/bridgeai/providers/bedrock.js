/**
 * Amazon Bedrock — OpenAI Chat Completions via the "Mantle" engine.
 *   base URL:  https://bedrock-mantle.{region}.api.aws/v1   (confirmed; note .api.aws, not .amazonaws.com)
 *   auth:      Bedrock API key (Bearer). No SigV4 on this path.
 *   model:     region-prefixed Bedrock ids — us.anthropic.claude-sonnet-4-6, openai.gpt-oss-120b, ...
 *
 * bedrock-runtime.{region}.amazonaws.com/v1 is a same-shape fallback host if ever needed.
 * Guardrails (X-Amzn-Bedrock-* headers) would attach here as a transformRequest hook.
 */
module.exports = {
	id: 'bedrock',
	label: 'Amazon Bedrock (Mantle)',
	authStyle: 'bearer',                 // Authorization: Bearer <AWS_BEARER_TOKEN_BEDROCK>
	keyEnv: 'AWS_BEARER_TOKEN_BEDROCK',
	regionEnv: 'AWS_REGION',
	listModels: true,                    // GET /v1/models works on bedrock-mantle
	defaultModel: null,
	note: 'Bedrock API key (Bearer); region-prefixed model ids.',

	resolveBaseURL: function (env) {
		env = env || process.env;
		const region = env[this.regionEnv];
		if (!region) return { url: null, missing: this.regionEnv };
		return { url: 'https://bedrock-mantle.' + region + '.api.aws/v1' };
	}
};
