/**
 * The cloud-side efficiency platform (云端能效管理平台) — one zero-dependency
 * Node HTTP server:
 *
 *   PUSH ingestion
 *     POST /api/v1/metrics   agent push (JSON deltas)
 *     POST /v1/metrics       native OTLP/JSON push (Claude Code, Gemini CLI, ...)
 *   PULL exposure
 *     GET  /metrics          Prometheus exposition (cumulative totals + KPI gauges)
 *     GET  /api/v1/overview  KPI JSON for the built-in dashboard
 *   UI / ops
 *     GET  /                 built-in dashboard
 *     GET  /api/v1/health    liveness + ingestion stats
 *
 * Optional shared-secret auth (`x-api-key`) protects the push endpoints.
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { decodeOtlpMetrics } from "../normalize.js";
import { renderPrometheus, escapeHtml } from "../registry.js";
import { PACKAGE_VERSION } from "../config.js";
import { dashboardHtml } from "./dashboard.js";
import { computeOverview } from "./kpi.js";
import { MetricsStore } from "./store.js";
import type { MetricSample, PushPayload, ServerConfig } from "../types.js";

export interface MetricsServerOptions {
	config: ServerConfig;
	log?: (message: string) => void;
	/** Storage injection for tests; defaults to a SQLite file at config.dbFile. */
	store?: MetricsStore;
}

export class MetricsServer {
	private store: MetricsStore;
	private server: Server | undefined;
	private retentionTimer: NodeJS.Timeout | undefined;
	private readonly log: (message: string) => void;
	private startedAt = Date.now();

	constructor(private readonly options: MetricsServerOptions) {
		this.store = options.store ?? new MetricsStore(options.config.dbFile);
		this.log = options.log ?? (() => {});
	}

	async start(): Promise<void> {
		if (this.server) return;
		const http = await import("node:http");
		this.server = http.createServer((req, res) => {
			void this.route(req, res);
		});
		const { host, port } = this.options.config;
		await new Promise<void>((resolve, reject) => {
			this.server!.once("error", reject);
			this.server!.listen(port, host, () => resolve());
		});
		this.store.metaSet("startedAt", String(Date.now()));
		const removed = this.store.applyRetention(this.options.config.retentionDays);
		if (removed > 0) this.log(`retention: removed ${removed} expired samples`);
		this.retentionTimer = setInterval(() => {
			try {
				const removed = this.store.applyRetention(this.options.config.retentionDays);
				if (removed > 0) this.log(`retention: removed ${removed} expired samples`);
			} catch {
				/* ignore */
			}
		}, 3_600_000);
		this.retentionTimer.unref?.();
		this.log(`metrics server listening on http://${host}:${port} (db: ${this.options.config.dbFile})`);
	}

	async stop(): Promise<void> {
		if (this.retentionTimer) clearInterval(this.retentionTimer);
		this.retentionTimer = undefined;
		if (!this.server) return;
		await new Promise<void>((resolve) => this.server!.close(() => resolve()));
		this.server = undefined;
		this.store.close();
	}

	private authorized(req: IncomingMessage): boolean {
		const apiKey = this.options.config.apiKey;
		if (!apiKey) return true;
		return req.headers["x-api-key"] === apiKey;
	}

	private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const url = new URL(req.url ?? "/", "http://localhost");
		const path = url.pathname.replace(/\/+$/, "") || "/";
		try {
			if (req.method === "GET" && path === "/") {
				respond(res, 200, "text/html; charset=utf-8", dashboardHtml());
				return;
			}
			if (req.method === "GET" && path === "/api/v1/health") {
				respond(res, 200, "application/json", JSON.stringify(this.health()));
				return;
			}
			if (req.method === "GET" && path === "/metrics") {
				respond(res, 200, "text/plain; version=0.0.4; charset=utf-8", this.metricsText());
				return;
			}
			if (req.method === "GET" && path === "/api/v1/overview") {
				const days = Math.min(365, Math.max(1, Number(url.searchParams.get("window")?.replace(/d$/, "")) || 7));
				const tool = url.searchParams.get("tool") || undefined;
				const user = url.searchParams.get("user") || undefined;
				const overview = computeOverview(this.store, { days, tool, user });
				respond(res, 200, "application/json", JSON.stringify(overview));
				return;
			}
			if (req.method === "POST" && path === "/api/v1/metrics") {
				if (!this.authorized(req)) return this.unauthorized(res);
				const body = await readBody(req);
				const payload = JSON.parse(body.toString("utf8") || "{}") as PushPayload;
				const samples = sanitizePushSamples(payload);
				const inserted = this.store.insertSamples(samples);
				respond(res, 200, "application/json", JSON.stringify({ ok: true, received: samples.length, inserted }));
				return;
			}
			if (req.method === "POST" && path === "/v1/metrics") {
				if (!this.authorized(req)) return this.unauthorized(res);
				const body = await readBody(req);
				const parsed = JSON.parse(body.toString("utf8") || "{}");
				const samples = decodeOtlpMetrics(parsed, { tracker: this.store.otlpTracker() });
				const inserted = this.store.insertSamples(samples);
				// OTLP spec: reply with ExportMetricsServiceResponse (empty partialSuccess is valid)
				respond(res, 200, "application/json", JSON.stringify({ partialSuccess: {}, inserted }));
				return;
			}
			respond(res, 404, "application/json", JSON.stringify({ error: "not found" }));
		} catch (error) {
			this.log(`request error: ${error instanceof Error ? error.message : String(error)}`);
			respond(res, 400, "application/json", JSON.stringify({ error: error instanceof Error ? error.message : "bad request" }));
		}
	}

	private unauthorized(res: ServerResponse): void {
		respond(res, 401, "application/json", JSON.stringify({ error: "unauthorized" }));
	}

	private health(): Record<string, unknown> {
		let sampleCount = 0;
		let agentCount = 0;
		let lastWriteAt: number | undefined;
		const tools = new Set<string>();
		try {
			const row = this.store.dbRead("select count(*) as n, max(ts) as lastTs from samples").get() as {
				n: number;
				lastTs: number | null;
			};
			sampleCount = Number(row?.n ?? 0);
			lastWriteAt = row?.lastTs ? Number(row.lastTs) : undefined;
			const agents = this.store.dbRead("select count(distinct user) as n from samples").get() as { n: number };
			agentCount = Number(agents?.n ?? 0);
			for (const row of this.store.dbRead("select distinct tool from samples").all() as Array<{ tool: string }>) {
				tools.add(row.tool);
			}
		} catch {
			/* fresh database */
		}
		return {
			ok: true,
			version: PACKAGE_VERSION,
			uptimeSec: Math.floor((Date.now() - this.startedAt) / 1000),
			sampleCount,
			agentCount,
			tools: [...tools].sort(),
			lastWriteAt,
			retentionDays: this.options.config.retentionDays,
		};
	}

	private metricsText(): string {
		const rows = this.store.cumulativeRows();
		const counters: MetricSample[] = rows.map((row) => ({
			metric: row.metric,
			labels: {
				tool: row.tool,
				user: row.user,
				...(row.project ? { project: row.project } : {}),
				...(row.model ? { model: row.model } : {}),
				...MetricsStore.parseDims(row.dims),
			},
			value: Number(row.value),
			ts: Date.now(),
		}));
		const now = Date.now();
		const overview = computeOverview(this.store, { days: 90 });
		return renderPrometheus({
			counters,
			gauges: [
				{
					name: "agent_active_users",
					help: "Active users (distinct users with activity in the window)",
					values: [
						{ labels: { window: "daily" }, value: overview.activeUsers.dau },
						{ labels: { window: "weekly" }, value: overview.activeUsers.wau },
						{ labels: { window: "monthly" }, value: overview.activeUsers.mau },
					],
				},
				{
					name: "agent_edit_adoption_rate",
					help: "AI edit adoption rate over the last 90 days (accepted / (accepted+rejected))",
					values: [{ labels: { window: "90d" }, value: overview.adoption.rate ?? 0 }],
				},
				{
					name: "agent_server_up",
					help: "1 when the metrics server is reachable",
					values: [{ labels: {}, value: 1 }],
				},
			],
			helpText: {
				agent_active_users: `Active users (computed ${new Date(now).toISOString()})`,
			},
		});
	}
}

/** Validates and normalizes an agent push payload into MetricSamples. */
function sanitizePushSamples(payload: PushPayload): MetricSample[] {
	const samples: MetricSample[] = [];
	const tags = payload?.agent?.tags ?? {};
	for (const raw of Array.isArray(payload?.samples) ? payload.samples : []) {
		if (!raw || typeof raw !== "object") continue;
		const { metric, labels, value, ts } = raw as Partial<MetricSample>;
		if (typeof metric !== "string" || metric.length === 0 || metric.length > 200) continue;
		if (typeof value !== "number" || !Number.isFinite(value) || value < 0) continue;
		const safeLabels: Record<string, string> = {};
		for (const [key, labelValue] of Object.entries(labels ?? {})) {
			if (typeof labelValue === "string" && key.length <= 64) safeLabels[key] = labelValue.slice(0, 256);
		}
		for (const [key, labelValue] of Object.entries(tags)) {
			if (typeof labelValue === "string" && !(key in safeLabels)) safeLabels[key] = labelValue;
		}
		// identity precedence: explicit sample labels > agent identity
		safeLabels.tool = safeLabels.tool || "unknown";
		safeLabels.user = safeLabels.user || payload?.agent?.user || "anonymous";
		samples.push({
			metric,
			labels: safeLabels,
			value,
			ts: typeof ts === "number" && ts > 0 ? ts : Date.now(),
		});
	}
	return samples;
}

function respond(res: ServerResponse, status: number, contentType: string, body: string): void {
	res.writeHead(status, { "content-type": contentType });
	res.end(body);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		req.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > 64 * 1024 * 1024) {
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

export { escapeHtml };
