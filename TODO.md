# TODO

Ranked by impact. Context: competitive review of `GrowthJack.claude-code-usage`
(47k installs vs our 11k) on 2026-08-09. Their differentiator is breadth built on
*estimated* costs parsed from JSONL; ours is that every number comes from the
official Anthropic OAuth usage API. Items 2–5 are small, contained changes.

---

## 1. Drop `engines` to ~`^1.85.0` and publish to Open VSX

Highest install-per-hour ratio available to us by a wide margin.

`package.json` currently demands `vscode: ^1.104.0`. Cursor and Windsurf track
upstream VS Code by months, so that floor makes us invisible to every user on
those editors. The competitor's floor is `^1.74.0` (2022) and they ship to
Open VSX from CI — that alone plausibly explains a large slice of the install gap.

- [ ] Lower `engines.vscode` to `^1.85.0` and confirm nothing we call needs newer
- [ ] Publish to Open VSX (`npx ovsx publish`), add the registry link to the README
- [ ] Consider a GitHub Actions release workflow so both registries stay in sync

## 2. Add the curl fallback and fix the misleading 403 copy

We may be silently broken for a slice of users right now — and blaming their
subscription for it.

Anthropic's edge fingerprints the TLS ClientHello (JA3/JA4) and returns
`403 "Request not allowed"` to Node's OpenSSL handshake for some users, while
accepting `curl`. The competitor hit this and falls back to the system `curl`
binary permanently once detected (`curl.exe` ships with Windows 10+, and is
universal on macOS/Linux). We use `https.get` in `src/usageClient.ts:58`, so we
have the same exposed handshake.

Worse: `src/usageClient.ts:143` tells anyone who gets a 403 that their *account*
may not have access and to check their Pro/Max subscription. If the real cause is
the fingerprint gate, we are blaming the user's subscription for our transport
problem — and they uninstall.

- [ ] On `403` + body containing `Request not allowed`, retry via `curl`
- [ ] Remember the fallback for the session so we stop paying for a doomed attempt
- [ ] Rewrite the 403 message so it does not assert a subscription problem

## 3. Re-read credentials from disk on expiry

We have no token refresh at all — expiry surfaces a 401 telling the user to go
start a Claude Code session. But Claude Code normally rotates the token on disk
itself, so simply re-reading `.credentials.json` fixes most of these cases.

Deliberately **skip the write-back**: the competitor POSTs the refresh token to
`console.anthropic.com/v1/oauth/token` and writes the result back to
`.credentials.json`, which races Claude Code writing the same file. Not worth it.

- [ ] Track `expiresAt` and re-read from disk before failing on a stale token
- [ ] Retry the usage call once after a successful re-read

## 4. Zero out rolled-over windows on stale data

`src/extension.ts:48` keeps the last good `UsageData` forever on fetch failure.
After a long outage the status bar shows a frozen percentage while
`formatTimeRemaining` is stuck on `resetting`, which reads as a live figure and
is not one.

- [ ] In `src/windows.ts`, zero a window whose `resetsAt` has already passed
- [ ] Drop it entirely once more than ~2 periods have elapsed (no trustworthy figure)

## 5. Read `spend` / honor `decimal_places`

The live API returns both `extra_usage` and a newer `spend` object carrying
`amount_minor` plus an explicit `exponent`. We only read `extra_usage` and
hardcode `/100` at `src/windows.ts:108` while ignoring the `decimal_places: 2`
field sitting right next to it. Correct today by luck; wrong the first time a
currency with a different exponent shows up.

- [ ] Prefer `spend` (unambiguous minor units + exponent), fall back to `extra_usage`
- [ ] Scale by `decimal_places` instead of a hardcoded `/100`
- [ ] Treat a missing/zero monthly cap as "no cap", not as `0`

## 6. Lead the README with "official API, not an estimate"

Our whole differentiator, currently buried under the status bar template docs.

The competitor's headline number is derived from token counts × published rates,
maintained across 3,500 lines of loader/pricing code against a moving target, and
their own README concedes it is "not a billing tool." Ours comes from Anthropic —
the same source Claude Code's own `/usage` reads. That claim belongs above the
fold, not in a "Data Source" section near the bottom.

- [ ] Open with the accuracy claim; move the template reference below the features
- [ ] Say plainly what we do *not* do: no telemetry, no LLM calls, no quota spent on us
