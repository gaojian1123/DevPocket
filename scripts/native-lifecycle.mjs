const byteBudget = 16384;
const phases = ["supervisor-starting", "spawn-starting", "native-started", "spawn-failed", "native-exited",
  "stop-requested", "cleanup-starting", "cleanup-native-exited", "cleanup-complete", "cleanup-failed", "supervisor-failed"];
const reasons = ["stdin-cancel", "stdin-eof", "stdin-error", "owner-exited", "timeout", "supervisor-signal", "input-limit"];
const stages = ["initialize", "spawn", "monitor", "cleanup", "diagnostic-channel"];
const classes = ["os-error", "invalid-request", "supervisor-error"];
const integer = (value, low, high) => Number.isInteger(value) && value >= low && value <= high ? value : "unknown";

export function projectNativeLifecycle(value) {
  const available = Array.isArray(value?.events);
  let invalid = !!value?.invalid;
  const events = [], seen = new Set();
  let sequence = 0;
  for (const input of available ? value.events.slice(0, 12) : []) {
    if (!phases.includes(input?.phase) || seen.has(input.phase) ||
        !Number.isInteger(input.sequence) || input.sequence <= sequence || input.sequence > 12) {
      invalid = true;
      continue;
    }
    seen.add(input.phase);
    sequence = input.sequence;
    const event = { sequence, phase: input.phase };
    if (["native-exited", "cleanup-native-exited"].includes(input.phase)) {
      event.returnCode = integer(input.returnCode, -128, 255);
      event.signalNumber = integer(input.signalNumber, 0, 128);
      if (event.returnCode === "unknown" || event.signalNumber !== (event.returnCode < 0 ? -event.returnCode : 0)) {
        event.returnCode = "unknown";
        event.signalNumber = "unknown";
        invalid = true;
      }
    }
    if (["stop-requested", "cleanup-starting"].includes(input.phase)) {
      event.nativeAlive = typeof input.nativeAlive === "boolean" ? input.nativeAlive : "unknown";
      invalid ||= event.nativeAlive === "unknown";
    }
    if (input.phase === "stop-requested") {
      event.reason = reasons.includes(input.reason) ? input.reason : "unknown";
      invalid ||= event.reason === "unknown";
      if (input.requestedSignal !== undefined) event.requestedSignal = integer(input.requestedSignal, 1, 128);
    }
    if (["spawn-failed", "supervisor-failed", "cleanup-failed"].includes(input.phase)) {
      event.errno = input.errno === null ? "unknown" : integer(input.errno, 1, 4095);
    }
    if (["supervisor-failed", "cleanup-failed"].includes(input.phase)) {
      event.stage = stages.includes(input.stage) ? input.stage : "unknown";
      event.failureClass = classes.includes(input.failureClass) ? input.failureClass : "unknown";
      invalid ||= event.stage === "unknown" || event.failureClass === "unknown";
      if (input.nativeAlive !== undefined) event.nativeAlive = typeof input.nativeAlive === "boolean" ? input.nativeAlive : "unknown";
    }
    events.push(event);
  }
  const truncated = !!value?.truncated || (available && value.events.length > 12);
  const terminal = events.some((event) => ["cleanup-complete", "cleanup-failed", "supervisor-failed"].includes(event.phase));
  const natural = events.find((event) => event.phase === "native-exited");
  const cleanup = events.find((event) => event.phase === "cleanup-native-exited");
  const cleanupStarted = events.find((event) => event.phase === "cleanup-starting");
  const nativeStarted = events.find((event) => event.phase === "native-started");
  if (natural && cleanup) invalid = true;
  if (events.length && (events[0].phase !== "supervisor-starting" || events[0].sequence !== 1)) invalid = true;
  if (seen.has("native-started") && (!seen.has("spawn-starting") || seen.has("spawn-failed"))) invalid = true;
  if ((natural || cleanup) && !seen.has("native-started")) invalid = true;
  if (cleanup && !seen.has("cleanup-starting")) invalid = true;
  const conflicting = !!natural && !!cleanup ||
    !!natural && !!cleanupStarted && natural.sequence > cleanupStarted.sequence ||
    !!cleanup && !!cleanupStarted && cleanup.sequence < cleanupStarted.sequence ||
    !!nativeStarted && [natural, cleanup].some((event) => event && event.sequence < nativeStarted.sequence);
  invalid ||= conflicting;
  const exited = conflicting ? undefined : natural ?? cleanup;
  return {
    version: 1, observedProcess: "launched-command", transport: "dedicated-supervisor-pipe",
    availability: !available ? "unavailable"
      : terminal && !invalid && !truncated && value.availability === "complete" ? "complete" : "incomplete",
    started: seen.has("native-started") ? true : seen.has("spawn-failed") ||
      events.some((event) => event.phase === "supervisor-failed" && event.stage === "initialize") ? false : "unknown",
    returnCode: exited?.returnCode ?? "unknown",
    signalNumber: exited?.signalNumber ?? "unknown",
    exitContext: conflicting ? "unknown" : natural ? "before-cleanup" : cleanup ? "during-cleanup" : "unknown",
    truncated, events,
  };
}

export function createNativeLifecycleCapture() {
  const events = [];
  let pending = Buffer.alloc(0), seen = 0, invalid = false, truncated = false, ended = false;
  return {
    data: (value) => {
      const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
      seen += bytes.length;
      if (seen > byteBudget) { truncated = true; return; }
      pending = Buffer.concat([pending, bytes]);
      for (let index = pending.indexOf(10); index >= 0; index = pending.indexOf(10)) {
        const line = pending.subarray(0, index).toString("utf8");
        pending = pending.subarray(index + 1);
        if (events.length >= 12) { truncated = true; continue; }
        try {
          const event = JSON.parse(line);
          if (event.version !== 1) invalid = true;
          else events.push(event);
        } catch { invalid = true; }
      }
    },
    end: () => { ended = true; if (pending.length) invalid = true; },
    fail: () => { invalid = true; },
    snapshot: () => projectNativeLifecycle({
      events, truncated, invalid, availability: ended && !invalid && !truncated ? "complete" : "incomplete",
    }),
  };
}
