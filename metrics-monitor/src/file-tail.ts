/**
 * Append-only JSONL tailing helper shared by the file-based adapters
 * (Claude Code transcripts, Codex rollouts). Tracks byte offsets, survives
 * file truncation (rotation/rewrite) and skips unparseable lines.
 */

import { existsSync, readSync, openSync, closeSync, statSync } from "node:fs";

const READ_CHUNK = 512 * 1024;

export class LineTailer {
	/** path -> byte offset */
	private offsets = new Map<string, number>();

	/**
	 * Returns new complete lines appended since the last poll.
	 * If the file shrank below the remembered offset it is re-read from the start
	 * (rotation / rewrite) and the offset is reset.
	 */
	poll(path: string, maxBytes = 8 * 1024 * 1024): string[] {
		if (!existsSync(path)) {
			this.offsets.delete(path);
			return [];
		}
		let offset = this.offsets.get(path) ?? 0;
		let size = 0;
		try {
			size = statSync(path).size;
		} catch {
			return [];
		}
		if (size < offset) offset = 0;
		if (size === offset) return [];
		// Guard against pathological growth in a single poll: jump to the tail.
		if (size - offset > maxBytes) offset = size - maxBytes;

		const lines: string[] = [];
		let fd: number | undefined;
		try {
			fd = openSync(path, "r");
			let position = offset;
			let carry = "";
			const buffer = Buffer.alloc(READ_CHUNK);
			while (position < size) {
				const toRead = Math.min(READ_CHUNK, size - position);
				const read = readSync(fd, buffer, 0, toRead, position);
				if (read <= 0) break;
				const chunk = carry + buffer.toString("utf8", 0, read);
				const parts = chunk.split("\n");
				carry = parts.pop() ?? "";
				for (const line of parts) {
					if (line.trim()) lines.push(line);
				}
				position += read;
			}
			// `carry` holds an incomplete trailing line; leave it for the next poll
			// by rewinding the offset to the start of that partial line.
			const consumed = position - Buffer.byteLength(carry, "utf8");
			this.offsets.set(path, consumed);
		} catch {
			// transient read error: retry on next poll from the remembered offset
		} finally {
			if (fd !== undefined) {
				try {
					closeSync(fd);
				} catch {
					/* ignore */
				}
			}
		}
		return lines;
	}

	/** Forget a file (deleted / rotated away). */
	forget(path: string): void {
		this.offsets.delete(path);
	}
}

/** Parses each line as JSON, skipping corrupt lines. */
export function parseJsonLines<T>(lines: string[]): T[] {
	const out: T[] = [];
	for (const line of lines) {
		try {
			out.push(JSON.parse(line) as T);
		} catch {
			// partial or corrupt line — skip
		}
	}
	return out;
}

/** Whether a file exists and is non-empty. */
export function fileExists(path: string): boolean {
	try {
		return existsSync(path) && statSync(path).size > 0;
	} catch {
		return false;
	}
}
