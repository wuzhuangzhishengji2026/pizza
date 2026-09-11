/**
 * Pizza in-process metrics extension (端侧指标插件, pizza 集成模式).
 *
 * Usage — add to `~/.pizza/agent/settings.json` (or `<project>/.pizza/settings.json`):
 *
 *   {
 *     "extensions": ["/path/to/metrics-monitor/src/adapters/pizza-live.ts"]
 *   }
 *
 * (or the built path: ".../metrics-monitor/dist/adapters/pizza-live.js")
 *
 * The factory subscribes to pizza's event store (via the extension session
 * manager) and projects events into unified metric deltas — the same
 * projection used by the offline events.sqlite adapter. Deltas are:
 *   - PUSHed to the cloud server (config: PIZZA_METRICS_SERVER_URL / api key /
 *     `~/.pizza/metrics-monitor.json`), and/or
 *   - exposed for PULL at http://127.0.0.1:<pullPort>/metrics for Prometheus,
 *     with an OTLP/JSON relay at POST /v1/metrics for local tools.
 *
 * Config: env vars + `~/.pizza/metrics-monitor.json` (see README).
 *
 * NOTE: intentionally dependency-free and structurally typed — this file is
 * loaded by pizza's jiti extension loader and must not import pizza itself.
 */

import { hostname } from "node:os";
import { ensureAgentId, resolveAgentConfig } from "../config.js";
import { Collector, LocalEndpoint, packageVersion, pushSamples } from "../agent/core.js";
import { StateFile } from "../state.js";
import { PizzaEventProjector, type PizzaEventLike } from "../normalize.js";
import type { AgentConfig, MetricSample } from "../types.js";

/** Structural subset of pizza's ExtensionAPI (kept loose on purpose). */
interface PizzaExtensionApiLike {
	on(event: string, handler: (event: unknown, ctx: PizzaExtensionContextLike) => void | Promise<void>): void;
	registerCommand?(command: { name: string; description: string; handler: (ctx: unknown) => void | Promise<void> }): void;
}

interface PizzaExtensionContextLike {
	cwd?: string;
	sessionManager?: {
		eventStore?: {
			subscribe?: (listener: (event: unknown) => void, options?: unknown) => () => void;
		};
	};
}

interface PizzaStoreEventLike extends PizzaEventLike {
	type: string;
	timestamp: number;
	payload: Record<string, unknown>;
	event_id?: string;
}

const KNOWN_EVENTS = new Set([
	"SESSION_CREATED",
	"AGENT_MESSAGE_END",
	"INTENT_TOOL_CALL",
	"USER_APPROVAL",
	"USER_REJECTION",
	"TOOL_EXECUTION_END",
	"FILE_MUTATION_APPLIED",
]);

export function createPizzaMetricsExtension(pizza: PizzaExtensionApiLike): void {
	const config: AgentConfig = resolveAgentConfig();
	const state = new StateFile(config.stateFile);
	const agentId = ensureAgentId(
		config,
		(key, fallback) => state.get(key, fallback),
		(key, value) => state.set(key, value),
	);
	const collector = new Collector({ user: config.user, tags: config.tags });
	const projector = new PizzaEventProjector();

	// pizza has no per-user identity; the workspace cwd acts as the project label
	let currentProject = process.cwd();
	const baseTags = config.tags;

	const ingestEvent = (raw: unknown): void => {
		const event = raw as PizzaStoreEventLike;
		if (!event || typeof event.type !== "string" || !KNOWN_EVENTS.has(event.type)) return;
		const samples: MetricSample[] = [];
		projector.ingest(
			{ type: event.type, timestamp: event.timestamp, payload: event.payload ?? {}, event_id: event.event_id },
			{ user: config.user, project: currentProject, tags: baseTags },
			(sample) => samples.push(sample),
		);
		collector.ingest(samples);
	};

	pizza.on("session_start", (_event, ctx) => {
		if (ctx?.cwd) currentProject = ctx.cwd;
		const store = ctx?.sessionManager?.eventStore;
		if (store?.subscribe) {
			store.subscribe((event: unknown) => ingestEvent(event));
		}
	});

	let endpoint: LocalEndpoint | undefined;
	let timer: NodeJS.Timeout | undefined;
	const started = { value: false };

	const startBackground = (): void => {
		if (started.value) return;
		started.value = true;
		if (config.pullEnabled) {
			endpoint = new LocalEndpoint({ port: config.pullPort, collector });
			void endpoint.start().catch(() => {
				// port busy (e.g. the standalone agent already owns it): pull is optional
			});
		}
		if (config.pushEnabled && config.serverUrl) {
			timer = setInterval(() => {
				void (async () => {
					const samples = collector.pending.drain();
					if (samples.length === 0) return;
					await pushSamples(samples, {
						serverUrl: config.serverUrl,
						apiKey: config.apiKey,
						agentId,
						user: config.user,
						tags: baseTags,
					});
					state.save();
				})();
			}, Math.max(5, config.intervalSec) * 1000);
			timer.unref?.();
		}
	};
	// defer background start to the next tick so pizza startup is never blocked
	setTimeout(startBackground, 0);

	// optional /metrics:status command inside pizza (best-effort registration)
	pizza.registerCommand?.({
		name: "metrics-status",
		description: "Show metrics-monitor plugin status (samples collected, push/pull endpoints)",
		handler: (ctx: unknown) => {
			const ui = (ctx as { ui?: { notify?: (message: string) => void } })?.ui;
			const message =
				`metrics-monitor: ${collector.cumulative.size} cumulative series, ` +
				`push=${config.pushEnabled ? config.serverUrl : "off"}, ` +
				`pull=${config.pullEnabled ? `http://127.0.0.1:${config.pullPort}/metrics` : "off"}, ` +
				`agent=${agentId}@${hostname()}, v${packageVersion()}`;
			ui?.notify?.(message);
		},
	});

	// flush on graceful shutdown
	pizza.on("session_shutdown", () => {
		if (timer) clearInterval(timer);
		state.save();
		void pushSamples(collector.pending.drain(), {
			serverUrl: config.serverUrl,
			apiKey: config.apiKey,
			agentId,
			user: config.user,
			tags: baseTags,
		});
		void endpoint?.stop();
	});
}

export default createPizzaMetricsExtension;
