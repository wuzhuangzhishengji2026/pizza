/**
 * Metric aggregation and Prometheus exposition.
 *
 * Everything internal is a delta (increment). Two aggregators are derived:
 *  - DeltaAggregator: merges the current collect round's deltas for pushing.
 *  - CumulativeRegistry: running totals for the pull endpoint (/metrics).
 *
 * The Prometheus text format (version 0.0.4) is rendered by hand — we only
 * emit counters and gauges, which keeps the renderer small and dependency-free.
 */

import type { MetricSample } from "./types.js";

const METRIC_NAME_RE = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export function sanitizeMetricName(name: string): string {
	const cleaned = name.replace(/[^a-zA-Z0-9_:]/g, "_").replace(/^[^a-zA-Z_:]+/, "_");
	return METRIC_NAME_RE.test(cleaned) ? cleaned : "agent_invalid_metric";
}

function escapeLabelValue(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

export function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

/** Canonical, order-stable string for the extra (non-identity) labels of a sample. */
export function dimsKey(labels: Record<string, string>, exclude: string[]): string {
	const parts: string[] = [];
	for (const key of Object.keys(labels).sort()) {
		if (exclude.includes(key)) continue;
		const value = labels[key];
		if (value === undefined || value === "") continue;
		parts.push(`${key}=${value}`);
	}
	return parts.join(",");
}

function keyFor(sample: MetricSample, exclude: string[]): string {
	return `${sample.metric}\u0000${dimsKey(sample.labels, exclude)}`;
}

/** Merges deltas of one collect round: metric+dims -> summed increment. */
export class DeltaAggregator {
	private map = new Map<string, { sample: MetricSample }>();

	add(sample: MetricSample): void {
		if (!Number.isFinite(sample.value) || sample.value === 0) return;
		if (sample.value < 0) return; // deltas are increments; negative corrections are ignored
		const key = keyFor(sample, []);
		const existing = this.map.get(key);
		if (existing) {
			existing.sample.value += sample.value;
			// keep the earliest timestamp of the merged window
			existing.sample.ts = Math.min(existing.sample.ts, sample.ts);
		} else {
			this.map.set(key, { sample: { ...sample, labels: { ...sample.labels } } });
		}
	}

	get size(): number {
		return this.map.size;
	}

	drain(): MetricSample[] {
		const samples = [...this.map.values()].map((entry) => entry.sample);
		this.map.clear();
		return samples;
	}
}

/** Running totals per metric+full-labelset, rendered as Prometheus counters. */
export class CumulativeRegistry {
	private totals = new Map<string, { sample: MetricSample }>();

	add(sample: MetricSample): void {
		if (!Number.isFinite(sample.value) || sample.value <= 0) return;
		const key = keyFor(sample, []);
		const existing = this.totals.get(key);
		if (existing) {
			existing.sample.value += sample.value;
		} else {
			this.totals.set(key, { sample: { ...sample, labels: { ...sample.labels } } });
		}
	}

	samples(): MetricSample[] {
		return [...this.totals.values()].map((entry) => entry.sample);
	}

	get size(): number {
		return this.totals.size;
	}
}

export interface PrometheusGauge {
	name: string;
	help: string;
	/** Labeled gauge values; empty labels object = single unlabeled gauge. */
	values: { labels: Record<string, string>; value: number }[];
}

export interface RenderOptions {
	counters: MetricSample[];
	gauges?: PrometheusGauge[];
	/** HELP/TYPE header text per metric name (optional). */
	helpText?: Record<string, string>;
}

/** Renders counters + gauges in the Prometheus text exposition format. */
export function renderPrometheus(options: RenderOptions): string {
	const lines: string[] = [];
	const seenHelp = new Set<string>();

	const emitHeader = (name: string, type: "counter" | "gauge", helpOverride?: string): void => {
		if (seenHelp.has(name)) return;
		seenHelp.add(name);
		const help = helpOverride ?? options.helpText?.[name] ?? `${name} (metrics-monitor)`;
		lines.push(`# HELP ${name} ${help.replace(/\n/g, " ")}`);
		lines.push(`# TYPE ${name} ${type}`);
	};

	const emitLabels = (labels: Record<string, string>): string => {
		const parts: string[] = [];
		for (const key of Object.keys(labels).sort()) {
			if (!LABEL_NAME_RE.test(key)) continue;
			const value = labels[key];
			if (value === undefined || value === "") continue;
			parts.push(`${key}="${escapeLabelValue(value)}"`);
		}
		return parts.length ? `{${parts.join(",")}}` : "";
	};

	for (const sample of options.counters) {
		const name = sanitizeMetricName(sample.metric);
		emitHeader(name, "counter");
		lines.push(`${name}${emitLabels(sample.labels)} ${formatValue(sample.value)}`);
	}
	for (const gauge of options.gauges ?? []) {
		emitHeader(sanitizeMetricName(gauge.name), "gauge", gauge.help);
		for (const entry of gauge.values) {
			lines.push(`${sanitizeMetricName(gauge.name)}${emitLabels(entry.labels)} ${formatValue(entry.value)}`);
		}
	}
	return lines.length ? `${lines.join("\n")}\n` : "";
}

function formatValue(value: number): string {
	if (Number.isInteger(value)) return String(value);
	return String(Math.round(value * 1e6) / 1e6);
}
