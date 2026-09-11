import { describe, expect, it } from "vitest";
import { CumulativeRegistry, DeltaAggregator, renderPrometheus } from "../src/registry.js";
import type { MetricSample } from "../src/types.js";

function sample(metric: string, labels: Record<string, string>, value: number): MetricSample {
	return { metric, labels, value, ts: 1700000000000 };
}

describe("DeltaAggregator", () => {
	it("merges deltas with identical metric+labels", () => {
		const agg = new DeltaAggregator();
		agg.add(sample("agent_tokens_total", { tool: "pizza", type: "input" }, 10));
		agg.add(sample("agent_tokens_total", { tool: "pizza", type: "input" }, 15));
		agg.add(sample("agent_tokens_total", { tool: "pizza", type: "output" }, 5));
		const drained = agg.drain();
		expect(drained).toHaveLength(2);
		const input = drained.find((s) => s.labels.type === "input");
		expect(input?.value).toBe(25);
	});

	it("ignores zero and negative deltas", () => {
		const agg = new DeltaAggregator();
		agg.add(sample("m", {}, 0));
		agg.add(sample("m", {}, -5));
		expect(agg.drain()).toHaveLength(0);
	});
});

describe("CumulativeRegistry", () => {
	it("accumulates per labelset", () => {
		const reg = new CumulativeRegistry();
		reg.add(sample("m", { tool: "a" }, 1));
		reg.add(sample("m", { tool: "a" }, 2));
		reg.add(sample("m", { tool: "b" }, 3));
		expect(reg.samples()).toHaveLength(2);
		expect(reg.samples().find((s) => s.labels.tool === "a")?.value).toBe(3);
	});
});

describe("renderPrometheus", () => {
	it("renders counters and gauges with proper escaping", () => {
		const text = renderPrometheus({
			counters: [sample("agent_tokens_total", { tool: "pizza", user: 'u"1' }, 1.5)],
			gauges: [{ name: "agent_active_users", help: "Active users\n(bug)", values: [{ labels: { window: "daily" }, value: 3 }] }],
			helpText: { agent_tokens_total: "Tokens" },
		});
		expect(text).toContain("# HELP agent_tokens_total Tokens");
		expect(text).toContain("# TYPE agent_tokens_total counter");
		expect(text).toContain('agent_tokens_total{tool="pizza",user="u\\"1"} 1.5');
		expect(text).toContain("# HELP agent_active_users Active users (bug)");
		expect(text).toContain('agent_active_users{window="daily"} 3');
	});

	it("sanitizes passthrough metric names", () => {
		const text = renderPrometheus({ counters: [sample("agent_ext_claude_code.commit-count", {}, 1)] });
		expect(text).toContain("agent_ext_claude_code_commit_count 1");
	});
});
