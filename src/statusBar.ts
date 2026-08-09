import * as vscode from 'vscode';
import { UsageData } from './types';
import {
	allWindows,
	blockedWindow,
	colorPct,
	formatTimeRemaining,
	readColorSources,
	readStatusBarFormat,
	renderTemplate,
} from './windows';

interface StatusBarConfig {
	format:           string;
	colorSources:     string[];
	warningThreshold: number;
	errorThreshold:   number;
}

function readConfig(): StatusBarConfig {
	const cfg = vscode.workspace.getConfiguration('claude-usage-monitor');
	return {
		format:           readStatusBarFormat(),
		colorSources:     readColorSources(),
		warningThreshold: cfg.get<number>('warningThreshold', 60),
		errorThreshold:   cfg.get<number>('errorThreshold', 80),
	};
}

function timeAgo(date: Date): string {
	const sec = Math.floor((Date.now() - date.getTime()) / 1000);
	if (sec < 60) { return 'just now'; }
	if (sec < 3600) { const m = Math.floor(sec / 60); return `${m} minute${m === 1 ? '' : 's'} ago`; }
	const h = Math.floor(sec / 3600);
	return `${h} hour${h === 1 ? '' : 's'} ago`;
}

function utilizationColor(pct: number, warnT: number, errT: number): vscode.ThemeColor | undefined {
	if (pct >= errT)  { return new vscode.ThemeColor('statusBarItem.errorBackground'); }
	if (pct >= warnT) { return new vscode.ThemeColor('statusBarItem.warningBackground'); }
	return undefined;
}

export class StatusBarManager {
	private item: vscode.StatusBarItem;
	private lastData:  UsageData | null = null;
	private lastError: string | null    = null;
	private configSub: vscode.Disposable;

	constructor() {
		this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
		this.item.command = 'claude-usage-monitor.showPopup';
		this.item.show();

		this.configSub = vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration('claude-usage-monitor') && this.lastData) {
				this.update(this.lastData, this.lastError);
			}
		});
	}

	public update(data: UsageData, error: string | null = null) {
		this.lastData  = data;
		this.lastError = error;

		const windows = allWindows(data);
		if (windows.length === 0) {
			this.item.text = '$(claude-icon) No data';
			this.item.tooltip = 'No quota windows returned from API';
			this.item.backgroundColor = undefined;
			return;
		}

		const { format, colorSources, warningThreshold, errorThreshold } = readConfig();

		// Being blocked is the one state worth overriding a custom format for:
		// the only thing that matters then is when work can resume.
		const blocked = blockedWindow(data);
		if (blocked) {
			const what = blocked.key === '5h' ? 'blocked' : `${blocked.name} blocked`;
			const when = blocked.resetsAt ? ` · ${formatTimeRemaining(blocked.resetsAt)}` : '';
			this.item.text = `$(claude-icon) ${what}${when}${error ? ' $(warning)' : ''}`;
			this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
		} else {
			const body = renderTemplate(format, data);
			this.item.text = `${body || '$(claude-icon)'}${error ? ' $(warning)' : ''}`;
			this.item.backgroundColor = error
				? new vscode.ThemeColor('statusBarItem.warningBackground')
				: utilizationColor(colorPct(data, colorSources), warningThreshold, errorThreshold);
		}

		const bar = (p: number) => {
			const filled = Math.round(Math.min(p, 100) / 10);
			const color  = p >= errorThreshold ? '🔴' : p >= warningThreshold ? '🟡' : '🟢';
			return `[${('█'.repeat(filled)).padEnd(10, '—')}] ${p.toFixed(0)}% ${color}`;
		};

		const lines: string[] = [`$(claude-icon) **Claude Usage**`, `---`];

		// One entry per window the account reports — per-model and pay-as-you-go
		// included, since they all come from the same normalised list.
		for (const w of windows) {
			if (w.money) {
				const cap = w.money.limit ? ` / ${w.money.limit}` : '';
				lines.push(`**${w.label}**  💳 ${w.money.spent}${cap} ${data.extraUsage?.currency ?? ''}`.trim());
			} else if (w.resetsAt) {
				lines.push(`**${w.label}**\n\n\`${bar(w.pct)}\`\n\n↻ Resets in **${formatTimeRemaining(w.resetsAt)}**`);
			} else {
				lines.push(`**${w.label}**\n\n\`${bar(w.pct)}\``);
			}
		}

		if (error) {
			lines.push(`⚠️ *Poll failed — showing cached data*`);
		}

		lines.push(`---\n_Updated ${timeAgo(data.fetchedAt)} · Click to open panel_`);

		const md = new vscode.MarkdownString(lines.join('\n\n'));
		md.supportThemeIcons = true;
		this.item.tooltip = md;
	}

	public showInitializing() {
		this.item.text = '$(claude-icon) Connecting…';
		this.item.tooltip = 'Fetching Claude usage data…';
		this.item.backgroundColor = undefined;
	}

	public showError(message: string) {
		this.item.text = '$(claude-icon) Error';
		this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');

		let displayMsg = message;
		let hint: string | null = null;
		if (message.includes('401')) {
			displayMsg = 'HTTP 401 — Token expired or invalid.';
			hint = 'Fix: run `claude` in terminal to start a session, then Ctrl+Shift+P → Claude: Refresh Usage. Or: `claude logout` and log back in.';
		} else if (message.includes('403')) {
			displayMsg = 'HTTP 403 — Account lacks API access.';
			hint = 'Fix: ensure you are logged in to Claude Code with a Pro or Max subscription.';
		} else if (message.includes('429')) {
			displayMsg = 'HTTP 429 — Rate limited.';
			hint = 'The extension will retry automatically.';
		} else if (message.includes('timed out') || message.includes('ECONNREFUSED') || message.includes('ENOTFOUND')) {
			displayMsg = 'Network error — cannot reach api.anthropic.com.';
			hint = 'Fix: check your internet connection, then Ctrl+Shift+P → Claude: Refresh Usage.';
		} else if (message.includes('No OAuth token')) {
			displayMsg = 'Not logged in to Claude Code.';
			hint = 'Fix: run `claude` in terminal to log in, then Ctrl+Shift+P → Claude: Refresh Usage.';
		}

		const md = new vscode.MarkdownString(
			hint
				? `**Error:** ${displayMsg}\n\n${hint}`
				: `**Error:** ${displayMsg}`
		);
		md.supportThemeIcons = true;
		this.item.tooltip = md;
	}

	public dispose() {
		this.item.dispose();
		this.configSub.dispose();
	}
}
