import * as vscode from 'vscode';
import { UsageData, UsageLimit } from './types';

/**
 * One addressable quota window, normalised from whichever shape the API used
 * to report it. Everything downstream — status bar template, tooltip, panel
 * bars, colour sources — works from these, so nothing hardcodes a model name.
 */
export interface QuotaWindow {
	key:      string;        // address: '5h' | '7d' | 'model:Fable' | 'extra' | <kind>
	name:     string;        // short, for status bar text: '5h', '7d', 'Fable'
	label:    string;        // long, for tooltips and panel rows
	pct:      number;
	resetsAt: string | null;
	/** Only on the pay-as-you-go window, which is measured in money. */
	money?:   { spent: string; limit: string | null };
}

export function limitLabel(l: UsageLimit): string {
	if (l.modelName) {
		const prefix  = l.group === 'weekly' ? '7-Day ' : l.group === 'session' ? 'Session ' : '';
		const surface = l.surface ? ` (${l.surface})` : '';
		return `${prefix}${l.modelName}${surface}`;
	}
	switch (l.kind) {
		case 'session':    return '5-Hour Window';
		case 'weekly_all': return '7-Day All Models';
		default:
			// Unknown kind — prettify "some_new_kind" → "Some New Kind"
			return l.kind.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
	}
}

/** Stable render order: session first, then weekly all-models, then scoped/others. */
export function sortLimits(limits: UsageLimit[]): UsageLimit[] {
	const rank = (l: UsageLimit) =>
		l.kind === 'session' ? 0 : l.kind === 'weekly_all' ? 1 : l.modelName ? 2 : 3;
	return [...limits].sort((a, b) => rank(a) - rank(b));
}

export function formatTimeRemaining(resetsAt: string): string {
	const ms = new Date(resetsAt).getTime() - Date.now();
	if (ms <= 0) { return 'resetting'; }
	const totalMin = Math.floor(ms / 60_000);
	const h = Math.floor(totalMin / 60);
	const m = totalMin % 60;
	if (h >= 24) {
		return new Date(resetsAt).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
	}
	return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export function formatResetAbsolute(iso: string): string {
	const d = new Date(iso);
	const fmt = vscode.workspace.getConfiguration('claude-usage-monitor').get<string>('clockFormat', 'auto');
	if (fmt === '24h') { return d.toLocaleString(undefined, { hour12: false }); }
	if (fmt === '12h') { return d.toLocaleString(undefined, { hour12: true }); }
	return d.toLocaleString();
}

/**
 * Every window the account currently reports. The `limits` array wins where it
 * covers a window; the legacy top-level fields only fill gaps, so an account
 * mid-rollout never loses a bar and never shows one twice.
 */
export function allWindows(data: UsageData): QuotaWindow[] {
	const out:  QuotaWindow[] = [];
	const seen = new Set<string>();
	const push = (w: QuotaWindow) => {
		if (seen.has(w.key)) { return; }
		seen.add(w.key);
		out.push(w);
	};

	for (const l of sortLimits(data.limits ?? [])) {
		if (l.modelName) {
			push({ key: `model:${l.modelName}`, name: l.modelName, label: limitLabel(l), pct: l.percent, resetsAt: l.resetsAt });
		} else if (l.kind === 'session') {
			push({ key: '5h', name: '5h', label: limitLabel(l), pct: l.percent, resetsAt: l.resetsAt });
		} else if (l.kind === 'weekly_all') {
			push({ key: '7d', name: '7d', label: limitLabel(l), pct: l.percent, resetsAt: l.resetsAt });
		} else {
			push({ key: l.kind, name: l.kind, label: limitLabel(l), pct: l.percent, resetsAt: l.resetsAt });
		}
	}

	if (data.fiveHour)          { push({ key: '5h',        name: '5h',    label: '5-Hour Window',    pct: data.fiveHour.utilization,          resetsAt: data.fiveHour.resetsAt }); }
	if (data.sevenDay)          { push({ key: '7d',        name: '7d',    label: '7-Day Window',     pct: data.sevenDay.utilization,          resetsAt: data.sevenDay.resetsAt }); }
	if (data.sevenDaySonnet)    { push({ key: 'model:Sonnet', name: 'Sonnet', label: '7-Day Sonnet', pct: data.sevenDaySonnet.utilization,    resetsAt: data.sevenDaySonnet.resetsAt }); }
	if (data.sevenDayOpus)      { push({ key: 'model:Opus',   name: 'Opus',   label: '7-Day Opus',   pct: data.sevenDayOpus.utilization,      resetsAt: data.sevenDayOpus.resetsAt }); }
	if (data.sevenDayOauthApps) { push({ key: 'oauth_apps', name: 'OAuth', label: '7-Day OAuth Apps', pct: data.sevenDayOauthApps.utilization, resetsAt: data.sevenDayOauthApps.resetsAt }); }

	// Pay-as-you-go. Measured in money rather than a percentage of a quota, so
	// the percentage is derived from the monthly cap when the API omits it.
	const eu = data.extraUsage;
	if (eu?.isEnabled) {
		const spentCents = eu.usedCredits ?? 0;
		const pct = eu.utilization !== null
			? eu.utilization
			: (eu.monthlyLimit ? (spentCents / eu.monthlyLimit) * 100 : 0);
		push({
			key:      'extra',
			name:     'extra',
			label:    'Extra Usage',
			pct,
			resetsAt: null,
			money: {
				spent: `$${(spentCents / 100).toFixed(2)}`,
				limit: eu.monthlyLimit !== null ? `$${(eu.monthlyLimit / 100).toFixed(2)}` : null,
			},
		});
	}

	return out;
}

function highest(windows: QuotaWindow[]): QuotaWindow | null {
	return windows.reduce<QuotaWindow | null>((a, b) => (!a || b.pct > a.pct ? b : a), null);
}

/** Look up one window by address. 'max' resolves to whichever is highest now. */
export function resolveWindow(data: UsageData, key: string): QuotaWindow | null {
	const k = key.trim().toLowerCase();
	const windows = allWindows(data);
	if (k === 'max' || k === 'max-all' || k === '*') { return highest(windows); }
	return windows.find((w) => w.key.toLowerCase() === k) ?? null;
}

function miniBar(pct: number): string {
	const filled = Math.round(Math.min(Math.max(pct, 0), 100) / 10);
	return '█'.repeat(filled) + '░'.repeat(10 - filled);
}

const FIELDS = ['pct', 'reset', 'resetAt', 'name', 'bar', 'spent', 'limit'] as const;

function fieldValue(w: QuotaWindow, field: string): string {
	switch (field) {
		case 'pct':     return `${Math.round(w.pct)}%`;
		case 'name':    return w.name;
		case 'reset':   return w.resetsAt ? formatTimeRemaining(w.resetsAt) : '';
		case 'resetAt': return w.resetsAt ? formatResetAbsolute(w.resetsAt) : '';
		case 'bar':     return miniBar(w.pct);
		case 'spent':   return w.money?.spent ?? '';
		case 'limit':   return w.money?.limit ?? '';
		default:        return '';
	}
}

/**
 * Every `window.field` token with its current value, keyed lower-case. The
 * panel renders its live preview from this same map, so the preview and the
 * real status bar can never drift apart.
 */
export function tokenValues(data: UsageData | null): Record<string, string> {
	const out: Record<string, string> = {};
	if (!data) { return out; }
	const windows = allWindows(data);
	const max = highest(windows);
	const addressable = max ? [...windows, { ...max, key: 'max' }] : windows;
	for (const w of addressable) {
		for (const f of FIELDS) { out[`${w.key}.${f}`.toLowerCase()] = fieldValue(w, f); }
	}
	return out;
}

const TOKEN_RE = /\{\{|\}\}|\{([^{}]*)\}/g;

/** True once the codicon references are stripped and nothing is left. */
function isDecorationOnly(s: string): boolean {
	return s.replace(/\$\([^)]*\)/g, '').trim().length === 0;
}

/**
 * Drop the empty segments an unresolved token leaves behind. A segment holding
 * only the icon is kept but does not earn a separator, so a format like
 * "{icon} {model:Gone.pct} · {5h.pct}" renders "$(icon) 12%", not "$(icon) · 12%".
 */
function collapse(s: string): string {
	const parts = s
		.split('·')
		.map((part) => part.replace(/\s+/g, ' ').trim())
		.filter((part) => part.length > 0);

	let out = '';
	for (const part of parts) {
		if (!out) { out = part; }
		else if (isDecorationOnly(out) || isDecorationOnly(part)) { out += ` ${part}`; }
		else { out += ` · ${part}`; }
	}
	// An empty token can also strand a literal separator the user typed, as in
	// "{extra.spent} / {extra.limit}" on an account with no monthly cap.
	return out.replace(/^[\s·/|,-]+/, '').replace(/[\s·/|,-]+$/, '');
}

export function renderTemplate(template: string, data: UsageData | null): string {
	const tokens = tokenValues(data);
	const filled = template.replace(TOKEN_RE, (match, expr: string) => {
		if (match === '{{') { return '{'; }
		if (match === '}}') { return '}'; }
		if (expr.trim().toLowerCase() === 'icon') { return '$(claude-icon)'; }
		return tokens[expr.trim().toLowerCase()] ?? '';
	});
	return collapse(filled);
}

export interface Preset { id: string; label: string; template: string; }

/** Presets offered in the panel. Per-model entries come from the account. */
export function presets(data: UsageData | null): Preset[] {
	const out: Preset[] = [
		{ id: '5h',   label: '5-hour',       template: '{icon} {5h.pct} · {5h.reset}' },
		{ id: '7d',   label: '7-day',        template: '{icon} 7d {7d.pct} · {7d.reset}' },
		{ id: 'both', label: 'Both',         template: '{icon} 5h {5h.pct} ({5h.reset}) · 7d {7d.pct}' },
		{ id: 'max',  label: 'Worst window', template: '{icon} {max.name} {max.pct}' },
	];
	for (const w of data ? allWindows(data) : []) {
		if (w.key.startsWith('model:')) {
			out.push({ id: w.key, label: w.name, template: `{icon} ${w.name} {${w.key}.pct} · {${w.key}.reset}` });
		} else if (w.key === 'extra') {
			out.push({
				id: 'extra',
				label: 'Extra usage',
				template: w.money?.limit ? '{icon} {extra.spent} / {extra.limit}' : '{icon} {extra.spent}',
			});
		}
	}
	return out;
}

const LEGACY_TEMPLATES: Record<string, string> = {
	'5h':   '{icon} {5h.pct} · {5h.reset}',
	'7d':   '{icon} 7d {7d.pct} · {7d.reset}',
	'both': '{icon} 5h {5h.pct} ({5h.reset}) · 7d {7d.pct}',
};

/**
 * The active template. When `statusBarFormat` is unset we derive one from the
 * legacy `statusBar` value at read time — no rewriting of anyone's settings.
 */
export function readStatusBarFormat(): string {
	const cfg = vscode.workspace.getConfiguration('claude-usage-monitor');
	const explicit = cfg.get<string>('statusBarFormat', '').trim();
	if (explicit) { return explicit; }

	const legacy = (cfg.get<string>('statusBar', '5h') || '5h').trim();
	if (legacy.toLowerCase().startsWith('model:')) {
		const name = legacy.slice('model:'.length);
		return `{icon} ${name} {model:${name}.pct} · {model:${name}.reset}`;
	}
	return LEGACY_TEMPLATES[legacy] ?? LEGACY_TEMPLATES['5h'];
}

/** Windows whose utilization drives the status bar colour. */
export function readColorSources(): string[] {
	const raw = vscode.workspace
		.getConfiguration('claude-usage-monitor')
		.get<string[] | string>('statusBarColorFrom', ['5h', '7d']);

	if (Array.isArray(raw)) { return raw.length > 0 ? raw : ['5h', '7d']; }

	// Legacy scalar values.
	if (raw === 'max')     { return ['5h', '7d']; }
	if (raw === 'max-all') { return ['*']; }
	if (typeof raw === 'string' && raw.trim()) { return [raw.trim()]; }
	return ['5h', '7d'];
}

export function colorPct(data: UsageData, sources: string[]): number {
	const picked = sources
		.map((s) => resolveWindow(data, s))
		.filter((w): w is QuotaWindow => w !== null);
	if (picked.length > 0) { return Math.max(...picked.map((w) => w.pct)); }
	// Nothing resolved (e.g. a model the API stopped reporting) — fall back to
	// the default pair rather than leaving the bar permanently uncoloured.
	const fallback = allWindows(data).filter((w) => w.key === '5h' || w.key === '7d');
	return fallback.length > 0 ? Math.max(...fallback.map((w) => w.pct)) : 0;
}
