import { setTimeout as delay } from "node:timers/promises";
import { diagnosticError } from "./diagnostic-errors.mjs";

const componentPattern = "[A-Za-z_][\\w.]*\\/(?:\\.)?[A-Za-z_$][\\w.$]*";
function component(value) {
  if (typeof value !== "string" || !new RegExp(`^${componentPattern}$`).test(value)) return undefined;
  const [name, activity] = value.split("/");
  return `${name}/${activity.startsWith(".") ? name + activity : activity}`;
}
const bounded = (value) => typeof value === "string" && Buffer.byteLength(value) <= 512 * 1024;

export function androidHomeState({ resolved, activities, windows, anrs }) {
  if (![resolved, activities, windows, anrs].every(bounded)) return { status: "pending", reason: "unavailable" };
  const candidates = resolved.trim().split(/\r?\n/).map((line) => component(line.trim())).filter(Boolean);
  if (candidates.length !== 1) return { status: "pending", reason: "home-unresolved" };
  const home = candidates[0], packageName = home.split("/")[0];
  const display = windows.split(/(?=^\s*Display: mDisplayId=\d+)/m)
    .find((part) => /^\s*Display: mDisplayId=0\b/m.test(part));
  const focusLine = display?.match(/^\s*mCurrentFocus=(.+)$/m)?.[1];
  if (/Application Not Responding/.test(focusLine ?? "") ||
      anrs.split(/\r?\n/).some((line) => /am_anr\s*:/.test(line) && line.includes(`,${packageName},`))) {
    return { status: "blocked", reason: "launcher-anr" };
  }
  const focus = component(focusLine?.match(new RegExp(`\\bu0 (${componentPattern})\\}`))?.[1]);
  const top = component(activities.match(new RegExp(`^\\s*topResumedActivity=ActivityRecord\\{[^\\n]*\\bu0 (${componentPattern}) `, "m"))?.[1]);
  if (focus !== home || top !== home) return { status: "pending", reason: "home-unfocused" };
  const blocks = activities.split(/(?=^\s*\* Hist\s+#\d+:)/m).filter((part) => /^\s*\* Hist\s+#\d+:/m.test(part));
  const record = blocks.find((part) =>
    component(part.match(new RegExp(`^\\s*mActivityComponent=(${componentPattern})\\s*$`, "m"))?.[1]) === home);
  if (!record || !/^\s*state=RESUMED\b/m.test(record) ||
      !/^\s*mVisibleRequested=true mVisible=true mClientVisible=true reportedDrawn=true reportedVisible=true\s*$/m.test(record) ||
      !/^\s*.*\ballDrawn=true\b/m.test(record) || !/\bfirstWindowDrawn=true\b/.test(record)) {
    return { status: "pending", reason: "home-undrawn" };
  }
  return { status: "ready", reason: "home-drawn-focused" };
}

export async function waitForAndroidHome(adb, { deadline, signal, observe = async () => {} }) {
  const read = async (args) => {
    signal?.throwIfAborted();
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw diagnosticError("readiness-timeout");
    return (await adb(args, Math.min(10_000, remaining))).stdout;
  };
  let attempts = 0;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    const resolved = await read(["shell", "cmd", "package", "resolve-activity", "--brief", "--user", "0",
      "-a", "android.intent.action.MAIN", "-c", "android.intent.category.HOME"]);
    const activities = await read(["shell", "dumpsys", "activity", "activities"]);
    const windows = await read(["shell", "dumpsys", "window", "displays"]);
    const anrs = await read(["logcat", "-d", "-b", "events", "-s", "am_anr:I", "*:S"]);
    const state = androidHomeState({ resolved, activities, windows, anrs });
    await observe({ ...state, attempts: ++attempts });
    if (state.status === "blocked") {
      throw Object.assign(diagnosticError("resource-unavailable"), { readinessReason: state.reason });
    }
    if (Date.now() >= deadline) throw diagnosticError("readiness-timeout");
    if (state.status === "ready") return { ...state, attempts };
    await delay(Math.min(500, deadline - Date.now()), undefined, { signal });
  }
  throw diagnosticError("readiness-timeout");
}
