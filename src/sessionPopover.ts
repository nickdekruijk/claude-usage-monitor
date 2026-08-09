import * as vscode from "vscode";
import { UsageData, QuotaBucket, UsageLimit } from "./types";
import {
  allWindows,
  limitLabel,
  presets,
  readColorSources,
  readStatusBarFormat,
  renderTemplate,
  sortLimits,
  tokenValues,
} from "./windows";

function timeAgo(date: Date): string {
  const sec = Math.floor((Date.now() - date.getTime()) / 1000);
  if (sec < 60) { return "just now"; }
  if (sec < 3600) { const m = Math.floor(sec / 60); return `${m} minute${m === 1 ? "" : "s"} ago`; }
  const h = Math.floor(sec / 3600);
  return `${h} hour${h === 1 ? "" : "s"} ago`;
}

function formatTimeRemaining(resetsAt: string): string {
  const ms = new Date(resetsAt).getTime() - Date.now();
  if (ms <= 0) { return "resetting now"; }
  const totalMin = Math.floor(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h >= 24) {
    return new Date(resetsAt).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  }
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function formatError(raw: string): { message: string; hint: string | null } {
  if (raw.includes('401')) {
    return {
      message: 'HTTP 401 — Unauthorized: session token expired or invalid.',
      hint: 'Fix: start a new Claude Code session in your terminal (<code>claude</code>), then refresh via <strong>Ctrl+Shift+P</strong> → <em>Claude: Refresh Usage</em>. If it still fails, log out (<code>claude logout</code>) and log back in.',
    };
  }
  if (raw.includes('403')) {
    return {
      message: 'HTTP 403 — Forbidden: account may lack API access.',
      hint: 'Fix: ensure you are logged in to Claude Code with a valid Pro or Max subscription. You can log in by running <code>claude</code> in your terminal.',
    };
  }
  if (raw.includes('429')) {
    return {
      message: 'HTTP 429 — Rate limited by Anthropic API.',
      hint: 'The extension will retry automatically with backoff. No action needed.',
    };
  }
  if (raw.includes('timed out') || raw.includes('ECONNREFUSED') || raw.includes('ENOTFOUND')) {
    return {
      message: `Network error — could not reach api.anthropic.com.`,
      hint: 'Fix: check your internet connection, then refresh via <strong>Ctrl+Shift+P</strong> → <em>Claude: Refresh Usage</em>.',
    };
  }
  if (raw.includes('No OAuth token')) {
    return {
      message: 'No OAuth token found — not logged in to Claude Code.',
      hint: 'Fix: open a terminal and run <code>claude</code> to start a session. Once logged in, refresh via <strong>Ctrl+Shift+P</strong> → <em>Claude: Refresh Usage</em>.',
    };
  }
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      const inner = parsed?.error;
      if (inner?.message) {
        const prefix = raw.match(/^HTTP \d+/)?.[0];
        return { message: prefix ? `${prefix} — ${inner.message}` : inner.message, hint: null };
      }
    } catch { /* fall through */ }
  }
  return { message: raw, hint: null };
}

function barColor(pct: number, warnT: number, errT: number): string {
  if (pct >= errT)  { return "#ff6b6b"; }
  if (pct >= warnT) { return "#ffd93d"; }
  return "#51cf66";
}

function formatResetDate(iso: string): string {
  const d = new Date(iso);
  const fmt = vscode.workspace.getConfiguration('claude-usage-monitor').get<string>('clockFormat', 'auto');
  if (fmt === '24h') { return d.toLocaleString(undefined, { hour12: false }); }
  if (fmt === '12h') { return d.toLocaleString(undefined, { hour12: true }); }
  return d.toLocaleString();
}

function bucketRow(label: string, bucket: QuotaBucket, warnT: number, errT: number): string {
  const pct = bucket.utilization;
  const color = barColor(pct, warnT, errT);
  const timeLeft = formatTimeRemaining(bucket.resetsAt);
  const resetsDate = formatResetDate(bucket.resetsAt);
  return `
			<div class="bucket">
				<div class="bucket-header">
					<span class="bucket-label">${label}</span>
					<span class="bucket-pct" style="color:${color}">${pct.toFixed(1)}%</span>
				</div>
				<div class="progress"><div class="fill" style="width:${Math.min(pct, 100)}%;background:${color}"></div></div>
				<div class="bucket-meta">
					<span>Resets in ${timeLeft}</span>
					<span>${resetsDate}</span>
				</div>
			</div>`;
}

/** Severity can force a higher alert color than the numeric thresholds. */
function severityColor(severity: string | null): string | null {
  if (severity === "warning") { return "#ffd93d"; }
  if (severity === "error" || severity === "critical" || severity === "exceeded" || severity === "over_limit") { return "#ff6b6b"; }
  return null; // "normal", null, or unknown → use thresholds
}

function limitRow(l: UsageLimit, warnT: number, errT: number): string {
  const pct = l.percent;
  // Severity can only escalate past the thresholds, never downgrade them
  const rank = (c: string) => c === "#ff6b6b" ? 2 : c === "#ffd93d" ? 1 : 0;
  const tColor = barColor(pct, warnT, errT);
  const sColor = severityColor(l.severity);
  const color = sColor && rank(sColor) > rank(tColor) ? sColor : tColor;
  const meta = l.resetsAt
    ? `<span>Resets in ${formatTimeRemaining(l.resetsAt)}</span><span>${formatResetDate(l.resetsAt)}</span>`
    : `<span></span><span></span>`;
  return `
			<div class="bucket">
				<div class="bucket-header">
					<span class="bucket-label">${escapeHtml(limitLabel(l))}</span>
					<span class="bucket-pct" style="color:${color}">${pct.toFixed(0)}%</span>
				</div>
				<div class="progress"><div class="fill" style="width:${Math.min(pct, 100)}%;background:${color}"></div></div>
				<div class="bucket-meta">${meta}</div>
			</div>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** The CC mark, sized for inline use in the status bar preview. */
const ICON_SVG = `<svg class="sb-icon" viewBox="50 140 420 290" width="17" height="12" aria-hidden="true"><path d="M 250 200 A 100 100 0 1 0 250 362" stroke="#C15F3C" stroke-width="50" fill="none" stroke-linecap="round"/><path d="M 402 200 A 100 100 0 1 0 402 362" stroke="#C15F3C" stroke-width="50" fill="none" stroke-linecap="round"/></svg>`;

/** Render status bar text (which carries $(codicon) refs) as preview HTML. */
function statusTextToHtml(text: string): string {
  return escapeHtml(text)
    .replace(/\$\(claude-icon\)/g, ICON_SVG)
    .replace(/\$\(warning\)/g, "⚠");
}

function readPanelConfig() {
  const cfg = vscode.workspace.getConfiguration('claude-usage-monitor');
  return {
    warnT:    cfg.get<number>('warningThreshold', 60),
    errT:     cfg.get<number>('errorThreshold', 80),
    clockFmt: cfg.get<string>('clockFormat', 'auto'),
  };
}

interface PanelState {
  type: "state";
  subtitle: string;
  errorHtml: string;
  bucketsHtml: string;
  extraHtml: string;
  settingsHtml: string;
  /** Current value of every {window.field} token, for the live format preview. */
  tokens: Record<string, string>;
}

/**
 * The data-dependent fragments of the panel. These are pushed to the webview
 * over postMessage and patched into their containers, so the document itself
 * is never replaced — the active tab, the scroll position, and any control the
 * user is mid-edit all survive a poll.
 */
function buildFragments(data: UsageData | null, error: string | null): PanelState {
  const { warnT, errT, clockFmt } = readPanelConfig();

  let errorHtml = "";
  if (error) {
    const { message, hint } = formatError(error);
    const lead = data
      ? "<strong>⚠️ Last poll failed</strong> — showing cached data"
      : "<strong>⚠️ Could not fetch usage</strong>";
    errorHtml = `<div class="banner">${lead}<br><span style="opacity:0.85">${message}</span>${hint ? `<br><span class="banner-hint">${hint}</span>` : ""}</div>`;
  }

  const source = `<span style="opacity:0.6">api.anthropic.com/api/oauth/usage</span>`;
  const subtitle = data ? `Updated ${timeAgo(data.fetchedAt)} · ${source}` : source;

  const eu = data?.extraUsage ?? null;
  const extraSection = eu?.isEnabled
    ? `
		<div class="section">
			<div class="section-title">Extra Usage (Pay-as-you-go)</div>
			${eu.usedCredits !== null
        ? `<div class="row"><span class="label">Spent this month</span><span class="value">$${(eu.usedCredits / 100).toFixed(2)} ${eu.currency ?? ""}</span></div>`
        : ""}
			${eu.monthlyLimit !== null
        ? `<div class="row"><span class="label">Monthly limit</span><span class="value">$${(eu.monthlyLimit! / 100).toFixed(2)}</span></div>`
        : '<div class="row"><span class="label">Monthly limit</span><span class="value">No cap set</span></div>'}
			${eu.utilization !== null
        ? `<div class="row"><span class="label">Extra utilization</span><span class="value">${eu.utilization!.toFixed(1)}%</span></div>`
        : ""}
		</div>`
    : "";

  // Prefer the newer `limits` array (covers session, weekly, and any scoped
  // per-model windows like Fable). Fall back to the legacy fields for accounts
  // that don't return `limits` — and for data revived from a pre-1.3.0 cache,
  // where `limits` is undefined.
  const limits = data ? sortLimits(data.limits ?? []) : [];
  const buckets: string[] = [];
  if (data && limits.length > 0) {
    for (const l of limits) { buckets.push(limitRow(l, warnT, errT)); }
    // Legacy windows with no equivalent limits entry (e.g. OAuth apps)
    if (data.sevenDayOauthApps) { buckets.push(bucketRow("7-Day OAuth Apps", data.sevenDayOauthApps, warnT, errT)); }
  } else if (data) {
    if (data.fiveHour)          { buckets.push(bucketRow("5-Hour Window",    data.fiveHour,          warnT, errT)); }
    if (data.sevenDay)          { buckets.push(bucketRow("7-Day Window",     data.sevenDay,          warnT, errT)); }
    if (data.sevenDaySonnet)    { buckets.push(bucketRow("7-Day Sonnet",     data.sevenDaySonnet,    warnT, errT)); }
    if (data.sevenDayOpus)      { buckets.push(bucketRow("7-Day Opus",       data.sevenDayOpus,      warnT, errT)); }
    if (data.sevenDayOauthApps) { buckets.push(bucketRow("7-Day OAuth Apps", data.sevenDayOauthApps, warnT, errT)); }
  }

  const bucketsHtml = buckets.length > 0
    ? buckets.join("")
    : `<div class="no-quota">${data ? "No active quota windows returned." : "Fetching usage from the Anthropic API…"}</div>`;

  const sel = (val: string, opt: string) => val === opt ? ' selected' : '';

  const format       = readStatusBarFormat();
  const colorSources = readColorSources().map((s) => s.toLowerCase());
  const windows      = data ? allWindows(data) : [];
  const colorAll     = colorSources.some((s) => s === "*" || s === "max-all");

  const chips = presets(data).map((p) => {
    const active = p.template === format ? " active" : "";
    return `<button class="chip${active}" data-tpl="${escapeHtml(p.template)}" onclick="applyPreset(this)">${escapeHtml(p.label)}</button>`;
  }).join("");

  const colorBoxes = windows.map((w) => {
    const checked = colorAll || colorSources.includes(w.key.toLowerCase()) ? " checked" : "";
    return `<label class="check"><input type="checkbox" value="${escapeHtml(w.key)}"${checked} onchange="updateColorSources()"> ${escapeHtml(w.label)}</label>`;
  }).join("");

  const windowKeys = [...windows.map((w) => `{${w.key}}`), "{max}"].join(" ");

  const settingsHtml = `
	<div class="settings-group">
		<div class="settings-group-title">Status Bar</div>
		<div class="setting-row">
			<span class="setting-label">Preview</span>
			<span class="sb-preview" id="sb-preview">${data ? statusTextToHtml(renderTemplate(format, data)) : "—"}</span>
		</div>
		<div class="setting-stack">
			<span class="setting-label">Display <span class="info-icon" title="Pick a preset, or edit the format below to build your own.">ⓘ</span></span>
			<div class="chips">${chips}</div>
		</div>
		<div class="setting-stack">
			<span class="setting-label">Format</span>
			<input type="text" class="format-input" id="sb-format" spellcheck="false" value="${escapeHtml(format)}"
				oninput="previewFormat(this.value)"
				onchange="updateSetting('claude-usage-monitor.statusBarFormat', this.value)">
			<div class="hint">Windows ${escapeHtml(windowKeys)} · fields <code>.pct .reset .resetAt .name .bar</code> · plus <code>{icon}</code></div>
		</div>
	</div>

	<div class="settings-group">
		<div class="settings-group-title">Status Bar Color</div>
		<div class="setting-stack" id="color-sources">
			${colorBoxes || '<div class="hint">No windows reported yet.</div>'}
			<div class="hint">Turns orange/red when the highest checked window crosses a threshold below.</div>
		</div>
	</div>

	<div class="settings-group">
		<div class="settings-group-title">Color Thresholds</div>
		<div class="setting-row">
			<span class="setting-label"><span class="color-dot" style="background:#ffd93d"></span>Warning <span class="info-icon" title="When usage reaches this percentage, the status bar turns orange.">ⓘ</span></span>
			<div class="threshold-wrap">
				<input type="number" class="setting-input" min="1" max="99" value="${warnT}"
					onchange="updateSetting('claude-usage-monitor.warningThreshold', Number(this.value))">
				<span class="threshold-pct">%</span>
			</div>
		</div>
		<div class="setting-row">
			<span class="setting-label"><span class="color-dot" style="background:#ff6b6b"></span>Error <span class="info-icon" title="When usage reaches this percentage, the status bar turns red.">ⓘ</span></span>
			<div class="threshold-wrap">
				<input type="number" class="setting-input" min="1" max="100" value="${errT}"
					onchange="updateSetting('claude-usage-monitor.errorThreshold', Number(this.value))">
				<span class="threshold-pct">%</span>
			</div>
		</div>
	</div>

	<div class="settings-group last-group">
		<div class="settings-group-title">Panel</div>
		<div class="setting-row">
			<span class="setting-label">Clock format <span class="info-icon" title="How reset times are displayed in this panel. 'Auto' follows your system locale.">ⓘ</span></span>
			<select class="setting-control" onchange="updateSetting('claude-usage-monitor.clockFormat', this.value)">
				<option value="auto"${sel(clockFmt, 'auto')}>Auto (system default)</option>
				<option value="12h"${sel(clockFmt, '12h')}>12-hour (7:44 PM)</option>
				<option value="24h"${sel(clockFmt, '24h')}>24-hour (19:44)</option>
			</select>
		</div>
	</div>`;

  return {
    type: "state",
    subtitle,
    errorHtml,
    bucketsHtml,
    extraHtml: extraSection,
    settingsHtml,
    tokens: tokenValues(data),
  };
}

/** The panel's static shell — written to the webview exactly once, then patched. */
function buildShell(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
* { margin:0; padding:0; box-sizing:border-box; }
body {
	font-family: var(--vscode-font-family);
	font-size: 13px;
	color: var(--vscode-foreground);
	background: var(--vscode-editor-background);
	padding: 24px;
	max-width: 960px;
	margin: 0 auto;
}
/* Wide panels get multiple columns of bars instead of one tall stack. */
#quota-windows {
	display: grid;
	grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
	column-gap: 28px;
}
/* Extra Usage tracks the same columns, so it lines up under the bars instead
   of stretching its label and value to opposite edges of the panel. */
#extra-usage {
	display: grid;
	grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
	column-gap: 28px;
}
/* Settings groups flow into columns so the tab fills the panel, while each
   group keeps a form-width row instead of stretching label away from control. */
#settings-content {
	display: grid;
	grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
	column-gap: 32px;
	align-items: start;
}
#settings-content .settings-group { min-width: 0; }
h1 { font-size: 18px; }
h2 { font-size: 16px; font-weight: 600; margin-bottom: 14px; }
.page-header { margin-bottom: 12px; }
.title-row { display: flex; align-items: center; gap: 8px; }
.title-row .refresh-btn { margin-left: auto; }
.logo { flex-shrink: 0; }
.subtitle { color: var(--vscode-descriptionForeground); font-size: 11px; margin-top: 4px; }
.tabs {
	display: flex;
	gap: 2px;
	border-bottom: 1px solid var(--vscode-panel-border);
	margin-bottom: 18px;
}
.tab {
	background: none;
	border: none;
	border-bottom: 2px solid transparent;
	color: var(--vscode-descriptionForeground);
	font-family: inherit;
	font-size: 12px;
	padding: 6px 12px;
	margin-bottom: -1px;
	cursor: pointer;
}
.tab:hover { color: var(--vscode-foreground); }
.tab.active {
	color: var(--vscode-foreground);
	font-weight: 600;
	border-bottom-color: #C15F3C;
}
.tab:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -2px; }
.tab-panel[hidden] { display: none; }
.banner {
	margin-bottom: 16px;
	padding: 8px 12px;
	background: #ffd93d20;
	border-left: 3px solid #ffd93d;
	border-radius: 4px;
	font-size: 12px;
}
.banner-hint { opacity: 0.7; font-size: 11px; }
.section { margin-bottom: 20px; }
.section-title {
	font-size: 11px;
	font-weight: 600;
	color: var(--vscode-descriptionForeground);
	text-transform: uppercase;
	letter-spacing: 0.05em;
	margin-bottom: 10px;
}
.bucket { margin-bottom: 16px; }
.bucket-header { display:flex; justify-content:space-between; margin-bottom: 5px; }
.bucket-label { font-weight: 600; }
.bucket-pct { font-weight: 700; font-size: 14px; }
.progress {
	width: 100%; height: 7px;
	background: var(--vscode-editorWidget-border, #444);
	border-radius: 4px; overflow: hidden; margin-bottom: 4px;
}
.fill { height: 100%; border-radius: 4px; transition: width 0.3s; }
.bucket-meta {
	display:flex; justify-content:space-between;
	font-size: 11px; color: var(--vscode-descriptionForeground);
}
.row {
	display:flex; justify-content:space-between;
	padding: 5px 0;
	border-bottom: 1px solid var(--vscode-panel-border);
	font-size: 12px;
}
.row:last-child { border-bottom: none; }
.label { color: var(--vscode-descriptionForeground); }
.value { font-weight: 600; }
.no-quota { color: var(--vscode-descriptionForeground); font-size: 12px; font-style: italic; }
hr { border: none; border-top: 1px solid var(--vscode-panel-border); margin: 16px 0; }
.refresh-btn {
	background: none;
	border: none;
	cursor: pointer;
	color: var(--vscode-descriptionForeground);
	font-size: 11px;
	padding: 0;
	opacity: 0.7;
	transition: opacity 0.15s;
}
.refresh-btn:hover { opacity: 1; }
.settings-group { margin-bottom: 14px; }
.settings-group.last-group { margin-bottom: 0; }
.settings-group-title {
	font-size: 10px;
	font-weight: 600;
	color: var(--vscode-descriptionForeground);
	text-transform: uppercase;
	letter-spacing: 0.06em;
	margin-bottom: 6px;
	padding-bottom: 4px;
	border-bottom: 1px solid var(--vscode-panel-border);
}
.setting-row {
	display: flex;
	justify-content: space-between;
	align-items: center;
	padding: 5px 0;
}
.setting-label {
	font-size: 12px;
	display: flex;
	align-items: center;
	gap: 6px;
}
.setting-control {
	background: var(--vscode-dropdown-background);
	color: var(--vscode-dropdown-foreground);
	border: 1px solid var(--vscode-dropdown-border, #3c3c3c);
	border-radius: 2px;
	padding: 3px 6px;
	font-size: 12px;
	font-family: var(--vscode-font-family);
	cursor: pointer;
	outline: none;
	max-width: 100%;
}
.setting-control:focus { border-color: var(--vscode-focusBorder); }
.setting-input {
	background: var(--vscode-input-background);
	color: var(--vscode-input-foreground);
	border: 1px solid var(--vscode-input-border, #3c3c3c);
	border-radius: 2px;
	padding: 3px 6px;
	font-size: 12px;
	width: 54px;
	text-align: right;
	font-family: var(--vscode-font-family);
	outline: none;
}
.setting-input:focus { border-color: var(--vscode-focusBorder); }
.setting-stack { display: flex; flex-direction: column; gap: 6px; padding: 7px 0; }
.hint { font-size: 11px; color: var(--vscode-descriptionForeground); line-height: 1.5; }
.hint code {
	font-family: var(--vscode-editor-font-family, monospace);
	background: var(--vscode-textCodeBlock-background, rgba(127,127,127,0.15));
	border-radius: 3px;
	padding: 0 3px;
}
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip {
	background: var(--vscode-button-secondaryBackground, rgba(127,127,127,0.18));
	color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
	border: 1px solid transparent;
	border-radius: 999px;
	padding: 3px 11px;
	font-family: inherit;
	font-size: 11px;
	cursor: pointer;
}
.chip:hover { border-color: var(--vscode-focusBorder); }
.chip.active { background: #C15F3C; color: #fff; font-weight: 600; }
.format-input {
	width: 100%;
	background: var(--vscode-input-background);
	color: var(--vscode-input-foreground);
	border: 1px solid var(--vscode-input-border, #3c3c3c);
	border-radius: 2px;
	padding: 5px 7px;
	font-size: 12px;
	font-family: var(--vscode-editor-font-family, monospace);
	outline: none;
}
.format-input:focus { border-color: var(--vscode-focusBorder); }
.sb-preview {
	display: inline-flex;
	align-items: center;
	gap: 5px;
	background: var(--vscode-statusBar-background, rgba(127,127,127,0.18));
	border-radius: 3px;
	padding: 2px 8px;
	font-size: 12px;
	white-space: nowrap;
}
.sb-icon { flex-shrink: 0; }
.check { display: flex; align-items: center; gap: 6px; font-size: 12px; cursor: pointer; }
/* Native checkboxes default to the browser accent (purple), which reads as
   foreign in every VS Code theme — match the panel's own accent instead. */
.check input {
	cursor: pointer;
	margin: 0;
	accent-color: #C15F3C;
}
.threshold-wrap { display: flex; align-items: center; gap: 4px; }
.threshold-pct { font-size: 12px; color: var(--vscode-descriptionForeground); }
.color-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; flex-shrink: 0; }
.info-icon { font-size: 11px; opacity: 0.45; cursor: help; font-style: normal; }
.info-icon:hover { opacity: 1; }
</style>
</head>
<body>
<header class="page-header">
	<div class="title-row">
		<svg class="logo" viewBox="50 140 420 290" width="26" height="18" aria-hidden="true">
			<path d="M 250 200 A 100 100 0 1 0 250 362" stroke="#C15F3C" stroke-width="50" fill="none" stroke-linecap="round"/>
			<path d="M 402 200 A 100 100 0 1 0 402 362" stroke="#C15F3C" stroke-width="50" fill="none" stroke-linecap="round"/>
		</svg>
		<h1>Claude Usage</h1>
		<button class="refresh-btn" onclick="vscode.postMessage({command:'refresh'})" title="Refresh now">↻ Refresh</button>
	</div>
	<div class="subtitle" id="subtitle"></div>
</header>

<div class="tabs" role="tablist" aria-label="Panel sections">
	<button class="tab active" role="tab" id="tab-usage" aria-controls="panel-usage" aria-selected="true" onclick="setTab('usage')">Usage</button>
	<button class="tab" role="tab" id="tab-settings" aria-controls="panel-settings" aria-selected="false" tabindex="-1" onclick="setTab('settings')">Settings</button>
</div>

<div class="tab-panel" id="panel-usage" role="tabpanel" aria-labelledby="tab-usage">
	<div id="error-banner"></div>
	<div class="section">
		<div class="section-title">Quota Windows</div>
		<div id="quota-windows"></div>
	</div>
	<div id="extra-usage"></div>
</div>

<div class="tab-panel" id="panel-settings" role="tabpanel" aria-labelledby="tab-settings" hidden>
	<div id="settings-content"></div>
</div>

<script>
	const vscode = acquireVsCodeApi();
	const TABS = ['usage', 'settings'];

	const ICON_MARK = '@@ICON@@';
	const ICON_SVG  = ${JSON.stringify(ICON_SVG)};
	var TOKENS = {};

	function updateSetting(key, value) {
		vscode.postMessage({ command: 'updateSetting', key, value });
	}

	function esc(s) {
		return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
	}

	// Same substitution the extension does, over the token values it sent, so
	// the preview cannot drift from what the status bar will actually render.
	function renderPreview(tpl) {
		var filled = String(tpl).replace(/\\{\\{|\\}\\}|\\{([^{}]*)\\}/g, function (m, expr) {
			if (m === '{{') { return '{'; }
			if (m === '}}') { return '}'; }
			var key = String(expr).trim().toLowerCase();
			if (key === 'icon') { return ICON_MARK; }
			return TOKENS[key] != null ? TOKENS[key] : '';
		});
		var parts = filled.split('·').map(function (p) {
			return p.replace(/\\s+/g, ' ').trim();
		}).filter(function (p) { return p.length > 0; });

		// Mirrors collapse() in windows.ts: an icon-only segment earns no separator.
		var bare = function (s) { return s.split(ICON_MARK).join('').trim(); };
		var out  = '';
		for (var i = 0; i < parts.length; i++) {
			if (!out) { out = parts[i]; }
			else if (bare(out) === '' || bare(parts[i]) === '') { out += ' ' + parts[i]; }
			else { out += ' · ' + parts[i]; }
		}
		out = out.replace(/^[\\s·/|,-]+/, '').replace(/[\\s·/|,-]+$/, '');
		return esc(out).split(ICON_MARK).join(ICON_SVG);
	}

	function previewFormat(tpl) {
		var el = document.getElementById('sb-preview');
		if (el) { el.innerHTML = renderPreview(tpl) || '—'; }
	}

	function applyPreset(btn) {
		var tpl   = btn.getAttribute('data-tpl');
		var input = document.getElementById('sb-format');
		if (input) { input.value = tpl; }
		previewFormat(tpl);
		var chips = document.querySelectorAll('.chip');
		for (var i = 0; i < chips.length; i++) { chips[i].classList.toggle('active', chips[i] === btn); }
		updateSetting('claude-usage-monitor.statusBarFormat', tpl);
	}

	function updateColorSources() {
		var boxes = document.querySelectorAll('#color-sources input[type=checkbox]');
		var vals  = [];
		for (var i = 0; i < boxes.length; i++) {
			if (boxes[i].checked) { vals.push(boxes[i].value); }
		}
		updateSetting('claude-usage-monitor.statusBarColorFrom', vals);
	}

	function setTab(name) {
		for (var i = 0; i < TABS.length; i++) {
			var t  = TABS[i];
			var on = t === name;
			var el = document.getElementById('tab-' + t);
			el.classList.toggle('active', on);
			el.setAttribute('aria-selected', on ? 'true' : 'false');
			el.tabIndex = on ? 0 : -1;
			document.getElementById('panel-' + t).hidden = !on;
		}
		vscode.setState({ activeTab: name });
	}

	document.querySelector('.tabs').addEventListener('keydown', function (e) {
		if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') { return; }
		var i = TABS.indexOf(String(document.activeElement.id).replace('tab-', ''));
		if (i < 0) { return; }
		var next = TABS[(i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length];
		setTab(next);
		document.getElementById('tab-' + next).focus();
	});

	// Never redraw a control while the user is editing it.
	function settingsFocused() {
		var el = document.activeElement;
		return !!el && document.getElementById('panel-settings').contains(el);
	}

	window.addEventListener('message', function (e) {
		var m = e.data;
		if (!m || m.type !== 'state') { return; }
		TOKENS = m.tokens || {};
		document.getElementById('subtitle').innerHTML      = m.subtitle;
		document.getElementById('error-banner').innerHTML  = m.errorHtml;
		document.getElementById('quota-windows').innerHTML = m.bucketsHtml;
		document.getElementById('extra-usage').innerHTML   = m.extraHtml;
		if (!settingsFocused()) {
			document.getElementById('settings-content').innerHTML = m.settingsHtml;
		}
	});

	var saved = vscode.getState();
	setTab(saved && saved.activeTab ? saved.activeTab : 'usage');
	// The webview is torn down when hidden; ask for the current state on every load.
	vscode.postMessage({ command: 'ready' });
</script>
</body>
</html>`;
}

export class UsagePanel {
  private panel: vscode.WebviewPanel | undefined;
  private lastData: UsageData | null = null;
  private lastError: string | null = null;
  private configSub: vscode.Disposable;

  constructor(private extensionUri: vscode.Uri) {
    this.configSub = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('claude-usage-monitor')) { this.post(); }
    });
  }

  /**
   * Push the current state to the webview. The shell HTML is written once, at
   * creation — replacing it on every poll is what used to reset the active tab
   * and wipe whatever the user was typing into a settings field.
   */
  private post() {
    this.panel?.webview.postMessage(buildFragments(this.lastData, this.lastError));
  }

  public show(data: UsageData | null, error: string | null = null) {
    if (data) { this.lastData = data; }
    this.lastError = error;

    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.One, true);
      this.post();
      return;
    }
    this.panel = vscode.window.createWebviewPanel(
      "claudeUsage",
      "Claude Usage",
      { viewColumn: vscode.ViewColumn.One, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: false },
    );
    this.panel.iconPath = vscode.Uri.joinPath(this.extensionUri, "resources", "icon.png");
    // Register before the shell is written, so the webview's 'ready' can't race us.
    this.panel.webview.onDidReceiveMessage(async (msg) => {
      if (msg.command === 'ready') {
        // Fresh webview load (first open, or a reload after being hidden).
        this.post();
      } else if (msg.command === 'refresh') {
        vscode.commands.executeCommand('claude-usage-monitor.refresh');
      } else if (msg.command === 'updateSetting') {
        // The config listener re-posts once the write lands.
        await vscode.workspace.getConfiguration().update(
          msg.key, msg.value, vscode.ConfigurationTarget.Global
        );
      }
    });
    this.panel.webview.html = buildShell();
    this.panel.onDidDispose(() => {
      this.panel = undefined;
    });
  }

  public update(data: UsageData | null, error: string | null = null) {
    if (data) { this.lastData = data; }
    this.lastError = error;
    this.post();
  }

  public dispose() {
    this.panel?.dispose();
    this.configSub.dispose();
  }
}
