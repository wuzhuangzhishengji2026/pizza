/**
 * KPI computation on top of the raw-delta store.
 *
 * Metric definitions (aligned with GitHub Copilot's usage metrics and the
 * industry-standard AI-coding KPIs):
 *   - 活跃用户数 active users: distinct `user` with any activity in the window
 *     (DAU = last 1 day, WAU = last 7 days, MAU = last 28 days).
 *   - 消耗量 consumption: tokens by type, estimated cost, LLM requests.
 *   - 采纳率 adoption rate: accepted edit decisions / (accepted + rejected),
 *     mirroring Copilot's "percentage of suggestions accepted".
 */

import type { MetricsStore } from "./store.js";

export interface OverviewQuery {
	/** Window length in days for the main totals (default 7). */
	days: number;
	tool?: string;
	user?: string;
}

export interface Overview {
	window: { days: number; startTs: number; endTs: number };
	filters: { tool?: string; user?: string };
	activeUsers: { dau: number; wau: number; mau: number };
	totals: {
		sessions: number;
		requests: number;
		tokens: { input: number; output: number; cache_read: number; cache_write: number; reasoning: number; total: number };
		costUsd: number;
		toolCalls: number;
		toolErrors: number;
		locAdded: number;
		locRemoved: number;
		activeTimeSec: number;
	};
	adoption: { accepted: number; rejected: number; total: number; rate: number | null };
	daily: Array<{
		date: string;
		tokens: number;
		costUsd: number;
		requests: number;
		sessions: number;
		activeUsers: number;
		adoptionRate: number | null;
	}>;
	byTool: Array<{
		tool: string;
		tokens: number;
		costUsd: number;
		requests: number;
		sessions: number;
		activeUsers: number;
		accepted: number;
		rejected: number;
		adoptionRate: number | null;
	}>;
	byUser: Array<{
		user: string;
		tokens: number;
		costUsd: number;
		requests: number;
		sessions: number;
		activeDays: number;
		accepted: number;
		rejected: number;
		adoptionRate: number | null;
		lastActiveTs: number;
	}>;
	byModel: Array<{ model: string; tool: string; tokens: number; costUsd: number; requests: number }>;
}

interface FilterClause {
	clause: string;
	params: unknown[];
}

function buildFilter(query: OverviewQuery, startTs: number): FilterClause {
	const clauses = ["ts >= ?"];
	const params: unknown[] = [startTs];
	if (query.tool) {
		clauses.push("tool = ?");
		params.push(query.tool);
	}
	if (query.user) {
		clauses.push("user = ?");
		params.push(query.user);
	}
	return { clause: clauses.join(" and "), params };
}

function adoptRate(accepted: number, rejected: number): number | null {
	const total = accepted + rejected;
	return total > 0 ? accepted / total : null;
}

export function computeOverview(store: MetricsStore, query: OverviewQuery): Overview {
	const now = Date.now();
	const startTs = now - query.days * 86_400_000;
	const filter = buildFilter(query, startTs);
	const where = filter.clause;
	const params = filter.params;

	// --- active users (DAU/WAU/MAU, respecting tool filter but not user filter) ---
	const activeUsers = { dau: 0, wau: 0, mau: 0 };
	const windows: Array<[keyof typeof activeUsers, number]> = [
		["dau", now - 86_400_000],
		["wau", now - 7 * 86_400_000],
		["mau", now - 28 * 86_400_000],
	];
	const distinctStmt = store.dbRead(
		`select count(distinct user) as n from samples where ts >= ? ${query.tool ? "and tool = ?" : ""}`,
	);
	for (const [key, since] of windows) {
		const row = distinctStmt.get(since, ...(query.tool ? [query.tool] : [])) as { n: number };
		activeUsers[key] = Number(row?.n ?? 0);
	}

	// --- totals per metric ---
	const totals = {
		sessions: 0,
		requests: 0,
		tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0, reasoning: 0, total: 0 },
		costUsd: 0,
		toolCalls: 0,
		toolErrors: 0,
		locAdded: 0,
		locRemoved: 0,
		activeTimeSec: 0,
	};
	const metricSum = store.dbRead(
		`select metric, sum(value) as value from samples where ${where} group by metric`,
	);
	for (const row of metricSum.all(...params) as Array<{ metric: string; value: number }>) {
		switch (row.metric) {
			case "agent_sessions_total":
				totals.sessions = Number(row.value);
				break;
			case "agent_requests_total":
				totals.requests = Number(row.value);
				break;
			case "agent_tokens_total":
				totals.tokens.total += Number(row.value);
				break;
			case "agent_cost_usd_total":
				totals.costUsd += Number(row.value);
				break;
			case "agent_tool_calls_total":
				totals.toolCalls += Number(row.value);
				break;
			case "agent_lines_of_code_total":
				// split by dim below
				break;
			case "agent_active_time_seconds_total":
				totals.activeTimeSec += Number(row.value);
				break;
			default:
				break;
		}
	}
	const tokenTypes = store.dbRead(
		`select dims, sum(value) as value from samples
		 where ${where} and metric = 'agent_tokens_total' group by dims`,
	);
	for (const row of tokenTypes.all(...params) as Array<{ dims: string; value: number }>) {
		const labels = parseDims(row.dims);
		const type = labels.type ?? "total";
		const bucket = (totals.tokens as unknown as Record<string, number | undefined>)[type];
		if (typeof bucket === "number") {
			(totals.tokens as unknown as Record<string, number>)[type] = bucket + Number(row.value);
		}
	}
	const locRows = store.dbRead(
		`select dims, sum(value) as value from samples
		 where ${where} and metric = 'agent_lines_of_code_total' group by dims`,
	);
	for (const row of locRows.all(...params) as Array<{ dims: string; value: number }>) {
		const type = parseDims(row.dims).type;
		if (type === "removed") totals.locRemoved += Number(row.value);
		else totals.locAdded += Number(row.value);
	}
	const toolErrorRows = store.dbRead(
		`select dims, sum(value) as value from samples
		 where ${where} and metric = 'agent_tool_calls_total' group by dims`,
	);
	for (const row of toolErrorRows.all(...params) as Array<{ dims: string; value: number }>) {
		if (parseDims(row.dims).is_error === "true") totals.toolErrors += Number(row.value);
	}

	// --- adoption ---
	const adoptionRows = store.dbRead(
		`select dims, sum(value) as value from samples
		 where ${where} and metric = 'agent_edit_decisions_total' group by dims`,
	);
	let accepted = 0;
	let rejected = 0;
	for (const row of adoptionRows.all(...params) as Array<{ dims: string; value: number }>) {
		if (parseDims(row.dims).decision === "accept") accepted += Number(row.value);
		else if (parseDims(row.dims).decision === "reject") rejected += Number(row.value);
	}
	const adoption = { accepted, rejected, total: accepted + rejected, rate: adoptRate(accepted, rejected) };

	// --- daily series ---
	const dailyRows = store.dbRead(
		`select strftime('%Y-%m-%d', ts/1000, 'unixepoch', 'localtime') as date, metric, dims, sum(value) as value
		 from samples where ${where} group by date, metric, dims order by date asc`,
	);
	interface DayAcc {
		tokens: number;
		costUsd: number;
		requests: number;
		sessions: number;
		accepted: number;
		rejected: number;
		users: Set<string>;
	}
	const days = new Map<string, DayAcc>();
	const userRowsByDay = store.dbRead(
		`select strftime('%Y-%m-%d', ts/1000, 'unixepoch', 'localtime') as date, user
		 from samples where ${where} group by date, user`,
	);
	for (const row of userRowsByDay.all(...params) as Array<{ date: string; user: string }>) {
		getDay(days, row.date).users.add(row.user);
	}
	for (const row of dailyRows.all(...params) as Array<{ date: string; metric: string; dims: string; value: number }>) {
		const acc = getDay(days, row.date);
		const value = Number(row.value);
		switch (row.metric) {
			case "agent_tokens_total":
				acc.tokens += value;
				break;
			case "agent_cost_usd_total":
				acc.costUsd += value;
				break;
			case "agent_requests_total":
				acc.requests += value;
				break;
			case "agent_sessions_total":
				acc.sessions += value;
				break;
			case "agent_edit_decisions_total":
				if (parseDims(row.dims).decision === "accept") acc.accepted += value;
				else if (parseDims(row.dims).decision === "reject") acc.rejected += value;
				break;
			default:
				break;
		}
	}
	const daily = [...days.entries()]
		.sort(([a], [b]) => (a < b ? -1 : 1))
		.map(([date, acc]) => ({
			date,
			tokens: acc.tokens,
			costUsd: acc.costUsd,
			requests: acc.requests,
			sessions: acc.sessions,
			activeUsers: acc.users.size,
			adoptionRate: adoptRate(acc.accepted, acc.rejected),
		}));

	// --- by tool ---
	interface ToolAcc {
		tokens: number;
		costUsd: number;
		requests: number;
		sessions: number;
		accepted: number;
		rejected: number;
		users: Set<string>;
	}
	const tools = new Map<string, ToolAcc>();
	const toolRows = store.dbRead(
		`select tool, metric, dims, sum(value) as value from samples
		 where ${where} group by tool, metric, dims`,
	);
	for (const row of toolRows.all(...params) as Array<{ tool: string; metric: string; dims: string; value: number }>) {
		const acc = getMap(tools, row.tool, () => ({
			tokens: 0,
			costUsd: 0,
			requests: 0,
			sessions: 0,
			accepted: 0,
			rejected: 0,
			users: new Set<string>(),
		}));
		const value = Number(row.value);
		switch (row.metric) {
			case "agent_tokens_total":
				acc.tokens += value;
				break;
			case "agent_cost_usd_total":
				acc.costUsd += value;
				break;
			case "agent_requests_total":
				acc.requests += value;
				break;
			case "agent_sessions_total":
				acc.sessions += value;
				break;
			case "agent_edit_decisions_total":
				if (parseDims(row.dims).decision === "accept") acc.accepted += value;
				else if (parseDims(row.dims).decision === "reject") acc.rejected += value;
				break;
			default:
				break;
		}
	}
	const toolUsers = store.dbRead(
		`select tool, count(distinct user) as n from samples where ${where} group by tool`,
	);
	for (const row of toolUsers.all(...params) as Array<{ tool: string; n: number }>) {
		getMap(tools, row.tool, () => ({
			tokens: 0,
			costUsd: 0,
			requests: 0,
			sessions: 0,
			accepted: 0,
			rejected: 0,
			users: new Set<string>(),
		}));
	}
	// second pass for distinct users per tool (set size computed in JS)
	const toolUserPairs = store.dbRead(
		`select tool, user from samples where ${where} group by tool, user`,
	);
	for (const row of toolUserPairs.all(...params) as Array<{ tool: string; user: string }>) {
		getMap(tools, row.tool, () => ({
			tokens: 0,
			costUsd: 0,
			requests: 0,
			sessions: 0,
			accepted: 0,
			rejected: 0,
			users: new Set<string>(),
		})).users.add(row.user);
	}
	const byTool = [...tools.entries()]
		.map(([tool, acc]) => ({
			tool,
			tokens: acc.tokens,
			costUsd: acc.costUsd,
			requests: acc.requests,
			sessions: acc.sessions,
			activeUsers: acc.users.size,
			accepted: acc.accepted,
			rejected: acc.rejected,
			adoptionRate: adoptRate(acc.accepted, acc.rejected),
		}))
		.sort((a, b) => b.tokens - a.tokens);

	// --- by user ---
	interface UserAcc {
		tokens: number;
		costUsd: number;
		requests: number;
		sessions: number;
		accepted: number;
		rejected: number;
		days: Set<string>;
		lastActiveTs: number;
	}
	const users = new Map<string, UserAcc>();
	const userRows = store.dbRead(
		`select user, metric, dims, sum(value) as value, max(ts) as lastTs, strftime('%Y-%m-%d', ts/1000, 'unixepoch', 'localtime') as date
		 from samples where ${where} group by user, metric, dims, date`,
	);
	for (const row of userRows.all(...params) as Array<{
		user: string;
		metric: string;
		dims: string;
		value: number;
		lastTs: number;
		date: string;
	}>) {
		const acc = getMap(users, row.user, () => ({
			tokens: 0,
			costUsd: 0,
			requests: 0,
			sessions: 0,
			accepted: 0,
			rejected: 0,
			days: new Set<string>(),
			lastActiveTs: 0,
		}));
		const value = Number(row.value);
		acc.days.add(row.date);
		acc.lastActiveTs = Math.max(acc.lastActiveTs, Number(row.lastTs));
		switch (row.metric) {
			case "agent_tokens_total":
				acc.tokens += value;
				break;
			case "agent_cost_usd_total":
				acc.costUsd += value;
				break;
			case "agent_requests_total":
				acc.requests += value;
				break;
			case "agent_sessions_total":
				acc.sessions += value;
				break;
			case "agent_edit_decisions_total":
				if (parseDims(row.dims).decision === "accept") acc.accepted += value;
				else if (parseDims(row.dims).decision === "reject") acc.rejected += value;
				break;
			default:
				break;
		}
	}
	const byUser = [...users.entries()]
		.map(([user, acc]) => ({
			user,
			tokens: acc.tokens,
			costUsd: acc.costUsd,
			requests: acc.requests,
			sessions: acc.sessions,
			activeDays: acc.days.size,
			accepted: acc.accepted,
			rejected: acc.rejected,
			adoptionRate: adoptRate(acc.accepted, acc.rejected),
			lastActiveTs: acc.lastActiveTs,
		}))
		.sort((a, b) => b.tokens - a.tokens);

	// --- by model ---
	const byModelRows = store.dbRead(
		`select coalesce(nullif(model, ''), '(unknown)') as model, tool, metric, sum(value) as value
		 from samples where ${where} and model is not null group by model, tool, metric`,
	);
	interface ModelAcc {
		tokens: number;
		costUsd: number;
		requests: number;
	}
	const models = new Map<string, ModelAcc>();
	for (const row of byModelRows.all(...params) as Array<{ model: string; tool: string; metric: string; value: number }>) {
		const acc = getMap(models, `${row.model}\u0000${row.tool}`, () => ({ tokens: 0, costUsd: 0, requests: 0 }));
		switch (row.metric) {
			case "agent_tokens_total":
				acc.tokens += Number(row.value);
				break;
			case "agent_cost_usd_total":
				acc.costUsd += Number(row.value);
				break;
			case "agent_requests_total":
				acc.requests += Number(row.value);
				break;
			default:
				break;
		}
	}
	const byModel = [...models.entries()].map(([key, acc]) => {
		const [model, tool] = key.split("\u0000");
		return { model: model ?? "", tool: tool ?? "", tokens: acc.tokens, costUsd: acc.costUsd, requests: acc.requests };
	});

	return {
		window: { days: query.days, startTs, endTs: now },
		filters: { tool: query.tool, user: query.user },
		activeUsers,
		totals,
		adoption,
		daily,
		byTool,
		byUser,
		byModel,
	};
}

function getDay(map: Map<string, { tokens: number; costUsd: number; requests: number; sessions: number; accepted: number; rejected: number; users: Set<string> }>, date: string) {
	let acc = map.get(date);
	if (!acc) {
		acc = { tokens: 0, costUsd: 0, requests: 0, sessions: 0, accepted: 0, rejected: 0, users: new Set<string>() };
		map.set(date, acc);
	}
	return acc;
}

function getMap<K, V>(map: Map<K, V>, key: K, init: () => V): V {
	let acc = map.get(key);
	if (!acc) {
		acc = init();
		map.set(key, acc);
	}
	return acc;
}

function parseDims(dims: string): Record<string, string> {
	const labels: Record<string, string> = {};
	if (!dims) return labels;
	for (const pair of dims.split(",")) {
		const idx = pair.indexOf("=");
		if (idx <= 0) continue;
		labels[pair.slice(0, idx)] = pair.slice(idx + 1);
	}
	return labels;
}
