/**
 * SQLite loader mirroring pizza's own approach: prefer the built-in
 * `node:sqlite` (Node >= 22.5), fall back to `bun:sqlite` under Bun.
 * Zero native dependencies.
 */

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

type DatabaseSyncLike = new (path: string, options?: { readOnly?: boolean }) => {
	exec(sql: string): void;
	prepare(sql: string): {
		run(...params: unknown[]): unknown;
		get(...params: unknown[]): unknown;
		all(...params: unknown[]): unknown[];
	};
};

let ctor: DatabaseSyncLike | undefined;

export function loadDatabaseSync(): DatabaseSyncLike {
	if (!ctor) {
		try {
			ctor = (require("node:sqlite") as typeof import("node:sqlite")).DatabaseSync as DatabaseSyncLike;
		} catch {
			try {
				const bunSqlite = require("bun:sqlite") as { Database: DatabaseSyncLike };
				ctor = bunSqlite.Database;
			} catch {
				throw new Error(
					"Neither node:sqlite (Node >= 22.5) nor bun:sqlite is available. metrics-monitor needs one of them.",
				);
			}
		}
	}
	return ctor;
}

export interface SqliteDb {
	exec(sql: string): void;
	prepare(sql: string): {
		run(...params: unknown[]): unknown;
		get(...params: unknown[]): unknown;
		all(...params: unknown[]): unknown[];
	};
	close(): void;
}

/** Open a database file. `readOnly` opens without creating or locking for writes. */
export function openDatabase(path: string, readOnly = false): SqliteDb {
	const Db = loadDatabaseSync();
	return (readOnly ? new Db(path, { readOnly: true }) : new Db(path)) as SqliteDb;
}
