export type Role = "writer" | "reviewer";

export interface AgentRequest {
	role: Role;
	task: string;
	draft?: string;
	feedback?: readonly string[];
}

export interface Usage {
	inputTokens: number | null;
	outputTokens: number | null;
	cost: number | null;
}

export interface AgentResult {
	status: "completed" | "failed" | "timed_out" | "cancelled";
	text: string;
	error: string | null;
	usage: Usage | null;
}

export interface Executor {
	execute(request: AgentRequest, options: { timeoutMs: number; signal?: AbortSignal }): Promise<AgentResult>;
}

export interface Review {
	approved: boolean;
	feedback: string[];
}

export type RunStatus = "completed" | "review_failed" | "execution_failed" | "timed_out" | "cancelled";

export interface Attempt {
	role: Role;
	status: AgentResult["status"];
	elapsedMs: number;
	usage: Usage | null;
}

export interface RunResult {
	runId: string;
	task: string;
	status: RunStatus;
	draft: string | null;
	review: Review | null;
	attempts: Attempt[];
	elapsedMs: number;
	error: string | null;
}
