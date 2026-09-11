import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "../src/sqlite.js";
import { StateFile } from "../src/state.js";
import { PizzaStoreAdapter } from "../src/adapters/pizza-store.js";
import { ClaudeCodeAdapter } from "../src/adapters/claude-code.js";
import { CodexAdapter } from "../src/adapters/codex.js";
import { OpenCodeAdapter } from "../src/adapters/opencode.js";
import { METRICS, type MetricSample } from "../src/types.js";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "mm-adapters-"));
});

afterEach(() => {
	// Windows: SQLite handles can be released asynchronously (AV/indexing) —
	// cleanup is best-effort; the OS clears the temp dir eventually.
	try {
		rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	} catch {
		/* leave the temp dir behind rather than failing the suite */
	}
});

function collect(adapter: { collect(sink: (s: MetricSample) => void): Promise<void> }): Promise<MetricSample[]> {
	const samples: MetricSample[] = [];
	return adapter.collect((s) => samples.push(s)).then(() => samples);
}

function sum(samples: MetricSample[], metric: string, match?: (s: MetricSample) => boolean): number {
	return samples.filter((s) => s.metric === metric && (!match || match(s))).reduce((acc, s) => acc + s.value, 0);
}

// ---------------------------------------------------------------------------
// pizza store adapter
// ---------------------------------------------------------------------------

function createPizzaWorkspace(agentDir: string, wsId: string, cwd: string): string {
	const wsDir = join(agentDir, "workspaces", wsId);
	mkdirSync(wsDir, { recursive: true });
	writeFileSync(join(wsDir, "meta.json"), JSON.stringify({ workspace_id: wsId, cwd }));
	const db = openDatabase(join(wsDir, "events.sqlite"));
	db.exec(`
		create table events (
			sequence integer not null,
			event_id text not null unique,
			workspace_id text not null,
			runtime_id text not null,
			actor_id text not null,
			timestamp integer not null,
			type text not null,
			payload_json text not null,
			caused_by text,
			correlation_id text,
			thread_id text,
			schema_version integer not null default 1,
			idempotency_key text
		);
	`);
	return wsDir;
}

function insertEvent(wsDir: string, sequence: number, type: string, payload: unknown, eventId: string): void {
	const db = openDatabase(join(wsDir, "events.sqlite"));
	db.prepare(
		"insert into events (sequence, event_id, workspace_id, runtime_id, actor_id, timestamp, type, payload_json) values (?, ?, 'ws', 'rt', 'user', ?, ?, ?)",
	).run(sequence, eventId, 1700000000000 + sequence, type, JSON.stringify(payload));
	db.close();
}

describe("PizzaStoreAdapter", () => {
	it("discovers workspaces, projects events and advances cursors", async () => {
		const agentDir = join(root, "agent");
		const wsDir = createPizzaWorkspace(agentDir, "ws_abc", "D:/work/demo");
		insertEvent(wsDir, 0, "SESSION_CREATED", {}, "e0");
		insertEvent(wsDir, 1, "AGENT_MESSAGE_END", { usage: { input: 10, output: 5, cache_read: 0, cache_write: 0, total: 15, cost: 0.01 } }, "e1");
		insertEvent(wsDir, 2, "INTENT_TOOL_CALL", { tool_call_id: "t", tool_name: "edit", arguments: {} }, "i1");
		insertEvent(wsDir, 3, "USER_APPROVAL", { intent_event_id: "i1" }, "e3");
		insertEvent(wsDir, 4, "TOOL_EXECUTION_END", { tool_call_id: "t", tool_name: "edit", result: "", is_error: false }, "e4");
		insertEvent(wsDir, 5, "FILE_MUTATION_APPLIED", { path: "a", operation: "modify", diff: "-x\n+y\n+z" }, "e5");

		const state = new StateFile(join(root, "state.json"));
		const adapter = new PizzaStoreAdapter({ agentDir, user: "u1", state });
		expect(adapter.discover()).toBe(true);

		const first = await collect(adapter);
		expect(sum(first, METRICS.sessions)).toBe(1);
		expect(sum(first, METRICS.requests)).toBe(1);
		expect(sum(first, METRICS.tokens, (s) => s.labels.type === "input")).toBe(10);
		expect(sum(first, METRICS.editDecisions, (s) => s.labels.decision === "accept")).toBe(1);
		expect(sum(first, METRICS.toolCalls)).toBe(1);
		expect(sum(first, METRICS.linesOfCode, (s) => s.labels.type === "added")).toBe(2);
		// project label from meta.json cwd
		expect(first[0].labels.project).toBe("D:/work/demo");

		// second round without new events: no deltas
		const second = await collect(adapter);
		expect(second).toHaveLength(0);

		// new events only: incremental deltas
		insertEvent(wsDir, 6, "AGENT_MESSAGE_END", { usage: { input: 7, output: 0, cache_read: 0, cache_write: 0, total: 7, cost: 0 } }, "e6");
		const third = await collect(adapter);
		expect(sum(third, METRICS.tokens)).toBe(7);
	});
});

// ---------------------------------------------------------------------------
// claude code adapter
// ---------------------------------------------------------------------------

function writeTranscript(claudeHome: string, project: string, file: string, lines: unknown[]): string {
	const dir = join(claudeHome, "projects", project);
	mkdirSync(dir, { recursive: true });
	const path = join(dir, file);
	writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
	return path;
}

describe("ClaudeCodeAdapter", () => {
	it("extracts tokens, requests, tool calls and sessions from transcripts", async () => {
		const claudeHome = join(root, ".claude");
		writeTranscript(claudeHome, "proj", "s1.jsonl", [
			{ type: "assistant", timestamp: "2026-09-10T01:00:00Z", sessionId: "sid-1", cwd: "D:/work/x", message: { role: "assistant", model: "claude-sonnet-4-5", usage: { input_tokens: 100, output_tokens: 40, cache_read_input_tokens: 1000, cache_creation_input_tokens: 20 }, content: [{ type: "text", text: "hi" }, { type: "tool_use", id: "t1", name: "Edit", input: {} }] } },
			{ type: "assistant", timestamp: "2026-09-10T01:01:00Z", sessionId: "sid-1", message: { role: "assistant", model: "claude-sonnet-4-5", usage: { input_tokens: 50, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, content: [] } },
		]);
		const adapter = new ClaudeCodeAdapter({ claudeHome, user: "u1" });
		expect(adapter.discover()).toBe(true);
		const samples = await collect(adapter);

		expect(sum(samples, METRICS.tokens, (s) => s.labels.type === "input")).toBe(150);
		expect(sum(samples, METRICS.tokens, (s) => s.labels.type === "output")).toBe(50);
		expect(sum(samples, METRICS.tokens, (s) => s.labels.type === "cache_read")).toBe(1000);
		expect(sum(samples, METRICS.tokens, (s) => s.labels.type === "cache_write")).toBe(20);
		expect(sum(samples, METRICS.requests)).toBe(2);
		expect(sum(samples, METRICS.toolCalls, (s) => s.labels.tool_name === "Edit")).toBe(1);
		expect(sum(samples, METRICS.sessions)).toBe(1);
		expect(samples[0].labels.tool).toBe("claude-code");
		expect(samples[0].labels.project).toBe("D:/work/x");
		expect(samples[0].labels.model).toBe("claude-sonnet-4-5");

		// append more lines: only new deltas, session not double counted
		appendFileSync(
			join(claudeHome, "projects", "proj", "s1.jsonl"),
			JSON.stringify({ type: "assistant", timestamp: "2026-09-10T02:00:00Z", sessionId: "sid-1", message: { role: "assistant", model: "claude-sonnet-4-5", usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, content: [] } }) + "\n",
		);
		const more = await collect(adapter);
		expect(sum(more, METRICS.tokens)).toBe(10);
		expect(sum(more, METRICS.sessions)).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// codex adapter
// ---------------------------------------------------------------------------

describe("CodexAdapter", () => {
	it("turns cumulative token_count snapshots into deltas", async () => {
		const codexHome = join(root, ".codex");
		const dir = join(codexHome, "sessions", "2026", "09", "10");
		mkdirSync(dir, { recursive: true });
		const line = (input: number, output: number, cached: number) =>
			JSON.stringify({
				timestamp: "2026-09-10T03:00:00Z",
				type: "event_msg",
				payload: { type: "token_count", info: { total_token_usage: { input, output, cached_input: cached } } },
			});
		writeFileSync(join(dir, "rollout-1.jsonl"), [line(100, 10, 0), line(150, 25, 5)].join("\n") + "\n");

		const state = new StateFile(join(root, "state-codex.json"));
		const adapter = new CodexAdapter({ codexHome, user: "u1", state });
		expect(adapter.discover()).toBe(true);
		const samples = await collect(adapter);

		expect(sum(samples, METRICS.tokens, (s) => s.labels.type === "input")).toBe(150);
		expect(sum(samples, METRICS.tokens, (s) => s.labels.type === "output")).toBe(25);
		expect(sum(samples, METRICS.tokens, (s) => s.labels.type === "cache_read")).toBe(5);

		// re-collect: no new data
		expect(await collect(adapter)).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// opencode adapter (legacy JSON storage)
// ---------------------------------------------------------------------------

describe("OpenCodeAdapter", () => {
	it("reads legacy storage/message JSON files", async () => {
		const dataDir = join(root, "opencode");
		const msgDir = join(dataDir, "storage", "message", "sess1");
		mkdirSync(msgDir, { recursive: true });
		writeFileSync(
			join(msgDir, "msg_1.json"),
			JSON.stringify({ role: "assistant", providerID: "anthropic", modelID: "claude-sonnet-4-5", cost: 0, tokens: { input: 100, output: 30, reasoning: 5, cache: { read: 50, write: 10 } }, time: { created: 1700000000000 } }),
		);
		writeFileSync(join(msgDir, "msg_2.json"), JSON.stringify({ role: "user", tokens: {} }));

		const state = new StateFile(join(root, "state-oc.json"));
		const adapter = new OpenCodeAdapter({ dataDir, user: "u1", state });
		expect(adapter.discover()).toBe(true);
		const samples = await collect(adapter);

		expect(sum(samples, METRICS.tokens, (s) => s.labels.type === "input")).toBe(100);
		expect(sum(samples, METRICS.tokens, (s) => s.labels.type === "reasoning")).toBe(5);
		expect(sum(samples, METRICS.requests)).toBe(1);
		expect(sum(samples, METRICS.cost)).toBe(0); // opencode reports cost 0: not emitted
		expect(samples[0].labels.model).toBe("anthropic/claude-sonnet-4-5");
	});
});
