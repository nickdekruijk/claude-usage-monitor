import * as vscode from 'vscode';
import { UsageData } from './types';
import { QuotaWindow, allWindows, formatTimeRemaining } from './windows';

/**
 * Threshold notifications. The status bar turning red is easy to miss while
 * you are heads-down in a file, so crossing a threshold says so once — and
 * only once per window per reset cycle, because an extension that nags every
 * poll gets uninstalled.
 */

const STATE_KEY = 'claudeUsage.notified.v1';

const enum Level { none = 0, warning = 1, error = 2, blocked = 3 }

function levelOf(w: QuotaWindow, warnT: number, errT: number): Level {
	if (w.pct >= 100)  { return Level.blocked; }
	if (w.pct >= errT)  { return Level.error; }
	if (w.pct >= warnT) { return Level.warning; }
	return Level.none;
}

/**
 * Entries are keyed by reset time, so a window that has since reset simply
 * never matches again. Old keys are dropped once their reset is in the past.
 */
function cycleKey(w: QuotaWindow): string {
	return `${w.key}@${w.resetsAt ?? 'none'}`;
}

function prune(seen: Record<string, number>): Record<string, number> {
	const now = Date.now();
	const out: Record<string, number> = {};
	for (const [key, level] of Object.entries(seen)) {
		const stamp = key.slice(key.lastIndexOf('@') + 1);
		if (stamp === 'none') { continue; }
		const at = new Date(stamp).getTime();
		if (!isNaN(at) && at > now) { out[key] = level; }
	}
	return out;
}

function show(w: QuotaWindow, level: Level) {
	const when = w.resetsAt ? ` — resets in ${formatTimeRemaining(w.resetsAt)}` : '';
	const message = level === Level.blocked
		? `Claude ${w.label} exhausted${when}`
		: `Claude ${w.label} at ${Math.round(w.pct)}%${when}`;

	const open = 'Open panel';
	const shown = level >= Level.error
		? vscode.window.showWarningMessage(message, open)
		: vscode.window.showInformationMessage(message, open);

	shown.then((choice) => {
		if (choice === open) { vscode.commands.executeCommand('claude-usage-monitor.showPopup'); }
	});
}

export async function maybeNotify(memento: vscode.Memento, data: UsageData): Promise<void> {
	const cfg  = vscode.workspace.getConfiguration('claude-usage-monitor');
	const mode = cfg.get<string>('notifications', 'error');
	if (mode === 'off') { return; }

	const warnT    = cfg.get<number>('warningThreshold', 60);
	const errT     = cfg.get<number>('errorThreshold', 80);
	const minLevel = mode === 'all' ? Level.warning : Level.error;

	const seen = { ...(memento.get<Record<string, number>>(STATE_KEY) ?? {}) };
	const due: Array<[QuotaWindow, Level]> = [];

	for (const w of allWindows(data)) {
		const level = levelOf(w, warnT, errT);
		if (level < minLevel) { continue; }
		const key = cycleKey(w);
		if ((seen[key] ?? Level.none) >= level) { continue; }
		seen[key] = level;
		due.push([w, level]);
	}

	if (due.length === 0) { return; }

	// Record before showing: globalState is shared across windows, so writing
	// first keeps a second window from repeating the same notification.
	await memento.update(STATE_KEY, prune(seen));
	for (const [w, level] of due) { show(w, level); }
}
