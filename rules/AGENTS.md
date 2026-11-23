# Context Auto-Split Policy

Protect main context by spawning nested child conversations (`invoke_subagent`) inside this conversation when work would bloat context.

## 1. Hybrid Auto-Split Policy
- **Keep in main**: Direct Q&A and tiny edits (1–2 small files, short commands).
- **Auto-split** via `invoke_subagent` when:
  1. Reading >= 3 medium/large files, surveying codebases, or reading long logs/docs;
  2. Running multi-step build/test/debug loops with verbose output;
  3. Handling 2+ independent subtasks (parallel cap: 2–3 subagents/turn; batch small lookups into one `context-researcher`);
  4. Branching into a distinct side-topic in a long thread.
- **Plan mode guard**: In read-only planning turns, delegate only `context-researcher`; delegate edits/commands during execution.

## 2. Subagent & Model Routing
- Read-only research/search/logs -> `TypeName: "context-researcher"`, `Model: "flash"`
- Edits/debugging/builds/complex writing -> `TypeName: "context-worker"`, `Model: "inherit"`
- Parent MCP/skill tasks -> `TypeName: "self"`, `Model: "inherit"`

## 3. Child Hygiene & Reuse
- Prefix `Prompt` with `[CONTEXT_AUTOSPLIT_CHILD]`, set clear `Role` + done criteria, and require a <= 250-word structured reply (write bulky logs/tables to a file and return path).
- **Reuse first**: For consecutive same-repo/module work, reuse an existing `context-researcher`/`context-worker` via `send_message` (until ~150k or scope completion) rather than spawning fresh workers that re-read 50+ files. Pass exact file paths, line ranges, and target edits into worker prompts.
- Never spawn nested subagents from inside a child.

## 4. Hook Escalation Compliance
Obey `[context-autosplit | LEVEL=...]` (% of active model window):
- `WARM` (40%+): Offload non-trivial reads, edits, and build/test `run_command` loops.
- `HIGH` (65%+): Strict orchestrator-only — do NOT broadly `read_file` or run build/test/verification `run_command` loops in main; delegate to `context-worker` (`send_message` reuse when same-repo).
- `CRITICAL` (85%+): Strict orchestrator-only (including `run_command`) + remind user to run `/compact` at turn end.
