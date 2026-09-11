/**
 * `pizza-metrics` CLI.
 *
 *   pizza-metrics agent          run the client-side collector (push + local pull)
 *   pizza-metrics serve          run the cloud-side platform (dashboard + APIs)
 *   pizza-metrics probe          show which local data sources were discovered
 *   pizza-metrics seed           push demo data into a running server
 *   pizza-metrics help
 */

import { resolveAgentConfig, resolveServerConfig, PACKAGE_VERSION } from "./config.js";
import { MetricsAgent } from "./agent/agent.js";
import { MetricsServer } from "./server/server.js";
import { pushSamples } from "./agent/core.js";
import { StateFile } from "./state.js";
import { PizzaStoreAdapter } from "./adapters/pizza-store.js";
import { ClaudeCodeAdapter } from "./adapters/claude-code.js";
import { OpenCodeAdapter } from "./adapters/opencode.js";
import { CodexAdapter } from "./adapters/codex.js";
import type { AgentConfig, SourceAdapter } from "./types.js";

const log = (message: string): void => {
	console.log(`[pizza-metrics] ${message}`);
};

function parseArgs(argv: string[]): Record<string, string> {
	const args: Record<string, string> = {};
	for (let i = 0; i < argv.length; i++) {
		const token = argv[i];
		if (token === undefined || !token.startsWith("--")) continue;
		const key = token.slice(2);
		const next = argv[i + 1];
		if (next !== undefined && !next.startsWith("--")) {
			args[key] = next;
			i++;
		} else {
			args[key] = "true";
		}
	}
	return args;
}

function buildAdapters(config: AgentConfig, state: StateFile): SourceAdapter[] {
	const adapters: SourceAdapter[] = [];
	if (config.adapters.pizza) {
		adapters.push(
			new PizzaStoreAdapter({
				agentDir: config.paths.pizzaAgentDir ?? `${process.env.HOME ?? process.env.USERPROFILE}/.pizza/agent`,
				user: config.user,
				tags: config.tags,
				state,
			}),
		);
	}
	if (config.adapters.claudeCode) {
		adapters.push(new ClaudeCodeAdapter({ claudeHome: config.paths.claudeHome!, user: config.user, tags: config.tags }));
	}
	if (config.adapters.opencode) {
		adapters.push(new OpenCodeAdapter({ dataDir: config.paths.opencodeDataDir!, user: config.user, tags: config.tags, state }));
	}
	if (config.adapters.codex) {
		adapters.push(new CodexAdapter({ codexHome: config.paths.codexHome!, user: config.user, tags: config.tags, state }));
	}
	return adapters;
}

async function cmdAgent(args: Record<string, string>): Promise<number> {
	const config = resolveAgentConfig({
		configPath: args.config,
		serverUrl: args.server,
		apiKey: args["api-key"],
		user: args.user,
		intervalSec: args.interval ? Number(args.interval) : undefined,
		pullPort: args.port ? Number(args.port) : undefined,
		stateFile: args["state-file"],
	});
	const state = new StateFile(config.stateFile);
	const adapters = buildAdapters(config, state);
	const agent = new MetricsAgent(config, adapters, { log });
	await agent.start();
	log(`pid ${process.pid} — ctrl+c to stop`);
	const shutdown = (): void => {
		void agent.stop().then(() => process.exit(0));
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
	return 0;
}

async function cmdServe(args: Record<string, string>): Promise<number> {
	const config = resolveServerConfig({
		configPath: args.config,
		port: args.port ? Number(args.port) : undefined,
		host: args.host,
		dbFile: args.db,
		apiKey: args["api-key"],
		retentionDays: args.retention ? Number(args.retention) : undefined,
	});
	const server = new MetricsServer({ config, log });
	await server.start();
	log(`dashboard: http://${config.host}:${config.port}/`);
	log(`push endpoints: POST /api/v1/metrics (agent), POST /v1/metrics (OTLP/JSON)`);
	log(`pull endpoint: GET /metrics (Prometheus)`);
	const shutdown = (): void => {
		void server.stop().then(() => process.exit(0));
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
	return 0;
}

async function cmdProbe(args: Record<string, string>): Promise<number> {
	const config = resolveAgentConfig({ configPath: args.config });
	const state = new StateFile(config.stateFile);
	const adapters = buildAdapters(config, state);
	console.log(`identity user: ${config.user}`);
	console.log(`push server:   ${config.pushEnabled ? config.serverUrl || "(set)" : "disabled"}  interval=${config.intervalSec}s`);
	console.log(`pull endpoint: ${config.pullEnabled ? `http://127.0.0.1:${config.pullPort}/metrics` : "disabled"}`);
	console.log(`state file:    ${config.stateFile}`);
	console.log("");
	for (const adapter of adapters) {
		const found = adapter.discover();
		console.log(`[${found ? "x" : " "}] ${adapter.id.padEnd(12)} ${adapter.describe()}`);
	}
	return 0;
}

interface SeedOptions {
	days: number;
	users: string[];
	tools: string[];
	serverUrl: string;
	apiKey: string;
}

async function cmdSeed(args: Record<string, string>): Promise<number> {
	const serverUrl = (args.server ?? args["server-url"] ?? "http://127.0.0.1:9480").replace(/\/+$/, "");
	const apiKey = args["api-key"] ?? "";
	const days = Number(args.days ?? 14);
	const options: SeedOptions = {
		days,
		users: (args.users ?? "zhang.san@dev,li.si@dev,wang.wu@dev").split(",").map((u) => u.trim()),
		tools: (args.tools ?? "pizza,claude-code,opencode,codex").split(",").map((u) => u.trim()),
		serverUrl,
		apiKey,
	};
	const samples = generateSeedSamples(options);
	log(`pushing ${samples.length} seed samples to ${serverUrl}/api/v1/metrics ...`);
	const ok = await pushSamples(samples, {
		serverUrl,
		apiKey,
		agentId: "seed-agent",
		user: "seed",
		tags: { seed: "true" },
		log,
	});
	if (!ok) {
		log("seed push failed — is the server running? (pizza-metrics serve)");
		return 1;
	}
	log("seed data pushed. open the dashboard to view it.");
	return 0;
}

/** Deterministic-ish plausible demo data: weekdays heavier, adoption 30-60%. */
export function generateSeedSamples(options: SeedOptions): import("./types.js").MetricSample[] {
	const samples: import("./types.js").MetricSample[] = [];
	const models: Record<string, string[]> = {
		pizza: ["anthropic/claude-sonnet-4-5", "openai/gpt-5.2"],
		"claude-code": ["claude-sonnet-4-5", "claude-opus-4-6"],
		opencode: ["anthropic/claude-sonnet-4-5", "kimi-k2.5"],
		codex: ["gpt-5.2-codex"],
	};
	const now = Date.now();
	const dayMs = 86_400_000;
	let seed = 42;
	const rand = (): number => {
		seed = (seed * 1103515245 + 12345) % 2147483648;
		return seed / 2147483648;
	};

	for (let day = options.days - 1; day >= 0; day--) {
		const dayStart = new Date(now - day * dayMs);
		dayStart.setHours(0, 0, 0, 0);
		const weekend = [0, 6].includes(dayStart.getDay());
		for (const user of options.users) {
			if (rand() < (weekend ? 0.45 : 0.12)) continue; // some users idle
			for (const tool of options.tools) {
				if (rand() < 0.3) continue; // not everyone uses every tool
				const project = `proj-${tool}-${1 + Math.floor(rand() * 2)}`;
				const base = { tool, user, project };
				const sessions = 1 + Math.floor(rand() * (weekend ? 2 : 4));
				samples.push({ metric: "agent_sessions_total", labels: base, value: sessions, ts: dayStart.getTime() + 9 * 3_600_000 });
				const model = models[tool]?.[Math.floor(rand() * (models[tool]?.length ?? 1))] ?? "unknown";
				const requests = Math.round(sessions * (6 + rand() * 14));
				samples.push({ metric: "agent_requests_total", labels: { ...base, model }, value: requests, ts: dayStart.getTime() + 12 * 3_600_000 });
				const inputK = requests * (8 + rand() * 12);
				const outputK = requests * (1.5 + rand() * 2.5);
				samples.push({ metric: "agent_tokens_total", labels: { ...base, model, type: "input" }, value: Math.round(inputK * 1000), ts: dayStart.getTime() + 12 * 3_600_000 });
				samples.push({ metric: "agent_tokens_total", labels: { ...base, model, type: "output" }, value: Math.round(outputK * 1000), ts: dayStart.getTime() + 12 * 3_600_000 });
				samples.push({ metric: "agent_tokens_total", labels: { ...base, model, type: "cache_read" }, value: Math.round(inputK * 700), ts: dayStart.getTime() + 12 * 3_600_000 });
				samples.push({ metric: "agent_cost_usd_total", labels: { ...base, model }, value: Number(((inputK * 3 + outputK * 15) / 1000).toFixed(4)), ts: dayStart.getTime() + 12 * 3_600_000 });
				samples.push({ metric: "agent_tool_calls_total", labels: { ...base, tool_name: "bash" }, value: Math.round(requests * (1 + rand() * 2)), ts: dayStart.getTime() + 13 * 3_600_000 });
				samples.push({ metric: "agent_tool_calls_total", labels: { ...base, tool_name: "read" }, value: Math.round(requests * (2 + rand() * 3)), ts: dayStart.getTime() + 13 * 3_600_000 });
				const accepted = Math.round(4 + rand() * 16);
				const rejected = Math.round(2 + rand() * 10);
				samples.push({ metric: "agent_edit_decisions_total", labels: { ...base, decision: "accept", tool_name: "edit" }, value: accepted, ts: dayStart.getTime() + 14 * 3_600_000 });
				samples.push({ metric: "agent_edit_decisions_total", labels: { ...base, decision: "reject", tool_name: "edit" }, value: rejected, ts: dayStart.getTime() + 14 * 3_600_000 });
				samples.push({ metric: "agent_lines_of_code_total", labels: { ...base, type: "added" }, value: accepted * (5 + Math.round(rand() * 20)), ts: dayStart.getTime() + 14 * 3_600_000 });
				samples.push({ metric: "agent_lines_of_code_total", labels: { ...base, type: "removed" }, value: accepted * Math.round(rand() * 8), ts: dayStart.getTime() + 14 * 3_600_000 });
			}
		}
	}
	return samples;
}

const HELP = `pizza-metrics ${PACKAGE_VERSION} — AI coding agent efficiency platform (能效管理平台)

Usage:
  pizza-metrics agent [--server URL] [--api-key KEY] [--interval SEC] [--port PORT] [--user ID] [--config FILE]
      Client-side collector: tails local tool data (pizza / claude code / opencode / codex),
      pushes deltas to the cloud server and serves a local /metrics pull endpoint.

  pizza-metrics serve [--port PORT] [--host HOST] [--db FILE] [--api-key KEY] [--retention DAYS] [--config FILE]
      Cloud-side platform: push ingestion (/api/v1/metrics, /v1/metrics OTLP),
      Prometheus pull (/metrics), KPI API and built-in dashboard at /.

  pizza-metrics probe [--config FILE]
      Show which local data sources were discovered and the effective config.

  pizza-metrics seed [--server URL] [--days N] [--users a,b,c] [--tools t1,t2]
      Push demo data into a running server (try the dashboard).

  pizza-metrics help
      This help.

Environment:
  PIZZA_METRICS_SERVER_URL / PIZZA_METRICS_API_KEY / PIZZA_METRICS_USER
  PIZZA_METRICS_INTERVAL / PIZZA_METRICS_PULL_PORT / PIZZA_METRICS_PUSH / PIZZA_METRICS_PULL
  Config file: ./metrics-monitor.config.json or ~/.pizza/metrics-monitor.json
`;

async function main(argv: string[]): Promise<number> {
	const [command, ...rest] = argv;
	const args = parseArgs(rest);
	switch (command) {
		case "agent":
			return cmdAgent(args);
		case "serve":
			return cmdServe(args);
		case "probe":
			return cmdProbe(args);
		case "seed":
			return cmdSeed(args);
		case "help":
		case "--help":
		case "-h":
		case undefined:
			process.stdout.write(HELP);
			return 0;
		default:
			process.stderr.write(`unknown command: ${command}\n\n${HELP}`);
			return 1;
	}
}

// Only run when executed directly (not when imported in tests).
const isMain = process.argv[1]?.replace(/\\/g, "/").endsWith("cli.js");
if (isMain) {
	void main(process.argv.slice(2)).then((code) => {
		process.exitCode = code;
	});
}
