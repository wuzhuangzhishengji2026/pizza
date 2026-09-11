/**
 * Core type definitions for the metrics-monitor platform.
 *
 * The unified metric model: every adapter normalizes its tool-specific data
 * into a flat list of delta samples (value = increment since last collect),
 * labeled with the standard dimensions `tool` / `user` / `project`.
 */

/** A single metric increment (delta). */
export interface MetricSample {
	/** Unified metric name, e.g. `agent_tokens_total`. */
	metric: string;
	/** Labels including the standard `tool`/`user`/`project` plus metric-specific dims. */
	labels: Record<string, string>;
	/** Non-negative increment. */
	value: number;
	/** Event timestamp (epoch ms) — when the activity happened, not when collected. */
	ts: number;
}

/** Standard label keys. */
export const LABEL_TOOL = "tool";
export const LABEL_USER = "user";
export const LABEL_PROJECT = "project";
export const LABEL_MODEL = "model";

/** Unified metric catalog (all counters;Prometheus renders them as counters). */
export const METRICS = {
	sessions: "agent_sessions_total",
	requests: "agent_requests_total",
	tokens: "agent_tokens_total",
	cost: "agent_cost_usd_total",
	toolCalls: "agent_tool_calls_total",
	editDecisions: "agent_edit_decisions_total",
	linesOfCode: "agent_lines_of_code_total",
	activeTime: "agent_active_time_seconds_total",
} as const;

/** Token type label values. */
export const TOKEN_TYPES = ["input", "output", "cache_read", "cache_write", "reasoning"] as const;

/** Tools known to the platform. */
export type ToolId = "pizza" | "claude-code" | "opencode" | "codex" | "gemini-cli";

/** A data source adapter that tails one tool's local storage and emits deltas. */
export interface SourceAdapter {
	readonly id: string;
	/** Whether the tool's data source exists on this machine. */
	discover(): boolean;
	/** Collect new deltas since the last collect. Must not throw for recoverable errors. */
	collect(sink: (sample: MetricSample) => void): Promise<void>;
	/** Human-readable summary for `probe`. */
	describe(): string;
}

/** Resolved agent-side configuration. */
export interface AgentConfig {
	/** Identity reported for the local user (defaults to `username@hostname`). */
	user: string;
	/** Stable agent instance id (persisted). */
	agentId: string;
	/** Cloud server base URL, e.g. `http://metrics.internal:9090`. Empty disables push. */
	serverUrl: string;
	/** Shared secret sent as `x-api-key` (must match server config). */
	apiKey: string;
	/** Collect + push interval in seconds. */
	intervalSec: number;
	/** Push deltas to the cloud server. */
	pushEnabled: boolean;
	/** Serve a local `/metrics` + OTLP relay endpoint. */
	pullEnabled: boolean;
	/** Port for the local endpoint. */
	pullPort: number;
	/** Which adapters are enabled. */
	adapters: {
		pizza: boolean;
		claudeCode: boolean;
		opencode: boolean;
		codex: boolean;
	};
	/** Source root overrides (all optional). */
	paths: {
		pizzaAgentDir?: string;
		claudeHome?: string;
		opencodeDataDir?: string;
		codexHome?: string;
	};
	/** Path of the agent state file (cursors, cumulative counters, pending buffer). */
	stateFile: string;
	/** Extra static labels merged into every emitted sample (e.g. team, env). */
	tags: Record<string, string>;
	/** OTLP export interval for the local relay's own accounting (informational). */
	otlpExportIntervalSec: number;
}

/** Resolved server-side configuration. */
export interface ServerConfig {
	port: number;
	host: string;
	/** SQLite database file (uses node:sqlite, same engine as pizza). */
	dbFile: string;
	/** When set, push/OTLP endpoints require header `x-api-key`. */
	apiKey: string;
	/** Delete samples older than this many days (0 = keep forever). */
	retentionDays: number;
}

/** Push payload sent from agent (or CLI seed) to the server. */
export interface PushPayload {
	agent: {
		id: string;
		user: string;
		hostname: string;
		version: string;
		tags: Record<string, string>;
	};
	samples: MetricSample[];
}

/** An ingest error that should not crash the agent. */
export class CollectError extends Error {
	constructor(
		message: string,
		readonly source: string,
	) {
		super(message);
		this.name = "CollectError";
	}
}
