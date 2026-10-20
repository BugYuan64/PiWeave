import assert from "node:assert/strict";
import test from "node:test";
import { EXIT_CODES, runCli, selectModel } from "../src/orchestration/cli.js";
import type { AgentResult, Executor } from "../src/orchestration/model.js";
import { PROVIDER_ID } from "../src/orchestration/provider.js";
import { FakeExecutor, completed, reviewJson } from "./fakes.js";

interface Captured {
	stdout: string;
	stderr: string;
}

function capture(): { io: { stdout: { write(chunk: string): unknown }; stderr: { write(chunk: string): unknown } }; read(): Captured } {
	let stdout = "";
	let stderr = "";
	return {
		io: {
			stdout: {
				write(chunk: string) {
					stdout += chunk;
				},
			},
			stderr: {
				write(chunk: string) {
					stderr += chunk;
				},
			},
		},
		read: () => ({ stdout, stderr }),
	};
}

function parseSingleJson(stdout: string): unknown {
	const lines = stdout.split("\n").filter((line) => line.trim().length > 0);
	assert.equal(lines.length, 1, `stdout must hold exactly one JSON document, got: ${stdout}`);
	return JSON.parse(lines[0] ?? "");
}

const PASSING: Executor = new FakeExecutor((request) =>
	request.role === "writer" ? completed("draft") : completed(reviewJson({ approved: true, feedback: [] })),
);

test("completed writes one JSON document to stdout and exits 0", async () => {
	const { io, read } = capture();
	const code = await runCli(["run", "explain", "it"], {
		...io,
		createExecutor: async () => PASSING,
	});

	assert.equal(code, EXIT_CODES.completed);
	assert.equal(code, 0);
	const { stdout, stderr } = read();
	const result = parseSingleJson(stdout) as Record<string, unknown>;
	assert.equal(result["status"], "completed");
	assert.equal(result["task"], "explain it");
	assert.equal(result["draft"], "draft");
	assert.notEqual(result["runId"], "");
	assert.equal(typeof result["elapsedMs"], "number");
	const attempts = result["attempts"] as Array<Record<string, unknown>>;
	assert.deepEqual(attempts.map((attempt) => attempt["role"]), ["writer", "reviewer"]);
	assert.deepEqual(attempts.map((attempt) => attempt["status"]), ["completed", "completed"]);
	// Progress lives on stderr, never stdout.
	assert.doesNotMatch(stdout, /starting|result:/);
	assert.match(stderr, /writer: starting/);
	assert.match(stderr, /result: completed/);
});

test("review_failed exits 1 and keeps the last draft and review", async () => {
	const executor: Executor = new FakeExecutor((request) =>
		request.role === "writer"
			? completed(request.draft === undefined ? "first" : "second")
			: completed(reviewJson({ approved: false, feedback: ["still weak"] })),
	);
	const { io, read } = capture();
	const code = await runCli(["run", "task"], { ...io, createExecutor: async () => executor });

	assert.equal(code, 1);
	const result = parseSingleJson(read().stdout) as Record<string, unknown>;
	assert.equal(result["status"], "review_failed");
	assert.equal(result["draft"], "second");
	assert.deepEqual(result["review"], { approved: false, feedback: ["still weak"] });
});

test("execution_failed exits 2 for an invalid review", async () => {
	const executor: Executor = new FakeExecutor((request) =>
		request.role === "writer" ? completed("draft") : completed("not json"),
	);
	const { io, read } = capture();
	const code = await runCli(["run", "task"], { ...io, createExecutor: async () => executor });

	assert.equal(code, 2);
	const result = parseSingleJson(read().stdout) as Record<string, unknown>;
	assert.equal(result["status"], "execution_failed");
	assert.match(String(result["error"]), /not valid JSON/);
});

test("timed_out exits 124", async () => {
	const executor: Executor = new FakeExecutor(() => ({
		status: "timed_out",
		text: "",
		error: "Role writer did not finish within 10 ms",
		usage: null,
	}));
	const { io } = capture();
	const code = await runCli(["run", "task"], { ...io, createExecutor: async () => executor });
	assert.equal(code, 124);
});

test("cancelled exits 130", async () => {
	const executor: Executor = new FakeExecutor(() => ({
		status: "cancelled",
		text: "",
		error: "Cancelled by user",
		usage: null,
	}));
	const { io, read } = capture();
	const code = await runCli(["run", "task"], { ...io, createExecutor: async () => executor });
	assert.equal(code, 130);
	const result = parseSingleJson(read().stdout) as Record<string, unknown>;
	assert.equal(result["status"], "cancelled");
});

test("executor setup failure still writes one JSON document", async () => {
	const { io, read } = capture();
	const code = await runCli(["run", "task"], {
		...io,
		createExecutor: async () => {
			throw new Error("no credentials");
		},
	});

	assert.equal(code, EXIT_CODES.execution_failed);
	const result = parseSingleJson(read().stdout) as Record<string, unknown>;
	assert.equal(result["status"], "execution_failed");
	assert.match(String(result["error"]), /no credentials/);
});

test("a missing or empty task is a usage error", async () => {
	for (const argv of [[], ["run"], ["run", "   "], ["other", "x"]] as string[][]) {
		const { io, read } = capture();
		let created = false;
		const code = await runCli(argv, {
			...io,
			createExecutor: async () => {
				created = true;
				return PASSING;
			},
		});
		assert.equal(code, EXIT_CODES.usage, `argv: ${JSON.stringify(argv)}`);
		assert.equal(created, false);
		assert.equal(read().stdout, "");
		assert.match(read().stderr, /Usage: piweave run/);
	}
});

test("selectModel reads the endpoint from the environment", () => {
	const selection = selectModel({
		PIWEAVE_BASE_URL: "http://127.0.0.1:9999/v1",
		PIWEAVE_API_KEY: "another-key",
		PIWEAVE_MODEL: "glm-5.3",
	});

	assert.deepEqual(selection, {
		providerId: PROVIDER_ID,
		baseUrl: "http://127.0.0.1:9999/v1",
		apiKey: "another-key",
		modelId: "glm-5.3",
	});
});

test("selectModel names the variables that are still missing", () => {
	assert.throws(
		() => selectModel({}),
		/PIWEAVE_BASE_URL, PIWEAVE_API_KEY, PIWEAVE_MODEL/,
	);
});

test("an executor exception becomes one failure document", async () => {
	const { io, read } = capture();
	const code = await runCli(["run", "task"], {
		...io,
		createExecutor: async () => ({
			execute: async (): Promise<AgentResult> => {
				throw new Error("unexpected");
			},
		}),
	});

	assert.equal(code, EXIT_CODES.execution_failed);
	const result = parseSingleJson(read().stdout) as Record<string, unknown>;
	assert.equal(result["status"], "execution_failed");
	assert.match(String(result["error"]), /unexpected/);
	const attempts = result["attempts"] as Array<Record<string, unknown>>;
	assert.equal(attempts.length, 1, "the thrown call is still reported");
	assert.equal(attempts[0]?.["status"], "failed");
});
