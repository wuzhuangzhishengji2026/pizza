/**
 * Configuration resolution for both agent (client plugin) and server.
 *
 * Precedence: explicit overrides > environment variables > config file > defaults.
 * Config files are searched at `./metrics-monitor.config.json` and
 * `~/.pizza/metrics-monitor.json` (first that exists wins).
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { defaultClaudeHome } from "./adapters/claude-code.js";
import { defaultCodexHome } from "./adapters/codex.js";
import { resolveOpenCodeDataDir } from "./adapters/opencode.js";
import { resolveUserId } from "./identity.js";
import { defaultUser } from "./identity.js";
import type { AgentConfig, ServerConfig } from "./types.js";

export const METRICS_SERVER_PORT = 9480;
export const METRICS_AGENT_PORT = 9465;
export const PACKAGE_VERSION = "0.1.0";

export interface ConfigFileShape {
	user?: string;
	agentId?: string;
	serverUrl?: string;
	apiKey?: string;
	intervalSec?: number;
	pushEnabled?: boolean;
	pullEnabled?: boolean;
	pullPort?: number;
	stateFile?: string;
	tags?: Record<string, string>;
	adapters?: Partial<AgentConfig["adapters"]>;
	paths?: Partial<AgentConfig["paths"]>;
	server?: {
		port?: number;
		host?: string;
		dbFile?: string;
		apiKey?: string;
		retentionDays?: number;
	};
}

export function configFilePaths(): string[] {
	return [join(process.cwd(), "metrics-monitor.config.json"), join(homedir(), ".pizza", "metrics-monitor.json")];
}

export function loadConfigFile(explicitPath?: string): ConfigFileShape {
	const candidates = explicitPath ? [explicitPath] : configFilePaths();
	for (const path of candidates) {
		try {
			if (existsSync(path)) {
				return JSON.parse(readFileSync(path, "utf8")) as ConfigFileShape;
			}
		} catch {
			// corrupt config file: ignore and fall through to defaults
		}
	}
	return {};
}

function numEnv(name: string): number | undefined {
	const raw = process.env[name];
	if (raw === undefined || raw === "") return undefined;
	const value = Number(raw);
	return Number.isFinite(value) ? value : undefined;
}

function boolEnv(name: string): boolean | undefined {
	const raw = process.env[name];
	if (raw === undefined || raw === "") return undefined;
	return !["0", "false", "no", "off"].includes(raw.toLowerCase());
}

export function resolveAgentConfig(overrides: Partial<AgentConfig> & { configPath?: string } = {}): AgentConfig {
	const file = loadConfigFile(overrides.configPath);
	const serverUrl =
		overrides.serverUrl ?? process.env.PIZZA_METRICS_SERVER_URL ?? file.serverUrl ?? "";
	const user = overrides.user ?? process.env.PIZZA_METRICS_USER ?? file.user ?? defaultUser();
	const stateFile =
		overrides.stateFile ??
		process.env.PIZZA_METRICS_STATE_FILE ??
		file.stateFile ??
		join(homedir(), ".pizza", "metrics-monitor", "agent-state.json");

	return {
		user,
		agentId: overrides.agentId ?? file.agentId ?? "",
		serverUrl: serverUrl.replace(/\/+$/, ""),
		apiKey: overrides.apiKey ?? process.env.PIZZA_METRICS_API_KEY ?? file.apiKey ?? "",
		intervalSec:
			overrides.intervalSec ?? numEnv("PIZZA_METRICS_INTERVAL") ?? file.intervalSec ?? 30,
		pushEnabled:
			overrides.pushEnabled ?? boolEnv("PIZZA_METRICS_PUSH") ?? file.pushEnabled ?? Boolean(serverUrl),
		pullEnabled: overrides.pullEnabled ?? boolEnv("PIZZA_METRICS_PULL") ?? file.pullEnabled ?? true,
		pullPort: overrides.pullPort ?? numEnv("PIZZA_METRICS_PULL_PORT") ?? file.pullPort ?? METRICS_AGENT_PORT,
		adapters: {
			pizza: true,
			claudeCode: true,
			opencode: true,
			codex: true,
			...(file.adapters ?? {}),
			...(overrides.adapters ?? {}),
		},
		paths: {
			pizzaAgentDir: process.env.PIZZA_CODING_AGENT_DIR ?? file.paths?.pizzaAgentDir,
			claudeHome: process.env.PIZZA_METRICS_CLAUDE_HOME ?? file.paths?.claudeHome ?? defaultClaudeHome(),
			opencodeDataDir: resolveOpenCodeDataDir(file.paths?.opencodeDataDir),
			codexHome: process.env.PIZZA_METRICS_CODEX_HOME ?? file.paths?.codexHome ?? defaultCodexHome(),
			...(overrides.paths ?? {}),
		},
		stateFile,
		tags: { ...(file.tags ?? {}), ...(overrides.tags ?? {}) },
		otlpExportIntervalSec: 60,
	};
}

export function resolveServerConfig(overrides: Partial<ServerConfig> & { configPath?: string } = {}): ServerConfig {
	const file = loadConfigFile(overrides.configPath);
	const server = file.server ?? {};
	return {
		port: overrides.port ?? numEnv("PIZZA_METRICS_SERVER_PORT") ?? server.port ?? METRICS_SERVER_PORT,
		host: overrides.host ?? process.env.PIZZA_METRICS_SERVER_HOST ?? server.host ?? "127.0.0.1",
		dbFile:
			overrides.dbFile ??
			process.env.PIZZA_METRICS_DB_FILE ??
			server.dbFile ??
			join(homedir(), ".pizza", "metrics-monitor", "server.sqlite"),
		apiKey: overrides.apiKey ?? process.env.PIZZA_METRICS_API_KEY ?? server.apiKey ?? "",
		retentionDays: overrides.retentionDays ?? server.retentionDays ?? 90,
	};
}

/** Stable agent id: config > env > persisted random id in the state file. */
export function ensureAgentId(config: AgentConfig, stateGet: (key: string, fallback: string) => string, stateSet: (key: string, value: string) => void): string {
	if (config.agentId) return config.agentId;
	const fromEnv = process.env.PIZZA_METRICS_AGENT_ID;
	if (fromEnv) return fromEnv;
	const existing = stateGet("agentId", "");
	if (existing) return existing;
	const created = `agt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
	stateSet("agentId", created);
	return created;
}

/** Utility re-export so callers only need one import for identity helpers. */
export { resolveUserId };
