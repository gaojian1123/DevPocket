export const VERIFICATION_REPORT_VERSION = 5;
export const isDiagnosticVerificationVersion = (version) => [1, 2, 3, 4, VERIFICATION_REPORT_VERSION].includes(version);

export const CHECKS = [
  { id: "workflow-tests", group: "tooling" },
  { id: "typecheck", group: "backend" },
  { id: "backend-tests", group: "backend" },
  { id: "backend-build", group: "backend" },
  { id: "schema", group: "backend" },
  { id: "extension-package", group: "backend" },
  { id: "setup", group: "backend" },
  { id: "azure-tests", group: "backend" },
  { id: "operations-tests", group: "backend" },
  { id: "android-build", group: "android" },
  { id: "android-device", group: "device" },
];

export const CHECK_GROUPS = [...new Set(CHECKS.map((check) => check.group))];
export const verificationGroups = (ids) => [...new Set(CHECKS.filter((check) => ids.includes(check.id)).map((check) => check.group))];
export const diagnosticCheckGroup = (check, version) =>
  version === 1 && check.id === "workflow-tests" ? "backend" : check.group;

const allChecks = CHECKS.map((check) => check.id);
const tooling = ["workflow-tests"];
const backend = ["workflow-tests", "typecheck", "backend-tests", "backend-build", "schema"];
const backendExecution = CHECKS.filter((check) => ["tooling", "backend"].includes(check.group)).map((check) => check.id);
const android = ["android-build", "android-device"];
const nativeExecution = { checks: [...tooling, ...android], layouts: () => true };
const full = { checks: allChecks, layouts: () => true };
const rules = [
  { id: "documentation", description: "Documentation does not select application checks.",
    matches: (file) => ["README.md", "VALIDATION.md"].includes(file) || /^docs\/.*\.md$/.test(file), checks: [] },
  { id: "task-routing", description: "Task routing and development workflow regressions use the complete workflow suite.",
    matches: (file) => ["scripts/workflow-extension.mjs", "scripts/tests/development-workflow.test.mjs",
      ".github/extensions/devpocket-development/extension.mjs"].includes(file), checks: tooling },
  { id: "development-tooling", description: "Development orchestration, local tool setup, trust policy and candidate preparation use the complete workflow suite.",
    matches: (file) => ["scripts/development-workflow.mjs", "scripts/development-policy.mjs",
      "scripts/candidate-commit.mjs", "scripts/native-candidate.mjs",
      "scripts/setup-xcode-mcp.mjs", "config/xcode-mcp.example.json", "scripts/test-workflow.mjs"].includes(file), checks: tooling },
  { id: "agent-instructions", description: "DevPocket development instructions use workflow regressions, not application checks.",
    matches: (file) => ["AGENTS.md", ".github/agents/devpocket-reviewer.agent.md",
      ".github/skills/devpocket-development/SKILL.md", ".github/ISSUE_TEMPLATE/ai-task.yml"].includes(file), checks: tooling },
  { id: "verification-contract", description: "Source identity, planning, evidence validation and report projection use workflow contracts, not application builds.",
    matches: (file) => [".gitignore", "scripts/git-state.mjs", "scripts/verification.mjs", "scripts/verification-policy.mjs",
      "scripts/verify.mjs", "scripts/verify.ps1", "scripts/verification-tooling.mjs", "scripts/verification-diagnostics.mjs", "scripts/diagnostic-errors.mjs",
      "scripts/diagnostic-publication.mjs", "scripts/android-diagnostics.mjs", "scripts/device-diagnostics.mjs",
      "scripts/worker-diagnostics.mjs", "scripts/native-lifecycle.mjs"].includes(file), checks: tooling },
  { id: "tooling-regression", description: "Named synthetic workflow regressions run the complete workflow suite without provisioning application toolchains.",
    matches: (file) => [
      "verification", "verification-execution", "verification-diagnostics", "android-runner", "android-build", "android-diagnostics",
      "device-diagnostics", "platform-diagnostics", "backend-diagnostics", "worker-diagnostics", "native-lifecycle",
      "bounded-worker-log", "process", "emulator-resources", "manual-emulator", "linux-emulator", "linux-runtime", "xcode-mcp", "workflow-runner",
    ].some((name) => file === `scripts/tests/${name}.test.mjs`) ||
      ["scripts/tests/fixtures/emulator-lease-peer.mjs", "scripts/tests/fixtures/verification-tools.mjs"].includes(file), checks: tooling },
  { id: "backend-execution", description: "Backend command adaptation, builds and packaging require backend checks, not native execution.",
    matches: (file) => ["scripts/verification-backend.mjs", "scripts/bundle-extension.mjs", "scripts/package-extension.ps1",
      "scripts/launch-cli-proof.ps1", "scripts/tests/extension-package.test.mjs", "scripts/tests/fixtures/proof-cli-process.mjs",
      "scripts/tests/fixtures/proof-cli.ps1", "backend/tsconfig.json", "backend/tsconfig.cli-proof.json",
      ".github/workflows/extension-release.yml"].includes(file), checks: backendExecution },
  { id: "android-execution", description: "Native build, device commands, prerequisites and owned device cleanup require build, device and layout evidence.",
    matches: (file) => ["scripts/verification-android.mjs", "scripts/build-android.ps1", "scripts/prepare-android.ps1", "scripts/android-platform.mjs",
      "scripts/test-android.ps1", "scripts/android-runner.mjs", "scripts/android-emulator.mjs", "scripts/android-home.mjs",
      "scripts/device-run.mjs", "scripts/emulator-resources.mjs", "scripts/linux-emulator.mjs", "scripts/linux-runtime.mjs",
      "scripts/manual-emulator.mjs", "scripts/native-startup.mjs", "scripts/platform-diagnostics.mjs",
      "scripts/start-test-emulator.ps1", "scripts/stop-test-emulator.ps1", "scripts/test-native-layouts.ps1",
      "scripts/save-debug-artifact.ps1", "scripts/tests/linux-process.test.mjs",
      ".github/actions/prepare-native/action.yml", ".github/workflows/native-startup-diagnostics.yml"].includes(file) ||
      /^(?:android\/gradle\/|android\/gradlew(?:\.bat)?$)/.test(file) ||
      /^android\/.*(?:\.gradle(?:\.kts)?|gradle\.properties)$/.test(file), ...nativeExecution },
  { id: "shared-execution", description: "The shared executor, process ownership, bounded logs and shared backend/native preflight require all downstream checks.",
    matches: (file) => ["scripts/verification-executor.mjs", "scripts/verification-preflight.mjs", "scripts/verification-run.mjs",
      "scripts/verification-transition.mjs", "scripts/verification-admission.mjs", "scripts/verification-ci.mjs",
      "scripts/verification-ci-artifact.ps1", "scripts/process.mjs", "scripts/owned-command.ps1",
      "scripts/owned-command.cs", "scripts/owned-command-windows.mjs", "scripts/owned-command-linux.py",
      "scripts/owned-command-darwin.py", "scripts/local-ipc.mjs",
      "scripts/bounded-worker-log.mjs", "scripts/backend-diagnostics.mjs"].includes(file), ...full },
  { id: "operations", description: "Deployment and infrastructure changes, including their dependencies, require backend and operational fixtures.",
    matches: (file) => file.startsWith("deployment/") || file.startsWith("infra/") || file === "azure.yaml",
    checks: [...backend, "setup", "azure-tests", "operations-tests"] },
  { id: "verification-infrastructure", description: "Cross-lane CI and shared or unclassified dependency inputs require all downstream checks.",
    matches: (file) => [".github/workflows/ci.yml", ".github/CODEOWNERS"].includes(file) ||
      /(?:^|\/)(?:\.npmrc|package(?:-lock)?\.json|npm-shrinkwrap\.json|tsconfig(?:\.[^/]+)?\.json|requirements[^/]*\.txt)$/i.test(file), ...full },
  { id: "android", description: "Android changes require native build and device evidence.",
    matches: (file) => file.startsWith("android/"), checks: android,
    layouts: (file) => /\/ui\/|\/res\/|Manifest|\.gradle|gradle\.properties/.test(file) },
  { id: "backend-runtime", description: "Backend/runtime source requires backend, packaging, setup and native compatibility checks.",
    matches: (file) => file.startsWith("backend/src/"),
    checks: [...backend, "extension-package", "setup", ...android] },
  { id: "backend-integration", description: "Runtime integration changes require backend and native compatibility checks.",
    matches: (file) => file.startsWith("backend/integration/"), checks: [...backend, ...android] },
  { id: "backend", description: "Backend changes require workflow regressions and backend checks.",
    matches: (file) => file.startsWith("backend/"), checks: backend },
  { id: "runtime-extension", description: "The shipped runtime extension requires backend, packaging and setup checks.",
    matches: (file) => file.startsWith("extension/"), checks: [...backend, "extension-package", "setup"] },
  { id: "wire-fixtures", description: "Shared wire contracts and fixtures require backend and native compatibility checks.",
    matches: (file) => file.startsWith("test-fixtures/") || ["protocol.schema.json", "scripts/export-schema.ts"].includes(file),
    checks: [...backend, ...android] },
  { id: "unknown", description: "Unclassified paths require every check and layouts.",
    matches: () => true, ...full },
];
const allRule = { id: "all-checks", description: "Explicit --all selects every check.", checks: allChecks };
const ruleFor = (file) => rules.find((rule) => rule.matches(file));
const orderedChecks = (ids) => allChecks.filter((id) => ids.includes(id));
const safePath = (file) => typeof file === "string" && file.length <= 240 &&
  /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(file) && !file.split("/").some((part) => [".", ".."].includes(part));
const pathLimit = 16;

function explanation(rule, files) {
  const paths = files.filter(safePath).slice(0, pathLimit);
  return { rule: rule.id, description: rule.description, paths, omittedPaths: files.length - paths.length,
    checks: orderedChecks(rule.checks), groups: verificationGroups(rule.checks) };
}

export function verificationImpact(changedFiles, all = false) {
  const selected = new Set(), causes = new Map();
  let layouts = false;
  for (const file of [...new Set(changedFiles)].sort()) {
    const rule = ruleFor(file);
    rule.checks.forEach((id) => selected.add(id));
    if (!causes.has(rule.id)) causes.set(rule.id, []);
    causes.get(rule.id).push(file);
    layouts ||= Boolean(rule.layouts?.(file));
  }
  if (all) allChecks.forEach((id) => selected.add(id));
  const requiredChecks = orderedChecks([...selected]);
  return { requiredChecks, requiredGroups: verificationGroups(requiredChecks), layouts,
    selectionReasons: [
      ...rules.filter((rule) => causes.has(rule.id)).map((rule) => explanation(rule, causes.get(rule.id))),
      ...(all ? [explanation(allRule, [])] : []),
    ] };
}

// Diagnostics are not evidence. Rebuild fixed descriptions/checks and only show current source-indexed paths.
export function projectVerificationSelection(report, sourcePaths) {
  if (!Array.isArray(report?.requiredChecks)) return null;
  const selected = CHECKS.filter((check) => report.requiredChecks.includes(check.id));
  const requiredChecks = selected.map((check) => check.id);
  const reasons = [3, VERIFICATION_REPORT_VERSION].includes(report.version) && Array.isArray(report.selectionReasons) ? report.selectionReasons : [];
  let remainingPaths = pathLimit;
  return {
    requiredChecks, requiredGroups: [...new Set(selected.map((check) => diagnosticCheckGroup(check, report.version)))],
    layouts: typeof report.layouts === "boolean" ? report.layouts : "unknown",
    ...([1, 2].includes(report.version) ? { legacyAgentReview: {
      requiresHumanReview: typeof report.requiresHumanReview === "boolean" ? report.requiresHumanReview : "unknown",
      approval: "not-established",
    } } : {}),
    selectionReasons: [...rules, allRule].flatMap((rule) => {
      const inputs = reasons.filter((item) => item?.rule === rule.id);
      if (inputs.length !== 1 || !Array.isArray(inputs[0].paths)) return [];
      const input = inputs[0], paths = [...new Set(input.paths.filter((file) =>
        safePath(file) && sourcePaths.has(file) && ruleFor(file).id === rule.id))].sort().slice(0, remainingPaths);
      remainingPaths -= paths.length;
      const omitted = Number.isSafeInteger(input.omittedPaths) && input.omittedPaths >= 0 ? input.omittedPaths : 0;
      return [{ ...explanation(rule, paths), omittedPaths: Math.min(1_000_000, omitted + input.paths.length - paths.length) }];
    }),
  };
}
