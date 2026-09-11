/**
 * Integration check: load src/adapters/pizza-live.ts through pizza's own jiti
 * extension loader (the same path pizza uses for user extensions) and drive it
 * with a stub ExtensionAPI + event store.
 *
 * Run from metrics-monitor/:  node scripts/check-pizza-live.mjs
 */
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const { createJiti } = require("@mariozechner/jiti");

const root = mkdtempSync(join(tmpdir(), "mm-jiti-"));
const port = 19465 + Math.floor(Math.random() * 400);
process.env.PIZZA_METRICS_STATE_FILE = join(root, "state.json");
process.env.PIZZA_METRICS_USER = "jiti-tester";
process.env.PIZZA_METRICS_PULL_PORT = String(port);
process.env.PIZZA_METRICS_PUSH = "0";

const jiti = createJiti(import.meta.url, { interopDefault: true, tryNative: false });
const extensionPath = pathToFileURL(join(import.meta.dirname, "..", "src", "adapters", "pizza-live.ts")).href;
const factory = await jiti.import(extensionPath, { default: true });
if (typeof factory !== "function") throw new Error("pizza-live.ts did not export a default factory");

// stub ExtensionAPI (structural subset of pizza's ExtensionAPI)
const listeners = new Map();
const pizza = {
	on(event, handler) {
		if (!listeners.has(event)) listeners.set(event, []);
		listeners.get(event).push(handler);
	},
};
factory(pizza);

// simulate session_start handing us pizza's event store
const storeEvents = [
	{ type: "SESSION_CREATED", timestamp: 1700000000000, payload: {}, event_id: "s1" },
	{
		type: "AGENT_MESSAGE_END",
		timestamp: 1700000001000,
		payload: { model: { provider: "x", model_id: "m1" }, usage: { input: 11, output: 7, cache_read: 0, cache_write: 0, total: 18, cost: 0.02 } },
	},
	{ type: "INTENT_TOOL_CALL", timestamp: 1700000002000, payload: { tool_call_id: "t", tool_name: "edit", arguments: {} }, event_id: "i1" },
	{ type: "USER_REJECTION", timestamp: 1700000003000, payload: { intent_event_id: "i1" } },
];
const store = {
	subscribe: (listener) => {
		storeEvents.forEach(listener);
		return () => {};
	},
};
for (const handler of listeners.get("session_start") ?? []) {
	await handler({ type: "session_start", reason: "startup" }, { cwd: "D:/work/demo", sessionManager: { eventStore: store } });
}

// the extension defers its background start by one tick
await new Promise((resolve) => setTimeout(resolve, 400));

const response = await fetch(`http://127.0.0.1:${port}/metrics`);
const text = await response.text();
const lines = text.split("\n").filter((line) => line.startsWith("agent_"));
console.log("---- /metrics excerpt ----");
console.log(lines.slice(0, 8).join("\n"));

const ok =
	text.includes("agent_tokens_total{") &&
	text.includes('tool="pizza"') &&
	text.includes("agent_edit_decisions_total{") &&
	text.includes('decision="reject"') &&
	lines.length >= 6;

console.log(ok ? "PIZZA-LIVE JITI CHECK: PASS" : "PIZZA-LIVE JITI CHECK: FAIL");
rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
process.exit(ok ? 0 : 1);
