import { realpath } from "node:fs/promises";
import path from "node:path";
import { parseTask, runDevelopment, taskSchema } from "./development-workflow.mjs";
import { git } from "./verification.mjs";

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
      description: "Implement one explicitly requested DevPocket task in an isolated worktree, verify it, independently review it, and repair at most twice. No merge or deployment.",
      argsSchema: taskSchema,
      phases: [{ title: "Implement" }, { title: "Verify" }, { title: "Review" }],
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
      description: "Start a NEW DevPocket implementation task, current-session first: reuse a freshly inspected clean linked worktree via the App's devpocket-development workflow; isolate a clean primary checkout in a new App worktree. Dirty/unknown checkouts block. Settle goal, acceptance and dependencies first; follow-ups stay with their existing run. See docs\\DEVELOPMENT-WORKFLOW.md for direct invocation and prerequisites. No real GitHub Copilot runtime control, installation, cloud, merge or release authority.",
      parameters: taskSchema,
      handler: async (input) => {
        const task = parseTask(input);
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
                "Implement the user's DevPocket task using the registered devpocket-development workflow in this new worktree.",
                "Read AGENTS.md. Invoke run_dynamic_workflow with name devpocket-development and the JSON arguments below.",
                "If the workflow/reviewer is not loaded, request scoped loading; do not replace the workflow with unchecked self-review.",
                "The workflow stops at reviewed, source-bound handoff. Preserve any blocked/needs_human outcome.",
                "Report back to the creating session. Do not commit, push, merge, install/reload runtime extensions, enroll devices, or deploy.",
                `Task arguments:\n${JSON.stringify(task)}`,
              ].join("\n"),
            },
          },
        });
      },
    }],
  });
  return session;
}
