/**
 * Pizza adapter (offline/agent mode): tails the per-workspace event stores
 * under `~/.pizza/agent/workspaces/` (each workspace keeps an `events.sqlite`)
 * and projects the immutable event log into unified metric deltas.
 *
 * The authoritative adoption-rate signals are the USER_APPROVAL / USER_REJECTION
 * events correlated with INTENT_TOOL_CALL — the same projection the in-process
 * extension uses (PizzaEventProjector).
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { openDatabase } from "../sqlite.js";
import { StateFile } from "../state.js";
import { PizzaEventProjector, type PizzaEventLike } from "../normalize.js";
import type { MetricSample, SourceAdapter } from "../types.js";

export interface PizzaStoreOptions {
	/** pizza agent dir (default `~/.pizza/agent`). */
	agentDir: string;
	user: string;
	tags?: Record<string, string>;
	/** Persistence for per-workspace sequence cursors. */
	state: StateFile;
	/** In-memory only projector state (intent correlation). */
	projector?: PizzaEventProjector;
}

interface WorkspaceRef {
	id: string;
	dbPath: string;
}

export class PizzaStoreAdapter implements SourceAdapter {
	readonly id = "pizza";
	private projector: PizzaEventProjector;
	private workspaces: WorkspaceRef[] = [];

	constructor(private readonly options: PizzaStoreOptions) {
		this.projector = options.projector ?? new PizzaEventProjector();
	}

	discover(): boolean {
		return this.listWorkspaces().length > 0;
	}

	describe(): string {
		const workspaces = this.listWorkspaces();
		return `pizza event stores: ${workspaces.length} workspace(s) under ${this.options.agentDir}`;
	}

	private listWorkspaces(): WorkspaceRef[] {
		const root = join(this.options.agentDir, "workspaces");
		if (!existsSync(root)) return [];
		try {
			this.workspaces = readdirSync(root, { withFileTypes: true })
				.filter((entry) => entry.isDirectory() && entry.name.startsWith("ws_"))
				.map((entry) => ({ id: entry.name, dbPath: join(root, entry.name, "events.sqlite") }))
				.filter((ws) => existsSync(ws.dbPath));
		} catch {
			this.workspaces = [];
		}
		return this.workspaces;
	}

	async collect(sink: (sample: MetricSample) => void): Promise<void> {
		for (const workspace of this.listWorkspaces()) {
			this.collectWorkspace(workspace, sink);
		}
	}

	private collectWorkspace(workspace: WorkspaceRef, sink: (sample: MetricSample) => void): void {
		const cursorKey = `pizzaStore.${workspace.id}.lastSequence`;
		const lastSequence = Number(this.options.state.get(cursorKey, -1));

		let rows: Array<{ sequence: number; type: string; payload_json: string; timestamp: number; event_id: string | null }> = [];
		try {
			const db = openDatabase(workspace.dbPath, true);
			try {
				rows = db
					.prepare(
						`select sequence, type, payload_json, timestamp, event_id from events
						 where sequence > ? and type in ('SESSION_CREATED','AGENT_MESSAGE_END','INTENT_TOOL_CALL','USER_APPROVAL','USER_REJECTION','TOOL_EXECUTION_END','FILE_MUTATION_APPLIED')
						 order by sequence asc limit 5000`,
					)
					.all(lastSequence) as typeof rows;
			} finally {
				db.close();
			}
		} catch {
			return; // locked/corrupt db: retry next round
		}

		if (rows.length === 0) return;

		const project = this.projectCwd(workspace.id);
		const base = { user: this.options.user, project, tags: this.options.tags };
		for (const row of rows) {
			let payload: Record<string, unknown> = {};
			try {
				payload = JSON.parse(row.payload_json) as Record<string, unknown>;
			} catch {
				continue;
			}
			const event: PizzaEventLike & { event_id?: string } = {
				type: row.type,
				timestamp: Number(row.timestamp),
				payload,
				event_id: row.event_id ?? undefined,
			};
			this.projector.ingest(event, base, sink);
		}

		const maxSequence = rows[rows.length - 1]?.sequence;
		if (maxSequence !== undefined) {
			this.options.state.set(cursorKey, maxSequence);
		}
	}

	private projectCwd(workspaceId: string): string {
		try {
			const metaPath = join(this.options.agentDir, "workspaces", workspaceId, "meta.json");
			if (existsSync(metaPath)) {
				const meta = JSON.parse(readFileSync(metaPath, "utf8")) as { cwd?: string };
				if (meta.cwd) return meta.cwd;
			}
		} catch {
			/* fall through */
		}
		return workspaceId;
	}
}
