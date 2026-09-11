import { describe, expect, it } from "vitest";
import {
	MemoryCumulativeTracker,
	PizzaEventProjector,
	decodeOtlpMetrics,
	diffLines,
	isEditTool,
} from "../src/normalize.js";
import { METRICS } from "../src/types.js";

function attr(key: string, value: string) {
	return { key, value: { stringValue: value } };
}

function point(attributes: Record<string, string>, value: number) {
	return {
		attributes: Object.entries(attributes).map(([key, v]) => attr(key, v)),
		asDouble: value,
		timeUnixNano: String(1_700_000_000_000 * 1e6),
	};
}

interface TestPoint {
	attrs?: Record<string, string>;
	value: number;
}

function otlpBody(
	tool: string,
	metrics: Array<{ name: string; points: TestPoint[]; attrs?: Record<string, string> }>,
	resourceAttrs: Record<string, string> = {},
) {
	return {
		resourceMetrics: [
			{
				resource: {
					attributes: Object.entries({
						"user.email": "dev@example.com",
						...resourceAttrs,
					}).map(([key, v]) => attr(key, v)),
				},
				scopeMetrics: [
					{
						scope: { name: tool },
						metrics: metrics.map((m) => ({
							name: m.name,
							sum: {
								dataPoints: m.points.map((p) => point({ ...(m.attrs ?? {}), ...(p.attrs ?? {}) }, p.value)),
								aggregationTemporality: 2,
							},
						})),
					},
				],
			},
		],
	};
}

describe("diffLines", () => {
	it("counts added/removed lines and skips headers", () => {
		const diff = ["--- a/f.ts", "+++ b/f.ts", "@@ -1,2 +1,3 @@", "-old", "+new", "+newer", " context"].join("\n");
		expect(diffLines(diff)).toEqual({ added: 2, removed: 1 });
	});
});

describe("isEditTool", () => {
	it("matches edit-family tools case-insensitively", () => {
		expect(isEditTool("Edit")).toBe(true);
		expect(isEditTool("Write")).toBe(true);
		expect(isEditTool("MultiEdit")).toBe(true);
		expect(isEditTool("str_replace_editor")).toBe(true);
		expect(isEditTool("bash")).toBe(false);
		expect(isEditTool("read")).toBe(false);
	});
});

describe("PizzaEventProjector", () => {
	const base = { user: "u1", project: "proj" };
	const sink = () => {
		const samples: Parameters<Parameters<PizzaEventProjector["ingest"]>[2]>[0][] = [];
		return { samples, push: (s: never) => samples.push(s) };
	};

	it("maps AGENT_MESSAGE_END usage into tokens/cost/requests", () => {
		const projector = new PizzaEventProjector();
		const out = sink();
		projector.ingest(
			{
				type: "AGENT_MESSAGE_END",
				timestamp: 1700000000000,
				payload: {
					model: { provider: "anthropic", model_id: "claude-sonnet-4-5" },
					usage: { input: 100, output: 50, cache_read: 200, cache_write: 10, total: 360, cost: 0.05 },
				},
			},
			base,
			out.push,
		);
		const byMetric = Object.fromEntries(out.samples.map((s) => [s.metric + "|" + (s.labels.type ?? ""), s.value]));
		expect(byMetric[`${METRICS.requests}|`]).toBe(1);
		expect(byMetric[`${METRICS.tokens}|input`]).toBe(100);
		expect(byMetric[`${METRICS.tokens}|output`]).toBe(50);
		expect(byMetric[`${METRICS.tokens}|cache_read`]).toBe(200);
		expect(byMetric[`${METRICS.tokens}|cache_write`]).toBe(10);
		expect(byMetric[`${METRICS.cost}|`]).toBeCloseTo(0.05);
	});

	it("correlates INTENT_TOOL_CALL with USER_APPROVAL/REJECTION into adoption metrics", () => {
		const projector = new PizzaEventProjector();
		const out = sink();
		const intent = (tool: string, id: string) => ({
			type: "INTENT_TOOL_CALL",
			timestamp: 1700000000000,
			payload: { tool_call_id: "tc1", tool_name: tool, arguments: {} },
			event_id: id,
		});
		projector.ingest(intent("Edit", "i1"), base, out.push);
		projector.ingest(intent("bash", "i2"), base, out.push);
		projector.ingest({ type: "USER_APPROVAL", timestamp: 1700000001000, payload: { intent_event_id: "i1" } }, base, out.push);
		projector.ingest({ type: "USER_REJECTION", timestamp: 1700000002000, payload: { intent_event_id: "i2" } }, base, out.push);
		// bash rejection is not an edit decision
		expect(out.samples).toHaveLength(1);
		expect(out.samples[0].metric).toBe(METRICS.editDecisions);
		expect(out.samples[0].labels.decision).toBe("accept");
		expect(out.samples[0].labels.tool_name).toBe("Edit");
	});

	it("counts FILE_MUTATION_APPLIED diff lines", () => {
		const projector = new PizzaEventProjector();
		const out = sink();
		projector.ingest(
			{
				type: "FILE_MUTATION_APPLIED",
				timestamp: 1700000000000,
				payload: { path: "a.ts", operation: "modify", diff: "--- a\n+++ b\n-old\n+new1\n+new2" },
			},
			base,
			out.push,
		);
		const added = out.samples.find((s) => s.labels.type === "added");
		const removed = out.samples.find((s) => s.labels.type === "removed");
		expect(added?.value).toBe(2);
		expect(removed?.value).toBe(1);
	});

	it("maps TOOL_EXECUTION_END with is_error", () => {
		const projector = new PizzaEventProjector();
		const out = sink();
		projector.ingest(
			{ type: "TOOL_EXECUTION_END", timestamp: 1700000000000, payload: { tool_call_id: "t", tool_name: "bash", result: "", is_error: true } },
			base,
			out.push,
		);
		expect(out.samples[0].metric).toBe(METRICS.toolCalls);
		expect(out.samples[0].labels.is_error).toBe("true");
	});
});

describe("decodeOtlpMetrics", () => {
	it("converts claude_code cumulative sums into deltas and unifies names", () => {
		const tracker = new MemoryCumulativeTracker();
		const options = { tracker };
		const body = otlpBody("claude-code", [
			{ name: "claude_code.token.usage", points: [{ value: 500, attrs: { type: "input" } }] },
			{ name: "claude_code.token.usage", points: [{ value: 120, attrs: { type: "output" } }] },
			{ name: "claude_code.cost.usage", points: [{ value: 0.42 }] },
		]);
		const first = decodeOtlpMetrics(body, options);
		expect(first).toHaveLength(3);
		const input = first.find((s) => s.metric === METRICS.tokens && s.labels.type === "input");
		expect(input?.value).toBe(500);
		expect(input?.labels.tool).toBe("claude-code");
		expect(input?.labels.user).toBe("dev@example.com");

		// second export with higher cumulative values -> only the difference
		const body2 = otlpBody("claude-code", [
			{ name: "claude_code.token.usage", points: [{ value: 800, attrs: { type: "input" } }] },
			{ name: "claude_code.cost.usage", points: [{ value: 0.5 }] },
		]);
		const second = decodeOtlpMetrics(body2, options);
		expect(second.find((s) => s.labels.type === "input")?.value).toBe(300);
		expect(second.find((s) => s.metric === METRICS.cost)?.value).toBeCloseTo(0.08);

		// counter reset: treat the full new value as a delta
		const body3 = otlpBody("claude-code", [{ name: "claude_code.token.usage", points: [{ value: 50, attrs: { type: "input" } }] }]);
		const third = decodeOtlpMetrics(body3, options);
		expect(third.find((s) => s.labels.type === "input")?.value).toBe(50);
	});

	it("supports the legacy code_edit_tool_decision metric name and maps decisions", () => {
		const samples = decodeOtlpMetrics(
			otlpBody("claude-code", [
				{
					name: "claude_code.code_edit_tool.decision",
					attrs: { tool_name: "Edit" },
					points: [{ value: 3, attrs: { decision: "accept" } }, { value: 1, attrs: { decision: "reject" } }],
				},
			]),
			{ tracker: new MemoryCumulativeTracker() },
		);
		const accept = samples.find((s) => s.labels.decision === "accept");
		const reject = samples.find((s) => s.labels.decision === "reject");
		expect(accept?.value).toBe(3);
		expect(reject?.value).toBe(1);
		expect(accept?.labels.tool_name).toBe("Edit");
	});

	it("scales codex microusd cost and maps gemini_cli token types", () => {
		const samples = decodeOtlpMetrics(
			otlpBody("codex", [
				{ name: "codex.turn.cost_microusd", points: [{ value: 1_500_000 }] },
				{ name: "gemini_cli.token.usage", points: [{ value: 10, attrs: { type: "cached" } }, { value: 20, attrs: { type: "thought" } }] },
			]),
			{ tracker: new MemoryCumulativeTracker() },
		);
		expect(samples.find((s) => s.metric === METRICS.cost)?.value).toBeCloseTo(1.5);
		expect(samples.find((s) => s.labels.type === "cache_read")?.value).toBe(10);
		expect(samples.find((s) => s.labels.type === "reasoning")?.value).toBe(20);
	});

	it("passes through unknown metrics as agent_ext_*", () => {
		const samples = decodeOtlpMetrics(otlpBody("claude-code", [{ name: "claude_code.commit.count", points: [{ value: 2 }] }]), {
			tracker: new MemoryCumulativeTracker(),
		});
		expect(samples).toHaveLength(1);
		expect(samples[0].metric).toBe("agent_ext_claude_code_commit_count");
	});
});
