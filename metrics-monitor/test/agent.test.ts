import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MetricsAgent } from "../src/agent/agent.js";
import { resolveAgentConfig } from "../src/config.js";
import type { AgentConfig, MetricSample, PushPayload, SourceAdapter } from "../src/types.js";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "mm-agent-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

class FakeAdapter implements SourceAdapter {
	readonly id = "fake";
	round = 0;
	constructor(private readonly samplesPerRound: MetricSample[][]) {}
	discover(): boolean {
		return true;
	}
	describe(): string {
		return "fake adapter";
	}
	async collect(sink: (s: MetricSample) => void): Promise<void> {
		for (const sample of this.samplesPerRound[Math.min(this.round, this.samplesPerRound.length - 1)] ?? []) {
			sink(sample);
		}
		this.round++;
	}
}

function agentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
	return resolveAgentConfig({
		user: "u1",
		stateFile: join(root, "state.json"),
		serverUrl: "",
		intervalSec: 3600,
		pullEnabled: false,
		...overrides,
	});
}

/** Starts a capture server; returns the port and a close handle. */
async function startCapture(onRequest?: (req: import("node:http").IncomingMessage) => boolean): Promise<{
	port: number;
	pushes: PushPayload[];
	close: () => Promise<void>;
}> {
	const pushes: PushPayload[] = [];
	const http = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => (body += chunk));
		req.on("end", () => {
			if (onRequest && !onRequest(req)) {
				res.writeHead(401);
				res.end('{"error":"unauthorized"}');
				return;
			}
			pushes.push(JSON.parse(body) as PushPayload);
			res.writeHead(200, { "content-type": "application/json" });
			res.end('{"ok":true}');
		});
	});
	await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
	const address = http.address();
	const port = typeof address === "object" && address ? address.port : 0;
	return { port, pushes, close: () => new Promise((resolve) => http.close(() => resolve())) };
}

describe("MetricsAgent", () => {
	it("collects deltas from adapters and pushes them to the server", async () => {
		const { port, pushes, close } = await startCapture();

		const config = agentConfig({ serverUrl: `http://127.0.0.1:${port}`, pushEnabled: true, apiKey: "secret" });
		const adapter = new FakeAdapter([
			[{ metric: "agent_tokens_total", labels: { tool: "pizza", user: "u1", type: "input" }, value: 42, ts: 1700000000000 }],
			[{ metric: "agent_tokens_total", labels: { tool: "pizza", user: "u1", type: "input" }, value: 8, ts: 1700000000001 }],
		]);
		const agent = new MetricsAgent(config, [adapter], { log: () => {} });
		await agent.start();

		expect(pushes).toHaveLength(1);
		expect(pushes[0].samples).toHaveLength(1);
		expect(pushes[0].samples[0].value).toBe(42);

		// next round: only the new delta is pushed
		await agent.collectOnce();
		await agent.stop();

		expect(pushes).toHaveLength(2);
		expect(pushes[1].samples[0].value).toBe(8);
		expect(pushes[0].agent.user).toBe(config.user);
		await close();
	});

	it("buffers deltas when the server is down and resumes after restart", async () => {
		const config = agentConfig({ serverUrl: "http://127.0.0.1:1", pushEnabled: true }); // unreachable port
		const adapter = new FakeAdapter([
			[{ metric: "agent_sessions_total", labels: { tool: "pizza", user: "u1" }, value: 1, ts: 1700000000000 }],
		]);
		const agent = new MetricsAgent(config, [adapter], { log: () => {} });
		await agent.start(); // first collect fails to push -> buffered
		await agent.stop();

		const stateRaw = JSON.parse(readFileSync(config.stateFile, "utf8")) as { pendingBuffer?: MetricSample[] };
		expect(stateRaw.pendingBuffer).toHaveLength(1);

		// a fresh agent with a reachable server resumes the buffer
		const { port, pushes, close } = await startCapture();
		const agent2 = new MetricsAgent(agentConfig({ serverUrl: `http://127.0.0.1:${port}`, pushEnabled: true }), [
			new FakeAdapter([[]]),
		]);
		await agent2.start();
		await agent2.stop();
		const resumed = pushes.flatMap((p) => p.samples);
		expect(resumed.some((s) => s.metric === "agent_sessions_total" && s.value === 1)).toBe(true);
		await close();
	});

	it("serves /metrics for pull mode with cumulative counters and an OTLP relay", async () => {
		const port = 19465 + Math.floor(Math.random() * 400);
		const agent = new MetricsAgent(
			agentConfig({ pullEnabled: true, pullPort: port, pushEnabled: false }),
			[
				new FakeAdapter([
					[{ metric: "agent_requests_total", labels: { tool: "pizza", user: "u1" }, value: 3, ts: 1700000000000 }],
				]),
			],
			{ log: () => {} },
		);
		await agent.start();
		expect(agent.pullPort).toBe(port);

		const metricsResponse = await fetch(`http://127.0.0.1:${port}/metrics`);
		const text = await metricsResponse.text();
		expect(metricsResponse.headers.get("content-type")).toContain("text/plain");
		expect(text).toContain('agent_requests_total{tool="pizza",user="u1"} 3');
		expect(text).toContain("agent_monitor_up 1");

		// OTLP relay: the local agent attributes relayed metrics to the local user
		const otlpResponse = await fetch(`http://127.0.0.1:${port}/v1/metrics`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				resourceMetrics: [
					{
						resource: { attributes: [{ key: "user.email", value: { stringValue: "dev@x.com" } }] },
						scopeMetrics: [
							{
								metrics: [
									{
										name: "claude_code.token.usage",
										sum: { dataPoints: [{ attributes: [{ key: "type", value: { stringValue: "input" } }], asDouble: 77 }] },
									},
								],
							},
						],
					},
				],
			}),
		});
		expect(otlpResponse.status).toBe(200);
		const metricsAfter = await (await fetch(`http://127.0.0.1:${port}/metrics`)).text();
		expect(metricsAfter).toContain("agent_tokens_total{");
		expect(metricsAfter).toContain('user="u1"');
		expect(metricsAfter).toContain("77");
		await agent.stop();
	});
});
