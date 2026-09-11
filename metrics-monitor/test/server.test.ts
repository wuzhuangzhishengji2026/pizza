import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MetricsServer } from "../src/server/server.js";
import { MetricsStore } from "../src/server/store.js";
import { computeOverview } from "../src/server/kpi.js";
import { resolveServerConfig } from "../src/config.js";
import { decodeOtlpMetrics } from "../src/normalize.js";
import type { MetricSample } from "../src/types.js";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "mm-server-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function sample(metric: string, labels: Record<string, string>, value: number, ts: number): MetricSample {
	return { metric, labels, value, ts };
}

const NOW = new Date("2026-09-10T12:00:00Z").getTime();

function seedSamples(): MetricSample[] {
	const day = (n: number) => NOW - n * 86_400_000;
	return [
		// user A on pizza: today
		sample("agent_tokens_total", { tool: "pizza", user: "alice", type: "input" }, 1000, day(0)),
		sample("agent_tokens_total", { tool: "pizza", user: "alice", type: "output" }, 500, day(0)),
		sample("agent_requests_total", { tool: "pizza", user: "alice" }, 10, day(0)),
		sample("agent_sessions_total", { tool: "pizza", user: "alice" }, 2, day(0)),
		sample("agent_edit_decisions_total", { tool: "pizza", user: "alice", decision: "accept", tool_name: "edit" }, 8, day(0)),
		sample("agent_edit_decisions_total", { tool: "pizza", user: "alice", decision: "reject", tool_name: "edit" }, 2, day(0)),
		// user B on claude-code: 3 days ago
		sample("agent_tokens_total", { tool: "claude-code", user: "bob", type: "input" }, 2000, day(3)),
		sample("agent_edit_decisions_total", { tool: "claude-code", user: "bob", decision: "accept", tool_name: "Edit" }, 3, day(3)),
		sample("agent_edit_decisions_total", { tool: "claude-code", user: "bob", decision: "reject", tool_name: "Edit" }, 7, day(3)),
		// user C on opencode: 40 days ago (outside 28d MAU but inside 90d)
		sample("agent_tokens_total", { tool: "opencode", user: "carol", type: "input" }, 3000, day(40)),
	];
}

describe("MetricsStore", () => {
	it("inserts with idempotency (duplicate batches are ignored)", () => {
		const store = new MetricsStore(join(root, "db.sqlite"));
		const samples = seedSamples().slice(0, 3);
		expect(store.insertSamples(samples)).toBe(3);
		expect(store.insertSamples(samples)).toBe(0); // exact duplicate: ignored
		store.close();
	});
});

describe("computeOverview KPIs", () => {
	it("computes active users, consumption and adoption rate", () => {
		const store = new MetricsStore(":memory:");
		store.insertSamples(seedSamples());
		const overview = compute(store, 7);
		expect(overview.activeUsers.dau).toBe(1); // only alice today
		expect(overview.activeUsers.wau).toBe(2); // alice + bob in 7d
		expect(overview.totals.tokens.input).toBe(3000);
		expect(overview.totals.tokens.output).toBe(500);
		expect(overview.totals.requests).toBe(10);
		expect(overview.totals.sessions).toBe(2);
		expect(overview.adoption.accepted).toBe(11);
		expect(overview.adoption.rejected).toBe(9);
		expect(overview.adoption.rate).toBeCloseTo(0.55);

		const pizza = overview.byTool.find((t) => t.tool === "pizza");
		expect(pizza?.activeUsers).toBe(1);
		expect(pizza?.adoptionRate).toBeCloseTo(0.8);
		const claude = overview.byTool.find((t) => t.tool === "claude-code");
		expect(claude?.adoptionRate).toBeCloseTo(0.3);

		const alice = overview.byUser.find((u) => u.user === "alice");
		expect(alice?.tokens).toBe(1500);
		expect(alice?.activeDays).toBe(1);

		// MAU is a fixed 28d window: carol (40d ago) is outside it in any overview;
		// the 90d window's totals still include her consumption
		expect(overview.activeUsers.mau).toBe(2);
		const overview90 = compute(store, 90);
		expect(overview90.activeUsers.mau).toBe(2);
		expect(overview90.totals.tokens.input).toBe(6000);
		store.close();
	});

	it("applies tool filters", () => {
		const store = new MetricsStore(":memory:");
		store.insertSamples(seedSamples());
		const overview = compute(store, 90, "claude-code");
		expect(overview.totals.tokens.input).toBe(2000);
		expect(overview.activeUsers.mau).toBe(1);
		store.close();
	});
});

function compute(store: MetricsStore, days: number, tool?: string) {
	return computeOverview(store, { days, tool });
}

describe("OTLP ingestion with persistent tracker", () => {
	it("converts cumulative OTLP sums into deltas across exports", () => {
		const store = new MetricsStore(":memory:");
		const tracker = store.otlpTracker();
		const body = {
			resourceMetrics: [
				{
					resource: { attributes: [{ key: "user.id", value: { stringValue: "anon-123" } }] },
					scopeMetrics: [
						{
							metrics: [
								{
									name: "claude_code.token.usage",
									sum: {
										dataPoints: [
											{
												attributes: [
													{ key: "type", value: { stringValue: "input" } },
													{ key: "model", value: { stringValue: "claude-sonnet-4-5" } },
												],
												asDouble: 1000,
											},
										],
									},
								},
							],
						},
					],
				},
			],
		};
		// first observation counts in full (OTLP process-start semantics)
		const first = decodeOtlpMetrics(body, { tracker });
		expect(first).toHaveLength(1);
		expect(first[0].value).toBe(1000);
		const second = decodeOtlpMetrics(JSON.parse(JSON.stringify(body).replace("1000", "1500")), { tracker });
		expect(second).toHaveLength(1);
		expect(second[0].value).toBe(500);
		expect(second[0].labels.user).toBe("anon-123");
		expect(second[0].labels.model).toBe("claude-sonnet-4-5");
		store.insertSamples(first);
		expect(store.insertSamples(second)).toBe(1);
		expect(store.insertSamples(second)).toBe(0); // idempotent re-push
		store.close();
	});
});

describe("MetricsServer HTTP surface", () => {
	it("serves dashboard, health, push, overview and /metrics", async () => {
		const port = 19765 + Math.floor(Math.random() * 400);
		const server = new MetricsServer({
			config: resolveServerConfig({ port, host: "127.0.0.1", dbFile: join(root, "server.sqlite") }),
			log: () => {},
		});
		await server.start();

		// dashboard + health
		const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
		expect(html).toContain("AI 能效管理平台");
		const health = (await (await fetch(`http://127.0.0.1:${port}/api/v1/health`)).json()) as { ok: boolean; sampleCount: number };
		expect(health.ok).toBe(true);

		// agent push
		const pushResponse = await fetch(`http://127.0.0.1:${port}/api/v1/metrics`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				agent: { id: "agt_test", user: "alice", hostname: "h", version: "0.1.0", tags: {} },
				samples: seedSamples().slice(0, 6),
			}),
		});
		expect(pushResponse.status).toBe(200);
		const pushed = (await pushResponse.json()) as { inserted: number };
		expect(pushed.inserted).toBe(6);

		// overview reflects the push
		const overview = (await (await fetch(`http://127.0.0.1:${port}/api/v1/overview?window=7d`)).json()) as {
			activeUsers: { dau: number };
			totals: { tokens: { input: number } };
			adoption: { rate: number | null };
		};
		expect(overview.activeUsers.dau).toBe(1);
		expect(overview.totals.tokens.input).toBe(1000);
		expect(overview.adoption.rate).toBeCloseTo(0.8);

		// /metrics pull endpoint
		const metricsText = await (await fetch(`http://127.0.0.1:${port}/metrics`)).text();
		expect(metricsText).toContain('agent_tokens_total{tool="pizza"');
		expect(metricsText).toContain('agent_active_users{window="daily"} 1');
		expect(metricsText).toContain("agent_edit_adoption_rate");

		// OTLP endpoint (claude code push): two exports -> delta of the difference
		const otlpBody = (sessionCount: number) => ({
			resourceMetrics: [
				{
					resource: { attributes: [{ key: "user.email", value: { stringValue: "cc@x.com" } }] },
					scopeMetrics: [
						{
							metrics: [{ name: "claude_code.session.count", sum: { dataPoints: [{ asDouble: sessionCount }] } }],
						},
					],
				},
			],
		});
		const otlpResponse1 = await fetch(`http://127.0.0.1:${port}/v1/metrics`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(otlpBody(3)),
		});
		expect(otlpResponse1.status).toBe(200);
		await fetch(`http://127.0.0.1:${port}/v1/metrics`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(otlpBody(5)),
		});
		const healthAfter = (await (await fetch(`http://127.0.0.1:${port}/api/v1/health`)).json()) as {
			tools: string[];
			sampleCount: number;
		};
		expect(healthAfter.tools).toContain("claude-code");
		expect(healthAfter.sampleCount).toBe(6 + 2); // push + two OTLP deltas (3 + 2)

		await server.stop();
	});

	it("enforces the x-api-key on push endpoints when configured", async () => {
		const port = 19965 + Math.floor(Math.random() * 400);
		const server = new MetricsServer({
			config: resolveServerConfig({ port, host: "127.0.0.1", dbFile: ":memory:", apiKey: "s3cret" }),
			log: () => {},
		});
		await server.start();
		const noKey = await fetch(`http://127.0.0.1:${port}/api/v1/metrics`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ samples: [] }),
		});
		expect(noKey.status).toBe(401);
		const withKey = await fetch(`http://127.0.0.1:${port}/api/v1/metrics`, {
			method: "POST",
			headers: { "content-type": "application/json", "x-api-key": "s3cret" },
			body: JSON.stringify({ samples: [] }),
		});
		expect(withKey.status).toBe(200);
		// read endpoints stay open (protected at the reverse proxy if desired)
		expect((await fetch(`http://127.0.0.1:${port}/metrics`)).status).toBe(200);
		await server.stop();
	});
});
