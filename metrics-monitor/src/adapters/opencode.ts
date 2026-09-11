/**
 * OpenCode adapter: reads local OpenCode storage.
 *
 *  - v1.14+: SQLite database `opencode.db` (table `message`, JSON `data` column
 *    with `tokens: {input, output, reasoning, cache: {read, write}}`).
 *  - legacy: `storage/message/<sessionID>/msg_*.json` files with the same fields.
 *
 * OpenCode reports `cost: 0` in its data, so cost is only emitted when the
 * source actually provides a non-zero value.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { openDatabase } from "../sqlite.js";
import { StateFile } from "../state.js";
import { METRICS, type MetricSample, type SourceAdapter } from "../types.js";

export interface OpenCodeOptions {
	dataDir: string;
	user: string;
	tags?: Record<string, string>;
	state: StateFile;
}

interface OpenCodeMessage {
	role?: string;
	modelID?: string;
	providerID?: string;
	cost?: number;
	tokens?: {
		input?: number;
		output?: number;
		reasoning?: number;
		cache?: { read?: number; write?: number };
	};
	time?: { created?: number; updated?: number; completed?: number };
	sessionID?: string;
}

export class OpenCodeAdapter implements SourceAdapter {
	readonly id = "opencode";

	constructor(private readonly options: OpenCodeOptions) {}

	discover(): boolean {
		return existsSync(join(this.options.dataDir, "opencode.db")) || existsSync(join(this.options.dataDir, "storage", "message"));
	}

	describe(): string {
		return `opencode data: ${this.options.dataDir} (sqlite or legacy json)`;
	}

	async collect(sink: (sample: MetricSample) => void): Promise<void> {
		if (existsSync(join(this.options.dataDir, "opencode.db"))) {
			this.collectSqlite(sink);
		}
		if (existsSync(join(this.options.dataDir, "storage", "message"))) {
			this.collectLegacyJson(sink);
		}
	}

	private collectSqlite(sink: (sample: MetricSample) => void): void {
		const cursorKey = "opencode.sqlite.lastRowId";
		const lastRowId = Number(this.options.state.get(cursorKey, 0));
		let rows: Array<{ rowid: number; data: string }> = [];
		try {
			const db = openDatabase(join(this.options.dataDir, "opencode.db"), true);
			try {
				rows = db.prepare("select rowid, data from message where rowid > ? order by rowid asc limit 5000").all(lastRowId) as typeof rows;
			} finally {
				db.close();
			}
		} catch {
			return; // schema drift or locked db: skip this round
		}
		let maxRowId = lastRowId;
		for (const row of rows) {
			maxRowId = Math.max(maxRowId, Number(row.rowid));
			try {
				const message = JSON.parse(row.data) as OpenCodeMessage;
				this.emitMessage(message, Date.now(), sink);
			} catch {
				continue;
			}
		}
		if (maxRowId > lastRowId) this.options.state.set(cursorKey, maxRowId);
	}

	private collectLegacyJson(sink: (sample: MetricSample) => void): void {
		const cursorKey = "opencode.legacy.lastMtime";
		const lastMtime = Number(this.options.state.get(cursorKey, 0));
		const messageRoot = join(this.options.dataDir, "storage", "message");
		let maxMtime = lastMtime;
		const seen = new Set<string>();

		let sessionDirs: string[] = [];
		try {
			sessionDirs = readdirSync(messageRoot, { withFileTypes: true })
				.filter((entry) => entry.isDirectory())
				.map((entry) => join(messageRoot, entry.name));
		} catch {
			return;
		}

		for (const dir of sessionDirs) {
			let files: string[] = [];
			try {
				files = readdirSync(dir).filter((name) => name.endsWith(".json"));
			} catch {
				continue;
			}
			for (const name of files) {
				const path = join(dir, name);
				try {
					const mtime = statSync(path).mtimeMs;
					if (mtime <= lastMtime) continue;
					maxMtime = Math.max(maxMtime, mtime);
					// a message file can be written once and updated (rare); key on size to avoid double count
					const size = statSync(path).size;
					const dedupeKey = `${path}:${size}`;
					if (seen.has(dedupeKey)) continue;
					seen.add(dedupeKey);
					const message = JSON.parse(readFileSync(path, "utf8")) as OpenCodeMessage;
					this.emitMessage(message, mtime, sink);
				} catch {
					continue;
				}
			}
		}
		if (maxMtime > lastMtime) this.options.state.set(cursorKey, maxMtime);
	}

	private emitMessage(message: OpenCodeMessage, ts: number, sink: (sample: MetricSample) => void): void {
		if (!message || message.role !== "assistant") return;
		const tokens = message.tokens ?? {};
		const model = message.modelID ? `${message.providerID ?? ""}/${message.modelID}`.replace(/^\/+/, "") : "";
		const base: Record<string, string> = { tool: "opencode", user: this.options.user, ...(this.options.tags ?? {}) };
		if (model) base.model = model;

		const mapping: Array<[string, number | undefined]> = [
			["input", tokens.input],
			["output", tokens.output],
			["reasoning", tokens.reasoning],
			["cache_read", tokens.cache?.read],
			["cache_write", tokens.cache?.write],
		];
		let any = false;
		for (const [type, value] of mapping) {
			if (typeof value === "number" && value > 0) {
				any = true;
				sink({ metric: METRICS.tokens, labels: { ...base, type }, value, ts });
			}
		}
		if (any) {
			sink({ metric: METRICS.requests, labels: base, value: 1, ts });
		}
		const cost = Number(message.cost ?? 0);
		if (cost > 0) {
			sink({ metric: METRICS.cost, labels: base, value: cost, ts });
		}
	}
}

/** Candidate data dirs, first existing wins. */
export function resolveOpenCodeDataDir(configured?: string): string {
	const candidates = [
		configured,
		process.env.OPENCODE_DATA_DIR,
		join(homedir(), ".local", "share", "opencode"),
		join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "opencode"),
	].filter((value): value is string => Boolean(value));
	for (const candidate of candidates) {
		if (existsSync(candidate)) return candidate;
	}
	return candidates[0] ?? join(homedir(), ".local", "share", "opencode");
}
