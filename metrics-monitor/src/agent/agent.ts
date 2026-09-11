/**
 * The client-side metrics agent (端侧指标插件, standalone mode).
 *
 * One process per developer machine:
 *   - polls every enabled SourceAdapter (pizza event stores, Claude Code,
 *     OpenCode, Codex local data) for new deltas
 *   - PUSHes deltas to the cloud server (buffered, retried, crash-safe)
 *   - PULL support: serves /metrics for Prometheus and /v1/metrics (OTLP/JSON)
 *     as a local relay for tools on the same machine
 */

import { StateFile } from "../state.js";
import { ensureAgentId } from "../config.js";
import { Collector, LocalEndpoint, pushSamples, type PusherOptions } from "./core.js";
import type { AgentConfig, MetricSample, SourceAdapter } from "../types.js";

export interface AgentOptions {
	/** Adapter injection for tests; defaults to auto-discovery from config. */
	adapters?: SourceAdapter[];
	log?: (message: string) => void;
}

export class MetricsAgent {
	private collector: Collector;
	private state: StateFile;
	private endpoint: LocalEndpoint | undefined;
	private timer: NodeJS.Timeout | undefined;
	private running = false;
	private agentId = "";
	private readonly log: (message: string) => void;

	constructor(
		private readonly config: AgentConfig,
		private readonly adapters: SourceAdapter[],
		private readonly options: AgentOptions = {},
	) {
		this.state = new StateFile(config.stateFile);
		this.collector = new Collector({ user: config.user, tags: config.tags });
		this.log = options.log ?? (() => {});
		this.agentId = ensureAgentId(
			config,
			(key, fallback) => this.state.get(key, fallback),
			(key, value) => this.state.set(key, value),
		);
	}

	async start(): Promise<void> {
		if (this.running) return;
		this.running = true;

		if (this.config.pullEnabled) {
			this.endpoint = new LocalEndpoint({
				port: this.config.pullPort,
				collector: this.collector,
				log: this.log,
			});
			await this.endpoint.start();
		}

		// re-emit any deltas buffered by a previous crash before push succeeded
		const buffered = this.state.get<MetricSample[]>("pendingBuffer", []);
		if (buffered.length > 0) {
			this.log(`resuming ${buffered.length} buffered sample(s) from previous run`);
		}
		this.buffered = buffered;

		await this.collectOnce();
		await this.pushPending();
		this.state.save();
		this.timer = setInterval(() => {
			void this.tick();
		}, Math.max(5, this.config.intervalSec) * 1000);
		this.timer.unref?.();
		this.log(
			`agent started: id=${this.agentId} user=${this.config.user} interval=${this.config.intervalSec}s ` +
				`push=${this.config.pushEnabled ? this.config.serverUrl || "on" : "off"} pull=${this.config.pullEnabled ? `http://127.0.0.1:${this.config.pullPort}/metrics` : "off"}`,
		);
	}

	async stop(): Promise<void> {
		this.running = false;
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		await this.endpoint?.stop();
		this.endpoint = undefined;
		// flush what we can before shutdown
		await this.pushPending();
		this.state.save();
	}

	private buffered: MetricSample[] = [];

	/** Bound port of the local pull endpoint (0 when pull is disabled). */
	get pullPort(): number {
		return this.endpoint?.port ?? 0;
	}

	private async tick(): Promise<void> {
		if (!this.running) return;
		try {
			await this.collectOnce();
			await this.pushPending();
			this.state.save();
		} catch (error) {
			this.log(`tick error: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/** Runs one collect round; returns the number of deltas gathered. */
	async collectOnce(): Promise<number> {
		let count = 0;
		for (const adapter of this.adapters) {
			try {
				if (!adapter.discover()) continue;
				await adapter.collect((sample) => {
					this.collector.ingest([sample]);
					count++;
				});
			} catch (error) {
				this.log(`adapter ${adapter.id} failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		return count;
	}

	private async pushPending(): Promise<void> {
		const drained = this.collector.pending.drain();
		if (drained.length > 0) {
			this.buffered.push(...drained);
		}
		if (this.buffered.length === 0) return;
		if (!this.config.pushEnabled || !this.config.serverUrl) {
			// pull-only mode: cumulative registry already serves /metrics; keep nothing pending
			this.buffered = [];
			this.state.set("pendingBuffer", []);
			return;
		}
		const pusherOptions: PusherOptions = {
			serverUrl: this.config.serverUrl,
			apiKey: this.config.apiKey,
			agentId: this.agentId,
			user: this.config.user,
			tags: this.config.tags,
			log: this.log,
		};
		const ok = await pushSamples(this.buffered, pusherOptions);
		if (ok) {
			this.buffered = [];
			this.state.set("pendingBuffer", []);
		} else {
			// cap the offline buffer so a long outage can't grow unbounded
			this.buffered = this.buffered.slice(-50_000);
			this.state.set("pendingBuffer", this.buffered);
		}
	}

	/** Snapshot for `probe` and tests. */
	snapshot(): { cumulative: number; buffered: number } {
		return { cumulative: this.collector.cumulative.size, buffered: this.buffered.length };
	}
}
