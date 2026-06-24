import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";

const mockRetrieveSecret = vi.fn();
const mockGetRepo = vi.fn();
const mockCreateTask = vi.fn();
const mockTransitionTask = vi.fn();
const mockQueueAdd = vi.fn();

vi.mock("../services/secret-service.js", () => ({
  retrieveSecret: (...args: unknown[]) => mockRetrieveSecret(...args),
}));

vi.mock("../services/repo-service.js", () => ({
  getRepo: (...args: unknown[]) => mockGetRepo(...args),
}));

vi.mock("../services/task-service.js", () => ({
  createTask: (...args: unknown[]) => mockCreateTask(...args),
  transitionTask: (...args: unknown[]) => mockTransitionTask(...args),
}));

vi.mock("../workers/task-worker.js", () => ({
  taskQueue: {
    add: (...args: unknown[]) => mockQueueAdd(...args),
  },
}));

import { jiraRoutes } from "./jira.js";

async function buildTestApp(): Promise<FastifyInstance> {
  return buildRouteTestApp(jiraRoutes);
}

const repo = {
  id: "repo-1",
  repoUrl: "https://gitlab.internal/org/repo.git",
  fullName: "org/repo",
  defaultBranch: "main",
  workspaceId: "ws-1",
  customDockerImageUrl: "registry.internal/optio/claude-sandbox:main",
};

const task = {
  id: "task-1",
  title: "[OPT-123] Fix login",
  workspaceId: "ws-1",
};

describe("POST /api/jira/run-issue", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockGetRepo.mockResolvedValue(repo);
    mockRetrieveSecret.mockImplementation((name: unknown) => {
      if (name === "JIRA_BASE_URL") return Promise.resolve("https://jira.internal");
      if (name === "JIRA_PAT") return Promise.resolve("jira-pat");
      return Promise.reject(new Error("not found"));
    });
    mockCreateTask.mockResolvedValue(task);
    mockTransitionTask.mockResolvedValue(undefined);
    mockQueueAdd.mockResolvedValue(undefined);
    app = await buildTestApp();
  });

  it("fetches the Jira issue and enqueues a claude-code repo task", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        key: "OPT-123",
        fields: {
          summary: "Fix login",
          description: "Users cannot sign in through SSO.",
        },
      }),
    });
    vi.stubGlobal("fetch", fetchSpy);

    const res = await app.inject({
      method: "POST",
      url: "/api/jira/run-issue",
      payload: { repoId: "repo-1", issueKey: "OPT-123" },
    });

    expect(res.statusCode).toBe(201);
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://jira.internal/rest/api/2/issue/OPT-123",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer jira-pat" }),
      }),
    );
    expect(mockCreateTask).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "[OPT-123] Fix login",
        repoUrl: "https://gitlab.internal/org/repo.git",
        repoBranch: "main",
        agentType: "claude-code",
        ticketSource: "jira",
        ticketExternalId: "OPT-123",
        workspaceId: "ws-1",
      }),
    );
    const createArg = mockCreateTask.mock.calls[0][0] as { prompt: string };
    expect(createArg.prompt).toContain("Users cannot sign in through SSO.");
    expect(mockTransitionTask).toHaveBeenCalledWith(
      "task-1",
      "queued",
      "task_submitted",
      undefined,
      "user-1",
    );
    expect(mockQueueAdd).toHaveBeenCalledWith(
      "process-task",
      { taskId: "task-1" },
      expect.any(Object),
    );
  });

  it("requires the selected repo to have a custom sandbox image", async () => {
    mockGetRepo.mockResolvedValue({ ...repo, customDockerImageUrl: null });

    const res = await app.inject({
      method: "POST",
      url: "/api/jira/run-issue",
      payload: { repoId: "repo-1", issueKey: "OPT-123" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("customDockerImageUrl");
    expect(mockCreateTask).not.toHaveBeenCalled();
  });
});
