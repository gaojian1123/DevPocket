const executionScripts = new Set([
  "development-paths", "development-policy", "candidate-commit", "native-candidate",
  "git-state", "verification", "verification-policy", "verify", "verification-executor", "test-tooling",
  "verification-backend", "verification-android", "process", "owned-command", "owned-command-windows",
  "verification-preflight", "verification-run", "verification-transition",
  "verification-tooling", "verification-admission", "verification-ci", "verification-ci-artifact",
  "owned-command-linux", "owned-command-darwin", "local-ipc", "device-run", "worker-diagnostics", "device-diagnostics", "diagnostic-errors",
  "bounded-worker-log", "diagnostic-publication", "native-lifecycle", "backend-diagnostics",
  "verification-diagnostics", "android-diagnostics", "platform-diagnostics",
  "bundle-extension", "package-extension", "launch-cli-proof", "export-schema",
  "build-android", "prepare-android", "test-android", "android-runner", "android-emulator", "android-home", "android-platform",
  "emulator-resources", "linux-emulator", "linux-runtime", "manual-emulator", "native-startup",
  "start-test-emulator", "stop-test-emulator", "test-native-layouts", "save-debug-artifact",
]);
const sensitiveBackend = new Set(["security", "runtime", "files", "protocol", "store", "relay", "bridge", "host-record", "push"]);

export function classifyDevelopmentPath(file) {
  const lower = file.toLowerCase();
  if (/(?:^|\/)(?:agents|claude)\.md$/.test(lower) ||
      lower === ".github/copilot-instructions.md" || /^\.github\/instructions\/.*\.instructions\.md$/.test(lower) ||
      /^\.github\/(?:agents|skills)\//.test(lower)) return "instructions";
  if (/^\.github\/(?:workflows|actions|extensions)\//.test(lower) || lower === ".github/codeowners" ||
      /^scripts\/([^/]+)\.(?:mjs|ps1|cs|py|ts)$/.test(lower) && executionScripts.has(lower.slice(8).replace(/\.[^.]+$/, ""))) {
    return "execution";
  }
  if (/(?:^|\/)(?:\.npmrc|package(?:-lock)?\.json|npm-shrinkwrap\.json|tsconfig(?:\.[^/]+)?\.json|requirements[^/]*\.txt)$/.test(lower) ||
      /^(?:android\/gradle\/|android\/gradlew(?:\.bat)?$)/.test(lower) ||
      /^android\/.*(?:\.gradle(?:\.kts)?|gradle\.properties)$/.test(lower)) return "dependency";
  if (/^backend\/src\/([^/]+)\.ts$/.test(lower) && sensitiveBackend.has(lower.slice(12, -3)) ||
      /\/(?:vault|wire|localstore|relayapi)\.kt$/.test(lower) || /(?:^|\/)androidmanifest\.xml$/.test(lower) ||
      lower.startsWith("extension/") || lower === "protocol.schema.json") return "sensitive";
  if (["readme.md", "validation.md", ".gitignore"].includes(lower) ||
      /^(?:docs|backend|android|scripts|test-fixtures)\//.test(lower) ||
      /^\.github\/(?:issue_template\/|pull_request_template(?:\/|\.md$))/.test(lower) ||
      /^\.github\/[^/]+\.md$/.test(lower) ||
      /^(?:deployment|infra)\//.test(lower) || lower === "azure.yaml") return null;
  return "unknown";
}

export const isVerificationPolicyPath = (file) =>
  ["execution", "instructions", "dependency"].includes(classifyDevelopmentPath(file));
