import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(__dirname, "..");
const GUARD_SCRIPT = path.join(__dirname, "context_guard.mjs");

function runGuard({ stdinObj, rawStdin, pluginDataDir, configPath }) {
  const input = rawStdin !== undefined ? rawStdin : JSON.stringify(stdinObj);
  const env = { ...process.env, PLUGIN_DATA: pluginDataDir };
  if (configPath) {
    env.CONTEXT_AUTOSPLIT_CONFIG_PATH = configPath;
  } else {
    delete env.CONTEXT_AUTOSPLIT_CONFIG_PATH;
  }

  const res = spawnSync(process.execPath, [GUARD_SCRIPT], {
    input,
    encoding: "utf8",
    env,
  });

  assert.equal(res.status, 0, `Hook exited with ${res.status}: ${res.stderr}`);
  const out = (res.stdout || "").trim();
  assert.ok(out.length > 0, "Hook produced empty stdout");
  return JSON.parse(out);
}

function writeTranscript(filePath, steps) {
  const lines = steps.map((s) => JSON.stringify(s)).join("\n") + "\n";
  fs.writeFileSync(filePath, lines, "utf8");
}

function getInjected(result) {
  assert.ok(Array.isArray(result.injectSteps) && result.injectSteps.length === 1, "Expected 1 injectStep");
  const sm = result.injectSteps[0].systemMessage;
  assert.ok(sm && typeof sm.systemMessage === "string", "Expected nested systemMessage object");
  assert.equal(sm.metadata, undefined, "Hook response must NOT include metadata (prevents silent runtime drop)");
  return sm;
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "context-autosplit-test-"));
let passed = 0;

function runTest(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`PASS: ${name}`);
  } catch (err) {
    console.error(`FAIL: ${name}\n`, err);
    process.exitCode = 1;
  }
}

try {
  // Sanity-check static JSON manifests first
  for (const rel of ["plugin.json", "hooks.json", "config.json"]) {
    JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, rel), "utf8"));
  }

  const pluginData = path.join(tmpRoot, "plugin_data");
  fs.mkdirSync(pluginData, { recursive: true });
  const mainConvId = "11111111-1111-4111-8111-111111111111";
  const mainTranscript = path.join(tmpRoot, "main.jsonl");
  const childUuid = "22222222-2222-4222-8222-222222222222";

  // 1. Normal low-token conversation -> {}
  runTest("1. Normal low-token conversation returns {}", () => {
    writeTranscript(mainTranscript, [
      { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", content: "Hello" },
      { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", model: "claude-sonnet-4-6", input_tokens: 8000, cache_read_tokens: 4000, output_tokens: 300 },
    ]);
    const res = runGuard({
      stdinObj: { conversationId: mainConvId, transcriptPath: mainTranscript, invocationNum: 1 },
      pluginDataDir: pluginData,
    });
    assert.deepEqual(res, {});
  });

  // 2. Burst tool output at 50k tokens -> triggers once, debounces on 2nd invocation in same turn
  runTest("2. Burst tool output at 50k triggers once then debounces in same turn", () => {
    const bigToolOutput = "x".repeat(26000);
    writeTranscript(mainTranscript, [
      { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", content: "Read lots of files" },
      { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", model: "claude-sonnet-4-6", input_tokens: 30000, cache_read_tokens: 19500, output_tokens: 500 },
      { step_index: 2, source: "MODEL", type: "GENERIC", content: bigToolOutput },
    ]);
    const first = runGuard({
      stdinObj: { conversationId: mainConvId, transcriptPath: mainTranscript, invocationNum: 2 },
      pluginDataDir: pluginData,
    });
    const sm = getInjected(first);
    assert.match(sm.systemMessage, /LEVEL=BURST/);
    assert.match(sm.systemMessage, /<= 3 subagents/);
    assert.match(sm.systemMessage, /send_message/);

    const second = runGuard({
      stdinObj: { conversationId: mainConvId, transcriptPath: mainTranscript, invocationNum: 3 },
      pluginDataDir: pluginData,
    });
    assert.deepEqual(second, {});
  });

  // 3. Warm escalation at 85k -> triggers pure WARM, debounces at 95k
  runTest("3. Warm escalation at 85k triggers pure WARM then debounces at 95k", () => {
    writeTranscript(mainTranscript, [
      { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", content: "Continue" },
      { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", model: "claude-sonnet-4-6", input_tokens: 50000, cache_read_tokens: 34000, output_tokens: 1000 },
    ]);
    const warm = runGuard({
      stdinObj: { conversationId: mainConvId, transcriptPath: mainTranscript, invocationNum: 4 },
      pluginDataDir: pluginData,
    });
    const sm = getInjected(warm);
    assert.match(sm.systemMessage, /LEVEL=WARM/);
    assert.match(sm.systemMessage, /run_command/);

    writeTranscript(mainTranscript, [
      { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", content: "Continue" },
      { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", model: "claude-sonnet-4-6", input_tokens: 55000, cache_read_tokens: 39000, output_tokens: 1000 },
    ]);
    const debounced = runGuard({
      stdinObj: { conversationId: mainConvId, transcriptPath: mainTranscript, invocationNum: 5 },
      pluginDataDir: pluginData,
    });
    assert.deepEqual(debounced, {});
  });

  // 4. High escalation at 135k with prior invoke_subagent call -> triggers HIGH, lists child UUID/role, registers in children.json
  runTest("4. High escalation at 135k detects spawned child, prompts reuse, and registers children.json", () => {
    writeTranscript(mainTranscript, [
      { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", content: "Analyze repo" },
      {
        step_index: 1,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        model: "claude-sonnet-4-6",
        input_tokens: 60000,
        cache_read_tokens: 35000,
        output_tokens: 800,
        tool_calls: [
          {
            name: "invoke_subagent",
            args: {
              Role: '"Codebase Scanner"',
              TypeName: '"context-researcher"',
              Prompt: '"[CONTEXT_AUTOSPLIT_CHILD] Scan src"',
            },
          },
        ],
      },
      {
        step_index: 2,
        source: "MODEL",
        type: "GENERIC",
        content: `Launched subagent conversationId: ${childUuid}`,
      },
      {
        step_index: 3,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        model: "claude-sonnet-4-6",
        input_tokens: 80000,
        cache_read_tokens: 54000,
        output_tokens: 1000,
      },
    ]);
    const high = runGuard({
      stdinObj: { conversationId: mainConvId, transcriptPath: mainTranscript, invocationNum: 6 },
      pluginDataDir: pluginData,
    });
    const sm = getInjected(high);
    assert.match(sm.systemMessage, /LEVEL=HIGH/);
    assert.match(sm.systemMessage, /run_command/);
    assert.match(sm.systemMessage, /send_message/);
    assert.match(sm.systemMessage, /<= 3 subagents/);
    assert.ok(sm.systemMessage.includes(childUuid), "Expected child UUID in HIGH reminder");
    assert.ok(sm.systemMessage.includes("Codebase Scanner"), "Expected child role in HIGH reminder");

    const childrenJson = JSON.parse(fs.readFileSync(path.join(pluginData, "children.json"), "utf8"));
    assert.ok(childrenJson[childUuid], "Expected child UUID registered in children.json");
    assert.equal(childrenJson[childUuid].parentId, mainConvId);
    assert.equal(childrenJson[childUuid].role, "Codebase Scanner");
    assert.equal(childrenJson[childUuid].depth, 1);
  });

  // 5. Re-alert cooldown in High (145k silent -> 175k escalates to CRITICAL + /compact reminder)
  runTest("5. Cooldown at 145k is silent, 175k escalates to CRITICAL with /compact reminder", () => {
    writeTranscript(mainTranscript, [
      { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", content: "More work" },
      { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", model: "claude-sonnet-4-6", input_tokens: 85000, cache_read_tokens: 59000, output_tokens: 1000 },
    ]);
    const silent = runGuard({
      stdinObj: { conversationId: mainConvId, transcriptPath: mainTranscript, invocationNum: 7 },
      pluginDataDir: pluginData,
    });
    assert.deepEqual(silent, {});

    writeTranscript(mainTranscript, [
      { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", content: "Even more" },
      { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", model: "claude-sonnet-4-6", input_tokens: 100000, cache_read_tokens: 74000, output_tokens: 1000 },
    ]);
    const critical = runGuard({
      stdinObj: { conversationId: mainConvId, transcriptPath: mainTranscript, invocationNum: 8 },
      pluginDataDir: pluginData,
    });
    const sm = getInjected(critical);
    assert.match(sm.systemMessage, /LEVEL=CRITICAL/);
    assert.match(sm.systemMessage, /run_command/);
    assert.match(sm.systemMessage, /send_message/);
    assert.match(sm.systemMessage, /<= 3 subagents/);
    assert.match(sm.systemMessage, /\/compact/);
  });

  // 6. Compaction drop (175k -> 30k -> 85k) -> resets state and re-triggers WARM
  runTest("6. Compaction drop resets tier state and re-triggers WARM at 85k", () => {
    writeTranscript(mainTranscript, [
      { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", content: "After compact" },
      { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", model: "claude-sonnet-4-6", input_tokens: 20000, cache_read_tokens: 9500, output_tokens: 500 },
    ]);
    const postCompact = runGuard({
      stdinObj: { conversationId: mainConvId, transcriptPath: mainTranscript, invocationNum: 9 },
      pluginDataDir: pluginData,
    });
    assert.deepEqual(postCompact, {});

    writeTranscript(mainTranscript, [
      { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", content: "Grow again" },
      { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", model: "claude-sonnet-4-6", input_tokens: 55000, cache_read_tokens: 29000, output_tokens: 1000 },
    ]);
    const reWarm = runGuard({
      stdinObj: { conversationId: mainConvId, transcriptPath: mainTranscript, invocationNum: 10 },
      pluginDataDir: pluginData,
    });
    const sm = getInjected(reWarm);
    assert.match(sm.systemMessage, /LEVEL=WARM/);
  });

  // 7. Child anti-recursion via children.json AND [CONTEXT_AUTOSPLIT_CHILD] marker
  runTest("7. Child anti-recursion blocks splitting at 90k/135k and silently wraps up at 155k", () => {
    // 7a: child registered in children.json (childUuid)
    const childTranscriptA = path.join(tmpRoot, "childA.jsonl");
    writeTranscript(childTranscriptA, [
      { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", content: "Inspect modules" },
      { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", input_tokens: 60000, cache_read_tokens: 29500, output_tokens: 500 },
    ]);
    assert.deepEqual(
      runGuard({
        stdinObj: { conversationId: childUuid, transcriptPath: childTranscriptA, invocationNum: 1 },
        pluginDataDir: pluginData,
      }),
      {}
    );

    writeTranscript(childTranscriptA, [
      { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", content: "Inspect modules" },
      { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", input_tokens: 90000, cache_read_tokens: 44000, output_tokens: 1000 },
    ]);
    assert.deepEqual(
      runGuard({
        stdinObj: { conversationId: childUuid, transcriptPath: childTranscriptA, invocationNum: 2 },
        pluginDataDir: pluginData,
      }),
      {}
    );

    writeTranscript(childTranscriptA, [
      { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", content: "Inspect modules" },
      { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", input_tokens: 100000, cache_read_tokens: 54000, output_tokens: 1000 },
    ]);
    const wrapA = runGuard({
      stdinObj: { conversationId: childUuid, transcriptPath: childTranscriptA, invocationNum: 3 },
      pluginDataDir: pluginData,
    });
    const smA = getInjected(wrapA);
    assert.match(smA.systemMessage, /LEVEL=CHILD_CRITICAL/);
    assert.equal(smA.metadata, undefined, "Child critical directive must NOT emit user_markdown");

    // 7b: child detected purely via [CONTEXT_AUTOSPLIT_CHILD] marker
    const markedChildId = "33333333-3333-4333-8333-333333333333";
    const childTranscriptB = path.join(tmpRoot, "childB.jsonl");
    writeTranscript(childTranscriptB, [
      { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", content: "[CONTEXT_AUTOSPLIT_CHILD] Do isolated work" },
      { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", input_tokens: 90000, cache_read_tokens: 44000, output_tokens: 1000 },
    ]);
    assert.deepEqual(
      runGuard({
        stdinObj: { conversationId: markedChildId, transcriptPath: childTranscriptB, invocationNum: 1 },
        pluginDataDir: pluginData,
      }),
      {}
    );

    writeTranscript(childTranscriptB, [
      { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", content: "[CONTEXT_AUTOSPLIT_CHILD] Do isolated work" },
      { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", input_tokens: 100000, cache_read_tokens: 54000, output_tokens: 1000 },
    ]);
    const wrapB = runGuard({
      stdinObj: { conversationId: markedChildId, transcriptPath: childTranscriptB, invocationNum: 2 },
      pluginDataDir: pluginData,
    });
    const smB = getInjected(wrapB);
    assert.match(smB.systemMessage, /LEVEL=CHILD_CRITICAL/);
    assert.equal(smB.metadata, undefined, "Marked child critical must NOT emit user_markdown");
  });

  // 8. orchestrator mode & threshold-only mode behavior
  runTest("8. orchestrator mode & threshold-only mode behavior", () => {
    const baseCfg = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, "config.json"), "utf8"));

    // 8a: orchestrator mode reminds once at low tokens then stays silent until warm
    const orchCfgPath = path.join(tmpRoot, "orch_config.json");
    fs.writeFileSync(orchCfgPath, JSON.stringify({ ...baseCfg, mode: "orchestrator" }), "utf8");
    const orchConv = "44444444-4444-4444-8444-444444444444";
    const orchTx = path.join(tmpRoot, "orch.jsonl");
    writeTranscript(orchTx, [
      { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", content: "Build feature" },
      { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", input_tokens: 5000, cache_read_tokens: 0, output_tokens: 200 },
    ]);
    const orchFirst = runGuard({
      stdinObj: { conversationId: orchConv, transcriptPath: orchTx, invocationNum: 1 },
      pluginDataDir: pluginData,
      configPath: orchCfgPath,
    });
    assert.match(getInjected(orchFirst).systemMessage, /LEVEL=ORCHESTRATOR/);

    const orchSecond = runGuard({
      stdinObj: { conversationId: orchConv, transcriptPath: orchTx, invocationNum: 2 },
      pluginDataDir: pluginData,
      configPath: orchCfgPath,
    });
    assert.deepEqual(orchSecond, {});

    // 8b: threshold-only ignores heavy burst at 50k, still triggers at 85k WARM
    const threshCfgPath = path.join(tmpRoot, "thresh_config.json");
    fs.writeFileSync(threshCfgPath, JSON.stringify({ ...baseCfg, mode: "threshold-only" }), "utf8");
    const threshConv = "55555555-5555-4555-8555-555555555555";
    const threshTx = path.join(tmpRoot, "thresh.jsonl");
    writeTranscript(threshTx, [
      { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", content: "Read huge log" },
      { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", model: "claude-sonnet-4-6", input_tokens: 30000, cache_read_tokens: 19500, output_tokens: 500 },
      { step_index: 2, source: "MODEL", type: "GENERIC", content: "y".repeat(30000) },
    ]);
    assert.deepEqual(
      runGuard({
        stdinObj: { conversationId: threshConv, transcriptPath: threshTx, invocationNum: 1 },
        pluginDataDir: pluginData,
        configPath: threshCfgPath,
      }),
      {}
    );

    writeTranscript(threshTx, [
      { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", content: "Read huge log" },
      { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", model: "claude-sonnet-4-6", input_tokens: 55000, cache_read_tokens: 29000, output_tokens: 1000 },
    ]);
    const threshWarm = runGuard({
      stdinObj: { conversationId: threshConv, transcriptPath: threshTx, invocationNum: 2 },
      pluginDataDir: pluginData,
      configPath: threshCfgPath,
    });
    assert.match(getInjected(threshWarm).systemMessage, /LEVEL=WARM/);
  });

  // 9. Error resilience (invalid JSON stdin, missing transcript file) -> exits 0 with {}
  runTest("9. Error resilience on invalid JSON stdin and missing transcript returns {}", () => {
    const badJson = runGuard({
      rawStdin: "{not-valid-json",
      pluginDataDir: pluginData,
    });
    assert.deepEqual(badJson, {});

    const missingFile = runGuard({
      stdinObj: {
        conversationId: "66666666-6666-4666-8666-666666666666",
        transcriptPath: path.join(tmpRoot, "does-not-exist.jsonl"),
        invocationNum: 1,
      },
      pluginDataDir: pluginData,
    });
    assert.deepEqual(missingFile, {});
  });

  // 10. Official model windows (Neon 512k, Argon 1M, Claude 5.5/1M longest-key, Gemma 64k)
  runTest("10. Official model windows (Neon 512k, Argon 1M, Claude 5.5/1M, Gemma 64k)", () => {
    const neonConv = "77777777-7777-4777-8777-777777777777";
    const neonTx = path.join(tmpRoot, "neon.jsonl");

    writeTranscript(neonTx, [
      { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", content: "Start" },
      { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", model: "gemini-4-neon-high", input_tokens: 100000, cache_read_tokens: 49000, output_tokens: 1000 },
    ]);
    assert.deepEqual(
      runGuard({
        stdinObj: { conversationId: neonConv, transcriptPath: neonTx, modelName: "auto", invocationNum: 1 },
        pluginDataDir: pluginData,
      }),
      {}
    );

    writeTranscript(neonTx, [
      { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", content: "Warm" },
      { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", model: "gemini-4-neon-high", input_tokens: 140000, cache_read_tokens: 69000, output_tokens: 1000 },
    ]);
    const warmSm = getInjected(
      runGuard({
        stdinObj: { conversationId: neonConv, transcriptPath: neonTx, modelName: "Auto", invocationNum: 2 },
        pluginDataDir: pluginData,
      })
    );
    assert.match(warmSm.systemMessage, /LEVEL=WARM/);
    assert.ok(warmSm.systemMessage.includes("210k / 512k (41%, model=gemini-4-neon-high)"));

    writeTranscript(neonTx, [
      { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", content: "High" },
      { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", model: "gemini-4-neon-high", input_tokens: 220000, cache_read_tokens: 119000, output_tokens: 1000 },
    ]);
    const highSm = getInjected(
      runGuard({
        stdinObj: { conversationId: neonConv, transcriptPath: neonTx, modelName: "auto", invocationNum: 3 },
        pluginDataDir: pluginData,
      })
    );
    assert.match(highSm.systemMessage, /LEVEL=HIGH/);
    assert.ok(highSm.systemMessage.includes("340k / 512k (66%, model=gemini-4-neon-high)"));

    writeTranscript(neonTx, [
      { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", content: "Critical" },
      { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", model: "gemini-4-neon-high", input_tokens: 300000, cache_read_tokens: 139000, output_tokens: 1000 },
    ]);
    const critSm = getInjected(
      runGuard({
        stdinObj: { conversationId: neonConv, transcriptPath: neonTx, modelName: "auto", invocationNum: 4 },
        pluginDataDir: pluginData,
      })
    );
    assert.match(critSm.systemMessage, /LEVEL=CRITICAL/);
    assert.ok(critSm.systemMessage.includes("440k / 512k (86%, model=gemini-4-neon-high)"));

    // Hydrogen 512k: 210k (41%) triggers WARM
    const hydroPinnedConv = "77777776-7777-4777-8777-777777777776";
    const hydroPinnedTx = path.join(tmpRoot, "hydrogen_pinned.jsonl");
    writeTranscript(hydroPinnedTx, [
      { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", content: "Hydrogen warm" },
      { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", model: "gemini-4-hydrogen-xhigh", input_tokens: 140000, cache_read_tokens: 69000, output_tokens: 1000 },
    ]);
    const hydroWarm = getInjected(
      runGuard({
        stdinObj: { conversationId: hydroPinnedConv, transcriptPath: hydroPinnedTx, modelName: "gemini-4-hydrogen-xhigh", invocationNum: 1 },
        pluginDataDir: pluginData,
      })
    );
    assert.match(hydroWarm.systemMessage, /LEVEL=WARM/);
    assert.ok(hydroWarm.systemMessage.includes("210k / 512k (41%, model=gemini-4-hydrogen-xhigh)"));

    // Carbon 512k: 210k (41%) triggers WARM
    const carbonPinnedConv = "77777775-7777-4777-8777-777777777775";
    const carbonPinnedTx = path.join(tmpRoot, "carbon_pinned.jsonl");
    writeTranscript(carbonPinnedTx, [
      { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", content: "Carbon warm" },
      { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", model: "gemini-4-carbon-high", input_tokens: 140000, cache_read_tokens: 69000, output_tokens: 1000 },
    ]);
    const carbonWarm = getInjected(
      runGuard({
        stdinObj: { conversationId: carbonPinnedConv, transcriptPath: carbonPinnedTx, modelName: "gemini-4-carbon-high", invocationNum: 1 },
        pluginDataDir: pluginData,
      })
    );
    assert.match(carbonWarm.systemMessage, /LEVEL=WARM/);
    assert.ok(carbonWarm.systemMessage.includes("210k / 512k (41%, model=gemini-4-carbon-high)"));

    // Argon 1,048,576 (~1M): 350k silent, 430k WARM
    const argonConv = "77777778-7777-4777-8777-777777777778";
    const argonTx = path.join(tmpRoot, "argon.jsonl");
    writeTranscript(argonTx, [
      { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", content: "Argon low" },
      { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", model: "gemini-4-argon-medium", input_tokens: 250000, cache_read_tokens: 99000, output_tokens: 1000 },
    ]);
    assert.deepEqual(
      runGuard({
        stdinObj: { conversationId: argonConv, transcriptPath: argonTx, modelName: "gemini-4-argon-medium", invocationNum: 1 },
        pluginDataDir: pluginData,
      }),
      {}
    );

    writeTranscript(argonTx, [
      { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", content: "Argon warm" },
      { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", model: "gemini-4-argon-medium", input_tokens: 280000, cache_read_tokens: 149000, output_tokens: 1000 },
    ]);
    const argonWarm = getInjected(
      runGuard({
        stdinObj: { conversationId: argonConv, transcriptPath: argonTx, modelName: "gemini-4-argon-medium", invocationNum: 2 },
        pluginDataDir: pluginData,
      })
    );
    assert.match(argonWarm.systemMessage, /LEVEL=WARM/);
    assert.ok(argonWarm.systemMessage.includes("430k / 1M (41%, model=gemini-4-argon-medium)"));

    // Longest-key matching: claude-sonnet-5-5 and claude-opus-4-6-1m must hit 1M (not 200k "claude")
    for (const [idx, model] of ["claude-sonnet-5-5", "claude-opus-4-6-1m"].entries()) {
      const cConv = `8888888${idx}-8888-4888-8888-88888888888${idx}`;
      const cTx = path.join(tmpRoot, `claude1m_${idx}.jsonl`);
      writeTranscript(cTx, [
        { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", content: "Big context" },
        { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", model, input_tokens: 150000, cache_read_tokens: 99000, output_tokens: 1000 },
      ]);
      assert.deepEqual(
        runGuard({
          stdinObj: { conversationId: cConv, transcriptPath: cTx, modelName: model, invocationNum: 1 },
          pluginDataDir: pluginData,
        }),
        {}
      );
    }

    // Gemma 64k: 27k (42%) triggers WARM
    const gemmaConv = "88888889-8888-4888-8888-888888888889";
    const gemmaTx = path.join(tmpRoot, "gemma.jsonl");
    writeTranscript(gemmaTx, [
      { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", content: "Local gemma" },
      { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", model: "gemma-4-26b", input_tokens: 18000, cache_read_tokens: 8500, output_tokens: 500 },
    ]);
    const gemmaWarm = getInjected(
      runGuard({
        stdinObj: { conversationId: gemmaConv, transcriptPath: gemmaTx, modelName: "gemma-4-26b", invocationNum: 1 },
        pluginDataDir: pluginData,
      })
    );
    assert.match(gemmaWarm.systemMessage, /LEVEL=WARM/);
    assert.ok(gemmaWarm.systemMessage.includes("27k / 64k (42%, model=gemma-4-26b)"));
  });

  // 11. Mid-conversation model switching (Neon 512k->Claude 200k escalates; Claude 200k HIGH->Argon 1M resets then WARM at 430k)
  runTest("11. Mid-conversation model switching updates thresholds and resets tier when dropping below warm", () => {
    const switchPluginData = path.join(tmpRoot, "plugin_data_switch");
    fs.mkdirSync(switchPluginData, { recursive: true });

    // 11a: 150k (29%) silent on gemini-4-neon-high -> switch to claude-sonnet-4-6 (75%) -> immediate HIGH
    const switchUpConv = "99999999-9999-4999-8999-999999999999";
    const switchUpTx = path.join(tmpRoot, "switch_up.jsonl");
    writeTranscript(switchUpTx, [
      { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", content: "Switch smaller" },
      { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", model: "gemini-4-neon-high", input_tokens: 100000, cache_read_tokens: 49000, output_tokens: 1000 },
    ]);
    assert.deepEqual(
      runGuard({
        stdinObj: { conversationId: switchUpConv, transcriptPath: switchUpTx, modelName: "gemini-4-neon-high", invocationNum: 1 },
        pluginDataDir: switchPluginData,
      }),
      {}
    );

    const switchedHigh = getInjected(
      runGuard({
        stdinObj: { conversationId: switchUpConv, transcriptPath: switchUpTx, modelName: "claude-sonnet-4-6", invocationNum: 2 },
        pluginDataDir: switchPluginData,
      })
    );
    assert.match(switchedHigh.systemMessage, /LEVEL=HIGH/);
    assert.ok(switchedHigh.systemMessage.includes("150k / 200k (75%, model=claude-sonnet-4-6)"));

    // 11b: 140k HIGH on claude-sonnet-4-6 -> switch to gemini-4-argon-medium (13%) resets to normal ({}) -> 430k triggers WARM
    const switchDownConv = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const switchDownTx = path.join(tmpRoot, "switch_down.jsonl");
    writeTranscript(switchDownTx, [
      { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", content: "Switch bigger" },
      { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", model: "claude-sonnet-4-6", input_tokens: 90000, cache_read_tokens: 49000, output_tokens: 1000 },
    ]);
    const initialHigh = getInjected(
      runGuard({
        stdinObj: { conversationId: switchDownConv, transcriptPath: switchDownTx, modelName: "claude-sonnet-4-6", invocationNum: 1 },
        pluginDataDir: switchPluginData,
      })
    );
    assert.match(initialHigh.systemMessage, /LEVEL=HIGH/);

    assert.deepEqual(
      runGuard({
        stdinObj: { conversationId: switchDownConv, transcriptPath: switchDownTx, modelName: "gemini-4-argon-medium", invocationNum: 2 },
        pluginDataDir: switchPluginData,
      }),
      {}
    );

    writeTranscript(switchDownTx, [
      { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", content: "Grow on Argon 1M" },
      { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", model: "gemini-4-argon-medium", input_tokens: 280000, cache_read_tokens: 149000, output_tokens: 1000 },
    ]);
    const warmAfterReset = getInjected(
      runGuard({
        stdinObj: { conversationId: switchDownConv, transcriptPath: switchDownTx, modelName: "gemini-4-argon-medium", invocationNum: 3 },
        pluginDataDir: switchPluginData,
      })
    );
    assert.match(warmAfterReset.systemMessage, /LEVEL=WARM/);
    assert.ok(warmAfterReset.systemMessage.includes("430k / 1M (41%, model=gemini-4-argon-medium)"));
  });

  // 12. Legacy thresholdMode: "tokens" compatibility & 1M child conversation 150k cap
  runTest("12. Legacy thresholdMode=tokens compatibility and 1M child 150k wrap-up cap", () => {
    const baseCfg = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, "config.json"), "utf8"));
    const tokensCfgPath = path.join(tmpRoot, "tokens_config.json");
    fs.writeFileSync(
      tokensCfgPath,
      JSON.stringify({
        ...baseCfg,
        thresholdMode: "tokens",
        windowTokens: 200000,
        thresholds: { warm: 80000, high: 130000, critical: 170000 },
        burstMinTokens: 45000,
        reAlertDeltaTokens: 35000,
      }),
      "utf8"
    );

    const tokensConv = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const tokensTx = path.join(tmpRoot, "tokens.jsonl");
    writeTranscript(tokensTx, [
      { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", content: "Legacy mode" },
      { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", model: "gemini-4-neon-high", input_tokens: 55000, cache_read_tokens: 29000, output_tokens: 1000 },
    ]);
    const legacyWarm = getInjected(
      runGuard({
        stdinObj: { conversationId: tokensConv, transcriptPath: tokensTx, modelName: "gemini-4-neon-high", invocationNum: 1 },
        pluginDataDir: pluginData,
        configPath: tokensCfgPath,
      })
    );
    assert.match(legacyWarm.systemMessage, /LEVEL=WARM/);
    assert.ok(legacyWarm.systemMessage.includes("85k / 200k (43%, model=gemini-4-neon-high)"));

    // 1M child conversation still caps wrap-up at 150k (triggers at 155k, silent at 135k)
    const argonChildId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const argonChildTx = path.join(tmpRoot, "argon_child.jsonl");
    writeTranscript(argonChildTx, [
      { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", content: "[CONTEXT_AUTOSPLIT_CHILD] Explore repo" },
      { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", model: "gemini-4-argon-medium", input_tokens: 90000, cache_read_tokens: 44000, output_tokens: 1000 },
    ]);
    assert.deepEqual(
      runGuard({
        stdinObj: { conversationId: argonChildId, transcriptPath: argonChildTx, modelName: "gemini-4-argon-medium", invocationNum: 1 },
        pluginDataDir: pluginData,
      }),
      {}
    );

    writeTranscript(argonChildTx, [
      { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", content: "[CONTEXT_AUTOSPLIT_CHILD] Explore repo" },
      { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", model: "gemini-4-argon-medium", input_tokens: 100000, cache_read_tokens: 54000, output_tokens: 1000 },
    ]);
    const childWrap = getInjected(
      runGuard({
        stdinObj: { conversationId: argonChildId, transcriptPath: argonChildTx, modelName: "gemini-4-argon-medium", invocationNum: 2 },
        pluginDataDir: pluginData,
      })
    );
    assert.match(childWrap.systemMessage, /LEVEL=CHILD_CRITICAL/);
    assert.equal(childWrap.metadata, undefined, "1M child critical must NOT emit metadata");
  });

  // 13. autoCalibrateFromCompaction learns generic model ceiling and never overrides explicit model keys
  runTest("13. autoCalibrateFromCompaction learns ceiling for generic models and preserves explicit keys", () => {
    const calPluginData = path.join(tmpRoot, "plugin_data_cal");
    fs.mkdirSync(calPluginData, { recursive: true });

    // 13a: unlisted gemini-4-xenon-high (generic "gemini" 1M) compacts 500k -> 60k, learns 500k, triggers WARM at 210k (42%)
    const xenonConv = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const xenonTx = path.join(tmpRoot, "xenon.jsonl");
    writeTranscript(xenonTx, [
      { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", content: "Grow on unlisted model" },
      { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", model: "gemini-4-xenon-high", input_tokens: 350000, cache_read_tokens: 149000, output_tokens: 1000 },
    ]);
    const preCompactWarm = getInjected(
      runGuard({
        stdinObj: { conversationId: xenonConv, transcriptPath: xenonTx, modelName: "gemini-4-xenon-high", invocationNum: 1 },
        pluginDataDir: calPluginData,
      })
    );
    assert.match(preCompactWarm.systemMessage, /LEVEL=WARM/);
    assert.ok(preCompactWarm.systemMessage.includes("500k / 1M (50%, model=gemini-4-xenon-high)"));

    writeTranscript(xenonTx, [
      { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", content: "Compacted" },
      { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", model: "gemini-4-xenon-high", input_tokens: 40000, cache_read_tokens: 19500, output_tokens: 500 },
    ]);
    assert.deepEqual(
      runGuard({
        stdinObj: { conversationId: xenonConv, transcriptPath: xenonTx, modelName: "gemini-4-xenon-high", invocationNum: 2 },
        pluginDataDir: calPluginData,
      }),
      {}
    );

    const observed = JSON.parse(fs.readFileSync(path.join(calPluginData, "observed_windows.json"), "utf8"));
    assert.equal(observed["gemini-4-xenon-high"].ceiling, 500000);
    assert.deepEqual(observed["gemini-4-xenon-high"].samples, [500000]);

    writeTranscript(xenonTx, [
      { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", content: "Grow again after calibration" },
      { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", model: "gemini-4-xenon-high", input_tokens: 140000, cache_read_tokens: 69000, output_tokens: 1000 },
    ]);
    const calibratedWarm = getInjected(
      runGuard({
        stdinObj: { conversationId: xenonConv, transcriptPath: xenonTx, modelName: "gemini-4-xenon-high", invocationNum: 3 },
        pluginDataDir: calPluginData,
      })
    );
    assert.match(calibratedWarm.systemMessage, /LEVEL=WARM/);
    assert.ok(calibratedWarm.systemMessage.includes("210k / 500k (42%, model=gemini-4-xenon-high)"));

    // 13b: explicit gemini-4-neon-high is never overridden by observed_windows.json
    const observedPath = path.join(calPluginData, "observed_windows.json");
    const updatedObserved = JSON.parse(fs.readFileSync(observedPath, "utf8"));
    updatedObserved["gemini-4-neon-high"] = { samples: [300000], ceiling: 300000, updatedAt: Date.now() };
    fs.writeFileSync(observedPath, JSON.stringify(updatedObserved, null, 2), "utf8");

    const explicitConv = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const explicitTx = path.join(tmpRoot, "explicit_neon.jsonl");
    writeTranscript(explicitTx, [
      { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", content: "Check explicit pin" },
      { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", model: "gemini-4-neon-high", input_tokens: 130000, cache_read_tokens: 59000, output_tokens: 1000 },
    ]);
    // 190k is 63% of 300k (would trigger WARM if overridden), but 37% of 512k (silent)
    assert.deepEqual(
      runGuard({
        stdinObj: { conversationId: explicitConv, transcriptPath: explicitTx, modelName: "gemini-4-neon-high", invocationNum: 1 },
        pluginDataDir: calPluginData,
      }),
      {}
    );

    writeTranscript(explicitTx, [
      { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", content: "Cross 512k warm" },
      { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", model: "gemini-4-neon-high", input_tokens: 140000, cache_read_tokens: 69000, output_tokens: 1000 },
    ]);
    const explicitWarm = getInjected(
      runGuard({
        stdinObj: { conversationId: explicitConv, transcriptPath: explicitTx, modelName: "gemini-4-neon-high", invocationNum: 2 },
        pluginDataDir: calPluginData,
      })
    );
    assert.match(explicitWarm.systemMessage, /LEVEL=WARM/);
    assert.ok(explicitWarm.systemMessage.includes("210k / 512k (41%, model=gemini-4-neon-high)"));
  });

  // 14. >6MB transcript with >20KB step0 preserves child detection without falling back to tail steps[0]
  runTest("14. >6MB transcript with >20KB step0 keeps child detection and triggers CHILD_CRITICAL at 155k", () => {
    const hugePluginData = path.join(tmpRoot, "plugin_data_huge");
    fs.mkdirSync(hugePluginData, { recursive: true });

    // 14a: ~22KB line 0 (>16KB, <256KB) + >6MB padding
    const hugeChildIdA = "14141414-1414-4141-8141-14141414141a";
    const hugeTxA = path.join(tmpRoot, "huge_child_22k.jsonl");
    const step0A = JSON.stringify({
      step_index: 0,
      source: "USER_EXPLICIT",
      type: "USER_INPUT",
      content: `[CONTEXT_AUTOSPLIT_CHILD] ${"a".repeat(22 * 1024)}`,
    });
    const padChunk = JSON.stringify({
      step_index: 1,
      source: "MODEL",
      type: "GENERIC",
      content: "p".repeat(120 * 1024),
    });
    const fdA = fs.openSync(hugeTxA, "w");
    fs.writeSync(fdA, step0A + "\n");
    for (let i = 0; i < 55; i++) {
      fs.writeSync(fdA, padChunk + "\n");
    }
    fs.closeSync(fdA);
    assert.ok(fs.statSync(hugeTxA).size > 6 * 1024 * 1024, "Expected > 6MB transcript");

    // 90k and 135k on claude-sonnet-4-6 (200k) would trigger WARM/HIGH if misidentified as parent
    fs.appendFileSync(
      hugeTxA,
      JSON.stringify({ step_index: 60, source: "MODEL", type: "PLANNER_RESPONSE", model: "claude-sonnet-4-6", input_tokens: 60000, cache_read_tokens: 29500, output_tokens: 500 }) + "\n",
      "utf8"
    );
    assert.deepEqual(
      runGuard({
        stdinObj: { conversationId: hugeChildIdA, transcriptPath: hugeTxA, modelName: "claude-sonnet-4-6", invocationNum: 1 },
        pluginDataDir: hugePluginData,
      }),
      {}
    );

    fs.appendFileSync(
      hugeTxA,
      JSON.stringify({ step_index: 61, source: "MODEL", type: "PLANNER_RESPONSE", model: "claude-sonnet-4-6", input_tokens: 90000, cache_read_tokens: 44000, output_tokens: 1000 }) + "\n",
      "utf8"
    );
    assert.deepEqual(
      runGuard({
        stdinObj: { conversationId: hugeChildIdA, transcriptPath: hugeTxA, modelName: "claude-sonnet-4-6", invocationNum: 2 },
        pluginDataDir: hugePluginData,
      }),
      {}
    );

    fs.appendFileSync(
      hugeTxA,
      JSON.stringify({ step_index: 62, source: "MODEL", type: "PLANNER_RESPONSE", model: "claude-sonnet-4-6", input_tokens: 100000, cache_read_tokens: 54000, output_tokens: 1000 }) + "\n",
      "utf8"
    );
    const wrapHugeA = getInjected(
      runGuard({
        stdinObj: { conversationId: hugeChildIdA, transcriptPath: hugeTxA, modelName: "claude-sonnet-4-6", invocationNum: 3 },
        pluginDataDir: hugePluginData,
      })
    );
    assert.match(wrapHugeA.systemMessage, /LEVEL=CHILD_CRITICAL/);

    // 14b: >270KB line 0 (>256KB head cap) + >6MB padding still extracts synthetic step0 marker
    const hugeChildIdB = "14141414-1414-4141-8141-14141414141b";
    const hugeTxB = path.join(tmpRoot, "huge_child_270k.jsonl");
    const step0B = JSON.stringify({
      step_index: 0,
      source: "USER_EXPLICIT",
      type: "USER_INPUT",
      content: `[CONTEXT_AUTOSPLIT_CHILD] ${"b".repeat(270 * 1024)}`,
    });
    const fdB = fs.openSync(hugeTxB, "w");
    fs.writeSync(fdB, step0B + "\n");
    for (let i = 0; i < 52; i++) {
      fs.writeSync(fdB, padChunk + "\n");
    }
    fs.closeSync(fdB);
    assert.ok(fs.statSync(hugeTxB).size > 6 * 1024 * 1024, "Expected > 6MB transcript for 14b");

    fs.appendFileSync(
      hugeTxB,
      JSON.stringify({ step_index: 60, source: "MODEL", type: "PLANNER_RESPONSE", model: "claude-sonnet-4-6", input_tokens: 90000, cache_read_tokens: 44000, output_tokens: 1000 }) + "\n",
      "utf8"
    );
    assert.deepEqual(
      runGuard({
        stdinObj: { conversationId: hugeChildIdB, transcriptPath: hugeTxB, modelName: "claude-sonnet-4-6", invocationNum: 1 },
        pluginDataDir: hugePluginData,
      }),
      {}
    );

    fs.appendFileSync(
      hugeTxB,
      JSON.stringify({ step_index: 61, source: "MODEL", type: "PLANNER_RESPONSE", model: "claude-sonnet-4-6", input_tokens: 100000, cache_read_tokens: 54000, output_tokens: 1000 }) + "\n",
      "utf8"
    );
    const wrapHugeB = getInjected(
      runGuard({
        stdinObj: { conversationId: hugeChildIdB, transcriptPath: hugeTxB, modelName: "claude-sonnet-4-6", invocationNum: 2 },
        pluginDataDir: hugePluginData,
      })
    );
    assert.match(wrapHugeB.systemMessage, /LEVEL=CHILD_CRITICAL/);
  });

  // 15. Strict anchored subagent UUID extraction prevents unrelated/leaked UUIDs from entering children.json
  runTest("15. Subagent UUID extraction rejects unanchored and stale-turn UUIDs, accepts anchored UUIDs", () => {
    const uuidPluginData = path.join(tmpRoot, "plugin_data_uuid");
    fs.mkdirSync(uuidPluginData, { recursive: true });
    const parentId = "15151515-1515-4151-8151-151515151515";
    const txPath = path.join(tmpRoot, "uuid_anchoring.jsonl");

    const unanchored1 = "deadbeef-0001-4001-8001-000000000001";
    const unanchored2 = "deadbeef-0002-4002-8002-000000000002";
    const leakedNextTurn = "deadbeef-0003-4003-8003-000000000003";
    const validKeyChild = "cafe1111-1111-4111-8111-111111111111";
    const validSubagentLineChild = "cafe2222-2222-4222-8222-222222222222";

    writeTranscript(txPath, [
      { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", content: "Spawn workers safely" },
      {
        step_index: 1,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        model: "claude-sonnet-4-6",
        input_tokens: 30000,
        cache_read_tokens: 10000,
        output_tokens: 300,
        tool_calls: [{ name: "invoke_subagent", args: { Role: '"Alpha"', TypeName: '"context-researcher"' } }],
      },
      {
        step_index: 2,
        source: "MODEL",
        type: "GENERIC",
        content: `Unrelated request_id=${unanchored1}\nTrace uuid: ${unanchored2}`,
      },
      {
        step_index: 3,
        source: "MODEL",
        type: "GENERIC",
        content: `{"status":"ok","conversationId":"${validKeyChild}"}`,
      },
      {
        step_index: 4,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        model: "claude-sonnet-4-6",
        input_tokens: 40000,
        cache_read_tokens: 15000,
        output_tokens: 300,
        tool_calls: [{ name: "invoke_subagent", args: { Role: '"FailedCall"', TypeName: '"context-worker"' } }],
      },
      {
        step_index: 5,
        source: "MODEL",
        type: "GENERIC",
        content: "Tool execution failed before creating child",
      },
      {
        step_index: 6,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        model: "claude-sonnet-4-6",
        input_tokens: 50000,
        cache_read_tokens: 20000,
        output_tokens: 300,
      },
      {
        step_index: 7,
        source: "MODEL",
        type: "GENERIC",
        content: `Tool log mentioned conversationId: ${leakedNextTurn} and subagent ${leakedNextTurn}`,
      },
      {
        step_index: 8,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        model: "claude-sonnet-4-6",
        input_tokens: 60000,
        cache_read_tokens: 25000,
        output_tokens: 300,
        tool_calls: [{ name: "invoke_subagent", args: { Role: '"Beta"', TypeName: '"context-worker"' } }],
      },
      {
        step_index: 9,
        source: "MODEL",
        type: "GENERIC",
        content: `Unrelated line with ${unanchored2}\nSpawned subagent ${validSubagentLineChild} ready`,
      },
      {
        step_index: 10,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        model: "claude-sonnet-4-6",
        input_tokens: 80000,
        cache_read_tokens: 54000,
        output_tokens: 1000,
      },
    ]);

    const highMsg = getInjected(
      runGuard({
        stdinObj: { conversationId: parentId, transcriptPath: txPath, modelName: "claude-sonnet-4-6", invocationNum: 1 },
        pluginDataDir: uuidPluginData,
      })
    );
    assert.match(highMsg.systemMessage, /LEVEL=HIGH/);
    assert.ok(highMsg.systemMessage.includes(validKeyChild));
    assert.ok(highMsg.systemMessage.includes(validSubagentLineChild));
    assert.ok(!highMsg.systemMessage.includes(unanchored1));
    assert.ok(!highMsg.systemMessage.includes(unanchored2));
    assert.ok(!highMsg.systemMessage.includes(leakedNextTurn));

    const childrenJson = JSON.parse(fs.readFileSync(path.join(uuidPluginData, "children.json"), "utf8"));
    assert.deepEqual(Object.keys(childrenJson).sort(), [validKeyChild, validSubagentLineChild].sort());
    assert.equal(childrenJson[validKeyChild].role, "Alpha");
    assert.equal(childrenJson[validSubagentLineChild].role, "Beta");
  });

  // 16. autoCalibrateFromCompaction supports upward expansion (512k default -> 850k observed)
  runTest("16. autoCalibrateFromCompaction expands unlisted model from 512k default to 850k observed ceiling", () => {
    const expPluginData = path.join(tmpRoot, "plugin_data_expand");
    fs.mkdirSync(expPluginData, { recursive: true });
    const convId = "16161616-1616-4161-8161-161616161616";
    const txPath = path.join(tmpRoot, "expand.jsonl");

    writeTranscript(txPath, [
      { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", content: "Start unlisted model" },
      { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", model: "new-frontier-model-x", input_tokens: 140000, cache_read_tokens: 69000, output_tokens: 1000 },
    ]);
    const initialWarm = getInjected(
      runGuard({
        stdinObj: { conversationId: convId, transcriptPath: txPath, modelName: "new-frontier-model-x", invocationNum: 1 },
        pluginDataDir: expPluginData,
      })
    );
    assert.match(initialWarm.systemMessage, /LEVEL=WARM/);
    assert.ok(initialWarm.systemMessage.includes("210k / 512k (41%, model=new-frontier-model-x)"));

    writeTranscript(txPath, [
      { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", content: "Reach 850k before compaction" },
      { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", model: "new-frontier-model-x", input_tokens: 550000, cache_read_tokens: 299000, output_tokens: 1000 },
    ]);
    const preCompactCrit = getInjected(
      runGuard({
        stdinObj: { conversationId: convId, transcriptPath: txPath, modelName: "new-frontier-model-x", invocationNum: 2 },
        pluginDataDir: expPluginData,
      })
    );
    assert.match(preCompactCrit.systemMessage, /LEVEL=CRITICAL/);

    writeTranscript(txPath, [
      { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", content: "Compacted to 100k" },
      { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", model: "new-frontier-model-x", input_tokens: 70000, cache_read_tokens: 29500, output_tokens: 500 },
    ]);
    assert.deepEqual(
      runGuard({
        stdinObj: { conversationId: convId, transcriptPath: txPath, modelName: "new-frontier-model-x", invocationNum: 3 },
        pluginDataDir: expPluginData,
      }),
      {}
    );

    const observed = JSON.parse(fs.readFileSync(path.join(expPluginData, "observed_windows.json"), "utf8"));
    assert.equal(observed["new-frontier-model-x"].ceiling, 850000);

    // 300k is 35% of 850k -> silent
    writeTranscript(txPath, [
      { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", content: "Grow to 300k" },
      { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", model: "new-frontier-model-x", input_tokens: 200000, cache_read_tokens: 99000, output_tokens: 1000 },
    ]);
    assert.deepEqual(
      runGuard({
        stdinObj: { conversationId: convId, transcriptPath: txPath, modelName: "new-frontier-model-x", invocationNum: 4 },
        pluginDataDir: expPluginData,
      }),
      {}
    );

    // 360k is 42% of 850k -> WARM
    writeTranscript(txPath, [
      { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", content: "Grow to 360k" },
      { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", model: "new-frontier-model-x", input_tokens: 250000, cache_read_tokens: 109000, output_tokens: 1000 },
    ]);
    const expandedWarm = getInjected(
      runGuard({
        stdinObj: { conversationId: convId, transcriptPath: txPath, modelName: "new-frontier-model-x", invocationNum: 5 },
        pluginDataDir: expPluginData,
      })
    );
    assert.match(expandedWarm.systemMessage, /LEVEL=WARM/);
    assert.ok(expandedWarm.systemMessage.includes("360k / 850k (42%, model=new-frontier-model-x)"));
  });

  // 17. Switching to a strictly larger window resets stale CRITICAL so new WARM/HIGH fire properly
  runTest("17. Switching from 512k CRITICAL to 1M triggers WARM at 42% and HIGH at 66%", () => {
    const swPluginData = path.join(tmpRoot, "plugin_data_switch_large");
    fs.mkdirSync(swPluginData, { recursive: true });
    const convId = "17171717-1717-4171-8171-171717171717";
    const txPath = path.join(tmpRoot, "switch_large.jsonl");

    writeTranscript(txPath, [
      { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", content: "High usage on Neon 512k" },
      { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", model: "gemini-4-neon-high", input_tokens: 300000, cache_read_tokens: 139000, output_tokens: 1000 },
    ]);
    const neonCrit = getInjected(
      runGuard({
        stdinObj: { conversationId: convId, transcriptPath: txPath, modelName: "gemini-4-neon-high", invocationNum: 1 },
        pluginDataDir: swPluginData,
      })
    );
    assert.match(neonCrit.systemMessage, /LEVEL=CRITICAL/);
    assert.ok(neonCrit.systemMessage.includes("440k / 512k (86%, model=gemini-4-neon-high)"));

    // Switch to Argon 1M at 440k (42%) -> must reset old CRITICAL and fire WARM immediately
    const argonWarm = getInjected(
      runGuard({
        stdinObj: { conversationId: convId, transcriptPath: txPath, modelName: "gemini-4-argon-medium", invocationNum: 2 },
        pluginDataDir: swPluginData,
      })
    );
    assert.match(argonWarm.systemMessage, /LEVEL=WARM/);
    assert.ok(argonWarm.systemMessage.includes("440k / 1M (42%, model=gemini-4-argon-medium)"));

    // Grow to 690k (66%) -> must fire HIGH
    writeTranscript(txPath, [
      { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", content: "Grow on Argon 1M" },
      { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", model: "gemini-4-argon-medium", input_tokens: 450000, cache_read_tokens: 239000, output_tokens: 1000 },
    ]);
    const argonHigh = getInjected(
      runGuard({
        stdinObj: { conversationId: convId, transcriptPath: txPath, modelName: "gemini-4-argon-medium", invocationNum: 3 },
        pluginDataDir: swPluginData,
      })
    );
    assert.match(argonHigh.systemMessage, /LEVEL=HIGH/);
    assert.ok(argonHigh.systemMessage.includes("690k / 1M (66%, model=gemini-4-argon-medium)"));
  });

  console.log(`\nSummary: ${passed}/17 tests passed.`);
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}
