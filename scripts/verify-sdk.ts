import { loadDotEnv } from "../src/orchestration/env.js";
import { selectModel } from "../src/orchestration/cli.js";
import { PiExecutor, createPiSessionFactory } from "../src/orchestration/executor.js";

/**
 * Verifies the configured endpoint end to end: one Writer role call through the Pi SDK.
 *
 * Reads the same configuration as the CLI (.env in the working directory, or the real
 * environment). Prints the endpoint (never the API key), the model, the call status, and
 * the reply. Exits 0 only when a non-empty answer comes back.
 */
loadDotEnv();

const selection = selectModel();
const factory = await createPiSessionFactory(selection);
const executor = new PiExecutor(factory, {});

const result = await executor.execute(
	{ role: "writer", task: "Reply with one short sentence confirming you received this request." },
	{ timeoutMs: 60_000 },
);

const report = {
	endpoint: selection.baseUrl,
	provider: selection.providerId,
	model: selection.modelId,
	status: result.status,
	error: result.error,
	usage: result.usage,
	text: result.text,
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exitCode = result.status === "completed" && result.text.length > 0 ? 0 : 1;
