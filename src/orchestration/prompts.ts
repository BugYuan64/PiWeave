import type { AgentRequest, Review, Role } from "./model.js";

export const WRITER_SYSTEM_PROMPT = `You are the Writer role in a two-role orchestration exercise.
Answer the user's task in plain Markdown text.
You have no tools; do not ask for files, commands, or web access.
When a previous draft and review feedback are supplied, revise that draft to address every feedback item and return the complete revised answer, not a diff or commentary.`;

export const REVIEWER_SYSTEM_PROMPT = `You are the Reviewer role in a two-role orchestration exercise.
Judge whether the draft answers the original task correctly and completely.
You have no tools. Reply with exactly one JSON object and nothing else:
{"approved": <boolean>, "feedback": [<string>, ...]}
Use approved=false with at least one concrete feedback item when the draft needs work, and approved=true with an empty feedback array otherwise.`;

const MAX_FEEDBACK_ITEMS = 20;

export function buildWriterPrompt(request: AgentRequest): string {
	const payload: Record<string, unknown> = { task: request.task };
	if (request.draft !== undefined) payload["previousDraft"] = request.draft;
	if (request.feedback !== undefined) payload["feedback"] = [...request.feedback];
	return ["Writer input (JSON data):", JSON.stringify(payload)].join("\n");
}

export function buildReviewerPrompt(request: AgentRequest): string {
	const payload = { task: request.task, draft: request.draft ?? "" };
	return ["Reviewer input (JSON data):", JSON.stringify(payload)].join("\n");
}

export function buildAgentPrompt(request: AgentRequest): string {
	switch (request.role) {
		case "writer":
			return buildWriterPrompt(request);
		case "reviewer":
			return buildReviewerPrompt(request);
	}
}

export const SYSTEM_PROMPTS = {
	writer: WRITER_SYSTEM_PROMPT,
	reviewer: REVIEWER_SYSTEM_PROMPT,
} as const satisfies Record<Role, string>;

/**
 * Parse and validate Reviewer output. The value comes from the model, so it starts as
 * `unknown` and every field is checked explicitly. Throws with a specific reason on any
 * malformed shape; callers map that to execution_failed.
 */
export function parseReview(text: string): Review {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(`Reviewer output is not valid JSON: ${reason}`);
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("Reviewer output must be a JSON object");
	}
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record);
	const extra = keys.filter((key) => key !== "approved" && key !== "feedback");
	if (extra.length > 0) throw new Error(`Reviewer output has unexpected fields: ${extra.join(", ")}`);
	const approved = record["approved"];
	const feedback = record["feedback"];
	if (typeof approved !== "boolean") throw new Error("Reviewer output field 'approved' must be a boolean");
	if (!Array.isArray(feedback) || !feedback.every((item) => typeof item === "string")) {
		throw new Error("Reviewer output field 'feedback' must be an array of strings");
	}
	if (feedback.length > MAX_FEEDBACK_ITEMS) {
		throw new Error(`Reviewer output has more than ${MAX_FEEDBACK_ITEMS} feedback items`);
	}
	if (approved && feedback.length > 0) {
		throw new Error("Reviewer output approved the draft but also returned feedback");
	}
	if (!approved && feedback.length === 0) {
		throw new Error("Reviewer output rejected the draft without any feedback");
	}
	return { approved, feedback };
}
