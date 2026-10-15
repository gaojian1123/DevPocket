export const VERIFICATION_REPORT_VERSION = 3;
export const isDiagnosticVerificationVersion = (version) => [1, 2, VERIFICATION_REPORT_VERSION].includes(version);

export const CHECKS = [
  { id: "workflow-tests", group: "tooling", npm: "run test:workflow" },
  { id: "typecheck", group: "backend", npm: "run typecheck" },
  { id: "backend-tests", group: "backend", npm: "test" },
  { id: "backend-build", group: "backend", npm: "run build" },
  { id: "schema", group: "backend", npm: "run schema" },
  { id: "extension-package", group: "backend", npm: "run test:extension-package" },
  { id: "setup", group: "backend", npm: "run test:setup" },
  { id: "azure-tests", group: "backend", npm: "--prefix deployment\\azure test" },
  { id: "operations-tests", group: "backend", npm: "run test:operations" },
  { id: "android-build", group: "android", script: "build-android.ps1", args: ["-Lint", "-Instrumentation"] },
  { id: "android-device", group: "device", script: "test-android.ps1", args: [] },
];

export const CHECK_GROUPS = [...new Set(CHECKS.map((check) => check.group))];
export const verificationGroups = (ids) => [...new Set(CHECKS.filter((check) => ids.includes(check.id)).map((check) => check.group))];
export const diagnosticCheckGroup = (check, version) =>
  version === 1 && check.id === "workflow-tests" ? "backend" : check.group;

const allChecks = CHECKS.map((check) => check.id);
const backend = ["workflow-tests", "typecheck", "backend-tests", "backend-build", "schema"];
const android = ["android-build", "android-device"];
const full = { checks: allChecks, layouts: () => true };
const rules = [
  { id: "documentation", description: "Documentation does not select application checks.",
    matches: (file) => ["README.md", "VALIDATION.md"].includes(file) || /^docs\/.*\.md$/.test(file), checks: [] },
  { id: "task-routing", description: "Task routing and development workflow regressions use the complete workflow suite.",
    matches: (file) => ["scripts/workflow-extension.mjs", "scripts/tests/development-workflow.test.mjs"].includes(file),
    checks: ["workflow-tests"] },
  { id: "development-tooling", description: "Development orchestration, local trust policy and candidate preparation use the complete workflow suite.",
    matches: (file) => ["scripts/development-workflow.mjs", "scripts/development-policy.mjs", "scripts/candidate-commit.mjs"].includes(file),
    checks: ["workflow-tests"] },
  { id: "agent-instructions", description: "DevPocket development instructions use workflow regressions, not application checks.",
    matches: (file) => ["AGENTS.md", ".github/agents/devpocket-reviewer.agent.md",
      ".github/skills/devpocket-development/SKILL.md"].includes(file), checks: ["workflow-tests"] },
  { id: "verification-infrastructure", description: "Verification, CI, build, shared execution or dependency policy requires all downstream checks.",
    matches: (file) =>
      /^(?:scripts\/|\.github\/|android\/gradle\/|android\/gradlew(?:\.bat)?$)/i.test(file) ||
      /(?:^|\/)(?:\.npmrc|package(?:-lock)?\.json|npm-shrinkwrap\.json|tsconfig(?:\.[^/]+)?\.json|requirements[^/]*\.txt)$/i.test(file) ||
      /^android\/.*(?:\.gradle(?:\.kts)?|gradle\.properties)$/i.test(file), ...full },
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
  { id: "operations", description: "Deployment and infrastructure changes require backend and operational fixtures.",
    matches: (file) => file.startsWith("deployment/") || file.startsWith("infra/") || file === "azure.yaml",
    checks: [...backend, "setup", "azure-tests", "operations-tests"] },
  { id: "wire-fixtures", description: "Shared wire contracts and fixtures require backend and native compatibility checks.",
    matches: (file) => file.startsWith("test-fixtures/") || file === "protocol.schema.json",
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
  const reasons = report.version === VERIFICATION_REPORT_VERSION && Array.isArray(report.selectionReasons) ? report.selectionReasons : [];
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
