import { realpath } from "node:fs/promises";
import path from "node:path";
import { activeHookSnapshot, inspectWorktree, sameHooks, sameSource, sha256,
  validateCandidateCommit, validateCandidateReceiptProof } from "./candidate-commit.mjs";
import { requireCandidateImplementation } from "./native-candidate.mjs";
import { failureDetails } from "./diagnostic-errors.mjs";
import { committedInputsMatch, committedSourceInputs, commitSourceProjection, readOnlyGit, sourceInputs } from "./git-state.mjs";
import { CHECKS } from "./verification-policy.mjs";
import { combineVerification, requireCompletedVerificationGroup, requireVerificationResults, verificationFault } from "./verification.mjs";
import { readCandidateInput, readVerificationRun, verificationStorageLocation } from "./verification-run.mjs";
import { verificationExecutionPolicy, verificationPreflight } from "./verification-preflight.mjs";

const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const fail = () => { throw verificationFault("candidate-transition", { phase: "source-validation" }); };
const liveInputs = (inputs) => inputs.filter((entry) => entry[1] !== "deleted");

export async function capturePromotionContext(root, plan) {
  const [git, common] = await Promise.all(["--git-dir", "--git-common-dir"].map(async (flag) =>
    realpath(path.resolve(root, (await readOnlyGit(root, ["rev-parse", flag])).trim()))));
  if (git === common) return { eligible: false, reason: "linked-worktree-required" };
  try { await readOnlyGit(root, ["symbolic-ref", "--quiet", "HEAD"]); }
  catch (error) {
    if (error.code !== 1) throw error;
    return { eligible: false, reason: "attached-branch-required" };
  }
  let workspace, hooks;
  try {
    workspace = await inspectWorktree(root);
    hooks = await activeHookSnapshot(root);
  } catch (error) {
    if (error.candidateFailure !== "candidate-changed" && !["EACCES", "EPERM"].includes(error.code)) throw error;
    return { eligible: false, reason: "candidate-inspection-unavailable", failure: failureDetails(error, "candidate-transition") };
  }
  const inputs = await sourceInputs(root);
  if (!sameSource(workspace.source, plan.source) || sha256(JSON.stringify(inputs)) !== plan.source.fingerprint) fail();
  const projection = await commitSourceProjection(root, inputs);
  if (projection.status !== "bound") return { eligible: false, reason: projection.reason };
  return { eligible: true, workspace, inputs, hooks, projection };
}

async function validateTransition(root, plan, transition) {
  if (transition?.version !== 2 || typeof transition.from !== "string" ||
      typeof transition.request !== "string" || !/^[a-f0-9]{64}$/.test(transition.requestHash ?? "") ||
      transition.candidate !== plan.source.head) fail();
  const original = await readVerificationRun(root, transition.from);
  const manifest = original.manifest, context = manifest.promotionContext;
  if (manifest.transition || manifest.id !== transition.run || manifest.binding.group !== "all" ||
      original.report?.status !== "passed" || original.report.complete !== true ||
      context?.eligible !== true || manifest.plan.base !== plan.base ||
      !equal(manifest.plan.changedFiles, plan.changedFiles) ||
      !equal(manifest.plan.requiredChecks, plan.requiredChecks) ||
      !equal(manifest.plan.requiredGroups, plan.requiredGroups) || manifest.plan.layouts !== plan.layouts ||
      manifest.binding.policy !== await verificationExecutionPolicy()) fail();
  combineVerification(manifest.plan, [original.report]);
  const requestInput = await readCandidateInput(root, transition.request);
  const request = requestInput.value;
  if (sha256(requestInput.bytes) !== transition.requestHash || request.version !== 4 ||
      path.resolve(request.root) !== path.resolve(root) || !equal(request.expected, context.workspace) ||
      !sameHooks(request.hooks, context.hooks) || !sameHooks(await activeHookSnapshot(root), context.hooks) ||
      !sameSource(request.expected.source, manifest.plan.source) ||
      !equal(liveInputs(await sourceInputs(root)), liveInputs(context.inputs)) ||
      !equal(await commitSourceProjection(root, context.inputs), context.projection) ||
      !committedInputsMatch(context.inputs, await committedSourceInputs(root, plan.source.head), context.projection) ||
      (await readOnlyGit(root, ["merge-base", plan.base, manifest.plan.source.head])).trim() !== plan.base) fail();
  await requireCandidateImplementation(request.execution);
  const receipt = (await readCandidateInput(root, `${transition.request}.result.json`)).value;
  await validateCandidateReceiptProof(root, transition.requestHash, receipt);
  await validateCandidateCommit(root, request, receipt.candidate);
  if (!sameSource(receipt.candidate.source, plan.source) || receipt.candidate.parent !== manifest.plan.source.head) fail();
  return original;
}

export async function prepareVerificationTransition(root, plan, options) {
  if ((options.group ?? "all") !== "all" || !options.candidateRequest || !options.promote || options.resume) fail();
  const original = await readVerificationRun(root, options.promote);
  const request = await readCandidateInput(root, options.candidateRequest);
  const from = await verificationStorageLocation(root, options.promote);
  const candidate = await verificationStorageLocation(root, options.candidateRequest);
  const transition = { version: 2, from: path.relative(from.root, from.file),
    run: original.manifest.id, request: path.relative(candidate.root, candidate.file),
    requestHash: sha256(request.bytes), candidate: plan.source.head };
  await validateTransition(root, plan, transition);
  return transition;
}

export async function candidateReusableChecks(root, plan, transition, preflight, options) {
  const original = await validateTransition(root, plan, transition), checks = new Map();
  if (original.manifest.binding.backendDiagnostics !== Boolean(options.backendDiagnostics)) fail();
  const eligible = preflight.groups.find((item) => item.group === "backend")?.candidateEligibility?.status === "bound"
    ? ["typecheck"] : [];
  for (const id of eligible) {
    if (!plan.requiredChecks.includes(id)) continue;
    const group = CHECKS.find((check) => check.id === id).group;
    const receipt = original.latest.get(group), current = preflight.groups.find((item) => item.group === group);
    if (!receipt || receipt.invalidated || !receipt.reusable || !current?.reusable || current.status !== "passed" ||
        receipt.environment !== current.fingerprint) continue;
    requireCompletedVerificationGroup(original.manifest.plan, receipt.report, group);
    const check = receipt.report.checks.find((check) => check.id === id);
    if (!check.execution || !sameSource(check.execution.source, original.manifest.plan.source)) fail();
    checks.set(id, { ...structuredClone(check),
      candidateReuse: { run: original.manifest.id, attempt: receipt.attempt, check: id } });
  }
  return checks;
}

export async function validateCandidateVerification(root, plan, report, options = {}) {
  if (report.status !== "passed" || report.complete !== true || !report.transition) fail();
  if (options.recorded !== false) {
    if (!report.run?.manifest) fail();
    const current = await readVerificationRun(root, report.run.manifest);
    if (!equal(current.report, report) || !equal(current.manifest.transition, report.transition)) fail();
    options = { ...options, backendDiagnostics: current.manifest.binding.backendDiagnostics };
  }
  const reused = report.checks.filter((check) => check.candidateReuse);
  const groups = [...new Set(reused.map((check) => CHECKS.find((item) => item.id === check.id)?.group))];
  const preflight = options.preflight ?? { groups: (await Promise.all(groups.map((group) =>
    verificationPreflight(root, plan, { ...options, group, directory: path.dirname(path.resolve(root, report.run.manifest)) }))))
    .flatMap((value) => value.groups) };
  const allowed = await candidateReusableChecks(root, plan, report.transition, preflight, options);
  const { transition, ...current } = report;
  const checks = requireVerificationResults(plan, current, allowed);
  if (!equal(checks.map((check) => check.id), plan.requiredChecks)) fail();
  return report;
}
