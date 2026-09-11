/**
 * metrics-monitor public API.
 *
 * Library usage:
 *   import { MetricsAgent, MetricsServer, resolveAgentConfig, resolveServerConfig } from "pizza-metrics-monitor";
 */

export * from "./types.js";
export { resolveAgentConfig, resolveServerConfig, loadConfigFile, PACKAGE_VERSION } from "./config.js";
export { MetricsAgent } from "./agent/agent.js";
export { Collector, LocalEndpoint, pushSamples } from "./agent/core.js";
export { MetricsServer } from "./server/server.js";
export { MetricsStore } from "./server/store.js";
export { computeOverview } from "./server/kpi.js";
export { dashboardHtml } from "./server/dashboard.js";
export { PizzaEventProjector, decodeOtlpMetrics, diffLines } from "./normalize.js";
export { DeltaAggregator, CumulativeRegistry, renderPrometheus } from "./registry.js";
export { PizzaStoreAdapter } from "./adapters/pizza-store.js";
export { ClaudeCodeAdapter } from "./adapters/claude-code.js";
export { OpenCodeAdapter } from "./adapters/opencode.js";
export { CodexAdapter } from "./adapters/codex.js";
export { StateFile } from "./state.js";
