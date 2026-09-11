/**
 * Durable agent state: adapter cursors, cumulative counters and the pending
 * push buffer live in a single JSON file so the agent survives restarts
 * without double-counting or losing unsent deltas.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export class StateFile {
	private data: Record<string, unknown>;
	private dirty = false;

	constructor(readonly filePath: string) {
		try {
			this.data = existsSync(filePath) ? (JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>) : {};
		} catch {
			// Corrupt state (e.g. crash mid-write before the atomic rename existed):
			// start fresh rather than refusing to run. Cursors reset -> sources
			// re-emit from their local cumulative stores; the server dedupes by
			// timestamps and counter resets are handled downstream.
			this.data = {};
		}
	}

	get<T>(key: string, fallback: T): T {
		const value = this.data[key];
		return value === undefined ? fallback : (value as T);
	}

	set(key: string, value: unknown): void {
		this.data[key] = value;
		this.dirty = true;
	}

	delete(key: string): void {
		if (key in this.data) {
			delete this.data[key];
			this.dirty = true;
		}
	}

	has(key: string): boolean {
		return key in this.data;
	}

	/** Drop keys matching a prefix — used to cap unbounded cursor maps. */
	prunePrefix(prefix: string, keep: (key: string, value: unknown) => boolean): void {
		for (const key of Object.keys(this.data)) {
			if (key.startsWith(prefix) && !keep(key, this.data[key])) {
				delete this.data[key];
				this.dirty = true;
			}
		}
	}

	save(): void {
		if (!this.dirty) return;
		mkdirSync(dirname(this.filePath), { recursive: true });
		const tmp = `${this.filePath}.${process.pid}.tmp`;
		writeFileSync(tmp, JSON.stringify(this.data), "utf8");
		renameSync(tmp, this.filePath);
		this.dirty = false;
	}
}
