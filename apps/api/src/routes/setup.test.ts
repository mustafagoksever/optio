import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";
import type { FastifyInstance } from "fastify";

// ─── Mocks ───

const mockListSecrets = vi.fn();
const mockRetrieveSecret = vi.fn();

vi.mock("../services/secret-service.js", () => ({
  listSecrets: (...args: unknown[]) => mockListSecrets(...args),
  retrieveSecret: (...args: unknown[]) => mockRetrieveSecret(...args),
}));

const mockCheckRuntimeHealth = vi.fn();
vi.mock("../services/container-service.js", () => ({
  checkRuntimeHealth: (...args: unknown[]) => mockCheckRuntimeHealth(...args),
}));

vi.mock("../services/auth-service.js", () => ({
  isSubscriptionAvailable: () => false,
}));

let authDisabled = false;
vi.mock("../services/oauth/index.js", () => ({
  isAuthDisabled: () => authDisabled,
}));

import { setupRoutes } from "./setup.js";

// ─── Helpers ───

async function buildTestApp(user?: { workspaceRole: string } | null): Promise<FastifyInstance> {
  return buildRouteTestApp(setupRoutes, {
    user:
      user === undefined
        ? undefined
        : user === null
          ? null
          : {
              id: "u1",
              workspaceId: "ws-1",
              workspaceRole: user.workspaceRole as "admin" | "member" | "viewer",
            },
  });
}

describe("GET /api/setup/status", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("returns fully set up when all keys exist and runtime is healthy", async () => {
    mockListSecrets.mockResolvedValue([{ name: "ANTHROPIC_API_KEY" }, { name: "GITHUB_TOKEN" }]);
    mockRetrieveSecret.mockRejectedValue(new Error("not found"));
    mockCheckRuntimeHealth.mockResolvedValue(true);

    const res = await app.inject({ method: "GET", url: "/api/setup/status" });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.isSetUp).toBe(true);
    expect(body.steps.runtime.done).toBe(true);
    expect(body.steps.gitToken.done).toBe(true);
    expect(body.steps.anthropicKey.done).toBe(true);
    expect(body.steps.anyAgentKey.done).toBe(true);
  });

  it("returns fully set up when using GitLab token", async () => {
    mockListSecrets.mockResolvedValue([{ name: "ANTHROPIC_API_KEY" }, { name: "GITLAB_TOKEN" }]);
    mockRetrieveSecret.mockRejectedValue(new Error("not found"));
    mockCheckRuntimeHealth.mockResolvedValue(true);

    const res = await app.inject({ method: "GET", url: "/api/setup/status" });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.isSetUp).toBe(true);
    expect(body.steps.gitToken.done).toBe(true);
    expect(body.steps.anthropicKey.done).toBe(true);
  });

  it("detects Claude gateway credentials as the Claude setup", async () => {
    mockListSecrets.mockResolvedValue([
      { name: "ANTHROPIC_BASE_URL" },
      { name: "ANTHROPIC_AUTH_TOKEN" },
      { name: "GITLAB_TOKEN" },
    ]);
    mockRetrieveSecret.mockRejectedValue(new Error("not found"));
    mockCheckRuntimeHealth.mockResolvedValue(true);

    const res = await app.inject({ method: "GET", url: "/api/setup/status" });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.isSetUp).toBe(true);
    expect(body.steps.anthropicKey.done).toBe(true);
    expect(body.steps.anyAgentKey.done).toBe(true);
  });

  it("returns not set up when no agent key exists", async () => {
    mockListSecrets.mockResolvedValue([{ name: "GITHUB_TOKEN" }]);
    mockRetrieveSecret.mockRejectedValue(new Error("not found"));
    mockCheckRuntimeHealth.mockResolvedValue(true);

    const res = await app.inject({ method: "GET", url: "/api/setup/status" });

    expect(res.statusCode).toBe(200);
    expect(res.json().isSetUp).toBe(false);
    expect(res.json().steps.anyAgentKey.done).toBe(false);
  });

  it("stays set up when runtime is unhealthy but keys exist", async () => {
    mockListSecrets.mockResolvedValue([{ name: "ANTHROPIC_API_KEY" }, { name: "GITHUB_TOKEN" }]);
    mockRetrieveSecret.mockRejectedValue(new Error("not found"));
    mockCheckRuntimeHealth.mockResolvedValue(false);

    const res = await app.inject({ method: "GET", url: "/api/setup/status" });

    expect(res.json().isSetUp).toBe(true);
    expect(res.json().steps.runtime.done).toBe(false);
  });

  it("detects OAuth token mode", async () => {
    mockListSecrets.mockResolvedValue([
      { name: "GITHUB_TOKEN" },
      { name: "CLAUDE_CODE_OAUTH_TOKEN" },
    ]);
    mockRetrieveSecret.mockImplementation(async (name: string) => {
      if (name === "CLAUDE_AUTH_MODE") return "oauth-token";
      throw new Error("not found");
    });
    mockCheckRuntimeHealth.mockResolvedValue(true);

    const res = await app.inject({ method: "GET", url: "/api/setup/status" });

    expect(res.json().isSetUp).toBe(true);
    expect(res.json().steps.anyAgentKey.done).toBe(true);
  });

  it("detects OAuth token mode by name when CLAUDE_AUTH_MODE cannot be decrypted", async () => {
    // Regression: public setup/status has no req.user context, so it can't
    // build the AAD that workspace-scoped CLAUDE_AUTH_MODE rows need.
    // The endpoint must infer the mode from CLAUDE_CODE_OAUTH_TOKEN's presence
    // in the secret names rather than calling retrieveSecret.
    mockListSecrets.mockResolvedValue([
      { name: "GITHUB_TOKEN" },
      { name: "CLAUDE_AUTH_MODE" },
      { name: "CLAUDE_CODE_OAUTH_TOKEN" },
    ]);
    mockRetrieveSecret.mockRejectedValue(new Error("decrypt failed: AAD mismatch"));
    mockCheckRuntimeHealth.mockResolvedValue(true);

    const res = await app.inject({ method: "GET", url: "/api/setup/status" });

    expect(res.json().isSetUp).toBe(true);
    expect(res.json().steps.anyAgentKey.done).toBe(true);
  });

  it("detects Codex app-server mode by name when CODEX_AUTH_MODE cannot be decrypted", async () => {
    mockListSecrets.mockResolvedValue([
      { name: "GITHUB_TOKEN" },
      { name: "CODEX_AUTH_MODE" },
      { name: "CODEX_APP_SERVER_URL" },
    ]);
    mockRetrieveSecret.mockRejectedValue(new Error("decrypt failed: AAD mismatch"));
    mockCheckRuntimeHealth.mockResolvedValue(true);

    const res = await app.inject({ method: "GET", url: "/api/setup/status" });

    expect(res.json().isSetUp).toBe(true);
    expect(res.json().steps.codexAppServer.done).toBe(true);
    expect(res.json().steps.anyAgentKey.done).toBe(true);
  });

  it("detects Gemini Vertex AI mode by name when GEMINI_AUTH_MODE cannot be decrypted", async () => {
    mockListSecrets.mockResolvedValue([
      { name: "GITHUB_TOKEN" },
      { name: "GEMINI_AUTH_MODE" },
      { name: "GOOGLE_CLOUD_PROJECT" },
    ]);
    mockRetrieveSecret.mockRejectedValue(new Error("decrypt failed: AAD mismatch"));
    mockCheckRuntimeHealth.mockResolvedValue(true);

    const res = await app.inject({ method: "GET", url: "/api/setup/status" });

    expect(res.json().isSetUp).toBe(true);
    expect(res.json().steps.geminiKey.done).toBe(true);
    expect(res.json().steps.anyAgentKey.done).toBe(true);
  });
});

describe("POST /api/setup/validate/github-token", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns 400 when no token is provided", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/setup/validate/github-token",
      payload: {},
    });

    expect(res.statusCode).toBe(400);
    // After type-provider migration, the 400 envelope is { error, details }
    // rather than { valid: false }
    expect(res.json().error).toBe("Validation error");
  });

  it("validates a valid GitHub token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ login: "testuser", name: "Test User" }),
      }),
    );

    const res = await app.inject({
      method: "POST",
      url: "/api/setup/validate/github-token",
      payload: { token: "ghp_valid_token" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().valid).toBe(true);
    expect(res.json().user.login).toBe("testuser");
  });

  it("returns invalid for bad token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
      }),
    );

    const res = await app.inject({
      method: "POST",
      url: "/api/setup/validate/github-token",
      payload: { token: "bad-token" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().valid).toBe(false);
  });
});

describe("POST /api/setup/validate/anthropic-key", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns 400 when no key is provided", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/setup/validate/anthropic-key",
      payload: {},
    });

    expect(res.statusCode).toBe(400);
  });

  it("validates a valid Anthropic key", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));

    const res = await app.inject({
      method: "POST",
      url: "/api/setup/validate/anthropic-key",
      payload: { key: "sk-ant-valid" },
    });

    expect(res.json().valid).toBe(true);
  });
});

describe("POST /api/setup/validate/claude-gateway", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("validates with the configured Anthropic-compatible base URL and bearer token", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchSpy);

    const res = await app.inject({
      method: "POST",
      url: "/api/setup/validate/claude-gateway",
      payload: {
        baseUrl: "https://claude-gateway.internal/",
        token: "gateway-token",
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().valid).toBe(true);
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://claude-gateway.internal/v1/models",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer gateway-token",
          "anthropic-version": "2023-06-01",
        }),
      }),
    );
  });
});

describe("POST /api/setup/validate/jira-pat", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("validates a Bearer PAT against Jira v2 and falls back to v3", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ name: "mustafa" }) });
    vi.stubGlobal("fetch", fetchSpy);

    const res = await app.inject({
      method: "POST",
      url: "/api/setup/validate/jira-pat",
      payload: {
        baseUrl: "https://jira.internal",
        token: "jira-pat",
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().valid).toBe(true);
    expect(fetchSpy).toHaveBeenNthCalledWith(
      1,
      "https://jira.internal/rest/api/2/myself",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer jira-pat" }),
      }),
    );
    expect(fetchSpy).toHaveBeenNthCalledWith(
      2,
      "https://jira.internal/rest/api/3/myself",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer jira-pat" }),
      }),
    );
  });
});

describe("POST /api/setup/validate/openai-key", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns 400 when no key is provided", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/setup/validate/openai-key",
      payload: {},
    });

    expect(res.statusCode).toBe(400);
  });
});

describe("error sanitization in setup routes", () => {
  let app: FastifyInstance;
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    vi.unstubAllGlobals();
  });

  it("returns generic error in production when github-token validation throws", async () => {
    process.env.NODE_ENV = "production";
    // Re-import to pick up the env change
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED 127.0.0.1:443")));

    const res = await app.inject({
      method: "POST",
      url: "/api/setup/validate/github-token",
      payload: { token: "ghp_test" },
    });

    expect(res.json().valid).toBe(false);
    // Should NOT contain the internal error details
    expect(res.json().error).not.toContain("ECONNREFUSED");
  });

  it("returns detailed error in development when github-token validation throws", async () => {
    process.env.NODE_ENV = "development";
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED 127.0.0.1:443")));

    const res = await app.inject({
      method: "POST",
      url: "/api/setup/validate/github-token",
      payload: { token: "ghp_test" },
    });

    expect(res.json().valid).toBe(false);
    expect(res.json().error).toContain("ECONNREFUSED");
  });

  it("returns generic error in production when repos listing throws", async () => {
    process.env.NODE_ENV = "production";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("getaddrinfo ENOTFOUND api.github.com")),
    );

    const res = await app.inject({
      method: "POST",
      url: "/api/setup/repos",
      payload: { token: "ghp_test" },
    });

    expect(res.json().repos).toEqual([]);
    expect(res.json().error).not.toContain("ENOTFOUND");
    expect(res.json().error).toBe("An unexpected error occurred");
  });
});

describe("POST /api/setup/repos", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns 400 when no token provided", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/setup/repos",
      payload: {},
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("Token is required");
  });

  it("lists repos for a valid token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [
          {
            full_name: "org/repo",
            html_url: "https://github.com/org/repo",
            clone_url: "https://github.com/org/repo.git",
            default_branch: "main",
            private: false,
            description: "A repo",
            language: "TypeScript",
            pushed_at: "2026-03-27T10:00:00Z",
          },
        ],
      }),
    );

    const res = await app.inject({
      method: "POST",
      url: "/api/setup/repos",
      payload: { token: "ghp_valid" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().repos).toHaveLength(1);
    expect(res.json().repos[0].fullName).toBe("org/repo");
  });
});

describe("POST /api/setup/repos/gitlab", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("lists membership projects from the configured GitLab base URL with pagination", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        headers: { get: (name: string) => (name.toLowerCase() === "x-next-page" ? "2" : null) },
        json: async () => [
          {
            path_with_namespace: "org/repo-a",
            web_url: "https://gitlab.internal/org/repo-a",
            http_url_to_repo: "https://gitlab.internal/org/repo-a.git",
            default_branch: "main",
            visibility: "private",
            description: "A",
            last_activity_at: "2026-06-01T10:00:00Z",
          },
        ],
      })
      .mockResolvedValueOnce({
        ok: true,
        headers: { get: () => null },
        json: async () => [
          {
            path_with_namespace: "org/repo-b",
            web_url: "https://gitlab.internal/org/repo-b",
            http_url_to_repo: "https://gitlab.internal/org/repo-b.git",
            default_branch: "develop",
            visibility: "internal",
            description: null,
            last_activity_at: "2026-06-02T10:00:00Z",
          },
        ],
      });
    vi.stubGlobal("fetch", fetchSpy);

    const res = await app.inject({
      method: "POST",
      url: "/api/setup/repos/gitlab",
      payload: { baseUrl: "https://gitlab.internal", token: "gl-token" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().repos.map((repo: { fullName: string }) => repo.fullName)).toEqual([
      "org/repo-a",
      "org/repo-b",
    ]);
    expect(String(fetchSpy.mock.calls[0][0])).toContain("https://gitlab.internal/api/v4/projects");
    expect(new URL(String(fetchSpy.mock.calls[0][0])).searchParams.get("page")).toBe("1");
    expect(new URL(String(fetchSpy.mock.calls[1][0])).searchParams.get("page")).toBe("2");
  });
});

describe("admin guard on POST setup routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authDisabled = false;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("allows POST requests when no user is set (setup not yet complete)", async () => {
    const app = await buildTestApp(); // no user
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ login: "testuser", name: "Test" }),
      }),
    );

    const res = await app.inject({
      method: "POST",
      url: "/api/setup/validate/github-token",
      payload: { token: "ghp_test" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().valid).toBe(true);
  });

  it("allows POST requests for admin users", async () => {
    const app = await buildTestApp({ workspaceRole: "admin" });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ login: "testuser", name: "Test" }),
      }),
    );

    const res = await app.inject({
      method: "POST",
      url: "/api/setup/validate/github-token",
      payload: { token: "ghp_test" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().valid).toBe(true);
  });

  it("rejects POST requests for non-admin users with 403", async () => {
    const app = await buildTestApp({ workspaceRole: "member" });

    const res = await app.inject({
      method: "POST",
      url: "/api/setup/validate/github-token",
      payload: { token: "ghp_test" },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error).toContain("Admin role required");
  });

  it("rejects viewer role on POST routes", async () => {
    const app = await buildTestApp({ workspaceRole: "viewer" });

    const res = await app.inject({
      method: "POST",
      url: "/api/setup/validate/anthropic-key",
      payload: { key: "sk-ant-test" },
    });

    expect(res.statusCode).toBe(403);
  });

  it("skips admin guard when auth is disabled", async () => {
    authDisabled = true;
    const app = await buildTestApp({ workspaceRole: "viewer" });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ login: "testuser", name: "Test" }),
      }),
    );

    const res = await app.inject({
      method: "POST",
      url: "/api/setup/validate/github-token",
      payload: { token: "ghp_test" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().valid).toBe(true);
  });
});
