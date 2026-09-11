/**
 * Server storage: SQLite (node:sqlite, same engine pizza uses) holding raw
 * metric deltas. Raw-delta storage keeps the server simple and lets KPIs be
 * recomputed at query time; volumes are small (per-event deltas, not spans).
 *
 * Idempotency: each sample row carries a dedupe hash so an agent that re-sends
 * a batch after a crash (push succeeded, state save didn't) cannot double count.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { openDatabase, type SqliteDb } from "../sqlite.js";
import { dimsKey } from "../registry.js";
import type { CumulativeTracker } from "../normalize.js";
import type { MetricSample } from "../types.js";

export interface CumulativeRow {
	metric: string;
	tool: string;
	user: string;
	project: string;
	model: string;
	dims: string;
	value: number;
}

const IDENTITY_LABELS = ["tool", "user", "project", "model"];

export class MetricsStore {
	private db: SqliteDb;
	private insertStmt: ReturnType<SqliteDb["prepare"]>;

	constructor(dbFile: string) {
		if (dbFile !== ":memory:") {
			mkdirSync(dirname(dbFile), { recursive: true });
		}
		this.db = openDatabase(dbFile);
		this.db.exec(`
			create table if not exists samples (
				id integer primary key autoincrement,
				ts integer not null,
				tool text not null,
				user text not null,
				project text not null default '',
				model text not null default '',
				metric text not null,
				dims text not null default '',
				value real not null,
				dedupe text not null
			);
			create unique index if not exists uniq_samples_dedupe on samples(dedupe);
			create index if not exists idx_samples_ts on samples(ts);
			create index if not exists idx_samples_metric_ts on samples(metric, ts);
			create index if not exists idx_samples_user_ts on samples(user, ts);
			create table if not exists otlp_last (
				key text primary key,
				value real not null,
				ts integer not null
			);
			create table if not exists meta (
				key text primary key,
				value text not null
			);
		`);
		this.insertStmt = this.db.prepare(
			`insert or ignore into samples (ts, tool, user, project, model, metric, dims, value, dedupe)
			 values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		);
	}

	insertSamples(samples: MetricSample[]): number {
		let inserted = 0;
		for (const sample of samples) {
			const labels = sample.labels ?? {};
			const dims = dimsKey(labels, IDENTITY_LABELS);
			const dedupe = createHash("sha1")
				.update(
					[
						sample.ts,
						labels.tool ?? "",
						labels.user ?? "",
						labels.project ?? "",
						labels.model ?? "",
						sample.metric,
						dims,
						sample.value,
					].join("\u0000"),
				)
				.digest("hex");
			const result = this.insertStmt.run(
				sample.ts,
				labels.tool ?? "unknown",
				labels.user ?? "anonymous",
				labels.project ?? "",
				labels.model ?? "",
				sample.metric,
				dims,
				sample.value,
				dedupe,
			) as { changes?: number };
			inserted += Number(result?.changes ?? 0);
		}
		return inserted;
	}

	/** Persistent cumulative->delta tracker for OTLP pushes (survives restarts). */
	otlpTracker(): CumulativeTracker {
		const getStmt = this.db.prepare("select value from otlp_last where key = ?");
		const setStmt = this.db.prepare(
			`insert into otlp_last (key, value, ts) values (?, ?, ?)
			 on conflict(key) do update set value = excluded.value, ts = excluded.ts`,
		);
		return {
			last: (key) => {
				const row = getStmt.get(key) as { value: number } | undefined;
				return row === undefined ? undefined : Number(row.value);
			},
			set: (key, value) => {
				setStmt.run(key, value, Date.now());
			},
		};
	}

	metaGet(key: string): string | undefined {
		const row = this.db.prepare("select value from meta where key = ?").get(key) as
			| { value: string }
			| undefined;
		return row?.value;
	}

	/** Prepare a read query (used by the KPI layer). */
	dbRead(sql: string): ReturnType<SqliteDb["prepare"]> {
		return this.db.prepare(sql);
	}

	metaSet(key: string, value: string): void {
		this.db
			.prepare("insert into meta (key, value) values (?, ?) on conflict(key) do update set value = excluded.value")
			.run(key, value);
	}

	applyRetention(retentionDays: number): number {
		if (retentionDays <= 0) return 0;
		const cutoff = Date.now() - retentionDays * 86_400_000;
		const result = this.db.prepare("delete from samples where ts < ?").run(cutoff) as { changes?: number };
		return Number(result?.changes ?? 0);
	}

	/** All-time cumulative sums per identity+series (for the /metrics pull endpoint). */
	cumulativeRows(): CumulativeRow[] {
		return this.db
			.prepare(
				`select metric, tool, user, project, model, dims, sum(value) as value
				 from samples group by metric, tool, user, project, model, dims`,
			)
			.all() as CumulativeRow[];
	}

	/** Parse a dims string back into a label record. */
	static parseDims(dims: string): Record<string, string> {
		const labels: Record<string, string> = {};
		if (!dims) return labels;
		for (const pair of dims.split(",")) {
			const idx = pair.indexOf("=");
			if (idx <= 0) continue;
			labels[pair.slice(0, idx)] = pair.slice(idx + 1);
		}
		return labels;
	}

	close(): void {
		this.db.close();
	}
}
