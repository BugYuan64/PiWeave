import {
	createAgentSession,
	createExtensionRuntime,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import type { AgentRequest, AgentResult, Executor, Role, Usage } from "./model.js";
import { SYSTEM_PROMPTS, buildAgentPrompt } from "./prompts.js";

export const DEFAULT_MAX_OUTPUT_CHARS = 12_000;
export const DEFAULT_CLEANUP_GRACE_MS = 5_000;

export interface AssistantMessageLike {
	role: "assistant";
	stopReason: string;
	errorMessage?: string;
	usage?: { input?: number; output?: number; cost?: { total?: number } };
}

export interface SessionEventLike {
	type: string;
	message?: { role?: string; stopReason?: string };
}

/** The subset of the SDK session the executor relies on. */
export interface AgentSessionLike {
	subscribe(listener: (event: SessionEventLike) => void): () => void;
	prompt(text: string): Promise<void>;
	abort(): Promise<void>;
	dispose(): void;
	getLastAssistantText(): string | undefined;
}

export interface SessionFactory {
	create(options: { role: Role; systemPrompt: string }): Promise<AgentSessionLike>;
}

export interface PiExecutorOptions {
	maxOutputChars?: number;
	cleanupGraceMs?: number;
	/** Called when a session failed to settle within the cleanup grace period. */
	onCleanupTimeout?: (role: Role) => void;
}

type Interruption = "timed_out" | "cancelled";

type PromptOutcome = { kind: "resolved" } | { kind: "rejected"; error: unknown };

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function normalizeUsage(message: AssistantMessageLike | undefined): Usage | null {
	const usage = message?.usage;
	if (!usage) return null;
	const input = usage.input;
	const output = usage.output;
	const cost = usage.cost?.total;
	return {
		inputTokens: typeof input === "number" && Number.isFinite(input) ? input : null,
		outputTokens: typeof output === "number" && Number.isFinite(output) ? output : null,
		cost: typeof cost === "number" && Number.isFinite(cost) ? cost : null,
	};
}

function failedResult(error: string): AgentResult {
	return { status: "failed", text: "", error, usage: null };
}

function timedOutResult(error: string): AgentResult {
	return { status: "timed_out", text: "", error, usage: null };
}

function cancelledResult(error: string): AgentResult {
	return { status: "cancelled", text: "", error, usage: null };
}

/**
 * Runs one role in a fresh, fully controlled Pi SDK session.
 *
 * Every call creates its own session, subscribes before prompting, waits for the
 * prompt to settle, validates the final assistant message, and disposes the session
 * on every path. A timeout or external abort calls `session.abort()` and waits a
 * bounded grace period for it; it never merely stops awaiting a promise that keeps
 * running unnoticed.
 */
export class PiExecutor implements Executor {
	readonly #factory: SessionFactory;
	readonly #maxOutputChars: number;
	readonly #cleanupGraceMs: number;
	readonly #onCleanupTimeout: ((role: Role) => void) | undefined;

	constructor(factory: SessionFactory, options: PiExecutorOptions = {}) {
		this.#factory = factory;
		this.#maxOutputChars = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
		this.#cleanupGraceMs = options.cleanupGraceMs ?? DEFAULT_CLEANUP_GRACE_MS;
		this.#onCleanupTimeout = options.onCleanupTimeout;
	}

	async execute(request: AgentRequest, options: { timeoutMs: number; signal?: AbortSignal }): Promise<AgentResult> {
		const { signal } = options;
		if (signal?.aborted === true) return cancelledResult("Cancelled before the role started");
		if (!(options.timeoutMs > 0)) return failedResult("Executor was given a non-positive timeout");

		let interruption: Interruption | null = null;
		let interruptStarted = false;
		let resolveInterrupt: (() => void) | undefined;
		const interruptPromise = new Promise<void>((resolve) => {
			resolveInterrupt = resolve;
		});
		const interrupt = (reason: Interruption): void => {
			if (interruptStarted) return;
			interruptStarted = true;
			interruption = reason;
			resolveInterrupt?.();
		};

		const onExternalAbort = (): void => interrupt("cancelled");
		signal?.addEventListener("abort", onExternalAbort, { once: true });
		const timer = setTimeout(() => interrupt("timed_out"), options.timeoutMs);

		let session: AgentSessionLike | undefined;
		let unsubscribe: (() => void) | undefined;
		let promptStarted = false;
		try {
			session = await this.#factory.create({
				role: request.role,
				systemPrompt: SYSTEM_PROMPTS[request.role],
			});
			if (interruption !== null) {
				return await this.#settleInterruption(session, promptStarted, request.role, options.timeoutMs, interruption);
			}

			let lastAssistant: AssistantMessageLike | undefined;
			unsubscribe = session.subscribe((event) => {
				if (event.type !== "message_end") return;
				const message = event.message as AssistantMessageLike | undefined;
				if (message?.role === "assistant") lastAssistant = message;
			});

			let settle: ((outcome: PromptOutcome) => void) | undefined;
			const promptOutcome = new Promise<PromptOutcome>((resolve) => {
				settle = resolve;
			});
			// The prompt promise is always handled, even when an abort wins the race.
			promptStarted = true;
			session.prompt(buildAgentPrompt(request)).then(
				() => settle?.({ kind: "resolved" }),
				(error: unknown) => settle?.({ kind: "rejected", error }),
			);

			const outcome = await Promise.race([promptOutcome, interruptPromise.then(() => null)]);
			if (outcome === null || interruption !== null) {
				const reason: Interruption = interruption ?? "cancelled";
				return await this.#settleInterruption(session, promptStarted, request.role, options.timeoutMs, reason);
			}
			if (outcome.kind === "rejected") {
				return failedResult(`Role ${request.role} failed: ${errorText(outcome.error)}`);
			}
			return this.#resultFromSession(request.role, session, lastAssistant);
		} catch (error) {
			if (interruption !== null) {
				if (session === undefined) {
					return interruption === "cancelled"
						? cancelledResult("Cancelled by user")
						: timedOutResult(`Role ${request.role} did not finish within ${options.timeoutMs} ms`);
				}
				return await this.#settleInterruption(session, promptStarted, request.role, options.timeoutMs, interruption);
			}
			return failedResult(`Role ${request.role} failed: ${errorText(error)}`);
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onExternalAbort);
			try {
				unsubscribe?.();
			} catch {
				// A listener that already unsubscribed is not an error.
			}
			try {
				session?.dispose();
			} catch {
				// Dispose must not mask the role result.
			}
		}
	}

	/**
	 * Aborts a live session and waits at most `cleanupGraceMs` for it to settle. The
	 * result reflects the interruption, never a reply that arrives after it.
	 */
	async #settleInterruption(
		session: AgentSessionLike,
		promptStarted: boolean,
		role: Role,
		timeoutMs: number,
		reason: Interruption,
	): Promise<AgentResult> {
		if (promptStarted) {
			let graceTimer: NodeJS.Timeout | undefined;
			const grace = new Promise<void>((resolve) => {
				graceTimer = setTimeout(resolve, this.#cleanupGraceMs);
			});
			let settled = false;
			const aborted = session.abort().then(
				() => {
					settled = true;
				},
				() => {
					settled = true;
				},
			);
			await Promise.race([aborted, grace]);
			clearTimeout(graceTimer);
			if (!settled) {
				this.#onCleanupTimeout?.(role);
			}
		}
		if (reason === "cancelled") return cancelledResult("Cancelled by user");
		return timedOutResult(`Role ${role} did not finish within ${timeoutMs} ms`);
	}

	#resultFromSession(
		role: Role,
		session: AgentSessionLike,
		lastAssistant: AssistantMessageLike | undefined,
	): AgentResult {
		let text: string | undefined;
		try {
			text = session.getLastAssistantText();
		} catch (error) {
			return failedResult(`Role ${role} could not read its final message: ${errorText(error)}`);
		}

		if (lastAssistant === undefined) {
			return failedResult(`Role ${role} produced no assistant message`);
		}
		switch (lastAssistant.stopReason) {
			case "stop":
				break;
			case "length":
				return failedResult(`Role ${role} output was truncated (stop reason: length)`);
			case "error":
				return failedResult(`Role ${role} failed: ${lastAssistant.errorMessage ?? "the model reported an error"}`);
			case "aborted":
				return failedResult(`Role ${role} was aborted before it finished`);
			default:
				return failedResult(`Role ${role} ended with unexpected stop reason: ${lastAssistant.stopReason}`);
		}
		if (text === undefined || text.trim().length === 0) {
			return failedResult(`Role ${role} returned empty text`);
		}
		if (text.length > this.#maxOutputChars) {
			return failedResult(`Role ${role} returned ${text.length} characters, over the ${this.#maxOutputChars} limit`);
		}
		return { status: "completed", text, error: null, usage: normalizeUsage(lastAssistant) };
	}
}

function createControlledResourceLoader(systemPrompt: string): ResourceLoader {
	return {
		getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => systemPrompt,
		getSystemPromptSource: () => undefined,
		getAppendSystemPrompt: () => [],
		getAppendSystemPromptSources: () => [],
		extendResources: () => {},
		reload: async () => {},
	};
}

export interface PiModelSelection {
	provider: string;
	modelId: string;
}

/**
 * Builds the real SDK session factory used by the CLI. Each `create` call uses
 * in-memory session and settings managers, an empty tool set, and a resource loader
 * that returns no extensions, skills, prompts, themes, or project context files.
 */
export async function createPiSessionFactory(
	selection: PiModelSelection,
	options: { cwd?: string } = {},
): Promise<SessionFactory> {
	const cwd = options.cwd ?? process.cwd();
	const modelRuntime = await ModelRuntime.create();
	const model = modelRuntime.getModel(selection.provider, selection.modelId);
	if (!model) {
		throw new Error(
			`Unknown model "${selection.provider}/${selection.modelId}". Set PIWEAVE_PROVIDER and PIWEAVE_MODEL to a model that Pi has configured.`,
		);
	}
	return {
		async create({ systemPrompt }) {
			const { session } = await createAgentSession({
				cwd,
				model,
				thinkingLevel: "off",
				modelRuntime,
				resourceLoader: createControlledResourceLoader(systemPrompt),
				tools: [],
				sessionManager: SessionManager.inMemory(cwd),
				settingsManager: SettingsManager.inMemory({
					compaction: { enabled: false },
					retry: { enabled: false },
				}),
			});
			return session;
		},
	};
}
