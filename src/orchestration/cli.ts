import { loadDotEnv } from "./env.js";
import type { Executor, RunResult, RunStatus } from "./model.js";
import { PiExecutor, createPiSessionFactory, type PiModelSelection } from "./executor.js";
import { resolveEndpoint } from "./provider.js";
import { runTask, type OrchestratorOptions } from "./service.js";

/** Exit codes for the documented final statuses, plus CLI usage errors. */
export const EXIT_CODES: Record<RunStatus, number> & { usage: number } = {
	completed: 0,
	review_failed: 1,
	execution_failed: 2,
	timed_out: 124,
	cancelled: 130,
	usage: 64,
};

export interface CliIo {
	stdout?: { write(chunk: string): unknown };
	stderr?: { write(chunk: string): unknown };
	/** Build the executor. Injected by tests; defaults to the real Pi SDK executor. */
	createExecutor?: (onCleanupTimeout: () => void) => Promise<Executor>;
	signal?: AbortSignal;
	perCallTimeoutMs?: number;
	totalTimeoutMs?: number;
}

const USAGE = `Usage: piweave run "<task>"

Configuration comes from the environment or a git-ignored .env in the working directory:
  PIWEAVE_BASE_URL  OpenAI-compatible endpoint, for example https://your-endpoint.example/v1
  PIWEAVE_API_KEY   API key for that endpoint
  PIWEAVE_MODEL     Model id, for example your-model-id`;

/**
 * Resolve the endpoint from the environment (a .env loaded by `main` shows up there).
 * No endpoint, key, or model is defaulted in code, so nothing sensitive is committed;
 * missing variables fail with the exact names. Nothing falls back to a Pi login, OAuth
 * credential, or user-level model configuration.
 */
export function selectModel(env: NodeJS.ProcessEnv = process.env): PiModelSelection {
	return resolveEndpoint(env);
}

async function createRealExecutor(onCleanupTimeout: () => void): Promise<Executor> {
	const selection = selectModel();
	const factory = await createPiSessionFactory(selection);
	return new PiExecutor(factory, { onCleanupTimeout });
}

/**
 * Runs the CLI. Progress goes to stderr; stdout receives exactly one JSON document.
 * Returns the exit code without terminating the process.
 */
export async function runCli(argv: readonly string[], io: CliIo = {}): Promise<number> {
	const stdout = io.stdout ?? process.stdout;
	const stderr = io.stderr ?? process.stderr;
	const [command, ...rest] = argv;
	if (command !== "run") {
		stderr.write(`Missing or unknown command.\n\n${USAGE}\n`);
		return EXIT_CODES.usage;
	}
	const task = rest.join(" ").trim();
	if (task.length === 0) {
		stderr.write(`Missing task text.\n\n${USAGE}\n`);
		return EXIT_CODES.usage;
	}

	const progress = (message: string): void => {
		stderr.write(`[${new Date().toISOString()}] ${message}\n`);
	};

	let cleanupTimedOut = false;
	const markCleanupTimeout = (): void => {
		cleanupTimedOut = true;
	};

	const failure = (error: string): RunResult => ({
		runId: "",
		task,
		status: "execution_failed",
		draft: null,
		review: null,
		attempts: [],
		elapsedMs: 0,
		error,
	});

	let executor: Executor;
	try {
		executor = await (io.createExecutor ?? createRealExecutor)(markCleanupTimeout);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		progress(`setup failed: ${message}`);
		stdout.write(`${JSON.stringify(failure(`Executor setup failed: ${message}`))}\n`);
		return EXIT_CODES.execution_failed;
	}

	const options: OrchestratorOptions = { report: progress };
	if (io.signal !== undefined) options.signal = io.signal;
	if (io.perCallTimeoutMs !== undefined) options.perCallTimeoutMs = io.perCallTimeoutMs;
	if (io.totalTimeoutMs !== undefined) options.totalTimeoutMs = io.totalTimeoutMs;

	let result: RunResult;
	try {
		result = await runTask(task, executor, options);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		result = failure(`Unexpected orchestrator error: ${message}`);
	}

	stdout.write(`${JSON.stringify(result)}\n`);
	const suffix = result.error === null ? "" : ` — ${result.error}`;
	stderr.write(`result: ${result.status} (${result.elapsedMs} ms)${suffix}\n`);
	if (cleanupTimedOut) {
		stderr.write("warning: a Pi session did not settle during cleanup; the process will end here\n");
	}
	return EXIT_CODES[result.status];
}

/** Entry point: wire SIGINT, run, and return the status code. */
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
	// Real environment variables win; a missing .env is fine and reported per variable later.
	loadDotEnv();
	const controller = new AbortController();
	let interrupted = false;
	const onSigint = (): void => {
		if (interrupted) {
			process.stderr.write("\nSecond interrupt; exiting immediately.\n");
			process.exit(EXIT_CODES.cancelled);
		}
		interrupted = true;
		process.stderr.write("\nInterrupt received; cancelling the current role...\n");
		controller.abort();
	};
	process.on("SIGINT", onSigint);
	try {
		return await runCli(argv, { signal: controller.signal });
	} finally {
		process.off("SIGINT", onSigint);
	}
}

function isEntryPoint(path: string | undefined): boolean {
	return path !== undefined && /(?:^|[\\/])cli\.(?:ts|js)$/u.test(path);
}

/**
 * Ends the process after stdout has flushed. The final JSON is the only machine interface,
 * and stdout writes are asynchronous when it is a pipe, so calling process.exit() directly
 * can truncate it. The timer only matters when a session that failed to abort keeps a
 * handle open; it is unref'd so a drained event loop still exits by itself.
 */
function exitAfterFlush(code: number): void {
	process.exitCode = code;
	setTimeout(() => process.exit(code), 1_000).unref();
}

if (isEntryPoint(process.argv[1])) {
	main().then(
		(code) => {
			exitAfterFlush(code);
		},
		(error: unknown) => {
			process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
			exitAfterFlush(EXIT_CODES.execution_failed);
		},
	);
}
