/**
 * Identity resolution: who is running the agent on this machine.
 *
 * Pizza has no account concept, and neither do the other local CLI tools, so
 * the default identity is derived from the OS user + hostname. It can be
 * overridden explicitly for team deployments (config `user`, or the
 * `PIZZA_METRICS_USER` / `METRICS_MONITOR_USER` env vars).
 */

import { hostname, userInfo } from "node:os";

export function defaultUser(): string {
	let name = "unknown";
	let host = "localhost";
	try {
		name = userInfo().username || name;
	} catch {
		/* ignore */
	}
	try {
		host = hostname() || host;
	} catch {
		/* ignore */
	}
	// Keep it short and filesystem/label friendly.
	host = host.replace(/\..*$/, "").toLowerCase();
	name = name.replace(/[^\w.-]/g, "_");
	return `${name}@${host}`.slice(0, 80);
}

export function resolveUserId(override?: string): string {
	return override || process.env.PIZZA_METRICS_USER || process.env.METRICS_MONITOR_USER || defaultUser();
}
