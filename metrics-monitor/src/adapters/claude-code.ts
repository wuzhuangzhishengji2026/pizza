/**
 * Claude Code adapter: tails `~/.claude/projects/<project>/*.jsonl` session
 * transcripts and extracts what is reliable from them:
 *   - token consumption (message.usage: input / output / cache read / cache creation)
 *   - LLM request counts and models
 *   - tool calls (assistant tool_use blocks)
 *   - session counts (one transcript file per session)
 *
 * Edit adoption is deliberately NOT parsed from transcripts — the format is
 * internal and rejection markers are not stable. Adoption for Claude Code comes
 * from its official OpenTelemetry metric `claude_code.code_edit_tool.decision`,
 * which this platform ingests natively (push directly to the server, or to the
 * local agent relay).
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { LineTailer, parseJsonLines } from "../file-tail.js";
import { METRICS, type MetricSample, type SourceAdapter } from "../types.js";

export interface ClaudeCodeOptions {
	claudeHome: string;
	user: string;
	tags?: Record<string, string>;
}

interface TranscriptLine {
	type?: string;
	timestamp?: string;
	sessionId?: string;
	session_id?: string;
	cwd?: string;
	isSidechain?: boolean;
	message?: {
		role?: string;
		model?: string;
		usage?: {
			input_tokens?: number;
			output_tokens?: number;
			cache_read_input_tokens?: number;
			cache_creation_input_tokens?: number;
		};
		content?: Array<Record<string, unknown>>;
	};
}

export class ClaudeCodeAdapter implements SourceAdapter {
	readonly id = "claude-code";
	private tailer = new LineTailer();
	private countedSessions = new Set<string>();

	constructor(private readonly options: ClaudeCodeOptions) {}

	discover(): boolean {
		return existsSync(join(this.options.claudeHome, "projects"));
	}

	describe(): string {
		return `claude code transcripts: ${join(this.options.claudeHome, "projects")}`;
	}

	/** All transcript files, oldest first. */
	private transcriptFiles(): string[] {
		const projectsDir = join(this.options.claudeHome, "projects");
		if (!existsSync(projectsDir)) return [];
		const files: string[] = [];
		try {
			for (const project of readdirSync(projectsDir, { withFileTypes: true })) {
				if (!project.isDirectory()) continue;
				const dir = join(projectsDir, project.name);
				try {
					for (const file of readdirSync(dir, { withFileTypes: true })) {
						if (file.isFile() && file.name.endsWith(".jsonl")) files.push(join(dir, file.name));
					}
				} catch {
					/* unreadable dir: skip */
				}
			}
		} catch {
			return [];
		}
		return files;
	}

	async collect(sink: (sample: MetricSample) => void): Promise<void> {
		for (const path of this.transcriptFiles()) {
			this.collectFile(path, sink);
		}
	}

	private collectFile(path: string, sink: (sample: MetricSample) => void): void {
		const lines = this.tailer.poll(path);
		if (lines.length === 0) return;
		const records = parseJsonLines<TranscriptLine>(lines);

		let project = "";
		let sessionId = "";
		for (const record of records) {
			if (!record || typeof record !== "object") continue;
			if (record.cwd && !project) project = record.cwd;
			const sid = record.sessionId ?? record.session_id ?? "";
			if (sid && !sessionId) sessionId = sid;

			if (record.type !== "assistant" || !record.message) continue;
			const usage = record.message.usage;
			const ts = parseTimestamp(record.timestamp);
			const model = sanitizeModel(record.message.model);
			const base = { tool: "claude-code", user: this.options.user, project, ...(this.options.tags ?? {}) };
			const labels = model ? { ...base, model } : base;

			if (usage) {
				emitTokens(sink, labels, ts, usage);
			}
			sink({ metric: METRICS.requests, labels, value: 1, ts });

			const content = record.message.content ?? [];
			for (const block of content) {
				if (block?.type === "tool_use" && typeof block.name === "string") {
					sink({
						metric: METRICS.toolCalls,
						labels: { ...base, tool_name: String(block.name) },
						value: 1,
						ts,
					});
				}
			}
		}

		// one session per transcript file (first-seen only)
		const sessionKey = sessionId || path;
		if (sessionKey && !this.countedSessions.has(sessionKey)) {
			this.countedSessions.add(sessionKey);
			if (this.countedSessions.size > 5000) {
				const oldest = this.countedSessions.values().next().value;
				if (oldest !== undefined) this.countedSessions.delete(oldest);
			}
			const base = { tool: "claude-code", user: this.options.user, project, ...(this.options.tags ?? {}) };
			sink({ metric: METRICS.sessions, labels: base, value: 1, ts: parseTimestamp(records[0]?.timestamp) });
		}
	}
}

function emitTokens(
	sink: (sample: MetricSample) => void,
	labels: Record<string, string>,
	ts: number,
	usage: NonNullable<TranscriptLine["message"]>["usage"],
): void {
	const mapping: Array<[string, number | undefined]> = [
		["input", usage?.input_tokens],
		["output", usage?.output_tokens],
		["cache_read", usage?.cache_read_input_tokens],
		["cache_write", usage?.cache_creation_input_tokens],
	];
	for (const [type, value] of mapping) {
		if (typeof value === "number" && value > 0) {
			sink({ metric: METRICS.tokens, labels: { ...labels, type }, value, ts });
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

function sanitizeModel(model: string | undefined): string {
	if (!model || model === "auto" || model === "<synthetic>") return "";
	return model;
}

export function defaultClaudeHome(): string {
	return join(homedir(), ".claude");
}
