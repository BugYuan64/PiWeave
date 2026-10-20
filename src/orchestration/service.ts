import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { AgentRequest, AgentResult, Attempt, Executor, Review, RunResult, RunStatus } from "./model.js";
import { parseReview } from "./prompts.js";

export const PER_CALL_TIMEOUT_MS = 60_000;
export const TOTAL_TIMEOUT_MS = 240_000;

export interface OrchestratorOptions {
	perCallTimeoutMs?: number;
	totalTimeoutMs?: number;
	signal?: AbortSignal;
	/** Progress is written to stderr by the CLI; this module never writes output itself. */
	report?: (message: string) => void;
}

const STATUS_FOR_RESULT: Record<AgentResult["status"], RunStatus> = {
	completed: "completed",
	failed: "execution_failed",
	timed_out: "timed_out",
	cancelled: "cancelled",
};

class StopRun extends Error {
	readonly result: RunResult;

	constructor(result: RunResult) {
		super(result.error ?? result.status);
		this.name = "StopRun";
		this.result = result;
	}
}

/**
 * Deterministic Writer → Reviewer flow with at most one revision.
 *
 * A direct pass uses two role calls; a revision attempt uses at most four. The
 * orchestrator owns every decision: the model only supplies the draft and the review
 * data, and a malformed review stops the run without a repair call.
 */
export async function runTask(
	task: string,
	executor: Executor,
	options: OrchestratorOptions = {},
): Promise<RunResult> {
	const perCallTimeoutMs = options.perCallTimeoutMs ?? PER_CALL_TIMEOUT_MS;
	const totalTimeoutMs = options.totalTimeoutMs ?? TOTAL_TIMEOUT_MS;
	const { signal, report } = options;
	const runId = randomUUID();
	const start = performance.now();
	const attempts: Attempt[] = [];

	let draft: string | null = null;
	let review: Review | null = null;

	const elapsed = (): number => Math.round(performance.now() - start);
	const finish = (status: RunStatus, error: string | null): RunResult => ({
		runId,
		task,
		status,
		draft,
		review,
		attempts,
		elapsedMs: elapsed(),
		error,
	});

	// The explicit variable type lets TypeScript treat calls to `stop` as terminating.
	const stop: (status: RunStatus, error: string) => never = (status, error) => {
		throw new StopRun(finish(status, error));
	};

	const remaining = (): number => totalTimeoutMs - (performance.now() - start);

	const invoke = async (request: AgentRequest): Promise<string> => {
		if (signal?.aborted === true) stop("cancelled", "Cancelled before the next role started");
		const budget = Math.min(perCallTimeoutMs, Math.floor(remaining()));
		if (!(budget > 0)) stop("timed_out", `Total time of ${totalTimeoutMs} ms is exhausted`);

		report?.(`${request.role}: starting (budget ${budget} ms)`);
		const callStart = performance.now();
		let result: AgentResult;
		try {
			result = await executor.execute(
				request,
				signal === undefined ? { timeoutMs: budget } : { timeoutMs: budget, signal },
			);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			attempts.push({
				role: request.role,
				status: "failed",
				elapsedMs: Math.round(performance.now() - callStart),
				usage: null,
			});
			stop("execution_failed", `Role ${request.role} threw: ${reason}`);
		}
		attempts.push({
			role: request.role,
			status: result.status,
			elapsedMs: Math.round(performance.now() - callStart),
			usage: result.usage,
		});
		report?.(`${request.role}: ${result.status} in ${attempts.at(-1)?.elapsedMs ?? 0} ms`);

		if (result.status !== "completed") {
			stop(STATUS_FOR_RESULT[result.status], result.error ?? `Role ${request.role} ended as ${result.status}`);
		}
		return result.text;
	};

	try {
		draft = await invoke({ role: "writer", task });

		const firstReviewText = await invoke({ role: "reviewer", task, draft });
		review = parseOrStop(firstReviewText, stop);
		if (review.approved) return finish("completed", null);

		report?.(`reviewer: rejected, requesting one revision (${review.feedback.length} feedback items)`);
		draft = await invoke({ role: "writer", task, draft, feedback: review.feedback });

		const secondReviewText = await invoke({ role: "reviewer", task, draft });
		review = parseOrStop(secondReviewText, stop);
		if (review.approved) return finish("completed", null);

		return finish("review_failed", "Reviewer still rejected the draft after one revision");
	} catch (error) {
		if (error instanceof StopRun) return error.result;
		throw error;
	}
}

function parseOrStop(
	text: string,
	stop: (status: RunStatus, error: string) => never,
): Review {
	try {
		return parseReview(text);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		stop("execution_failed", reason);
	}
}
