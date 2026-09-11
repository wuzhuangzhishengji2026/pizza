/**
 * Shared agent-core building blocks used both by the standalone agent
 * (`pizza-metrics agent`) and by the in-process pizza extension:
 *   - Collector: delta aggregation + cumulative registry + OTLP relay ingest
 *   - Pusher: batched push to the cloud server with retry
 *   - LocalEndpoint: local HTTP server exposing /metrics (pull) and
 *     /v1/metrics (OTLP/JSON relay for tools on the same machine)
 */

import { createRequire } from "node:module";
import { hostname } from "node:os";
import { decodeOtlpMetrics, MemoryCumulativeTracker } from "../normalize.js";
import { CumulativeRegistry, DeltaAggregator, renderPrometheus } from "../registry.js";
import { PACKAGE_VERSION } from "../config.js";
import type { MetricSample } from "../types.js";

const require = createRequire(import.meta.url);

export interface CollectorOptions {
	user: string;
	tags?: Record<string, string>;
}

/** Aggregates samples from all sources; one instance per process. */
export class Collector {
	readonly pending = new DeltaAggregator();
	readonly cumulative = new CumulativeRegistry();
	readonly otlpTracker = new MemoryCumulativeTracker();

	constructor(private readonly options: CollectorOptions) {}

	/** Add already-normalized delta samples. */
	ingest(samples: MetricSample[]): void {
		for (const sample of samples) {
			this.pending.add(sample);
			this.cumulative.add(sample);
		}
	}

	/** Decode an OTLP/JSON body (e.g. relayed from Claude Code) into deltas. */
	ingestOtlp(body: unknown): MetricSample[] {
		const samples = decodeOtlpMetrics(body, {
			tracker: this.otlpTracker,
			tags: this.options.tags,
			userOverride: this.options.user,
		});
		this.ingest(samples);
		return samples;
	}

	metricsText(): string {
		return renderPrometheus({
			counters: this.cumulative.samples(),
			gauges: [
				{
					name: "agent_monitor_up",
					help: "1 when the metrics agent endpoint is reachable",
					values: [{ labels: {}, value: 1 }],
				},
			],
			helpText: {
				agent_sessions_total: "AI coding sessions started",
				agent_requests_total: "LLM requests (assistant messages)",
				agent_tokens_total: "Tokens consumed by type (input/output/cache_read/cache_write/reasoning)",
				agent_cost_usd_total: "Estimated cost in USD",
				agent_tool_calls_total: "Tool calls executed",
				agent_edit_decisions_total: "AI edit suggestions accepted/rejected (adoption rate)",
				agent_lines_of_code_total: "Lines of code added/removed by AI edits",
				agent_active_time_seconds_total: "Active time in seconds",
				agent_monitor_up: "Metrics agent liveness",
			},
		});
	}
}

export interface PusherOptions {
	serverUrl: string;
	apiKey: string;
	agentId: string;
	user: string;
	tags: Record<string, string>;
	timeoutMs?: number;
	log?: (message: string) => void;
}

/** Pushes deltas to the cloud server. Returns true when the batch was accepted. */
export async function pushSamples(samples: MetricSample[], options: PusherOptions): Promise<boolean> {
	if (!options.serverUrl) return false;
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
	try {
		const response = await fetch(`${options.serverUrl}/api/v1/metrics`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(options.apiKey ? { "x-api-key": options.apiKey } : {}),
			},
			body: JSON.stringify({
				agent: {
					id: options.agentId,
					user: options.user,
					hostname: hostname(),
					version: PACKAGE_VERSION,
					tags: options.tags,
				},
				samples,
			}),
			signal: controller.signal,
		});
		if (!response.ok) {
			options.log?.(`push failed: HTTP ${response.status}`);
			return false;
		}
		return true;
	} catch (error) {
		options.log?.(`push failed: ${error instanceof Error ? error.message : String(error)}`);
		return false;
	} finally {
		clearTimeout(timeout);
	}
}

export interface LocalEndpointOptions {
	port: number;
	host?: string;
	collector: Collector;
	log?: (message: string) => void;
}

/**
 * Local pull endpoint. Routes:
 *   GET  /metrics   — Prometheus exposition of cumulative counters
 *   GET  /healthz   — liveness
 *   POST /v1/metrics — OTLP/JSON ingest (relay for local tools)
 */
export class LocalEndpoint {
	private server: ReturnType<typeof import("node:http").createServer> | undefined;
	private boundPort = 0;

	/** Actual bound port (useful when configured with port 0 = ephemeral). */
	get port(): number {
		return this.boundPort;
	}

	constructor(private readonly options: LocalEndpointOptions) {}

	async start(): Promise<void> {
		if (this.server) return;
		const http = await import("node:http");
		const collector = this.options.collector;
		this.server = http.createServer((req, res) => {
			const url = (req.url ?? "/").split("?")[0];
			if (req.method === "GET" && (url === "/metrics" || url === "/metrics/")) {
				res.writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8" });
				res.end(collector.metricsText());
				return;
			}
			if (req.method === "GET" && (url === "/healthz" || url === "/health")) {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ ok: true, version: PACKAGE_VERSION }));
				return;
			}
			if (req.method === "POST" && (url === "/v1/metrics" || url === "/v1/metrics/")) {
				readBody(req)
					.then((body) => {
						try {
							const parsed = body.length ? JSON.parse(body.toString("utf8")) : {};
							const samples = collector.ingestOtlp(parsed);
							res.writeHead(200, { "content-type": "application/json" });
							res.end(JSON.stringify({ partialSuccess: {}, ingested: samples.length }));
						} catch (error) {
							res.writeHead(400, { "content-type": "application/json" });
							res.end(JSON.stringify({ error: error instanceof Error ? error.message : "bad request" }));
						}
					})
					.catch(() => {
						res.writeHead(400);
						res.end();
					});
				return;
			}
			res.writeHead(404, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: "not found" }));
		});
		const host = this.options.host ?? "127.0.0.1";
		await new Promise<void>((resolve, reject) => {
			this.server!.once("error", reject);
			this.server!.listen(this.options.port, host, () => resolve());
		});
		const address = this.server!.address();
		this.boundPort = typeof address === "object" && address ? address.port : this.options.port;
		this.options.log?.(`local endpoint listening on http://${host}:${this.boundPort}/metrics`);
	}

	async stop(): Promise<void> {
		if (!this.server) return;
		await new Promise<void>((resolve) => this.server!.close(() => resolve()));
		this.server = undefined;
	}
}

function readBody(req: import("node:http").IncomingMessage): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		req.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > 32 * 1024 * 1024) {
				reject(new Error("body too large"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks)));
		req.on("error", reject);
	});
}

/** Reads the package version for reporting (best-effort). */
export function packageVersion(): string {
	try {
		// dist/../package.json when built, src/../package.json from source
		const pkg = require("../package.json") as { version?: string };
		return pkg.version ?? PACKAGE_VERSION;
	} catch {
		return PACKAGE_VERSION;
	}
}
