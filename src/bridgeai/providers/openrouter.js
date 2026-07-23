/**
 * OpenRouter — native OpenAI-compatible. Bearer key, GET /v1/models present.
 * Model ids look like `vendor/model` (anthropic/claude-sonnet-5, openai/gpt-5).
 */
module.exports = {
	id: 'openrouter',
	label: 'OpenRouter',
	authStyle: 'bearer',                 // Authorization: Bearer <key>
	keyEnv: 'OPENROUTER_API_KEY',
	listModels: true,                    // /models; filter supported_parameters for "tools"
	defaultModel: 'anthropic/claude-sonnet-5',
	// OpenRouter asks callers to identify themselves; ignored by other providers.
	extraHeaders: { 'HTTP-Referer': 'https://mockflow.com', 'X-Title': 'MockFlow Bridge' },
	note: 'One key, hundreds of models across providers.',

	resolveBaseURL: function () { return { url: 'https://openrouter.ai/api/v1' }; }
};
