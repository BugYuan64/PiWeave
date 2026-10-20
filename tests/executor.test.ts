import assert from "node:assert/strict";
import test from "node:test";
import {
	PiExecutor,
	type AgentSessionLike,
	type SessionEventLike,
	type SessionFactory,
} from "../src/orchestration/executor.js";
import type { AgentRequest, Role } from "../src/orchestration/model.js";
import { SYSTEM_PROMPTS } from "../src/orchestration/prompts.js";

interface FakeSessionOptions {
	/** Resolves the prompt with this behavior. */
	run?: (text: string) => Promise<void>;
	/** Text returned by getLastAssistantText. */
	text?: string | undefined;
	/** Final assistant message emitted before the prompt resolves. */
	final?: { stopReason: string; errorMessage?: string; usage?: unknown };
	/** Emit message_end even when the prompt rejects. */
	emitOnRejection?: boolean;
}

class FakeSession implements AgentSessionLike {
	readonly events: string[] = [];
	readonly prompts: string[] = [];
	abortCalls = 0;
	disposeCalls = 0;
	activeListeners = 0;
	private readonly options: FakeSessionOptions;

	constructor(options: FakeSessionOptions) {
		this.options = options;
	}

	subscribe(listener: (event: SessionEventLike) => void): () => void {
		this.activeListeners += 1;
		let active = true;
		// Expose the listener so prompt() can drive it.
		this.listener = listener;
		return () => {
			if (active) {
				active = false;
				this.activeListeners -= 1;
			}
		};
	}

	private listener: ((event: SessionEventLike) => void) | undefined;

	async prompt(text: string): Promise<void> {
		this.prompts.push(text);
		this.events.push("prompt");
		try {
			await (this.options.run?.(text) ?? Promise.resolve());
		} catch (error) {
			if (this.options.emitOnRejection === true) this.emitFinal();
			throw error;
		}
		if (this.options.final !== undefined) this.emitFinal();
	}

	private emitFinal(): void {
		const final = this.options.final;
		if (final === undefined) return;
		this.events.push("message_end");
		this.listener?.({
			type: "message_end",
			message: { role: "assistant", ...final },
		});
	}

	async abort(): Promise<void> {
		this.abortCalls += 1;
		this.events.push("abort");
	}

	dispose(): void {
		this.disposeCalls += 1;
		this.events.push("dispose");
	}

	getLastAssistantText(): string | undefined {
		this.events.push("getLastAssistantText");
		return this.options.text;
	}
}

class FakeFactory implements SessionFactory {
	readonly created: Array<{ role: Role; systemPrompt: string; session: FakeSession }> = [];
	private readonly makeSession: (index: number) => FakeSession;

	constructor(makeSession: (index: number) => FakeSession) {
		this.makeSession = makeSession;
	}

	async create(options: { role: Role; systemPrompt: string }): Promise<AgentSessionLike> {
		const session = this.makeSession(this.created.length);
		this.created.push({ role: options.role, systemPrompt: options.systemPrompt, session });
		return session;
	}
}

const WRITER_REQUEST: AgentRequest = { role: "writer", task: "Explain the difference." };

test("a completed role returns text and normalized usage", async () => {
	const session = new FakeSession({
		text: "answer",
		final: { stopReason: "stop", usage: { input: 11, output: 7, cost: { total: 0.002 } } },
	});
	const factory = new FakeFactory(() => session);
	const executor = new PiExecutor(factory, {});

	const result = await executor.execute(WRITER_REQUEST, { timeoutMs: 1_000 });

	assert.equal(result.status, "completed");
	assert.equal(result.text, "answer");
	assert.equal(result.error, null);
	assert.deepEqual(result.usage, { inputTokens: 11, outputTokens: 7, cost: 0.002 });
	assert.equal(session.activeListeners, 0, "listener removed");
	assert.equal(session.disposeCalls, 1, "session disposed");
	// Subscription happens before the prompt is sent.
	assert.ok(session.events.indexOf("prompt") > -1);
});

test("each execute creates a new session with the role system prompt", async () => {
	const factory = new FakeFactory(
		() =>
			new FakeSession({
				text: "ok",
				final: { stopReason: "stop" },
			}),
	);
	const executor = new PiExecutor(factory, {});

	await executor.execute(WRITER_REQUEST, { timeoutMs: 1_000 });
	await executor.execute({ role: "reviewer", task: "t", draft: "d" }, { timeoutMs: 1_000 });

	assert.equal(factory.created.length, 2);
	assert.equal(factory.created[0]?.session.prompts.length, 1);
	assert.equal(factory.created[1]?.session.prompts.length, 1);
	assert.equal(factory.created[0]?.systemPrompt, SYSTEM_PROMPTS.writer);
	assert.equal(factory.created[1]?.systemPrompt, SYSTEM_PROMPTS.reviewer);
	assert.notEqual(factory.created[0]?.session, factory.created[1]?.session);
});

test("unknown usage fields stay null rather than becoming zero", async () => {
	const session = new FakeSession({
		text: "ok",
		final: { stopReason: "stop", usage: { input: 5, cost: {} } },
	});
	const executor = new PiExecutor(new FakeFactory(() => session), {});

	const result = await executor.execute(WRITER_REQUEST, { timeoutMs: 1_000 });

	assert.deepEqual(result.usage, { inputTokens: 5, outputTokens: null, cost: null });
});

test("a missing usage record produces null", async () => {
	const session = new FakeSession({ text: "ok", final: { stopReason: "stop" } });
	const executor = new PiExecutor(new FakeFactory(() => session), {});
	const result = await executor.execute(WRITER_REQUEST, { timeoutMs: 1_000 });
	assert.equal(result.usage, null);
});

test("no message_end cannot be reported as completed", async () => {
	const session = new FakeSession({ text: "streamed but unfinished" });
	const executor = new PiExecutor(new FakeFactory(() => session), {});

	const result = await executor.execute(WRITER_REQUEST, { timeoutMs: 1_000 });

	assert.equal(result.status, "failed");
	assert.match(result.error ?? "", /no assistant message/);
	assert.equal(session.disposeCalls, 1);
});

test("error, truncation, and empty outputs are not completed", async () => {
	const cases: Array<{ final: { stopReason: string; errorMessage?: string }; text: string | undefined; pattern: RegExp }> = [
		{ final: { stopReason: "error", errorMessage: "model failed" }, text: "partial", pattern: /model failed/ },
		{ final: { stopReason: "length" }, text: "cut", pattern: /truncated/ },
		{ final: { stopReason: "aborted" }, text: "x", pattern: /aborted/ },
		{ final: { stopReason: "toolUse" }, text: "x", pattern: /unexpected stop reason/ },
		{ final: { stopReason: "stop" }, text: "   ", pattern: /empty text/ },
		{ final: { stopReason: "stop" }, text: undefined, pattern: /empty text/ },
	];
	for (const item of cases) {
		const session = new FakeSession({ text: item.text, final: item.final });
		const executor = new PiExecutor(new FakeFactory(() => session), {});
		const result = await executor.execute(WRITER_REQUEST, { timeoutMs: 1_000 });
		assert.equal(result.status, "failed", `${item.final.stopReason}/${String(item.text)}`);
		assert.match(result.error ?? "", item.pattern);
	}
});

test("oversized output is rejected with an explicit error", async () => {
	const session = new FakeSession({ text: "x".repeat(30), final: { stopReason: "stop" } });
	const executor = new PiExecutor(new FakeFactory(() => session), { maxOutputChars: 10 });
	const result = await executor.execute(WRITER_REQUEST, { timeoutMs: 1_000 });
	assert.equal(result.status, "failed");
	assert.match(result.error ?? "", /over the 10 limit/);
});

test("a prompt rejection becomes failed and still cleans up", async () => {
	const session = new FakeSession({
		run: async () => {
			throw new Error("auth missing");
		},
	});
	const executor = new PiExecutor(new FakeFactory(() => session), {});

	const result = await executor.execute(WRITER_REQUEST, { timeoutMs: 1_000 });

	assert.equal(result.status, "failed");
	assert.match(result.error ?? "", /auth missing/);
	assert.equal(session.activeListeners, 0);
	assert.equal(session.disposeCalls, 1);
});

test("a session factory failure becomes failed", async () => {
	const factory: SessionFactory = {
		create: async () => {
			throw new Error("cannot create session");
		},
	};
	const result = await new PiExecutor(factory, {}).execute(WRITER_REQUEST, { timeoutMs: 1_000 });
	assert.equal(result.status, "failed");
	assert.match(result.error ?? "", /cannot create session/);
});

test("a timeout during session creation never prompts and still disposes", async () => {
	const session = new FakeSession({ text: "too late", final: { stopReason: "stop" } });
	const factory: SessionFactory = {
		create: async () => {
			await new Promise((resolve) => setTimeout(resolve, 30));
			return session;
		},
	};

	const result = await new PiExecutor(factory, { cleanupGraceMs: 10 }).execute(WRITER_REQUEST, {
		timeoutMs: 5,
	});

	assert.equal(result.status, "timed_out");
	assert.equal(session.prompts.length, 0, "no prompt was sent");
	assert.equal(session.abortCalls, 0, "nothing to abort before the prompt started");
	assert.equal(session.disposeCalls, 1, "the late session is still disposed");
});

test("a timeout aborts the session and reports timed_out", async () => {
	const session = new FakeSession({ run: () => new Promise<void>(() => {}) });
	const executor = new PiExecutor(new FakeFactory(() => session), { cleanupGraceMs: 50 });

	const result = await executor.execute(WRITER_REQUEST, { timeoutMs: 20 });

	assert.equal(result.status, "timed_out");
	assert.equal(session.abortCalls, 1, "abort was called");
	assert.equal(session.disposeCalls, 1, "session disposed");
	assert.equal(session.activeListeners, 0, "subscription removed");
});

test("a timeout is reported even if the model answers later", async () => {
	let release: (() => void) | undefined;
	const session = new FakeSession({
		run: () =>
			new Promise<void>((resolve) => {
				release = resolve;
			}),
		text: "late answer",
		final: { stopReason: "stop" },
	});
	const executor = new PiExecutor(new FakeFactory(() => session), { cleanupGraceMs: 20 });

	const pending = executor.execute(WRITER_REQUEST, { timeoutMs: 15 });
	const result = await pending;
	release?.();
	await new Promise((resolve) => setTimeout(resolve, 10));

	assert.equal(result.status, "timed_out");
	assert.equal(result.text, "");
});

test("an external abort cancels the role and aborts the session", async () => {
	const session = new FakeSession({ run: () => new Promise<void>(() => {}) });
	const controller = new AbortController();
	const executor = new PiExecutor(new FakeFactory(() => session), { cleanupGraceMs: 50 });

	const pending = executor.execute(WRITER_REQUEST, { timeoutMs: 5_000, signal: controller.signal });
	setTimeout(() => controller.abort(), 10);
	const result = await pending;

	assert.equal(result.status, "cancelled");
	assert.equal(session.abortCalls, 1);
	assert.equal(session.disposeCalls, 1);
});

test("an already-aborted signal never creates a session", async () => {
	const factory = new FakeFactory(() => new FakeSession({ text: "x", final: { stopReason: "stop" } }));
	const controller = new AbortController();
	controller.abort();

	const result = await new PiExecutor(factory, {}).execute(WRITER_REQUEST, {
		timeoutMs: 1_000,
		signal: controller.signal,
	});

	assert.equal(result.status, "cancelled");
	assert.equal(factory.created.length, 0);
});

test("a non-positive timeout is rejected before creating a session", async () => {
	const factory = new FakeFactory(() => new FakeSession({ text: "x", final: { stopReason: "stop" } }));
	const result = await new PiExecutor(factory, {}).execute(WRITER_REQUEST, { timeoutMs: 0 });
	assert.equal(result.status, "failed");
	assert.equal(factory.created.length, 0);
});

test("cleanup timeout is reported when abort does not settle", async () => {
	let cleanupRoles: Role[] = [];
	const session = new FakeSession({ run: () => new Promise<void>(() => {}) });
	// abort never resolves
	session.abort = async () => {
		session.abortCalls += 1;
		return new Promise<void>(() => {});
	};
	const executor = new PiExecutor(new FakeFactory(() => session), {
		cleanupGraceMs: 10,
		onCleanupTimeout: (role) => {
			cleanupRoles.push(role);
		},
	});

	const result = await executor.execute(WRITER_REQUEST, { timeoutMs: 10 });

	assert.equal(result.status, "timed_out");
	assert.deepEqual(cleanupRoles, ["writer"]);
	assert.equal(session.disposeCalls, 1);
});

test("the prompt carries task, previous draft, and feedback as data", async () => {
	const session = new FakeSession({ text: "ok", final: { stopReason: "stop" } });
	const executor = new PiExecutor(new FakeFactory(() => session), {});

	await executor.execute(
		{ role: "writer", task: "do it", draft: "old", feedback: ["be specific"] },
		{ timeoutMs: 1_000 },
	);

	const prompt = session.prompts[0] ?? "";
	assert.match(prompt, /"task":"do it"/);
	assert.match(prompt, /"previousDraft":"old"/);
	assert.match(prompt, /"feedback":\["be specific"\]/);
});

test("the reviewer prompt never includes writer-only fields", async () => {
	const session = new FakeSession({ text: "ok", final: { stopReason: "stop" } });
	const executor = new PiExecutor(new FakeFactory(() => session), {});

	await executor.execute({ role: "reviewer", task: "do it", draft: "d" }, { timeoutMs: 1_000 });

	const prompt = session.prompts[0] ?? "";
	assert.match(prompt, /"draft":"d"/);
	assert.doesNotMatch(prompt, /previousDraft|feedback/);
});
