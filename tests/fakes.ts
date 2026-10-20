import type { AgentRequest, AgentResult, Executor } from "../src/orchestration/model.js";

export interface RecordedCall {
	request: AgentRequest;
	timeoutMs: number;
	signal: AbortSignal | undefined;
}

export type FakeHandler = (
	request: AgentRequest,
	call: RecordedCall,
) => AgentResult | Promise<AgentResult>;

/** Records every call and returns scripted results. */
export class FakeExecutor implements Executor {
	readonly calls: RecordedCall[] = [];
	readonly #handler: FakeHandler;

	constructor(handler: FakeHandler) {
		this.#handler = handler;
	}

	async execute(request: AgentRequest, options: { timeoutMs: number; signal?: AbortSignal }): Promise<AgentResult> {
		const call: RecordedCall = { request, timeoutMs: options.timeoutMs, signal: options.signal };
		this.calls.push(call);
		return this.#handler(request, call);
	}

	roles(): string[] {
		return this.calls.map((call) => call.request.role);
	}
}

export function completed(text: string, usage: AgentResult["usage"] = null): AgentResult {
	return { status: "completed", text, error: null, usage };
}

export function failed(error: string): AgentResult {
	return { status: "failed", text: "", error, usage: null };
}

export function reviewJson(value: unknown): string {
	return JSON.stringify(value);
}
