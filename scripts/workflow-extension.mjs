import { realpath } from "node:fs/promises";
import path from "node:path";
import { checkDevelopmentReadiness, parseTask, requireDevelopmentImplementation, runDevelopment, taskSchema } from "./development-workflow.mjs";
import { git } from "./verification.mjs";

const readinessSchema = {
  type: "object", required: ["runId"], properties: { runId: { type: "string" } },
};

export async function checkRecordedReadiness(session, root, input) {
  if (!input || Object.keys(input).length !== 1 || typeof input.runId !== "string" ||
      !/^[A-Za-z0-9-]{1,100}$/.test(input.runId)) {
    throw new TypeError("Provide the completed development workflow runId.");
  }
  const detail = await session.workflow.getRunDetail(input.runId);
  if (detail.runId !== input.runId || detail.workflowName !== "devpocket-development" || detail.status !== "completed") {
    return { status: "blocked", reason: "This is not a completed development run in the original session." };
  }
  const run = await session.workflow.getRun(input.runId);
  if (run.runId !== input.runId || run.status !== "completed" || run.result?.runId !== input.runId) {
    return { status: "blocked", reason: "This is not a completed development run in the original session." };
  }
  const result = await checkDevelopmentReadiness(root, run.result);
  if (result.status !== "ready") return result;
  return { status: "ready", runId: input.runId, commit: result.candidate.commit,
    base: result.base, source: result.source,
    reason: "The verified and independently reviewed candidate is unchanged. Publication still requires separate authorization; no verification or publication was executed." };
}

async function inspectStartingWorktree(root) {
  root = await realpath(root);
  const topLevel = await realpath((await git(root, ["rev-parse", "--show-toplevel"])).trim());
  if (topLevel !== root) throw new Error("Expected the repository worktree root.");
  const gitDirectory = await realpath(path.resolve(root, (await git(root, ["rev-parse", "--git-dir"])).trim()));
  const commonDirectory = await realpath(path.resolve(root, (await git(root, ["rev-parse", "--git-common-dir"])).trim()));
  const dirty = Boolean(await git(root, ["--no-optional-locks", "status", "--porcelain", "--untracked-files=all", "--ignore-submodules=none"]));
  return { linked: gitDirectory !== commonDirectory, dirty };
}

export async function requireReadonlyReviewer(session, root) {
  const list = await session.rpc.agent.list();
  const reviewer = list.agents.find((agent) => agent.id === "devpocket-reviewer");
  const expected = path.join(root, ".github", "agents", "devpocket-reviewer.agent.md");
  const allowed = new Set(["read", "search", "view", "glob", "rg", "grep"]);
  if (!reviewer || path.resolve(reviewer.path ?? "") !== expected || !Array.isArray(reviewer.tools) ||
      reviewer.tools.length === 0 || reviewer.tools.some((tool) => !allowed.has(tool.toLowerCase())) ||
      Object.keys(reviewer.mcpServers ?? {}).length) {
    throw new Error("Load the repository's read/search-only devpocket-reviewer profile before running this workflow.");
  }
}

export async function registerDevelopmentExtension({ defineWorkflow, joinSession }, root) {
  let session;
  const workflow = defineWorkflow({
    meta: {
      name: "devpocket-development",
      description: "Optional controller-managed DevPocket development. Use only when the user explicitly selects this workflow, or to continue its recorded run; normal implementation uses the devpocket-development skill. Make a scoped local candidate commit through original native permissions, then verify and independently review that exact clean commit. Repair at most twice with new commits. No push, PR creation, merge or deployment.",
      argsSchema: taskSchema,
      phases: [{ title: "Implement" }, { title: "Candidate" }, { title: "Verify" }, { title: "Review" }],
    },
    run: async (ctx) => {
      await requireReadonlyReviewer(ctx.session, root);
      return runDevelopment(ctx, { root });
    },
  });
  session = await joinSession({
    workflows: [workflow],
    tools: [{
      name: "devpocket_start_development",
      description: "Start a NEW task with the optional devpocket-development workflow, only when the user explicitly selects the workflow. Reuse a freshly inspected clean linked worktree in the current session; isolate a clean primary checkout in a new App worktree. Dirty/unknown checkouts block. Settle goal, acceptance and dependencies first; follow-ups stay with their recorded run. Normal implementation uses the devpocket-development skill. The workflow makes task-scoped local candidate commits through original native permissions before final verification and independent review. See docs\\DEVELOPMENT-WORKFLOW.md for direct invocation and prerequisites. No runtime control, installation, cloud, push, PR creation, merge or release authority.",
      parameters: taskSchema,
      handler: async (input) => {
        const task = parseTask(input);
        try { await requireDevelopmentImplementation(); }
        catch (error) {
          return { resultType: "failure", textResultForLlm: error.message };
        }
        const metadata = await session.rpc.tools.getCurrentMetadata();
        let checkout;
        try { checkout = await inspectStartingWorktree(root); }
        catch {
          return {
            resultType: "failure",
            textResultForLlm: "Git worktree inspection failed. No workflow or child session was started. Confirm the repository root, Git availability and repository access before choosing an entry point.",
          };
        }
        if (checkout.dirty) return {
          resultType: "failure",
          textResultForLlm: "The starting checkout is dirty. Resolve the task's dependency on existing changes before choosing a clean linked worktree; no workflow or child session was started and existing work was preserved.",
        };
        if (checkout.linked) {
          const run = metadata.tools?.find((tool) => ["run_dynamic_workflow", "functions.run_dynamic_workflow"].includes(tool.name));
          if (!run) return {
            resultType: "failure",
            textResultForLlm: "The current session's run_dynamic_workflow tool is unavailable. No child session was created. Request the missing workflow capability; do not retry through create_session.",
          };
          return session.rpc.tools.execute({
            name: run.name, arguments: { name: "devpocket-development", args: task },
          });
        }
        const create = metadata.tools?.find((tool) => ["create_session", "functions.create_session"].includes(tool.name));
        if (!create) return {
          resultType: "failure",
          textResultForLlm: "The App's create_session tool is unavailable for this clean primary checkout. Choose an isolated repository worktree session through the App; the workflow refuses the primary checkout.",
        };
        return session.rpc.tools.execute({
          name: create.name,
          arguments: {
            workspace_type: "worktree", name: "DevPocket development", notify_on_idle: "once",
            coordinate_with_creator: true,
            kickoff: {
              mode: "interactive",
              prompt: [
                "The user explicitly selected the optional devpocket-development workflow; implement that task in this new worktree.",
                "Read AGENTS.md. Invoke run_dynamic_workflow with name devpocket-development and the JSON arguments below.",
                "If the workflow/reviewer is not loaded, request scoped loading; do not replace the workflow with unchecked self-review.",
                "The workflow stops at a committed, independently reviewed, source-bound handoff. Preserve any blocked/needs_human outcome.",
                "Only the controller's candidate step may make task-scoped local commits through the original native tool/permission pipeline.",
                "Report back to the creating session. Do not independently commit, push, create a PR, merge, install/reload runtime extensions, enroll devices, or deploy.",
                `Task arguments:\n${JSON.stringify(task)}`,
              ].join("\n"),
            },
          },
        });
      },
    }, {
      name: "devpocket_check_development_readiness",
      description: "Read-only freshness/identity check of a completed devpocket-development run in this session before separately authorized push/PR creation. Uses the runtime's durable result, not editable handoff files. Does not rerun verification, commit or publish; changed source, HEAD, branch or index invalidates readiness.",
      parameters: readinessSchema,
      handler: async (input) => {
        const result = await checkRecordedReadiness(session, root, input);
        return { resultType: result.status === "ready" ? "success" : "failure", textResultForLlm: JSON.stringify(result) };
      },
    }],
  });
  return session;
}
