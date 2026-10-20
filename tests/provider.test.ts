import assert from "node:assert/strict";
import test from "node:test";
import {
	MissingConfigurationError,
	PROVIDER_ID,
	registerEndpoint,
	resolveEndpoint,
	type ModelRegistrar,
	type RegisteredModel,
} from "../src/orchestration/provider.js";

interface Registration {
	providerId: string;
	config: Record<string, unknown>;
}

/** Stands in for ModelRuntime so these tests never touch network or credentials. */
function stubRuntime(found: boolean): { runtime: ModelRegistrar; registered: Registration[] } {
	const registered: Registration[] = [];
	const runtime: ModelRegistrar = {
		registerProvider(providerId, config) {
			registered.push({ providerId, config: config as unknown as Record<string, unknown> });
		},
		getModel(providerId, modelId) {
			if (!found) return undefined;
			return { id: modelId, provider: providerId } as unknown as RegisteredModel;
		},
	};
	return { runtime, registered };
}

const COMPLETE_ENV = {
	PIWEAVE_BASE_URL: "https://example.test/v1",
	PIWEAVE_API_KEY: "sk-test",
	PIWEAVE_MODEL: "glm-5.3",
};

test("resolveEndpoint reads the endpoint from the environment", () => {
	assert.deepEqual(resolveEndpoint(COMPLETE_ENV), {
		providerId: PROVIDER_ID,
		baseUrl: "https://example.test/v1",
		apiKey: "sk-test",
		modelId: "glm-5.3",
	});
});

test("resolveEndpoint names every missing variable", () => {
	assert.throws(
		() => resolveEndpoint({}),
		(error: unknown) =>
			error instanceof MissingConfigurationError &&
			error.variables.join(", ") === "PIWEAVE_BASE_URL, PIWEAVE_API_KEY, PIWEAVE_MODEL",
	);
});

test("resolveEndpoint treats blank values as missing", () => {
	assert.throws(() => resolveEndpoint({ ...COMPLETE_ENV, PIWEAVE_API_KEY: "   " }), /PIWEAVE_API_KEY/);
});

test("resolveEndpoint rejects a base URL without a scheme", () => {
	assert.throws(
		() => resolveEndpoint({ ...COMPLETE_ENV, PIWEAVE_BASE_URL: "example.test:8443/v1" }),
		/must start with http/,
	);
});

test("resolveEndpoint accepts a fallback model id", () => {
	const endpoint = resolveEndpoint(
		{ PIWEAVE_BASE_URL: "https://example.test/v1", PIWEAVE_API_KEY: "k" },
		"fallback-model",
	);

	assert.equal(endpoint.modelId, "fallback-model");
});

test("registerEndpoint registers one OpenAI-compatible provider carrying the API key", () => {
	const { runtime, registered } = stubRuntime(true);
	const endpoint = resolveEndpoint(COMPLETE_ENV);

	const model = registerEndpoint(runtime, endpoint);

	assert.equal(model.id, "glm-5.3");
	assert.equal(model.provider, PROVIDER_ID);
	assert.equal(registered.length, 1);
	const [registration] = registered;
	assert.equal(registration?.providerId, PROVIDER_ID);
	assert.equal(registration?.config["baseUrl"], "https://example.test/v1");
	assert.equal(registration?.config["apiKey"], "sk-test");
	assert.equal(registration?.config["api"], "openai-completions");

	const models = registration?.config["models"] as Array<Record<string, unknown>> | undefined;
	assert.equal(models?.length, 1);
	assert.equal(models?.[0]?.["id"], "glm-5.3");
	assert.deepEqual(models?.[0]?.["input"], ["text"]);
	assert.equal(models?.[0]?.["reasoning"], false);
});

test("registerEndpoint reports a model that the runtime failed to register", () => {
	const { runtime } = stubRuntime(false);

	assert.throws(() => registerEndpoint(runtime, resolveEndpoint(COMPLETE_ENV)), /was not registered/);
});
