import assert from "node:assert/strict";
import test from "node:test";
import { FakeExecutor, completed, failed, reviewJson } from "./fakes.js";
import { parseReview } from "../src/orchestration/prompts.js";
import { runTask } from "../src/orchestration/service.js";

const TASK = "解释 Orchestrator 与执行器的区别，并举例";
const DRAFT_1 = "draft one";
const DRAFT_2 = "draft two";

test("direct pass: Writer then Reviewer with explicit context", async () => {
	const executor = new FakeExecutor((request) =>
		request.role === "writer"
			? completed(DRAFT_1)
			: completed(reviewJson({ approved: true, feedback: [] })),
	);

	const result = await runTask(TASK, executor);

	assert.equal(result.status, "completed");
	assert.equal(result.draft, DRAFT_1);
	assert.deepEqual(result.review, { approved: true, feedback: [] });
	assert.deepEqual(executor.roles(), ["writer", "reviewer"]);
	assert.equal(executor.calls[0]?.request.task, TASK);
	assert.equal(executor.calls[0]?.request.draft, undefined);
	assert.equal(executor.calls[1]?.request.task, TASK);
	assert.equal(executor.calls[1]?.request.draft, DRAFT_1);
	assert.equal(result.attempts.length, 2);
	assert.equal(result.error, null);
});

test("revision pass: four calls, second Reviewer sees the new draft", async () => {
	const reviews = [
		reviewJson({ approved: false, feedback: ["缺少一个具体例子"] }),
		reviewJson({ approved: true, feedback: [] }),
	];
	let reviewerIndex = 0;
	const executor = new FakeExecutor((request) => {
		if (request.role === "writer") {
			return completed(request.draft === undefined ? DRAFT_1 : DRAFT_2);
		}
		const text = reviews[reviewerIndex] ?? reviewJson({ approved: true, feedback: [] });
		reviewerIndex += 1;
		return completed(text);
	});

	const result = await runTask(TASK, executor);

	assert.equal(result.status, "completed");
	assert.deepEqual(executor.roles(), ["writer", "reviewer", "writer", "reviewer"]);
	assert.deepEqual(executor.calls[2]?.request.feedback, ["缺少一个具体例子"]);
	assert.equal(executor.calls[2]?.request.draft, DRAFT_1);
	assert.equal(executor.calls[3]?.request.draft, DRAFT_2);
	assert.equal(result.draft, DRAFT_2);
	assert.deepEqual(result.review, { approved: true, feedback: [] });
});

test("two rejections: review_failed after exactly four calls", async () => {
	const executor = new FakeExecutor((request) =>
		request.role === "writer"
			? completed(request.draft === undefined ? DRAFT_1 : DRAFT_2)
			: completed(reviewJson({ approved: false, feedback: ["仍然不完整"] })),
	);

	const result = await runTask(TASK, executor);

	assert.equal(result.status, "review_failed");
	assert.equal(executor.calls.length, 4);
	assert.equal(result.draft, DRAFT_2);
	assert.deepEqual(result.review, { approved: false, feedback: ["仍然不完整"] });
	assert.equal(result.attempts.length, 4);
	assert.equal(result.attempts.every((attempt) => attempt.status === "completed"), true);
});

test("malformed review JSON stops the run without a repair call", async () => {
	for (const text of [
		"approved",
		"```json\n{\"approved\":true,\"feedback\":[]}\n```",
		'{"approved":"false","feedback":[]}',
		'{"approved":false}',
		'{"approved":false,"feedback":[]}',
		'{"approved":true,"feedback":[{"note":"x"}]}',
	]) {
		const executor = new FakeExecutor((request) =>
			request.role === "writer" ? completed(DRAFT_1) : completed(text),
		);

		const result = await runTask(TASK, executor);

		assert.equal(result.status, "execution_failed", `text: ${text}`);
		assert.equal(executor.calls.length, 2, `text: ${text}`);
		assert.equal(result.draft, DRAFT_1);
		assert.equal(result.review, null);
		assert.match(result.error ?? "", /Reviewer output|review/i);
	}
});

test("an approval with non-blocking notes still counts as approved", async () => {
	const executor = new FakeExecutor((request) =>
		request.role === "writer"
			? completed(DRAFT_1)
			: completed('{"approved":true,"feedback":["可以补一个例子"],"confidence":"high"}'),
	);

	const result = await runTask(TASK, executor);

	assert.equal(result.status, "completed");
	assert.deepEqual(result.review, { approved: true, feedback: ["可以补一个例子"] });
	assert.deepEqual(executor.roles(), ["writer", "reviewer"], "no revision was requested");
});

test("executor failure stops downstream roles", async () => {
	const executor = new FakeExecutor((request) =>
		request.role === "writer" ? failed("model unavailable") : completed(reviewJson({ approved: true, feedback: [] })),
	);

	const result = await runTask(TASK, executor);

	assert.equal(result.status, "execution_failed");
	assert.deepEqual(executor.roles(), ["writer"]);
	assert.equal(result.error, "model unavailable");
	assert.equal(result.draft, null);
});

test("timeout from one role propagates and stops the flow", async () => {
	const executor = new FakeExecutor(() => ({
		status: "timed_out",
		text: "",
		error: "Role reviewer did not finish within 60000 ms",
		usage: null,
	}));

	const result = await runTask(TASK, executor, { perCallTimeoutMs: 1_000, totalTimeoutMs: 10_000 });

	assert.equal(result.status, "timed_out");
	assert.deepEqual(executor.roles(), ["writer"]);
});

test("cancellation from one role propagates", async () => {
	const controller = new AbortController();
	const executor = new FakeExecutor((request, call) => {
		assert.equal(call.signal, controller.signal);
		controller.abort();
		return { status: "cancelled", text: "", error: "Cancelled by user", usage: null };
	});

	const result = await runTask(TASK, executor, { signal: controller.signal });

	assert.equal(result.status, "cancelled");
	assert.deepEqual(executor.roles(), ["writer"]);
});

test("per-call budget is the smaller of 60s and the remaining total time", async () => {
	const executor = new FakeExecutor((request) =>
		request.role === "writer" ? completed(DRAFT_1) : completed(reviewJson({ approved: true, feedback: [] })),
	);

	await runTask(TASK, executor, { perCallTimeoutMs: 60_000, totalTimeoutMs: 240_000 });

	assert.equal(executor.calls.length, 2);
	for (const call of executor.calls) {
		assert.ok(call.timeoutMs > 0 && call.timeoutMs <= 60_000, `budget: ${call.timeoutMs}`);
	}
});

test("a total budget that runs out between roles stops the next call", async () => {
	const executor = new FakeExecutor(() => completed(DRAFT_1));

	const result = await runTask(TASK, executor, {
		perCallTimeoutMs: 5_000,
		totalTimeoutMs: Number.MIN_VALUE,
	});

	assert.equal(result.status, "timed_out");
	assert.equal(executor.calls.length, 0);
	assert.match(result.error ?? "", /Total time/);
});

test("an already-aborted signal prevents the first call", async () => {
	const controller = new AbortController();
	controller.abort();
	const executor = new FakeExecutor(() => completed(DRAFT_1));

	const result = await runTask(TASK, executor, { signal: controller.signal });

	assert.equal(result.status, "cancelled");
	assert.equal(executor.calls.length, 0);
});

test("a thrown executor error is reported as execution_failed", async () => {
	const executor = new FakeExecutor(() => {
		throw new Error("boom");
	});

	const result = await runTask(TASK, executor);

	assert.equal(result.status, "execution_failed");
	assert.match(result.error ?? "", /threw: boom/);
	assert.equal(executor.calls.length, 1);
	assert.equal(result.attempts.length, 1, "the thrown call is still recorded");
	assert.equal(result.attempts[0]?.role, "writer");
	assert.equal(result.attempts[0]?.status, "failed");
});

test("parseReview rejects non-boolean approved and non-string feedback", () => {
	assert.throws(() => parseReview('{"approved":true,"feedback":[1]}'), /array of strings/);
	assert.throws(() => parseReview("null"), /must be a JSON object/);
	assert.throws(() => parseReview("[]"), /must be a JSON object/);
	assert.throws(() => parseReview("{"), /not valid JSON/);
	assert.deepEqual(parseReview('{"approved":false,"feedback":["a"]}'), { approved: false, feedback: ["a"] });
});
