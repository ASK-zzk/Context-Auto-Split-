---
name: context-autosplit
description: Manually split tasks into parallel child conversations, inspect current context token watermark and active subagents, or tune context-autosplit thresholds and delegation modes in config.json.
---

# Context Auto-Split

Use this skill when the user wants to split a large task across nested child conversations inside the current conversation, inspect context usage and active subagents, or configure `context-autosplit` behavior.

## 1. Check Context Status & Active Subagents

1. Call `manage_subagents` with `Action: "list"` to see all nested child conversations spawned in this session and their states.
2. Read `~/.gemini/config/plugins/context-autosplit/config.json` for active window mappings, percentage thresholds, and routing mode.
3. Inspect the tail of the active `transcript.jsonl` (under `<appDataDir>\brain\<conversation-id>\.system_generated\logs\transcript.jsonl`) to check the latest `PLANNER_RESPONSE` model and token counts (`input_tokens + cache_read_tokens + output_tokens`), then compare against the resolved window from `modelWindows` / `defaultWindowTokens` and `thresholdPercents` (or legacy `windowTokens` / `thresholds` when `thresholdMode` is `"tokens"`).
4. Report current usage vs. active window thresholds, active child conversations eligible for `send_message` reuse, and whether a split or `/compact` is recommended.

## 2. Manually Split a Large Task into Parallel Child Conversations

Route each independent slice by capability and model preference from `config.json`:

| Work Type | `TypeName` | `Model` | When to Use |
| :--- | :--- | :--- | :--- |
| Read-only exploration / log reading / research | `context-researcher` | `flash` | Surveying files, searching references, analyzing logs |
| Code edits / debugging / builds / tests | `context-worker` | `inherit` | Implementing changes, fixing bugs, running test suites |
| Needs parent MCP tools or specialized skills | `self` | `inherit` | Tasks relying on external MCP servers or plugin skills |

**Prompt template for `invoke_subagent`**:

```text
[CONTEXT_AUTOSPLIT_CHILD]
目标：<具体的子任务目标与范围>
完成标准：<明确需要产出的结果或通过的验证>
输出约束：请在 <= 250 字内按结构化摘要返回结论、改动/关键文件路径与验证结果；若细节或日志较长，请写入 scratch/artifact 文件并仅返回路径。禁止再派生子对话。
```

- Launch at most `maxParallelSubagents` (default `3`) independent slices concurrently per wave, batching small related lookups into one `context-researcher`.
- For consecutive work in the same repository or module, reuse an existing `context-researcher` or `context-worker` `conversationId` via `send_message` (until it nears ~150k tokens) instead of creating a duplicate child conversation, and pass exact file paths / line ranges from researcher results into worker prompts.

## 3. Tune `config.json`

Edit `~/.gemini/config/plugins/context-autosplit/config.json`. Changes take effect automatically on the next `PreInvocation` hook call (no restart required). Note: `PreInvocation` directives intentionally emit pure `systemMessage` payloads (without `metadata.user_markdown`) so the Antigravity runtime delivers every threshold reminder reliably.

| Key | Default | Description |
| :--- | :--- | :--- |
| `enabled` | `true` | Master switch for the `PreInvocation` context guard hook. |
| `mode` | `"hybrid"` | `"hybrid"` (auto-split heavy/parallel tasks + watermarks), `"orchestrator"` (delegate non-trivial work from turn 1), or `"threshold-only"` (split only after crossing thresholds). |
| `thresholdMode` | `"percent"` | `"percent"` (scale thresholds dynamically by active model window) or `"tokens"` (legacy fixed-token mode using `windowTokens`, `thresholds`, `burstMinTokens`, `reAlertDeltaTokens`). |
| `defaultWindowTokens` | `512000` | Fallback context window (`512K`) when active model is unknown or does not match `modelWindows`. |
| `autoCalibrateFromCompaction` | `true` | For models without a specific override (matching only generic `"gemini"` / `"claude"` or unmatched), bidirectionally learn practical window ceilings (expanding above or shrinking below `defaultWindowTokens`) from historical compaction peaks in `transcript.jsonl` (`observed_windows.json`). Explicitly pinned models are never overridden; switching to a strictly larger window immediately resets stale alert tiers. |
| `modelWindows` | map | Longest-key-first case-insensitive substring map from model name to window tokens (`gemini-4-neon: 512000`, `gemini-4-hydrogen: 512000`, `gemini-4-argon: 1048576`, `gemini: 1000000`, `claude-opus-5-5`/`claude-sonnet-5-5`/`claude-*-1m`: `1000000`, `claude: 200000`, `gemma`/`litert`: `64000`, `gpt-4.1: 1000000`, `gpt-5: 400000`, `o3`/`o4: 200000`, `gpt-4o`/`gpt-oss: 128000`). |
| `thresholdPercents.burstMin` | `20` | Minimum percentage floor before single-turn heavy tool output triggers `BURST`. |
| `thresholdPercents.warm` | `40` | Triggers `WARM` proactive offload directive. |
| `thresholdPercents.high` | `65` | Triggers `HIGH` strict orchestrator-only mode (including `run_command` build/test offloading). |
| `thresholdPercents.critical` | `85` | Triggers `CRITICAL` orchestrator-only mode + `/compact` reminder. |
| `thresholdPercents.reAlertDelta` | `15` | Minimum percentage growth before repeating a `HIGH` or `CRITICAL` reminder. |
| `heavyToolBurstBytes` | `24000` | Single-turn `GENERIC` tool output byte threshold for `BURST` detection in `hybrid` mode. |
| `compactDropRatio` | `0.65` | If tokens drop below `peakTokens * compactDropRatio`, assumes `/compact` ran and resets escalation tier. |
| `maxChildDepth` | `1` | Maximum nested child depth guarded against recursion. |
| `childCriticalTokens` | `150000` | Child wrap-up cap (effective limit is `min(childCriticalTokens, round(activeWindow * 0.75))`). |
| `maxParallelSubagents` | `3` | Recommended concurrent subagent cap per wave included in hook routing directives. |
| `models.heavy` | `"inherit"` | Model hint for `context-worker` / `self`. |
| `models.lightweight` | `"flash"` | Model hint for `context-researcher`. |

**Effective threshold examples (`thresholdMode: "percent"`)**:
- **Gemini 4 Neon / Hydrogen (`512k`)**: `WARM 205k` / `HIGH 333k` / `CRITICAL 435k` (child wrap-up `150k`)
- **Gemini 4 Argon / Claude 5.5 (`~1M`)**: `WARM ~400k–419k` / `HIGH ~650k–682k` / `CRITICAL ~850k–891k` (child wrap-up `150k`)
- **Claude 4.6 (`200k`)**: `WARM 80k` / `HIGH 130k` / `CRITICAL 170k` (child wrap-up `150k`)
- **Local LiteRT / Gemma (`64k`)**: `WARM 25.6k` / `HIGH 41.6k` / `CRITICAL 54.4k` (child wrap-up `48k`)

## 4. Self-Test

Run the automated hook verification suite from the plugin root (`~/.gemini/config/plugins/context-autosplit/`):

```powershell
node scripts/test_context_guard.mjs
```
