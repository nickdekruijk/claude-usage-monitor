import * as vscode from 'vscode';
import { fetchUsageData } from './usageClient';
import { StatusBarManager } from './statusBar';
import { UsagePanel } from './sessionPopover';
import { maybeNotify } from './notifications';
import { recordHistory } from './history';
import { UsageData } from './types';

const CONFIG_SECTION           = 'claude-usage-monitor';
const DEFAULT_POLL_INTERVAL_S  = 300;
const MIN_POLL_INTERVAL_S      = 60;
const MAX_POLL_INTERVAL_S      = 3600;
// The cache is considered fresh for slightly less than one interval, so a
// window whose timer fires a moment early still reuses the previous fetch.
const CACHE_TTL_SLACK_MS       = 5_000;
const BACKOFF_STEPS_MS = [
	4  * 60_000,  // 1st error → wait 4 min
	8  * 60_000,  // 2nd error → wait 8 min
	16 * 60_000,  // 3rd+ error → wait 16 min
];

/** Poll interval from settings, clamped to the documented range. */
function pollIntervalMs(): number {
	const raw = vscode.workspace.getConfiguration(CONFIG_SECTION).get<number>('refreshInterval');
	const seconds = typeof raw === 'number' && Number.isFinite(raw) ? raw : DEFAULT_POLL_INTERVAL_S;
	return Math.min(MAX_POLL_INTERVAL_S, Math.max(MIN_POLL_INTERVAL_S, seconds)) * 1000;
}

function cacheTtlMs(): number {
	return pollIntervalMs() - CACHE_TTL_SLACK_MS;
}

// Versioned key: pre-1.3.0 builds wrote a UsageData without `limits` to the
// unversioned key. Sharing a key across versions let an older co-installed
// build feed limits-free data to a newer one, blanking the per-model bars.
const CACHE_KEY = 'claudeUsage.cache.v2';

interface CacheEntry {
	data:      UsageData | null;
	error:     string | null;
	fetchedAt: number; // Date.now()
}

function reviveCache(raw: CacheEntry | undefined): CacheEntry | null {
	if (!raw) { return null; }
	// Rehydrate fetchedAt on the nested data object if present
	if (raw.data) {
		raw.data.fetchedAt = new Date(raw.data.fetchedAt);
	}
	return raw;
}

/**
 * Keys written by earlier versions. Bumping a key's version orphans the old
 * blob, which would otherwise sit in global storage forever.
 */
const LEGACY_KEYS = [
	'claudeUsage.cache',
	'claudeUsage.history.v1',
	'claudeUsage.history.v2',
	'claudeUsage.notified.v1',
];

function dropLegacyKeys(memento: vscode.Memento) {
	for (const key of LEGACY_KEYS) {
		if (memento.get(key) !== undefined) { void memento.update(key, undefined); }
	}
}

export function activate(context: vscode.ExtensionContext) {
	dropLegacyKeys(context.globalState);

	const statusBar = new StatusBarManager();
	const panel     = new UsagePanel(context.extensionUri, context.globalState);

	let currentData:  UsageData | null = null;
	let currentError: string | null    = null;
	let errorCount    = 0;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let windowFocused = true;

	function applyState(data: UsageData | null, error: string | null) {
		if (data) { currentData = data; } // keep last good data on error
		currentError = error;
		if (currentData) {
			// Record before rendering so the panel sees this poll in its history.
			recordHistory(context.globalState, currentData);
			statusBar.update(currentData, error);
			panel.update(currentData, error);
			void maybeNotify(context.globalState, currentData);
		} else {
			statusBar.showError(error ?? 'Unknown error');
			panel.update(null, error);
		}
	}

	function scheduleNext() {
		if (!windowFocused) { return; } // don't poll in background

		// Back off after errors, but never poll faster than the configured interval.
		const interval = pollIntervalMs();
		const delay = errorCount === 0
			? interval
			: Math.max(interval, BACKOFF_STEPS_MS[Math.min(errorCount - 1, BACKOFF_STEPS_MS.length - 1)]);

		timer = setTimeout(async () => {
			await refresh();
			scheduleNext();
		}, delay);
	}

	async function refresh() {
		// Check global cache first — skip fetch if another window just did it
		const cached = reviveCache(context.globalState.get<CacheEntry>(CACHE_KEY));
		if (cached && (Date.now() - cached.fetchedAt) < cacheTtlMs()) {
			errorCount = cached.error ? errorCount : 0;
			applyState(cached.data, cached.error);
			return;
		}

		try {
			const data = await fetchUsageData();
			errorCount = 0;
			const entry: CacheEntry = { data, error: null, fetchedAt: Date.now() };
			await context.globalState.update(CACHE_KEY, entry);
			applyState(data, null);
		} catch (err) {
			errorCount++;
			const error = err instanceof Error ? err.message : String(err);
			const entry: CacheEntry = { data: null, error, fetchedAt: Date.now() };
			await context.globalState.update(CACHE_KEY, entry);
			applyState(null, error);
			console.error('[Claude Usage Monitor]', error);
		}
	}

	// On startup: show cached data immediately, then fetch if stale
	const cached = reviveCache(context.globalState.get<CacheEntry>(CACHE_KEY));
	if (cached) {
		applyState(cached.data, cached.error);
		const age = Date.now() - cached.fetchedAt;
		const ttl = cacheTtlMs();
		if (age < ttl) {
			// Cache is fresh — delay first fetch to fill remaining TTL
			timer = setTimeout(() => {
				refresh().then(() => scheduleNext());
			}, ttl - age);
		} else {
			refresh().then(() => scheduleNext());
		}
	} else {
		statusBar.showInitializing();
		refresh().then(() => scheduleNext());
	}

	const onFocus = vscode.window.onDidChangeWindowState((state) => {
		windowFocused = state.focused;
		if (state.focused) {
			// Window came back into focus — cancel any pending timer and refresh immediately
			if (timer) { clearTimeout(timer); timer = null; }
			refresh().then(() => scheduleNext());
		} else {
			// Window lost focus — cancel the pending timer
			if (timer) { clearTimeout(timer); timer = null; }
		}
	});

	const showPopup = vscode.commands.registerCommand('claude-usage-monitor.showPopup', () => {
		panel.show(currentData, currentError);
	});

	// Apply a changed interval without a reload: restart the timer from now.
	const onConfig = vscode.workspace.onDidChangeConfiguration((event) => {
		if (!event.affectsConfiguration(`${CONFIG_SECTION}.refreshInterval`)) { return; }
		if (timer) { clearTimeout(timer); timer = null; }
		scheduleNext();
	});

	const refreshCmd = vscode.commands.registerCommand('claude-usage-monitor.refresh', async () => {
		if (timer) { clearTimeout(timer); timer = null; }
		// Force a real fetch by clearing the cache
		await context.globalState.update(CACHE_KEY, undefined);
		await refresh();
		scheduleNext();
	});

	context.subscriptions.push(
		{ dispose: () => { if (timer) { clearTimeout(timer); } } },
		statusBar,
		panel,
		onFocus,
		onConfig,
		showPopup,
		refreshCmd,
	);
}

export function deactivate() {}
