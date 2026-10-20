import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

/**
 * PiWeave talks to one OpenAI-compatible HTTP endpoint.
 *
 * No endpoint, key, or model is baked into the sources: they come from the environment
 * (or a git-ignored `.env`), so nothing here is committed. The endpoint is registered on
 * the SDK's model runtime at start-up, which means model access never uses a Pi login,
 * OAuth credential, or user-level `models.json`.
 */

/** Provider label used when registering the endpoint. Fixed so it cannot collide with a built-in OAuth provider. */
export const PROVIDER_ID = "piweave-local";

export const BASE_URL_VARIABLE = "PIWEAVE_BASE_URL";
export const API_KEY_VARIABLE = "PIWEAVE_API_KEY";
export const MODEL_VARIABLE = "PIWEAVE_MODEL";

/** How one role reaches the model service. */
export interface ModelEndpoint {
	providerId: string;
	baseUrl: string;
	apiKey: string;
	modelId: string;
}

type ProviderConfigInput = Parameters<ModelRuntime["registerProvider"]>[1];
export type RegisteredModel = NonNullable<ReturnType<ModelRuntime["getModel"]>>;

/** The slice of `ModelRuntime` that registration needs; tests pass a stub instead. */
export interface ModelRegistrar {
	registerProvider(providerId: string, config: ProviderConfigInput): void;
	getModel(providerId: string, modelId: string): RegisteredModel | undefined;
}

export class MissingConfigurationError extends Error {
	readonly variables: readonly string[];

	constructor(variables: readonly string[]) {
		super(
			`Missing endpoint configuration: ${variables.join(", ")}. ` +
				"Copy .env.example to .env and fill it in, or set the variables in your environment.",
		);
		this.name = "MissingConfigurationError";
		this.variables = variables;
	}
}

function readEnvValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
	const value = env[name]?.trim();
	return value === undefined || value === "" ? undefined : value;
}

/**
 * Endpoint settings from the environment, validated. `fallbackModelId` is used only when
 * `PIWEAVE_MODEL` is unset; callers that have no fallback omit it.
 */
export function resolveEndpoint(
	env: NodeJS.ProcessEnv = process.env,
	fallbackModelId?: string,
): ModelEndpoint {
	const baseUrl = readEnvValue(env, BASE_URL_VARIABLE);
	const apiKey = readEnvValue(env, API_KEY_VARIABLE);
	const modelId = readEnvValue(env, MODEL_VARIABLE) ?? fallbackModelId;

	if (baseUrl === undefined || apiKey === undefined || modelId === undefined) {
		const missing: string[] = [];
		if (baseUrl === undefined) missing.push(BASE_URL_VARIABLE);
		if (apiKey === undefined) missing.push(API_KEY_VARIABLE);
		if (modelId === undefined) missing.push(MODEL_VARIABLE);
		throw new MissingConfigurationError(missing);
	}
	if (!/^https?:\/\//u.test(baseUrl)) {
		throw new Error(`${BASE_URL_VARIABLE} must start with http:// or https://, got "${baseUrl}"`);
	}
	return { providerId: PROVIDER_ID, baseUrl, apiKey, modelId };
}

/**
 * Register the endpoint as a provider and return its model. The provider carries the
 * API key itself, so authentication resolves from this configuration only.
 */
export function registerEndpoint(runtime: ModelRegistrar, endpoint: ModelEndpoint): RegisteredModel {
	runtime.registerProvider(endpoint.providerId, {
		name: "PiWeave endpoint",
		baseUrl: endpoint.baseUrl,
		api: "openai-completions",
		apiKey: endpoint.apiKey,
		models: [
			{
				id: endpoint.modelId,
				name: endpoint.modelId,
				input: ["text"],
				reasoning: false,
				contextWindow: 128_000,
				maxTokens: 8_192,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			},
		],
	});

	const model = runtime.getModel(endpoint.providerId, endpoint.modelId);
	if (model === undefined) {
		throw new Error(
			`Endpoint model "${endpoint.providerId}/${endpoint.modelId}" was not registered. Check ${MODEL_VARIABLE} and ${endpoint.baseUrl}`,
		);
	}
	return model;
}
