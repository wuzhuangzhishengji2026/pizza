/**
 * Normalization layer: converts tool-specific data into the unified
 * `agent_*` metric model.
 *
 *  - PizzaEventProjector: pizza EventBase stream -> samples (used by both the
 *    in-process extension and the offline events.sqlite adapter).
 *  - OTLP/JSON decoder: accepts native OpenTelemetry pushes from Claude Code,
 *    Gemini CLI, Codex, ... and maps their well-known metric names
 *    (`claude_code.*`, `codex.*`, `gemini_cli.*`) onto the unified model.
 *    Unmapped metrics are passed through as `agent_ext_*` so nothing is lost.
 */

import { METRICS, type MetricSample } from "./types.js";
import { sanitizeMetricName } from "./registry.js";

// ============================================================================
// Pizza
// ============================================================================

export interface PizzaEventLike {
	type: string;
	timestamp: number;
	payload: Record<string, unknown>;
	event_id?: string;
}

export interface PizzaBaseLabels {
	user: string;
	project: string;
	tags?: Record<string, string>;
}

/** File-edit tool names that count towards the adoption rate. */
const EDIT_TOOL_NAMES = new Set([
	"edit",
	"write",
	"multiedit",
	"notebookedit",
	"writefile",
	"editfile",
	"str_replace",
	"str_replace_editor",
	"apply_patch",
	"create_file",
]);

export function isEditTool(toolName: string): boolean {
	return EDIT_TOOL_NAMES.has(toolName.toLowerCase().replace(/[-]/g, "_"));
}

/** Counts added/removed lines in a unified diff. */
export function diffLines(diff: string): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const line of diff.split("\n")) {
		if (line.startsWith("+++") || line.startsWith("---")) continue;
		if (line.startsWith("+")) added++;
		else if (line.startsWith("-")) removed++;
	}
	return { added, removed };
}

/**
 * Correlates INTENT_TOOL_CALL with USER_APPROVAL / USER_REJECTION to compute
 * the edit adoption rate. Keep in one place so the live extension and the
 * offline store adapter behave identically.
 */
export class PizzaEventProjector {
	/** intent event_id -> {tool, ts}; bounded, pruned on ingest. */
	private pendingIntents = new Map<string, { tool: string; ts: number }>();
	private static readonly MAX_PENDING = 4096;

	ingest(event: PizzaEventLike, base: PizzaBaseLabels, sink: (sample: MetricSample) => void): void {
		const labels = { tool: "pizza", user: base.user, project: base.project, ...(base.tags ?? {}) };
		const ts = Number(event.timestamp) || Date.now();
		const payload = (event.payload ?? {}) as Record<string, unknown>;

		switch (event.type) {
			case "SESSION_CREATED": {
				sink({ metric: METRICS.sessions, labels, value: 1, ts });
				break;
			}
			case "AGENT_MESSAGE_END": {
				sink({ metric: METRICS.requests, labels, value: 1, ts });
				const usage = payload.usage as Record<string, number> | undefined;
				if (usage) {
					this.emitTokens(labels, ts, sink, {
						input: usage.input,
						output: usage.output,
						cache_read: usage.cache_read,
						cache_write: usage.cache_write,
					});
				}
				const cost = usage?.cost;
				if (typeof cost === "number" && cost > 0) {
					sink({ metric: METRICS.cost, labels, value: cost, ts });
				}
				break;
			}
			case "INTENT_TOOL_CALL": {
				const intentId = String(event.event_id ?? "");
				const toolName = String(payload.tool_name ?? "");
				if (intentId && toolName) {
					this.pendingIntents.set(intentId, { tool: toolName, ts });
					if (this.pendingIntents.size > PizzaEventProjector.MAX_PENDING) {
						// drop oldest
						const oldest = this.pendingIntents.keys().next().value;
						if (oldest !== undefined) this.pendingIntents.delete(oldest);
					}
				}
				break;
			}
			case "USER_APPROVAL":
			case "USER_REJECTION": {
				const intentId = String(payload.intent_event_id ?? "");
				const pending = this.pendingIntents.get(intentId);
				this.pendingIntents.delete(intentId);
				if (!pending || !isEditTool(pending.tool)) break;
				const decision = event.type === "USER_APPROVAL" ? "accept" : "reject";
				sink({
					metric: METRICS.editDecisions,
					labels: { ...labels, decision, tool_name: pending.tool },
					value: 1,
					ts,
				});
				break;
			}
			case "TOOL_EXECUTION_END": {
				const toolName = String(payload.tool_name ?? "unknown");
				const isError = payload.is_error === true;
				sink({
					metric: METRICS.toolCalls,
					labels: { ...labels, tool_name: toolName, is_error: String(isError) },
					value: 1,
					ts,
				});
				break;
			}
			case "FILE_MUTATION_APPLIED": {
				const diffs: string[] = [];
				if (typeof payload.diff === "string") diffs.push(payload.diff);
				if (Array.isArray(payload.mutations)) {
					for (const mutation of payload.mutations as Record<string, unknown>[]) {
						if (typeof mutation?.diff === "string") diffs.push(mutation.diff);
					}
				}
				let added = 0;
				let removed = 0;
				for (const diff of diffs) {
					const lines = diffLines(diff);
					added += lines.added;
					removed += lines.removed;
				}
				if (added > 0) sink({ metric: METRICS.linesOfCode, labels: { ...labels, type: "added" }, value: added, ts });
				if (removed > 0)
					sink({ metric: METRICS.linesOfCode, labels: { ...labels, type: "removed" }, value: removed, ts });
				break;
			}
			default:
				break;
		}
	}

	private emitTokens(
		labels: Record<string, string>,
		ts: number,
		sink: (sample: MetricSample) => void,
		tokens: { input?: unknown; output?: unknown; cache_read?: unknown; cache_write?: unknown },
	): void {
		const mapping: Array<[string, unknown]> = [
			["input", tokens.input],
			["output", tokens.output],
			["cache_read", tokens.cache_read],
			["cache_write", tokens.cache_write],
		];
		for (const [type, value] of mapping) {
			if (typeof value === "number" && value > 0) {
				sink({ metric: METRICS.tokens, labels: { ...labels, type }, value, ts });
			}
		}
	}
}

// ============================================================================
// OTLP/JSON (metrics only)
// ============================================================================

export interface OtlpAttribute {
	key: string;
	value: Record<string, unknown>;
}

export interface OtlpMetric {
	name: string;
	unit?: string;
	sum?: OtlpSum;
	gauge?: { dataPoints: OtlpDataPoint[] };
	histogram?: unknown;
}

export interface OtlpSum {
	dataPoints: OtlpDataPoint[];
	aggregationTemporality?: number;
	isMonotonic?: boolean;
}

export interface OtlpDataPoint {
	attributes?: OtlpAttribute[];
	asDouble?: number;
	asInt?: number;
	timeUnixNano?: string | number;
	startTimeUnixNano?: string | number;
}

export interface OtlpResourceMetrics {
	resource?: { attributes?: OtlpAttribute[] };
	scopeMetrics?: Array<{ scope?: { name?: string }; metrics?: OtlpMetric[] }>;
}

/** Tracks last cumulative value per series to convert OTLP cumulative sums into deltas. */
export interface CumulativeTracker {
	last(key: string): number | undefined;
	set(key: string, value: number): void;
}

/** In-memory tracker (agent local relay). */
export class MemoryCumulativeTracker implements CumulativeTracker {
	private map = new Map<string, number>();
	last(key: string): number | undefined {
		return this.map.get(key);
	}
	set(key: string, value: number): void {
		this.map.set(key, value);
	}
}

function attrValue(attr: OtlpAttribute): string | undefined {
	const value = attr.value ?? {};
	if ("stringValue" in value) return String(value.stringValue);
	if ("intValue" in value) return String(value.intValue);
	if ("doubleValue" in value) return String(value.doubleValue);
	if ("boolValue" in value) return String(value.boolValue);
	if ("arrayValue" in value || "kvlistValue" in value) return JSON.stringify(value);
	return undefined;
}

export function attributesToRecord(attributes: OtlpAttribute[] | undefined): Record<string, string> {
	const record: Record<string, string> = {};
	for (const attr of attributes ?? []) {
		const value = attrValue(attr);
		if (value !== undefined && value !== "") record[attr.key] = value;
	}
	return record;
}

const TOOL_BY_PREFIX: Array<[prefix: string, tool: string]> = [
	["claude_code", "claude-code"],
	["codex", "codex"],
	["gemini_cli", "gemini-cli"],
];

export function inferToolFromMetric(name: string, resourceLabels: Record<string, string>): string {
	for (const [prefix, tool] of TOOL_BY_PREFIX) {
		if (name.startsWith(prefix)) return tool;
	}
	return resourceLabels["tool"] || resourceLabels["service.name"] || "unknown";
}

function identityFromResource(resourceLabels: Record<string, string>): string {
	return (
		resourceLabels["user.email"] ||
		resourceLabels["enduser.id"] ||
		resourceLabels["user.id"] ||
		resourceLabels["user.account_uuid"] ||
		resourceLabels["user.account_id"] ||
		"anonymous"
	);
}

function projectFromResource(resourceLabels: Record<string, string>): string {
	return resourceLabels["project"] || resourceLabels["project.name"] || resourceLabels["cwd"] || "";
}

/** Metric-specific attribute name candidates for the token type dimension. */
const TOKEN_TYPE_ATTRS = ["type", "token_type", "token.type"];
const DECISION_ATTRS = ["decision", "decision_type"];
const TOOL_NAME_ATTRS = ["tool_name", "tool.name", "toolname"];

function firstAttr(labels: Record<string, string>, keys: string[]): string | undefined {
	for (const key of keys) {
		const value = labels[key];
		if (value !== undefined && value !== "") return value;
	}
	return undefined;
}

function normalizeTokenType(raw: string | undefined): string {
	const value = (raw ?? "").toLowerCase();
	switch (value) {
		case "cacheread":
		case "cache_read":
		case "cached":
		case "cache read":
			return "cache_read";
		case "cachecreation":
		case "cache_creation":
		case "cache_write":
		case "cache write":
			return "cache_write";
		case "thought":
		case "thinking":
		case "reasoning":
			return "reasoning";
		case "input":
		case "prompt":
			return "input";
		case "output":
		case "completion":
			return "output";
		case "":
			return "total";
		default:
			return value.replace(/[^a-z0-9]+/g, "_");
	}
}

export interface OtlpNormalizeOptions {
	/** Provides last cumulative values for monotonic sums. */
	tracker: CumulativeTracker;
	/** Extra static labels (e.g. config tags). */
	tags?: Record<string, string>;
	/** Overrides the resource-derived identity (agent relay already knows the local user). */
	userOverride?: string;
}

/**
 * Decodes an OTLP/JSON export request body into unified delta samples.
 * Supports `sum` (cumulative -> delta via tracker) and `gauge` data points;
 * histograms are ignored (v1 limitation, documented).
 */
export function decodeOtlpMetrics(body: unknown, options: OtlpNormalizeOptions): MetricSample[] {
	const samples: MetricSample[] = [];
	const root = body as { resourceMetrics?: OtlpResourceMetrics[] };
	if (!root || !Array.isArray(root.resourceMetrics)) return samples;

	for (const resourceMetrics of root.resourceMetrics) {
		const resourceLabels = attributesToRecord(resourceMetrics.resource?.attributes);
		const user = options.userOverride || identityFromResource(resourceLabels);
		const project = projectFromResource(resourceLabels);

		for (const scopeMetrics of resourceMetrics.scopeMetrics ?? []) {
			for (const metric of scopeMetrics.metrics ?? []) {
				processMetric(metric, resourceLabels, user, project, options, samples);
			}
		}
	}
	return samples;
}

function processMetric(
	metric: OtlpMetric,
	resourceLabels: Record<string, string>,
	user: string,
	project: string,
	options: OtlpNormalizeOptions,
	samples: MetricSample[],
): void {
	const name = metric.name ?? "";
	const tool = inferToolFromMetric(name, resourceLabels);
	const baseLabels: Record<string, string> = { tool, user, project, ...(options.tags ?? {}) };

	const points: OtlpDataPoint[] = metric.sum?.dataPoints ?? metric.gauge?.dataPoints ?? [];
	const isSum = Boolean(metric.sum);
	for (const point of points) {
		const pointLabels = attributesToRecord(point.attributes);
		const raw = point.asDouble ?? point.asInt;
		if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) continue;

		let value: number;

		if (isSum) {
			// OTLP cumulative sums represent activity since the exporting process
			// started. First observation counts as a delta (matches process-start
			// semantics; the server persists last-values so restarts don't double
			// count), higher values count as differences, and a lower value is a
			// counter reset (exporter restarted) counted in full.
			const seriesKey = `${tool}\u0000${user}\u0000${name}\u0000${JSON.stringify(pointLabels)}`;
			const last = options.tracker.last(seriesKey);
			value = last === undefined ? raw : raw >= last ? raw - last : raw;
			options.tracker.set(seriesKey, raw);
			if (value <= 0) continue;
		} else {
			value = raw;
		}

		const mapped = mapMetric(name, pointLabels, baseLabels);
		if (!mapped) {
			// pass-through so unknown metrics remain visible
			samples.push({
				metric: `agent_ext_${sanitizeMetricName(name)}`,
				labels: { ...baseLabels, ...pointLabels },
				value,
				ts: pointTime(point),
			});
			continue;
		}
		const scaled = mapped.scale ? value * mapped.scale : value;
		samples.push({
			metric: mapped.metric,
			labels: { ...mapped.labels, ...extraDims(pointLabels, mapped.metric) },
			value: scaled,
			ts: pointTime(point),
		});
	}
}

function pointTime(point: OtlpDataPoint): number {
	const raw = point.timeUnixNano;
	if (raw === undefined) return Date.now();
	const nano = typeof raw === "string" ? Number(raw) : raw;
	return Number.isFinite(nano) && nano > 0 ? Math.floor(nano / 1e6) : Date.now();
}

/** Extra dimensions worth keeping per unified metric (bounded cardinality). */
function extraDims(pointLabels: Record<string, string>, metric: string): Record<string, string> {
	if (metric === METRICS.editDecisions) {
		const toolName = firstAttr(pointLabels, TOOL_NAME_ATTRS);
		return toolName ? { tool_name: toolName } : {};
	}
	if (metric === METRICS.toolCalls) {
		const toolName = firstAttr(pointLabels, TOOL_NAME_ATTRS);
		return toolName ? { tool_name: toolName } : {};
	}
	return {};
}

interface MappedMetric {
	metric: string;
	labels: Record<string, string>;
	/** Value scale applied after delta conversion (e.g. microusd -> usd). */
	scale?: number;
}

function mapMetric(name: string, pointLabels: Record<string, string>, baseLabels: Record<string, string>): MappedMetric | null {
	const model = pointLabels["model"] || pointLabels["model_id"];
	const withModel = model ? { ...baseLabels, model } : baseLabels;

	if (name.startsWith("claude_code.")) {
		return mapClaudeCode(name, pointLabels, withModel);
	}
	if (name.startsWith("codex.")) {
		return mapCodex(name, pointLabels, withModel);
	}
	if (name.startsWith("gemini_cli.")) {
		return mapGeminiCli(name, pointLabels, withModel);
	}
	return null;
}

/** Keeps the model label only on metrics where it applies (avoids empty-label noise). */
function mapClaudeCode(name: string, pointLabels: Record<string, string>, base: Record<string, string>): MappedMetric | null {
	switch (name) {
		case "claude_code.token.usage":
		case "claude_code.token_usage": {
			const type = normalizeTokenType(firstAttr(pointLabels, TOKEN_TYPE_ATTRS));
			return { metric: METRICS.tokens, labels: { ...base, type } };
		}
		case "claude_code.cost.usage":
		case "claude_code.cost_usage":
			return { metric: METRICS.cost, labels: base };
		case "claude_code.session.count":
		case "claude_code.session_count":
			return { metric: METRICS.sessions, labels: base };
		case "claude_code.code_edit_tool.decision":
		case "claude_code.code_edit_tool_decision": {
			const decision = (firstAttr(pointLabels, DECISION_ATTRS) ?? "unknown").toLowerCase();
			const toolName = firstAttr(pointLabels, TOOL_NAME_ATTRS);
			return { metric: METRICS.editDecisions, labels: { ...base, decision, ...(toolName ? { tool_name: toolName } : {}) } };
		}
		case "claude_code.lines_of_code.count":
		case "claude_code.lines_of_code_count": {
			const type = (pointLabels["type"] ?? "added").toLowerCase();
			return { metric: METRICS.linesOfCode, labels: { ...base, type } };
		}
		case "claude_code.active_time.total":
		case "claude_code.active_time_total":
			return { metric: METRICS.activeTime, labels: base };
		default:
			return null;
	}
}

function mapCodex(name: string, pointLabels: Record<string, string>, base: Record<string, string>): MappedMetric | null {
	if (name.includes("token_usage") || name.includes("token.usage")) {
		const type = normalizeTokenType(firstAttr(pointLabels, TOKEN_TYPE_ATTRS));
		return { metric: METRICS.tokens, labels: { ...base, type } };
	}
	if (name.includes("cost_microusd") || name.includes("cost.usd") || name.includes("cost_usage")) {
		return { metric: METRICS.cost, labels: base, scale: name.includes("microusd") ? 1e-6 : 1 };
	}
	if (name.includes("tool.call") || name.includes("tool_call")) {
		const toolName = firstAttr(pointLabels, TOOL_NAME_ATTRS);
		return { metric: METRICS.toolCalls, labels: { ...base, ...(toolName ? { tool_name: toolName } : {}) } };
	}
	if (name.includes("api_request") || name.includes("api.request")) {
		return { metric: METRICS.requests, labels: base };
	}
	return null;
}

function mapGeminiCli(name: string, pointLabels: Record<string, string>, base: Record<string, string>): MappedMetric | null {
	if (name.includes("token.usage") || name.includes("token_usage")) {
		const type = normalizeTokenType(firstAttr(pointLabels, TOKEN_TYPE_ATTRS));
		return { metric: METRICS.tokens, labels: { ...base, type } };
	}
	if (name.includes("session.count") || name.includes("session_count")) {
		return { metric: METRICS.sessions, labels: base };
	}
	if (name.includes("tool.call.count") || name.includes("tool_call_count")) {
		const toolName = firstAttr(pointLabels, TOOL_NAME_ATTRS);
		return { metric: METRICS.toolCalls, labels: { ...base, ...(toolName ? { tool_name: toolName } : {}) } };
	}
	if (name.includes("api.request.count") || name.includes("api_request_count")) {
		return { metric: METRICS.requests, labels: base };
	}
	return null;
}
