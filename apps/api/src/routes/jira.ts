import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { TaskState } from "@optio/shared";
import { requireRole } from "../plugins/auth.js";
import { ErrorResponseSchema } from "../schemas/common.js";
import * as repoService from "../services/repo-service.js";
import * as taskService from "../services/task-service.js";
import { retrieveSecret } from "../services/secret-service.js";
import { fetchJiraIssue } from "../services/jira-service.js";
import { taskQueue } from "../workers/task-worker.js";

const runIssueSchema = z
  .object({
    repoId: z.string().min(1),
    issueKey: z
      .string()
      .min(1)
      .regex(/^[A-Za-z][A-Za-z0-9]+-\d+$/, "Invalid Jira issue key"),
  })
  .describe("Run a Claude Code task from a Jira issue key");

const JiraRunResponseSchema = z.object({
  task: z.record(z.unknown()),
});

function buildJiraPrompt(issue: {
  key: string;
  title: string;
  description: string;
  url: string;
}): string {
  return [
    `Work on Jira issue ${issue.key}.`,
    "",
    `Title: ${issue.title}`,
    `URL: ${issue.url}`,
    "",
    "Description:",
    issue.description || "(No description provided.)",
  ].join("\n");
}

export async function jiraRoutes(rawApp: FastifyInstance) {
  const app = rawApp.withTypeProvider<ZodTypeProvider>();

  app.post(
    "/api/jira/run-issue",
    {
      preHandler: [requireRole("member")],
      schema: {
        operationId: "runJiraIssue",
        summary: "Run a Claude task from a Jira issue",
        description:
          "Fetch a Jira issue using the configured global Jira PAT, then enqueue " +
          "a claude-code repo task for the selected repository.",
        tags: ["Repos & Integrations"],
        body: runIssueSchema,
        response: {
          201: JiraRunResponseSchema,
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const { repoId, issueKey } = req.body;
      const workspaceId = req.user?.workspaceId ?? null;
      const repo = await repoService.getRepo(repoId);
      if (!repo || (workspaceId && repo.workspaceId !== workspaceId)) {
        return reply.status(404).send({ error: "Repo not found" });
      }
      if (!repo.customDockerImageUrl?.trim()) {
        return reply.status(400).send({
          error: "Repo customDockerImageUrl is required before creating tasks",
        });
      }

      const [jiraBaseUrl, jiraPat] = await Promise.all([
        retrieveSecret("JIRA_BASE_URL", "global", workspaceId ?? undefined),
        retrieveSecret("JIRA_PAT", "global", workspaceId ?? undefined),
      ]);
      const issue = await fetchJiraIssue(jiraBaseUrl, jiraPat, issueKey);
      const task = await taskService.createTask({
        title: `[${issue.key}] ${issue.title}`,
        prompt: buildJiraPrompt(issue),
        repoUrl: repo.repoUrl,
        repoBranch: repo.defaultBranch,
        agentType: "claude-code",
        ticketSource: "jira",
        ticketExternalId: issue.key,
        metadata: { jiraUrl: issue.url, jiraTitle: issue.title },
        createdBy: req.user?.id,
        workspaceId,
      });

      await taskService.transitionTask(
        task.id,
        TaskState.QUEUED,
        "task_submitted",
        undefined,
        req.user?.id,
      );
      await taskQueue.add(
        "process-task",
        { taskId: task.id },
        {
          jobId: task.id,
          priority: task.priority ?? 100,
          attempts: task.maxRetries + 1,
          backoff: { type: "exponential", delay: 5000 },
        },
      );

      reply.status(201).send({ task: { type: "repo-task", ...task } });
    },
  );
}
