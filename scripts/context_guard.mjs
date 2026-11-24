import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(__dirname, "..");
const CONFIG_PATH = process.env.CONTEXT_AUTOSPLIT_CONFIG_PATH || path.join(PLUGIN_ROOT, "config.json");

const MAX_FULL_READ_BYTES = 6 * 1024 * 1024;
const HEAD_READ_BYTES = 16 * 1024;
const MAX_HEAD_READ_BYTES = 256 * 1024;
const TAIL_READ_BYTES = 4 * 1024 * 1024;
const CHILD_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const CHILD_KEY_UUID_RE =
  /"?(?:conversationId|conversation_id|subagentId|subagent_id)"?\s*[:=]\s*"?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"?/gi;

const TIER_RANK = {
  normal: 0,
  burst: 1,
  warm: 2,
  high: 3,
  critical: 4,
};

const DEFAULT_CONFIG = {
  enabled: true,
  mode: "hybrid",
  thresholdMode: "percent",
  defaultWindowTokens: 512000,
  autoCalibrateFromCompaction: true,
  modelWindows: {
    "gemini-4-neon": 512000,
    "gemini-4-hydrogen": 512000,
    "gemini-4-carbon": 512000,
    "gemini-4-argon": 1048576,
    gemini: 1000000,
    "claude-opus-5-5": 1000000,
    "claude-sonnet-5-5": 1000000,
    "claude-opus-4-6-1m": 1000000,
    "claude-sonnet-4-6-1m": 1000000,
    "claude-1m": 1000000,
    claude: 200000,
    gemma: 64000,
    litert: 64000,
    "gpt-4.1": 1000000,
    "gpt-5": 400000,
    o3: 200000,
    o4: 200000,
    "gpt-4o": 128000,
    "gpt-oss": 128000,
  },
  thresholdPercents: {
    burstMin: 20,
    warm: 40,
    high: 65,
    critical: 85,
    reAlertDelta: 15,
  },
  windowTokens: 200000,
  thresholds: {
    warm: 80000,
    high: 130000,
    critical: 170000,
  },
  reAlertDeltaTokens: 35000,
  burstMinTokens: 45000,
  heavyToolBurstBytes: 24000,
  compactDropRatio: 0.65,
  maxChildDepth: 1,
  childCriticalTokens: 150000,
  maxParallelSubagents: 3,
  models: {
    heavy: "inherit",
    lightweight: "flash",
  },
};

const GENERIC_MODEL_KEYS = new Set(["gemini", "claude", ""]);

function writeOut(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function posNum(val, fallback) {
  return typeof val === "number" && Number.isFinite(val) && val > 0 ? val : fallback;
}

function loadConfig() {
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    raw = {};
  }
  const t = raw && typeof raw.thresholds === "object" && raw.thresholds ? raw.thresholds : {};
  const tp =
    raw && typeof raw.thresholdPercents === "object" && raw.thresholdPercents ? raw.thresholdPercents : {};
  const mw =
    raw && typeof raw.modelWindows === "object" && !Array.isArray(raw.modelWindows) && raw.modelWindows
      ? raw.modelWindows
      : null;
  const m = raw && typeof raw.models === "object" && raw.models ? raw.models : {};
  const mode = ["hybrid", "orchestrator", "threshold-only"].includes(raw?.mode)
    ? raw.mode
    : DEFAULT_CONFIG.mode;
  const thresholdMode = ["percent", "tokens"].includes(raw?.thresholdMode)
    ? raw.thresholdMode
    : DEFAULT_CONFIG.thresholdMode;
  const defaultWindowTokens = posNum(raw?.defaultWindowTokens, DEFAULT_CONFIG.defaultWindowTokens);

  const modelWindows = { ...DEFAULT_CONFIG.modelWindows };
  if (mw) {
    for (const [key, val] of Object.entries(mw)) {
      if (typeof key === "string" && key.trim() && typeof val === "number" && Number.isFinite(val) && val > 0) {
        modelWindows[key.trim()] = val;
      }
    }
  }

  return {
    enabled: raw?.enabled !== false,
    mode,
    thresholdMode,
    defaultWindowTokens,
    autoCalibrateFromCompaction: raw?.autoCalibrateFromCompaction !== false,
    modelWindows,
    thresholdPercents: {
      burstMin: posNum(tp.burstMin, DEFAULT_CONFIG.thresholdPercents.burstMin),
      warm: posNum(tp.warm, DEFAULT_CONFIG.thresholdPercents.warm),
      high: posNum(tp.high, DEFAULT_CONFIG.thresholdPercents.high),
      critical: posNum(tp.critical, DEFAULT_CONFIG.thresholdPercents.critical),
      reAlertDelta: posNum(tp.reAlertDelta, DEFAULT_CONFIG.thresholdPercents.reAlertDelta),
    },
    windowTokens: posNum(raw?.windowTokens, defaultWindowTokens),
    thresholds: {
      warm: posNum(t.warm, DEFAULT_CONFIG.thresholds.warm),
      high: posNum(t.high, DEFAULT_CONFIG.thresholds.high),
      critical: posNum(t.critical, DEFAULT_CONFIG.thresholds.critical),
    },
    reAlertDeltaTokens: posNum(raw?.reAlertDeltaTokens, DEFAULT_CONFIG.reAlertDeltaTokens),
    burstMinTokens: posNum(raw?.burstMinTokens, DEFAULT_CONFIG.burstMinTokens),
    heavyToolBurstBytes: posNum(raw?.heavyToolBurstBytes, DEFAULT_CONFIG.heavyToolBurstBytes),
    compactDropRatio:
      typeof raw?.compactDropRatio === "number" && raw.compactDropRatio > 0 && raw.compactDropRatio < 1
        ? raw.compactDropRatio
        : DEFAULT_CONFIG.compactDropRatio,
    maxChildDepth: posNum(raw?.maxChildDepth, DEFAULT_CONFIG.maxChildDepth),
    childCriticalTokens: posNum(raw?.childCriticalTokens, DEFAULT_CONFIG.childCriticalTokens),
    maxParallelSubagents: posNum(raw?.maxParallelSubagents, DEFAULT_CONFIG.maxParallelSubagents),
    models: {
      heavy: typeof m.heavy === "string" && m.heavy ? m.heavy : DEFAULT_CONFIG.models.heavy,
      lightweight:
        typeof m.lightweight === "string" && m.lightweight ? m.lightweight : DEFAULT_CONFIG.models.lightweight,
    },
  };
}

async function readStdinJson() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return null;
  return JSON.parse(text);
}

function getStateDir() {
  const dir = process.env.PLUGIN_DATA || path.join(os.tmpdir(), "antigravity-context-autosplit");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function loadJsonSafe(filePath, fallback) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function saveJsonSafe(filePath, data) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
  } catch {
    // ignore persistence failures so hook never breaks invocation
  }
}

function pruneChildrenMap(map, now) {
  const cleaned = {};
  for (const [id, entry] of Object.entries(map || {})) {
    if (entry && typeof entry === "object" && typeof entry.updatedAt === "number") {
      if (now - entry.updatedAt <= CHILD_TTL_MS) {
        cleaned[id] = entry;
      }
    }
  }
  return cleaned;
}

function parseJsonLine(line) {
  if (!line) return null;
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function unquoteArg(val) {
  if (val == null) return "";
  if (typeof val !== "string") return String(val);
  const trimmed = val.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === "string") return parsed;
    } catch {
      // ignore and return trimmed
    }
  }
  return trimmed;
}

function readFirstLine(fd, fileSize) {
  const limit = Math.min(fileSize, MAX_HEAD_READ_BYTES);
  const chunks = [];
  let offset = 0;

  while (offset < limit) {
    const len = Math.min(HEAD_READ_BYTES, limit - offset);
    const buf = Buffer.allocUnsafe(len);
    const bytesRead = fs.readSync(fd, buf, 0, len, offset);
    if (bytesRead <= 0) break;
    const slice = bytesRead < len ? buf.subarray(0, bytesRead) : buf;
    const nlIdx = slice.indexOf(0x0a);
    if (nlIdx >= 0) {
      chunks.push(slice.subarray(0, nlIdx));
      break;
    }
    chunks.push(slice);
    offset += bytesRead;
  }

  const headStr = Buffer.concat(chunks).toString("utf8");
  const parsed = parseJsonLine(headStr);
  if (parsed) return parsed;
  if (!headStr.trim()) return null;

  const typeMatch = headStr.match(/(?<!\\)"type"\s*:\s*"([^"\\]+)"/);
  const sourceMatch = headStr.match(/(?<!\\)"source"\s*:\s*"([^"\\]+)"/);
  const hasMarker = headStr.includes("[CONTEXT_AUTOSPLIT_CHILD]");
  if (!typeMatch && !sourceMatch && !hasMarker) {
    return null;
  }
  return {
    type: typeMatch ? typeMatch[1] : undefined,
    source: sourceMatch ? sourceMatch[1] : undefined,
    content: hasMarker ? "[CONTEXT_AUTOSPLIT_CHILD]" : "",
  };
}

function readTranscriptSlices(transcriptPath) {
  let stat;
  try {
    stat = fs.statSync(transcriptPath);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.size === 0) {
    return { step0: null, steps: [] };
  }

  if (stat.size <= MAX_FULL_READ_BYTES) {
    const content = fs.readFileSync(transcriptPath, "utf8");
    const steps = [];
    for (const line of content.split(/\r?\n/)) {
      const obj = parseJsonLine(line);
      if (obj) steps.push(obj);
    }
    return { step0: steps[0] || null, steps };
  }

  let fd;
  try {
    fd = fs.openSync(transcriptPath, "r");
    const step0 = readFirstLine(fd, stat.size);

    const tailLen = Math.min(TAIL_READ_BYTES, stat.size);
    const tailOffset = stat.size - tailLen;
    const tailBuf = Buffer.allocUnsafe(tailLen);
    fs.readSync(fd, tailBuf, 0, tailLen, tailOffset);
    let tailStr = tailBuf.toString("utf8");
    if (tailOffset > 0) {
      const firstNl = tailStr.indexOf("\n");
      tailStr = firstNl >= 0 ? tailStr.slice(firstNl + 1) : "";
    }
    const steps = [];
    for (const line of tailStr.split(/\r?\n/)) {
      const obj = parseJsonLine(line);
      if (obj) steps.push(obj);
    }
    return { step0, steps };
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}

function inspectTranscript(transcriptPath, conversationId) {
  const parsed = readTranscriptSlices(transcriptPath);
  if (!parsed) return null;

  const { step0, steps } = parsed;
  let currentTokens = 0;
  let lastUserStepIdx = -1;
  let turnToolBytes = 0;
  let lastModel = "";
  const pendingSubagentCalls = [];
  const discoveredChildren = [];
  const seenChildIds = new Set();
  const selfLower = String(conversationId || "").toLowerCase();

  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const stepIdx = typeof s.step_index === "number" ? s.step_index : i;

    if (s.type === "USER_INPUT") {
      lastUserStepIdx = stepIdx;
      turnToolBytes = 0;
      continue;
    }

    if (s.type === "GENERIC") {
      if (typeof s.content === "string" && s.content.length > 0) {
        turnToolBytes += Buffer.byteLength(s.content, "utf8");

        while (pendingSubagentCalls.length > 0 && stepIdx - pendingSubagentCalls[0].callStepIdx > 4) {
          pendingSubagentCalls.shift();
        }
        if (pendingSubagentCalls.length > 0) {
          const uniqueInStep = [];
          const pushCandidate = (rawId) => {
            const norm = rawId.toLowerCase();
            if (norm !== selfLower && !uniqueInStep.includes(norm)) {
              uniqueInStep.push(norm);
            }
          };
          for (const m of s.content.matchAll(CHILD_KEY_UUID_RE)) {
            if (m[1]) pushCandidate(m[1]);
          }
          if (uniqueInStep.length === 0) {
            for (const line of s.content.split(/\r?\n/)) {
              if (/subagent/i.test(line)) {
                for (const rawId of line.match(UUID_RE) || []) {
                  pushCandidate(rawId);
                }
              }
            }
          }
          for (const childNorm of uniqueInStep) {
            if (pendingSubagentCalls.length === 0) break;
            if (seenChildIds.has(childNorm)) continue;
            const call = pendingSubagentCalls.shift();
            seenChildIds.add(childNorm);
            discoveredChildren.push({
              id: childNorm,
              role: call.role || "subagent",
              typeName: call.typeName || "self",
            });
          }
        }
      }
      continue;
    }

    if (s.type === "PLANNER_RESPONSE") {
      pendingSubagentCalls.length = 0;
      if (typeof s.model === "string" && s.model.trim()) {
        lastModel = s.model.trim();
      }
      if (typeof s.input_tokens === "number" || typeof s.cache_read_tokens === "number") {
        currentTokens =
          (Number(s.input_tokens) || 0) +
          (Number(s.cache_read_tokens) || 0) +
          (Number(s.output_tokens) || 0);
      }
      if (Array.isArray(s.tool_calls)) {
        for (const tc of s.tool_calls) {
          if (tc && tc.name === "invoke_subagent") {
            const args = tc.args && typeof tc.args === "object" ? tc.args : {};
            pendingSubagentCalls.push({
              callStepIdx: stepIdx,
              role: unquoteArg(args.Role ?? args.role ?? ""),
              typeName: unquoteArg(args.TypeName ?? args.typeName ?? ""),
            });
          }
        }
      }
    }
  }

  return {
    step0,
    currentTokens,
    lastUserStepIdx,
    turnToolBytes,
    discoveredChildren,
    lastModel,
  };
}

function resolveActiveModel(input, stats) {
  const fromInput = typeof input?.modelName === "string" ? input.modelName.trim() : "";
  if (fromInput && fromInput.toLowerCase() !== "auto") {
    return fromInput;
  }
  return stats?.lastModel || "";
}

function computeMedian(nums) {
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[mid];
  }
  return Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function resolveModelWindow(activeModel, config, observedWindows) {
  if (!activeModel) {
    return config.defaultWindowTokens;
  }
  const lower = activeModel.toLowerCase();
  const entries = Object.entries(config.modelWindows || {})
    .filter(([key, val]) => typeof key === "string" && key.trim() && typeof val === "number" && Number.isFinite(val) && val > 0)
    .sort((a, b) => b[0].trim().length - a[0].trim().length);

  let windowTokens = config.defaultWindowTokens;
  let matchedKey = "";
  for (const [key, win] of entries) {
    const normKey = key.trim().toLowerCase();
    if (lower.includes(normKey)) {
      windowTokens = win;
      matchedKey = normKey;
      break;
    }
  }

  if (
    config.autoCalibrateFromCompaction &&
    GENERIC_MODEL_KEYS.has(matchedKey) &&
    observedWindows &&
    typeof observedWindows === "object"
  ) {
    const entry = observedWindows[lower];
    const ceiling = entry && typeof entry === "object" ? Number(entry.ceiling) : Number(entry);
    if (Number.isFinite(ceiling) && ceiling >= 32000) {
      return ceiling;
    }
  }

  return windowTokens;
}

function resolveThresholds(activeModel, config, observedWindows) {
  if (config.thresholdMode === "tokens") {
    const activeWindow = config.windowTokens || config.defaultWindowTokens;
    return {
      activeWindow,
      burstMin: config.burstMinTokens,
      warm: config.thresholds.warm,
      high: config.thresholds.high,
      critical: config.thresholds.critical,
      reAlertDelta: config.reAlertDeltaTokens,
    };
  }
  const activeWindow = resolveModelWindow(activeModel, config, observedWindows);
  const tp = config.thresholdPercents;
  return {
    activeWindow,
    burstMin: Math.round(activeWindow * (tp.burstMin / 100)),
    warm: Math.round(activeWindow * (tp.warm / 100)),
    high: Math.round(activeWindow * (tp.high / 100)),
    critical: Math.round(activeWindow * (tp.critical / 100)),
    reAlertDelta: Math.round(activeWindow * (tp.reAlertDelta / 100)),
  };
}

function fmtTokens(n) {
  if (n >= 1000000) {
    return (n / 1000000).toFixed(1).replace(/\.0$/, "") + "M";
  }
  if (n >= 1000) {
    return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
  }
  return String(n);
}

function collectActiveChildren(childrenMap, conversationId) {
  if (!conversationId) return [];
  const list = [];
  for (const [id, entry] of Object.entries(childrenMap)) {
    if (entry && entry.parentId === conversationId) {
      list.push({
        id,
        role: entry.role || "subagent",
        typeName: entry.typeName || "self",
        updatedAt: entry.updatedAt || 0,
      });
    }
  }
  list.sort((a, b) => a.updatedAt - b.updatedAt);
  return list.slice(-5);
}

function buildInjectStep(systemMessage) {
  return {
    injectSteps: [{ systemMessage: { systemMessage } }],
    terminationBehavior: "",
  };
}

function buildDirectiveMessage(level, statsText, config, activeChildren) {
  const { models, maxParallelSubagents } = config;
  const routing =
    `Routing: read-only research/search/logs -> TypeName="context-researcher", Model="${models.lightweight}"; ` +
    `edits/debugging/builds -> TypeName="context-worker", Model="${models.heavy}"; ` +
    `parent MCP/skill tasks -> TypeName="self", Model="${models.heavy}". ` +
    `Cap parallel spawns at <= ${maxParallelSubagents} subagents per wave (batch small related lookups), reuse existing same-repo subagents via send_message before spawning fresh ones, ` +
    `prefix child Prompt with "[CONTEXT_AUTOSPLIT_CHILD]", pass exact file paths/line ranges when known, and require <= 250 word structured summary (write bulky outputs to a file and return path).`;

  let body = "";

  if (level === "ORCHESTRATOR") {
    body =
      `[context-autosplit | LEVEL=ORCHESTRATOR] Context usage: ${statsText}. ` +
      `Orchestrator mode is active: keep the main conversation thin from turn 1. Delegate all non-trivial file reading, searches, code edits, and build/test run_command loops to nested child conversations via invoke_subagent / send_message. ${routing}`;
  } else if (level === "BURST") {
    body =
      `[context-autosplit | LEVEL=BURST] Context usage: ${statsText} with heavy single-turn tool output. ` +
      `Offload further multi-file reading, verbose run_command outputs, or independent subtasks into nested child conversations via invoke_subagent / send_message instead of accumulating raw outputs here. ${routing}`;
  } else if (level === "WARM") {
    body =
      `[context-autosplit | LEVEL=WARM] Context usage reached ${statsText}. ` +
      `Proactively offload all non-trivial exploration, multi-file edits, and verbose build/test run_command loops to nested child conversations via invoke_subagent / send_message; keep only orchestration and concise summaries in main. ${routing}`;
  } else if (level === "HIGH") {
    body =
      `[context-autosplit | LEVEL=HIGH] Context usage is high (${statsText}). ` +
      `Switch to STRICT ORCHESTRATOR-ONLY MODE immediately: do NOT directly read multiple files or run verbose build/test/verification run_command loops in this main conversation. Spawn or reuse same-repo child conversations via invoke_subagent / send_message for all execution. ${routing}`;
  } else if (level === "CRITICAL") {
    body =
      `[context-autosplit | LEVEL=CRITICAL] Context usage is near limit (${statsText}). ` +
      `STRICT ORCHESTRATOR-ONLY MODE: delegate every non-trivial read, edit, or build/test run_command verification loop to child conversations via invoke_subagent / send_message, and explicitly remind the user at the end of this turn to run /compact to compress main context. ${routing}`;
  }

  if (activeChildren.length > 0) {
    const childLines = activeChildren.map((c) => `- ${c.id} (role: ${c.role}, type: ${c.typeName})`);
    body +=
      `\nActive child conversations in this session (reuse via send_message for same-repo or related follow-ups instead of spawning duplicates):\n` +
      childLines.join("\n");
  }

  return buildInjectStep(body);
}

async function main() {
  const config = loadConfig();
  if (!config.enabled) {
    writeOut({});
    return;
  }

  const input = await readStdinJson();
  if (!input || typeof input !== "object") {
    writeOut({});
    return;
  }

  const conversationId = typeof input.conversationId === "string" ? input.conversationId : "";
  const transcriptPath = typeof input.transcriptPath === "string" ? input.transcriptPath : "";
  if (!transcriptPath) {
    writeOut({});
    return;
  }

  const stats = inspectTranscript(transcriptPath, conversationId);
  if (!stats) {
    writeOut({});
    return;
  }

  const activeModel = resolveActiveModel(input, stats);

  const now = Date.now();
  const stateDir = getStateDir();
  const childrenPath = path.join(stateDir, "children.json");
  const observedWindowsPath = path.join(stateDir, "observed_windows.json");
  const safeId = (conversationId || "unknown").replace(/[^a-zA-Z0-9_-]/g, "_");
  const convStatePath = path.join(stateDir, `conv_${safeId}.json`);

  let childrenMap = pruneChildrenMap(loadJsonSafe(childrenPath, {}), now);
  const rawObserved = loadJsonSafe(observedWindowsPath, {});
  const observedWindows = rawObserved && !Array.isArray(rawObserved) ? rawObserved : {};
  const convState = Object.assign(
    {
      lastTier: "normal",
      lastAlertTokens: 0,
      peakTokens: 0,
      lastBurstUserStepIdx: -1,
      lastWindowTokens: 0,
      orchestratorReminded: false,
      updatedAt: 0,
    },
    loadJsonSafe(convStatePath, {})
  );

  let effectiveThresholds = resolveThresholds(activeModel, config, observedWindows);
  let activeWindow = effectiveThresholds.activeWindow;

  const childEntry = conversationId ? childrenMap[conversationId] : null;
  const myDepth = childEntry ? Number(childEntry.depth) || 1 : 0;
  const step0 = stats.step0;
  const step0Content = typeof step0?.content === "string" ? step0.content : "";
  const isMarkedChild = step0Content.includes("[CONTEXT_AUTOSPLIT_CHILD]");
  const isNonUserRoot = Boolean(
    step0 && step0.type === "USER_INPUT" && step0.source && step0.source !== "USER_EXPLICIT"
  );
  const isChild = myDepth >= 1 || isMarkedChild || isNonUserRoot;
  const effectiveDepth = Math.max(myDepth, isChild ? 1 : 0);

  if (isChild && effectiveDepth >= config.maxChildDepth) {
    const effectiveChildCritical = Math.min(config.childCriticalTokens, Math.round(activeWindow * 0.75));
    if (stats.currentTokens >= effectiveChildCritical && convState.lastTier !== "child_critical") {
      convState.lastTier = "child_critical";
      convState.lastAlertTokens = stats.currentTokens;
      convState.peakTokens = Math.max(Number(convState.peakTokens) || 0, stats.currentTokens);
      convState.lastWindowTokens = activeWindow;
      convState.updatedAt = now;
      saveJsonSafe(convStatePath, convState);

      const childMsg =
        `[context-autosplit | LEVEL=CHILD_CRITICAL] This child conversation reached ${fmtTokens(stats.currentTokens)} tokens. ` +
        `Wrap up immediately: stop further broad exploration, save detailed findings/logs to a scratch file if needed, and return your concise structured summary (<= 250 words) to the parent conversation. Do NOT spawn nested subagents.`;
      writeOut(buildInjectStep(childMsg));
      return;
    }
    if (stats.currentTokens > (Number(convState.peakTokens) || 0)) {
      convState.peakTokens = stats.currentTokens;
      convState.lastWindowTokens = activeWindow;
      convState.updatedAt = now;
      saveJsonSafe(convStatePath, convState);
    }
    writeOut({});
    return;
  }

  // Register newly discovered child conversations for this parent session
  if (!isChild && conversationId && stats.discoveredChildren.length > 0) {
    let changed = false;
    for (const child of stats.discoveredChildren) {
      const prev = childrenMap[child.id];
      childrenMap[child.id] = {
        parentId: conversationId,
        role: child.role || prev?.role || "subagent",
        typeName: child.typeName || prev?.typeName || "self",
        depth: effectiveDepth + 1,
        updatedAt: now,
      };
      changed = true;
    }
    if (changed) {
      saveJsonSafe(childrenPath, childrenMap);
    }
  }

  // Compaction detection & reset
  const prevPeak = Number(convState.peakTokens) || 0;
  if (
    prevPeak > 0 &&
    stats.currentTokens > 0 &&
    stats.currentTokens < prevPeak * config.compactDropRatio
  ) {
    convState.lastTier = "normal";
    convState.lastAlertTokens = 0;
    convState.peakTokens = stats.currentTokens;
    convState.lastBurstUserStepIdx = -1;

    if (prevPeak >= 32000 && activeModel) {
      const modelKey = activeModel.toLowerCase();
      const prevEntry = observedWindows[modelKey];
      const prevSamples = Array.isArray(prevEntry?.samples)
        ? prevEntry.samples.filter((n) => typeof n === "number" && Number.isFinite(n) && n > 0)
        : [];
      const nextSamples = [...prevSamples, prevPeak].slice(-5);
      observedWindows[modelKey] = {
        samples: nextSamples,
        ceiling: computeMedian(nextSamples),
        updatedAt: now,
      };
      saveJsonSafe(observedWindowsPath, observedWindows);

      effectiveThresholds = resolveThresholds(activeModel, config, observedWindows);
      activeWindow = effectiveThresholds.activeWindow;
    }
  } else {
    convState.peakTokens = Math.max(prevPeak, stats.currentTokens);
  }

  // Model window switch reset (reset stale tier when moving to a strictly larger window)
  const prevWindow = Number(convState.lastWindowTokens) || 0;
  if (prevWindow > 0 && activeWindow > prevWindow) {
    convState.lastTier = "normal";
    convState.lastAlertTokens = 0;
    convState.lastBurstUserStepIdx = -1;
  }
  convState.lastWindowTokens = activeWindow;

  const pct = Math.round((stats.currentTokens / activeWindow) * 100);
  const statsText = `${fmtTokens(stats.currentTokens)} / ${fmtTokens(activeWindow)} (${pct}%${activeModel ? `, model=${activeModel}` : ""})`;
  const activeChildren = collectActiveChildren(childrenMap, conversationId);

  // Orchestrator startup reminder (once per conversation below warm threshold)
  if (
    config.mode === "orchestrator" &&
    !convState.orchestratorReminded &&
    stats.currentTokens < effectiveThresholds.warm
  ) {
    convState.orchestratorReminded = true;
    convState.updatedAt = now;
    saveJsonSafe(convStatePath, convState);
    writeOut(buildDirectiveMessage("ORCHESTRATOR", statsText, config, activeChildren));
    return;
  }

  // Tier evaluation
  let tier = "normal";
  if (stats.currentTokens >= effectiveThresholds.critical) {
    tier = "critical";
  } else if (stats.currentTokens >= effectiveThresholds.high) {
    tier = "high";
  } else if (stats.currentTokens >= effectiveThresholds.warm) {
    tier = "warm";
  } else if (
    config.mode === "hybrid" &&
    stats.currentTokens >= effectiveThresholds.burstMin &&
    stats.turnToolBytes >= config.heavyToolBurstBytes
  ) {
    tier = "burst";
  }

  const rank = TIER_RANK[tier];
  const prevRank = TIER_RANK[convState.lastTier] ?? 0;
  const deltaSinceAlert = stats.currentTokens - (Number(convState.lastAlertTokens) || 0);

  const shouldTrigger =
    (tier === "burst" && prevRank === 0 && convState.lastBurstUserStepIdx !== stats.lastUserStepIdx) ||
    rank > prevRank ||
    (rank === prevRank && rank >= 3 && deltaSinceAlert >= effectiveThresholds.reAlertDelta);

  if (!shouldTrigger) {
    convState.updatedAt = now;
    saveJsonSafe(convStatePath, convState);
    writeOut({});
    return;
  }

  convState.lastTier = tier;
  convState.lastAlertTokens = stats.currentTokens;
  if (tier === "burst") {
    convState.lastBurstUserStepIdx = stats.lastUserStepIdx;
  }
  convState.updatedAt = now;
  saveJsonSafe(convStatePath, convState);

  writeOut(buildDirectiveMessage(tier.toUpperCase(), statsText, config, activeChildren));
}

main().catch(() => {
  writeOut({});
});
