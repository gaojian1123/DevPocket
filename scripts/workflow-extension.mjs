import path from "node:path";
import { parseTask, runDevelopment, taskSchema } from "./development-workflow.mjs";

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
      description: "Start an explicitly requested DevPocket implementation task in a NEW isolated Copilot App worktree. Use after the user chooses the goal and observable acceptance criteria, not for advice/planning. It starts the implementation/verification/independent-review workflow; it grants no real CLI, installation, cloud, merge or release authority.",
      parameters: taskSchema,
      handler: async (input) => {
        const task = parseTask(input);
        const metadata = await session.rpc.tools.getCurrentMetadata();
        const create = metadata.tools?.find((tool) => ["create_session", "functions.create_session"].includes(tool.name));
        if (!create) return {
          resultType: "failure",
          textResultForLlm: "The App's create_session tool is unavailable. Open an isolated repository worktree session and run devpocket-development there; the primary checkout will be refused.",
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
