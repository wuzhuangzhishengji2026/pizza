/**
 * Codex CLI adapter: tails `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`.
 *
 * Rollout files contain cumulative `token_count` snapshots (`payload.info.total_token_usage`),
 * so deltas are computed as monotonic differences per file. Tool-call and
 * adoption signals are not reliably available in rollouts; Codex adoption comes
 * via its OTel export when configured (`codex.*` metrics are normalized
 * server-side), while this adapter covers consumption offline.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { LineTailer, parseJsonLines } from "../file-tail.js";
import { StateFile } from "../state.js";
import { METRICS, type MetricSample, type SourceAdapter } from "../types.js";

export interface CodexOptions {
	codexHome: string;
	user: string;
	tags?: Record<string, string>;
	state: StateFile;
}

interface RolloutLine {
	timestamp?: string;
	type?: string;
	payload?: {
		type?: string;
		cwd?: string;
		id?: string;
		info?: {
			total_token_usage?: {
				input?: number;
				input_tokens?: number;
				output?: number;
				output_tokens?: number;
				cached_input?: number;
				cached_input_tokens?: number;
				total?: number;
				total_tokens?: number;
			};
		};
		total_token_usage?: Record<string, number>;
	};
}

interface FileCursor {
	lastInput: number;
	lastOutput: number;
	lastCached: number;
}

export class CodexAdapter implements SourceAdapter {
	readonly id = "codex";
	private tailer = new LineTailer();
	private cursors = new Map<string, FileCursor>();

	constructor(private readonly options: CodexOptions) {}

	discover(): boolean {
		return existsSync(join(this.options.codexHome, "sessions"));
	}

	describe(): string {
		return `codex rollouts: ${join(this.options.codexHome, "sessions")}`;
	}

	private rolloutFiles(): string[] {
		const root = join(this.options.codexHome, "sessions");
		const files: string[] = [];
		const walk = (dir: string, depth: number): void => {
			if (depth > 4) return;
			let entries;
			try {
				entries = readdirSync(dir, { withFileTypes: true });
			} catch {
				return;
			}
			for (const entry of entries) {
				const path = join(dir, entry.name);
				if (entry.isDirectory()) walk(path, depth + 1);
				else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path);
			}
		};
		walk(root, 0);
		return files;
	}

	async collect(sink: (sample: MetricSample) => void): Promise<void> {
		for (const path of this.rolloutFiles()) {
			this.collectFile(path, sink);
		}
	}

	private collectFile(path: string, sink: (sample: MetricSample) => void): void {
		const lines = this.tailer.poll(path);
		if (lines.length === 0) return;
		const records = parseJsonLines<RolloutLine>(lines);

		const cursorKey = `codex.${path}`;
		let cursor = this.cursors.get(path);
		if (!cursor) {
			const saved = this.options.state.get<FileCursor | undefined>(cursorKey, undefined);
			cursor = saved ?? { lastInput: 0, lastOutput: 0, lastCached: 0 };
			this.cursors.set(path, cursor);
		}

		let project = "";
		let emitted = false;
		for (const record of records) {
			if (!record || typeof record !== "object") continue;
			if (record.type === "session_meta" && record.payload?.cwd && !project) project = record.payload.cwd;

			const payload = record.payload;
			const usage =
				payload?.type === "token_count"
					? (payload.info?.total_token_usage ?? payload.total_token_usage)
					: undefined;
			if (!usage) continue;

			const input = Number(usage.input ?? usage.input_tokens ?? 0);
			const output = Number(usage.output ?? usage.output_tokens ?? 0);
			const cached = Number(usage.cached_input ?? usage.cached_input_tokens ?? 0);

			// cumulative snapshots -> deltas; guard against resets (restart of counters)
			const dInput = Math.max(0, input - cursor.lastInput);
			const dOutput = Math.max(0, output - cursor.lastOutput);
			const dCached = Math.max(0, cached - cursor.lastCached);
			cursor.lastInput = input;
			cursor.lastOutput = output;
			cursor.lastCached = cached;
			if (dInput + dOutput + dCached === 0) continue;

			const ts = parseTimestamp(record.timestamp);
			const base = { tool: "codex", user: this.options.user, project, ...(this.options.tags ?? {}) };
			if (dInput > 0) sink({ metric: METRICS.tokens, labels: { ...base, type: "input" }, value: dInput, ts });
			if (dOutput > 0) sink({ metric: METRICS.tokens, labels: { ...base, type: "output" }, value: dOutput, ts });
			if (dCached > 0) sink({ metric: METRICS.tokens, labels: { ...base, type: "cache_read" }, value: dCached, ts });
			emitted = true;
		}

		if (emitted) {
			this.options.state.set(cursorKey, cursor);
		}
	}
}

function parseTimestamp(raw: string | undefined): number {
	if (raw) {
		const ms = Date.parse(raw);
		if (Number.isFinite(ms)) return ms;
	}
	return Date.now();
}

export function defaultCodexHome(): string {
	return join(homedir(), ".codex");
}
