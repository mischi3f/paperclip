import { describe, expect, it, vi, afterEach } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { createPromptContextFixture } from "@paperclipai/adapter-utils/test-fixtures/prompt-context";
import { execute, mapFinalResultForTest, parseSseFramesForTest, resolveSessionKey } from "./execute.js";
import { testEnvironment } from "./test.js";

function makeCtx(config: Record<string, unknown>): AdapterExecutionContext {
  return {
    runId: "pc-run-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Hermes",
      adapterType: "hermes_gateway",
      adapterConfig: config,
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config,
    context: {
      issueId: "issue-1",
      wakeReason: "manual",
      paperclipWake: {
        issue: { identifier: "PAP-1", title: "Do the thing" },
      },
    },
    onLog: vi.fn(async () => undefined),
    onMeta: vi.fn(async () => undefined),
  };
}

function sseStream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveSessionKey", () => {
  it("derives issue-scoped session keys by default", () => {
    expect(
      resolveSessionKey({
        strategy: "issue",
        companyId: "company-1",
        agentId: "agent-1",
        runId: "run-1",
        issueId: "issue-1",
      }),
    ).toBe("paperclip:company:company-1:agent:agent-1:issue:issue-1");
  });

  it("omits the session key for none strategy", () => {
    expect(
      resolveSessionKey({
        strategy: "none",
        companyId: "company-1",
        agentId: "agent-1",
        runId: "run-1",
        issueId: "issue-1",
      }),
    ).toBeNull();
  });
});

describe("parseSseFramesForTest", () => {
  it("parses event and data lines while preserving partial frames", () => {
    const parsed = parseSseFramesForTest("event: message.delta\ndata: {\"delta\":\"hi\"}\n\n:data\ndata: later");
    expect(parsed.frames).toEqual([{ event: "message.delta", data: "{\"delta\":\"hi\"}" }]);
    expect(parsed.rest).toBe(":data\ndata: later");
  });
});

describe("execute", () => {
  it.each([
    "https://gateway-user:gateway-password@127.0.0.1:8642",
    "http://gateway-user@gateway.example:8642",
  ])("rejects apiBaseUrl userinfo without reflecting it (%s)", async (apiBaseUrl) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const ctx = makeCtx({ apiBaseUrl, apiKey: "secret-key" });

    const result = await execute(ctx);
    const serialized = JSON.stringify(result);

    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("hermes_gateway_api_base_url_invalid");
    expect(result.errorMessage).toBe("Invalid Hermes gateway apiBaseUrl.");
    expect(serialized).not.toContain("gateway-user");
    expect(serialized).not.toContain("gateway-password");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(ctx.onMeta).not.toHaveBeenCalled();
    expect(ctx.onLog).not.toHaveBeenCalled();
  });

  it("does not embed malformed secret-bearing apiBaseUrl input in errors", async () => {
    const malformed = "https://gateway-user:gateway-password@[invalid-host";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await execute(makeCtx({ apiBaseUrl: malformed, apiKey: "secret-key" }));
    const serialized = JSON.stringify(result);

    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("hermes_gateway_api_base_url_invalid");
    expect(result.errorMessage).toBe("Invalid Hermes gateway apiBaseUrl.");
    expect(serialized).not.toContain(malformed);
    expect(serialized).not.toContain("gateway-user");
    expect(serialized).not.toContain("gateway-password");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects remote plain HTTP unless the unsafe dev escape hatch is enabled", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ run_id: "unexpected" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await execute(makeCtx({
      apiBaseUrl: "http://192.168.1.25:8642",
      apiKey: "secret-key",
    }));

    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("hermes_gateway_plain_http_remote_denied");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports dispatch before starting the remote run create request", async () => {
    const ctx = makeCtx({
      apiBaseUrl: "http://127.0.0.1:8642",
      apiKey: "secret-key",
      timeoutSec: 5,
    });
    const onDispatch = vi.fn();
    ctx.onDispatch = onDispatch;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) {
        expect(onDispatch).toHaveBeenCalledTimes(1);
        return new Response(JSON.stringify({ run_id: "run-hermes-1", status: "started" }), { status: 200 });
      }
      if (url.endsWith("/events")) {
        return new Response(
          sseStream(["event: run.completed", "data: {\"status\":\"completed\",\"output\":\"done\"}", ""].join("\n")),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      return new Response(JSON.stringify({ status: "completed", output: "done" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await execute(ctx);

    expect(result.exitCode).toBe(0);
    expect(onDispatch).toHaveBeenCalledTimes(1);
  });

  it("constructs POST /v1/runs with auth, idempotency, and Hermes session headers", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) {
        return new Response(JSON.stringify({ run_id: "run-hermes-1", status: "started" }), { status: 200 });
      }
      if (url.endsWith("/events")) {
        return new Response(
          sseStream(
            [
              "event: message.delta",
              "data: {\"delta\":\"done\"}",
              "",
              "event: run.completed",
              "data: {\"status\":\"completed\",\"output\":\"done\",\"session_id\":\"session-1\",\"usage\":{\"input_tokens\":3,\"output_tokens\":2},\"model\":\"hermes-agent\"}",
              "",
            ].join("\n"),
          ),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      return new Response(JSON.stringify({ status: "completed", output: "done" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await execute(makeCtx({
      apiBaseUrl: "http://127.0.0.1:8642",
      apiKey: "secret-key",
      timeoutSec: 5,
    }));

    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe("done");
    expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 2 });

    const calls = fetchMock.mock.calls as Array<[RequestInfo | URL, RequestInit?]>;
    const createCall = calls.find(([input]) => String(input).endsWith("/v1/runs"));
    expect(createCall).toBeTruthy();
    const init = createCall?.[1] as RequestInit;
    expect(init.headers).toMatchObject({
      Authorization: "Bearer secret-key",
      "Content-Type": "application/json",
      "Idempotency-Key": "pc-run-1",
      "X-Hermes-Session-Key": "paperclip:company:company-1:agent:agent-1:issue:issue-1",
    });
    const body = JSON.parse(String(init.body));
    expect(body.input).toContain("Do the thing");
    expect(body.session_id).toBe("paperclip:company:company-1:agent:agent-1:issue:issue-1");
  });

  it("forwards only the allowlisted configured and authoritative Paperclip runtime environment", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => new Response(JSON.stringify(
      String(input).endsWith("/v1/runs")
        ? { run_id: "run-hermes-1", status: "completed", output: "done" }
        : { status: "completed", output: "done" },
    ), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const ctx = makeCtx({
      apiBaseUrl: "http://127.0.0.1:8642",
      apiKey: "hermes-gateway-key",
      paperclipApiUrl: "https://paperclip.example.test/api",
      env: {
        GH_TOKEN: "github-token",
        GIT_ASKPASS: "/usr/local/bin/wlg-github-askpass",
        GIT_TERMINAL_PROMPT: "0",
        ORDINARY_FLAG: "must-not-forward",
        PAPERCLIP_AGENT_ID: "spoofed-agent",
        PAPERCLIP_API_KEY: "spoofed-paperclip-key",
        PAPERCLIP_PROJECT_ID: "spoofed-project",
        PAPERCLIP_WORKSPACE_CWD: "/spoofed/cwd",
      },
      payloadTemplate: {
        environment: {
          GH_TOKEN: "template-github-token",
          ORDINARY_FLAG: "template-must-not-forward",
          PAPERCLIP_API_KEY: "template-paperclip-key",
        },
      },
    });
    ctx.authToken = "minted-run-token";
    ctx.context = {
      ...ctx.context,
      taskId: "task-1",
      wakeReason: "issue_commented",
      commentId: "comment-1",
      projectId: "project-1",
      approvalId: "approval-1",
      approvalStatus: "approved",
      issueIds: ["issue-1", "issue-2"],
      paperclipWorkspace: {
        cwd: "/workspace/project-1",
        source: "project_primary",
        strategy: "git_worktree",
        workspaceId: "workspace-1",
        repoUrl: "https://github.com/example/repo.git",
        repoRef: "refs/heads/main",
        branchName: "PAP-1-hardening",
        worktreePath: "/workspace/worktrees/PAP-1",
      },
    };

    const result = await execute(ctx);

    expect(result.exitCode).toBe(0);
    const calls = fetchMock.mock.calls as Array<[RequestInfo | URL, RequestInit?]>;
    const createCall = calls.find(([input]) => String(input).endsWith("/v1/runs"));
    const body = JSON.parse(String(createCall?.[1]?.body)) as {
      environment: Record<string, string>;
    };
    expect(body.environment).toEqual({
      GH_TOKEN: "github-token",
      GIT_ASKPASS: "/usr/local/bin/wlg-github-askpass",
      GIT_TERMINAL_PROMPT: "0",
      PAPERCLIP_AGENT_ID: "agent-1",
      PAPERCLIP_COMPANY_ID: "company-1",
      PAPERCLIP_API_URL: "https://paperclip.example.test/api",
      PAPERCLIP_API_KEY: "minted-run-token",
      PAPERCLIP_RUN_ID: "pc-run-1",
      PAPERCLIP_TASK_ID: "task-1",
      PAPERCLIP_WAKE_REASON: "issue_commented",
      PAPERCLIP_WAKE_COMMENT_ID: "comment-1",
      PAPERCLIP_PROJECT_ID: "project-1",
      PAPERCLIP_PROJECT_WORKSPACE_ID: "workspace-1",
      PAPERCLIP_APPROVAL_ID: "approval-1",
      PAPERCLIP_APPROVAL_STATUS: "approved",
      PAPERCLIP_LINKED_ISSUE_IDS: "issue-1,issue-2",
      PAPERCLIP_WORKSPACE_CWD: "/workspace/project-1",
      PAPERCLIP_WORKSPACE_SOURCE: "project_primary",
      PAPERCLIP_WORKSPACE_STRATEGY: "git_worktree",
      PAPERCLIP_WORKSPACE_ID: "workspace-1",
      PAPERCLIP_WORKSPACE_REPO_URL: "https://github.com/example/repo.git",
      PAPERCLIP_WORKSPACE_REPO_REF: "refs/heads/main",
      PAPERCLIP_WORKSPACE_BRANCH: "PAP-1-hardening",
      PAPERCLIP_WORKSPACE_WORKTREE_PATH: "/workspace/worktrees/PAP-1",
    });
  });

  it("rejects HTTP(S) workspace repo URL userinfo before dispatch without persisting credentials", async () => {
    const repoUrl = "https://repo-user:repo-password@github.com/example/repo.git";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const ctx = makeCtx({ apiBaseUrl: "http://127.0.0.1:8642", apiKey: "secret-key" });
    ctx.context.paperclipWorkspace = { repoUrl };

    const result = await execute(ctx);
    const serialized = JSON.stringify(result);

    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("hermes_gateway_workspace_repo_url_invalid");
    expect(result.errorMessage).toBe("Paperclip workspace repo URL must be valid and credential-free.");
    expect(serialized).not.toContain(repoUrl);
    expect(serialized).not.toContain("repo-user");
    expect(serialized).not.toContain("repo-password");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(ctx.onMeta).not.toHaveBeenCalled();
    expect(ctx.onLog).not.toHaveBeenCalled();
  });

  it.each([
    ["ssh://git:ssh-password@github.com/example/repo.git", "ssh-password"],
    ["git://git:git-password@github.com/example/repo.git", "git-password"],
    ["ftp://git:ftp-password@github.com/example/repo.git", "ftp-password"],
    ["custom://git:custom-password@github.com/example/repo.git", "custom-password"],
  ])("rejects password-bearing repository URL userinfo without logging or persisting it (%s)", async (repoUrl, password) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const ctx = makeCtx({ apiBaseUrl: "http://127.0.0.1:8642", apiKey: "hermes-test-key" });
    ctx.context.paperclipWorkspace = { repoUrl };

    const result = await execute(ctx);
    const logText = (ctx.onLog as ReturnType<typeof vi.fn>).mock.calls.map(([, line]) => String(line)).join("\n");
    const persistedText = JSON.stringify(result);

    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("hermes_gateway_workspace_repo_url_invalid");
    expect(logText).not.toContain(repoUrl);
    expect(logText).not.toContain(password);
    expect(persistedText).not.toContain(repoUrl);
    expect(persistedText).not.toContain(password);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(ctx.onMeta).not.toHaveBeenCalled();
    expect(ctx.onLog).not.toHaveBeenCalled();
  });

  it.each([
    "ssh://git:@github.com/example/repo.git",
    "ssh://git%3Aencoded-password@github.com/example/repo.git",
    "git://git@github.com/example/repo.git",
  ])("rejects ambiguous non-HTTP repository URL userinfo (%s)", async (repoUrl) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const ctx = makeCtx({
      apiBaseUrl: "http://127.0.0.1:8642",
      apiKey: "hermes-test-key",
    });
    ctx.context.paperclipWorkspace = { repoUrl };

    const result = await execute(ctx);

    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("hermes_gateway_workspace_repo_url_invalid");
    expect(JSON.stringify(result)).not.toContain(repoUrl);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(ctx.onMeta).not.toHaveBeenCalled();
    expect(ctx.onLog).not.toHaveBeenCalled();
  });

  it("sends a credential-free canonical repo URL and redacts reflected URL credentials everywhere", async () => {
    const queryToken = "repo-query-token-123";
    const queryPassword = "repo-query-password-456";
    const camelAccessToken = "repo-camel-access-token-654";
    const fragmentToken = "repo-fragment-token-789";
    const camelClientSecret = "repo-camel-client-secret-987";
    const repoUrl = `https://github.com/example/repo.git?ref=main&token=${queryToken}&password=${queryPassword}&accessToken=${camelAccessToken}#view=code&access_token=${fragmentToken}&clientSecret=${camelClientSecret}`;
    const canonicalRepoUrl = "https://github.com/example/repo.git?ref=main#view=code";
    const ctx = makeCtx({
      apiBaseUrl: "http://127.0.0.1:8642",
      apiKey: "secret-key",
      timeoutSec: 5,
    });
    ctx.context.paperclipWorkspace = { repoUrl };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) {
        const body = JSON.parse(String(init?.body)) as { environment: Record<string, string> };
        expect(body.environment.PAPERCLIP_WORKSPACE_REPO_URL).toBe(canonicalRepoUrl);
        expect(JSON.stringify(body)).not.toContain(queryToken);
        expect(JSON.stringify(body)).not.toContain(queryPassword);
        expect(JSON.stringify(body)).not.toContain(camelAccessToken);
        expect(JSON.stringify(body)).not.toContain(fragmentToken);
        expect(JSON.stringify(body)).not.toContain(camelClientSecret);
        return new Response(JSON.stringify({ run_id: "run-hermes-1", status: "started" }), { status: 200 });
      }
      if (url.endsWith("/events")) {
        return new Response(
          sseStream([
            `event: run.completed.${queryToken}`,
            `data: ${JSON.stringify({
              status: "completed",
              output: `repo ${repoUrl}`,
              session_id: `session-${queryPassword}`,
              model: `model-${fragmentToken}`,
            })}`,
            "",
          ].join("\n")),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      return new Response(JSON.stringify({ status: "completed", output: repoUrl }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await execute(ctx);
    const logText = (ctx.onLog as ReturnType<typeof vi.fn>).mock.calls.map(([, line]) => String(line)).join("\n");
    const persistedText = JSON.stringify(result);

    expect(result.exitCode).toBe(0);
    expect(result.summary).toContain("[redacted");
    expect(result.resultJson?.output).toBe(result.summary);
    expect(result.sessionId).toContain("[redacted");
    expect(result.sessionDisplayId).toBe(result.sessionId);
    expect(result.model).toContain("[redacted");
    expect(result.resultJson?.last_event).toContain("[redacted");
    for (const secret of [repoUrl, queryToken, queryPassword, camelAccessToken, fragmentToken, camelClientSecret]) {
      expect(logText).not.toContain(secret);
      expect(persistedText).not.toContain(secret);
    }
  });

  it("strips prefixed signed-URL credentials while preserving benign query and fragment parameters", async () => {
    const awsSignature = "aws-signature-secret";
    const googleSignature = "google-signature-secret";
    const googleCredential = "google-credential-secret";
    const authToken = "prefixed-auth-token-secret";
    const clientKey = "prefixed-client-key-secret";
    const signingSecret = "prefixed-signing-secret";
    const dbPassword = "prefixed-db-password-secret";
    const repoUrl = `https://storage.example.test/repo.git?ref=main&X-Amz-Signature=${awsSignature}&X-Goog-Credential=${googleCredential}&client-key=${clientKey}&signing_secret=${signingSecret}#view=code&X-Goog-Signature=${googleSignature}&vendor_auth=${authToken}&db.password=${dbPassword}`;
    const sensitiveValues = [
      awsSignature,
      googleSignature,
      googleCredential,
      authToken,
      clientKey,
      signingSecret,
      dbPassword,
    ];
    const ctx = makeCtx({
      apiBaseUrl: "http://127.0.0.1:8642",
      apiKey: "hermes-test-key",
      timeoutSec: 5,
    });
    ctx.context.paperclipWorkspace = { repoUrl };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) {
        const body = JSON.parse(String(init?.body)) as { environment: Record<string, string> };
        expect(body.environment.PAPERCLIP_WORKSPACE_REPO_URL)
          .toBe("https://storage.example.test/repo.git?ref=main#view=code");
        return new Response(JSON.stringify({ run_id: "run-hermes-1" }), { status: 200 });
      }
      if (url.endsWith("/events")) {
        return new Response(
          sseStream(`event: run.completed\ndata: ${JSON.stringify({ status: "completed", output: repoUrl })}\n\n`),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      return new Response(JSON.stringify({ status: "completed", output: "done" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await execute(ctx);
    const persistedText = JSON.stringify(result);
    const createCall = (fetchMock.mock.calls as Array<[RequestInfo | URL, RequestInit?]>)
      .find(([input]) => String(input).endsWith("/v1/runs"));
    const requestBody = String(createCall?.[1]?.body);

    expect(result.exitCode).toBe(0);
    for (const secret of sensitiveValues) {
      expect(requestBody).not.toContain(secret);
      expect(persistedText).not.toContain(secret);
    }
  });

  it("redacts reflected repo URL credentials from HTTP error metadata", async () => {
    const queryToken = "repo-error-token-123";
    const repoUrl = `https://github.com/example/repo.git?token=${queryToken}`;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      message: `clone failed for ${repoUrl}`,
      nested: { repoUrl, token: queryToken },
    }), { status: 401 })));
    const ctx = makeCtx({ apiBaseUrl: "http://127.0.0.1:8642", apiKey: "secret-key" });
    ctx.context.paperclipWorkspace = { repoUrl };

    const result = await execute(ctx);
    const persistedText = JSON.stringify(result);

    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("hermes_gateway_auth_failed");
    expect(persistedText).not.toContain(repoUrl);
    expect(persistedText).not.toContain(queryToken);
    expect(result.errorMeta?.body).toMatchObject({
      message: expect.stringContaining("[redacted"),
      nested: {
        repoUrl: expect.stringContaining("[redacted"),
        token: expect.stringContaining("[redacted"),
      },
    });
  });

  it.each([
    "git@github.com:example/repo.git",
    "ssh://git@github.com/example/repo.git",
    "git+ssh://git@github.com/example/repo.git",
  ])("preserves legitimate SSH-style workspace repo URLs (%s)", async (repoUrl) => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => new Response(JSON.stringify(
      String(input).endsWith("/v1/runs")
        ? { run_id: "run-hermes-1", status: "started" }
        : { status: "completed", output: "done" },
    ), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const ctx = makeCtx({ apiBaseUrl: "http://127.0.0.1:8642", apiKey: "secret-key", timeoutSec: 5 });
    ctx.context.paperclipWorkspace = { repoUrl };

    const result = await execute(ctx);
    const createCall = (fetchMock.mock.calls as Array<[RequestInfo | URL, RequestInit?]>)
      .find(([input]) => String(input).endsWith("/v1/runs"));
    const body = JSON.parse(String(createCall?.[1]?.body)) as { environment: Record<string, string> };

    expect(result.exitCode).toBe(0);
    expect(body.environment.PAPERCLIP_WORKSPACE_REPO_URL).toBe(repoUrl);
  });

  it("uses the authoritative workspace project ID when top-level context disagrees", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => new Response(JSON.stringify(
      String(input).endsWith("/v1/runs")
        ? { run_id: "run-hermes-1", status: "completed", output: "done" }
        : { status: "completed", output: "done" },
    ), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const ctx = makeCtx({
      apiBaseUrl: "http://127.0.0.1:8642",
      apiKey: "hermes-key",
    });
    ctx.context = {
      ...ctx.context,
      projectId: "stale-or-spoofed-project",
      paperclipWorkspace: {
        projectId: "authoritative-workspace-project",
      },
    };

    const result = await execute(ctx);

    expect(result.exitCode).toBe(0);
    const calls = fetchMock.mock.calls as Array<[RequestInfo | URL, RequestInit?]>;
    const createCall = calls.find(([input]) => String(input).endsWith("/v1/runs"));
    const body = JSON.parse(String(createCall?.[1]?.body)) as {
      environment: Record<string, string>;
    };
    expect(body.environment.PAPERCLIP_PROJECT_ID).toBe("authoritative-workspace-project");
  });

  it.each([false, true])("preserves chat handoff policy on gateway turns (resumed=%s)", async (resumed) => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => new Response(JSON.stringify(
      String(input).endsWith("/v1/runs")
        ? { run_id: "run-hermes-1", status: "started" }
        : { status: "completed", output: "done" },
    ), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const ctx = makeCtx({ apiBaseUrl: "http://127.0.0.1:8642", apiKey: "secret-key", timeoutSec: 5 });
    ctx.config.payloadTemplate = { input: "Custom gateway instruction." };
    const directive = "Chat directive: clarify goals and hand plans off to project tasks.";
    ctx.context = {
      conversationMode: true,
      issueId: "issue-1",
      paperclipTaskMarkdown: directive,
      paperclipTaskMarkdownCompact: directive,
      paperclipWake: {
        reason: "issue_commented",
        issue: { id: "issue-1", workMode: "planning", status: "in_progress" },
        interactionKind: "request_confirmation",
        interactionStatus: "accepted",
      },
    };
    if (resumed) ctx.runtime.sessionId = "prior-session";
    await execute(ctx);
    const calls = fetchMock.mock.calls as Array<[RequestInfo | URL, RequestInit?]>;
    const call = calls.find(([input]) => String(input).endsWith("/v1/runs"));
    const prompt = JSON.parse(String(call?.[1]?.body)).input as string;
    expect(prompt).toContain("Custom gateway instruction.");
    expect(prompt).toContain(directive);
    expect(prompt).not.toContain("Execution contract:");
    expect(prompt).not.toContain("clear final disposition");
    expect(prompt).not.toContain("Create child issues");
  });

  it("sends the task brief once on fresh runs and compacts it on stable-session resumes", async () => {
    const description = "Update launch-card.svg and change the CTA to Try Team free.";
    const fullTaskMarkdown = [
      "Paperclip task context:",
      '- Issue: "PAP-1"',
      "",
      "Issue description:",
      "```text",
      description,
      "```",
    ].join("\n");
    const compactTaskMarkdown = ["Paperclip task context:", '- Issue: "PAP-1"'].join("\n");
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) {
        return new Response(JSON.stringify({ run_id: "run-hermes-1", status: "started" }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: "completed", output: "done" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const wakeContext = (reason: string) => ({
      issueId: "issue-1",
      wakeReason: reason,
      paperclipTaskMarkdown: fullTaskMarkdown,
      paperclipTaskMarkdownCompact: compactTaskMarkdown,
      paperclipWake: {
        reason,
        issue: {
          id: "issue-1",
          identifier: "PAP-1",
          title: "Do the thing",
          description,
          descriptionTruncated: false,
          status: "in_progress",
        },
        commentWindow: { requestedCount: 0, includedCount: 0, missingCount: 0 },
        comments: [],
        fallbackFetchNeeded: false,
      },
    });

    const freshCtx = makeCtx({ apiBaseUrl: "http://127.0.0.1:8642", apiKey: "secret-key", timeoutSec: 5 });
    freshCtx.context = wakeContext("issue_assigned");
    await execute(freshCtx);

    const resumeCtx = makeCtx({ apiBaseUrl: "http://127.0.0.1:8642", apiKey: "secret-key", timeoutSec: 5 });
    resumeCtx.context = wakeContext("issue_commented");
    resumeCtx.runtime = {
      sessionId: "session-1",
      sessionParams: null,
      sessionDisplayId: "session-1",
      taskKey: "PAP-1",
    };
    await execute(resumeCtx);

    const calls = fetchMock.mock.calls as Array<[RequestInfo | URL, RequestInit?]>;
    const runBodies = calls
      .filter(([input]) => String(input).endsWith("/v1/runs"))
      .map(([, init]) => JSON.parse(String(init?.body)) as { input: string });
    expect(runBodies).toHaveLength(2);
    // Fresh run: brief exactly once (task markdown only; wake-prompt copy suppressed).
    expect(runBodies[0]!.input.split(description)).toHaveLength(2);
    // Stable-session resume: compact task markdown, no re-sent brief.
    expect(runBodies[1]!.input).toContain("Paperclip task context:");
    expect(runBodies[1]!.input).not.toContain(description);
  });

  it.each([false, true])("delivers the shared assignment and ordered comments at the HTTP boundary (resumed=%s)", async (resumed) => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) {
        return new Response(JSON.stringify({ run_id: "run-hermes-1", status: "completed", output: "done" }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: "completed", output: "done" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const ctx = makeCtx({
      apiBaseUrl: "http://127.0.0.1:8642",
      apiKey: "secret-key",
      timeoutSec: 5,
      payloadTemplate: { input: "Custom gateway instruction." },
    });
    const promptContext = createPromptContextFixture();
    ctx.context = { ...promptContext, conversationMode: true };
    if (resumed) ctx.runtime.sessionId = "prior-session";

    const result = await execute(ctx);

    expect(result.exitCode).toBe(0);
    const calls = fetchMock.mock.calls as Array<[RequestInfo | URL, RequestInit?]>;
    const runCall = calls.find(([input]) => String(input).endsWith("/v1/runs"));
    const input = JSON.parse(String(runCall?.[1]?.body)).input as string;
    expect(input).toContain("Custom gateway instruction.");
    expect(input.indexOf("Append the same ledger entry.")).toBeGreaterThanOrEqual(0);
    expect(input.indexOf("Append the same ledger entry.")).toBeLessThan(input.indexOf("Change the final scope to the launch checklist."));
    expect(input.split("Append the same ledger entry.")).toHaveLength(3);
    expect(input).not.toContain("Structured wake payload JSON:");
    expect(input.split("Keep this deliberate repetition. Keep this deliberate repetition.")).toHaveLength(2);
    const continuationHeading = "## Current request and continuation context";
    const continuationStart = input.indexOf(continuationHeading);
    const fencedStart = input.indexOf("```text\n", continuationStart);
    const fencedEnd = input.indexOf("\n```", fencedStart + "```text\n".length);
    expect(continuationStart).toBeGreaterThanOrEqual(0);
    expect(fencedStart).toBeGreaterThan(continuationStart);
    expect(fencedEnd).toBeGreaterThan(fencedStart);
    const continuation = JSON.parse(input.slice(
      fencedStart + "```text\n".length,
      fencedEnd,
    )) as Record<string, unknown>;
    expect(continuation.objectiveSource).toEqual(promptContext.executionContinuation.objectiveSource);
    if (resumed) {
      expect(input).toContain("## Compact assignment");
      expect(continuation.objective).toBe("Keep this deliberate repetition. Keep this deliberate repetition.");
    } else {
      expect(continuation).not.toHaveProperty("objective");
    }
  });

  it("routes a bare Hermes dashboard URL on port 9119 through the API prefix", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "http://127.0.0.1:9119/api/v1/runs") {
        return new Response(JSON.stringify({ run_id: "run-hermes-1", status: "started" }), { status: 200 });
      }
      if (url === "http://127.0.0.1:9119/api/v1/runs/run-hermes-1/events") {
        return new Response(
          sseStream(
            [
              "event: run.completed",
              "data: {\"status\":\"completed\",\"output\":\"done\"}",
              "",
            ].join("\n"),
          ),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      return new Response(JSON.stringify({ status: "completed", output: "done" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const ctx = makeCtx({
      apiBaseUrl: "http://127.0.0.1:9119",
      apiKey: "secret-key",
      timeoutSec: 5,
    });
    const result = await execute(ctx);

    expect(result.exitCode).toBe(0);
    expect(ctx.onMeta).toHaveBeenCalledWith(
      expect.objectContaining({
        commandArgs: ["http://127.0.0.1:9119/api/v1/runs"],
      }),
    );
    expect((ctx.onLog as ReturnType<typeof vi.fn>).mock.calls.map(([, line]) => String(line)).join("\n"))
      .toContain("creating run at http://127.0.0.1:9119/api/v1/runs");
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual(
      expect.arrayContaining([
        "http://127.0.0.1:9119/api/v1/runs",
        "http://127.0.0.1:9119/api/v1/runs/run-hermes-1/events",
      ]),
    );
  });

  it("renders current wake comments once when the gateway task brief owns them", async () => {
    const commentBody = "Keep this current comment exactly once.";
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) {
        return new Response(JSON.stringify({ run_id: "run-hermes-1", status: "started" }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: "completed", output: "done" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const ctx = makeCtx({ apiBaseUrl: "http://127.0.0.1:8642", apiKey: "secret-key" });
    ctx.context = {
      issueId: "issue-1",
      paperclipTaskMarkdown: [
        "Paperclip task context:",
        '- Issue: "PAP-1"',
      ].join("\n"),
      paperclipTurnContext: {
        version: 1,
        assignment: { owner: "task_markdown" },
        events: { owner: "wake_prompt", comments: [{ id: "comment-1", revision: "rev-1" }] },
      },
      paperclipWake: {
        reason: "issue_commented",
        issue: { id: "issue-1", identifier: "PAP-1", title: "Do the thing", status: "in_progress" },
        commentWindow: { requestedCount: 1, includedCount: 1, missingCount: 0 },
        comments: [{ id: "comment-1", body: commentBody }],
        fallbackFetchNeeded: false,
      },
    };

    await execute(ctx);
    const calls = fetchMock.mock.calls as Array<[RequestInfo | URL, RequestInit?]>;
    const runCall = calls.find(([input]) => String(input).endsWith("/v1/runs"));
    const prompt = JSON.parse(String(runCall?.[1]?.body)).input as string;
    expect(prompt.split(commentBody)).toHaveLength(2);
  });

  it("routes the default Hermes dashboard chat URL on port 9119 through the API prefix", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "http://127.0.0.1:9119/api/v1/runs") {
        return new Response(JSON.stringify({ run_id: "run-hermes-chat", status: "started" }), { status: 200 });
      }
      if (url === "http://127.0.0.1:9119/api/v1/runs/run-hermes-chat/events") {
        return new Response(
          sseStream(
            [
              "event: run.completed",
              "data: {\"status\":\"completed\",\"output\":\"done\"}",
              "",
            ].join("\n"),
          ),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      return new Response(JSON.stringify({ status: "completed", output: "done" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const ctx = makeCtx({
      apiBaseUrl: "http://127.0.0.1:9119/chat",
      apiKey: "secret-key",
      timeoutSec: 5,
    });
    const result = await execute(ctx);

    expect(result.exitCode).toBe(0);
    expect(ctx.onMeta).toHaveBeenCalledWith(
      expect.objectContaining({
        commandArgs: ["http://127.0.0.1:9119/api/v1/runs"],
      }),
    );
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual(
      expect.arrayContaining([
        "http://127.0.0.1:9119/api/v1/runs",
        "http://127.0.0.1:9119/api/v1/runs/run-hermes-chat/events",
      ]),
    );
  });

  it("redacts echoed gateway, Paperclip, and Git auth material from stream logs and summaries", async () => {
    const gatewayApiKey = "secret-key";
    const paperclipApiKey = "paperclip-run-token";
    const githubToken = "github-runtime-token";
    const sessionKey = "paperclip:company:company-1:agent:agent-1:issue:issue-1";
    const customHeaderValue = "custom-stream-header";
    const ctx = makeCtx({
      apiBaseUrl: "http://127.0.0.1:8642",
      apiKey: gatewayApiKey,
      env: { GH_TOKEN: githubToken },
      headers: { Cookie: customHeaderValue },
      timeoutSec: 5,
    });
    ctx.authToken = paperclipApiKey;
    const secrets = [gatewayApiKey, paperclipApiKey, githubToken, sessionKey, customHeaderValue];
    const echoedSecrets = `Authorization: Bearer ${gatewayApiKey} Paperclip ${paperclipApiKey} Git ${githubToken} Session ${sessionKey} Cookie ${customHeaderValue}`;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) {
        return new Response(JSON.stringify({ run_id: "run-hermes-1", status: "started" }), { status: 200 });
      }
      if (url.endsWith("/events")) {
        return new Response(
          sseStream(
            [
              "event: message.delta",
              `data: ${JSON.stringify({ delta: echoedSecrets })}`,
              "",
              "event: run.completed",
              `data: ${JSON.stringify({ status: "completed", output: echoedSecrets })}`,
              "",
            ].join("\n"),
          ),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      return new Response(JSON.stringify({ status: "completed" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await execute(ctx);
    const logText = (ctx.onLog as ReturnType<typeof vi.fn>).mock.calls.map(([, line]) => String(line)).join("\n");
    const persistedText = JSON.stringify(result);

    expect(result.exitCode).toBe(0);
    expect(result.summary).toContain("Bearer [redacted]");
    expect(result.resultJson?.output).toBe(result.summary);
    expect(logText).toContain("Bearer [redacted]");
    for (const secret of secrets) {
      expect(logText).not.toContain(secret);
      expect(persistedText).not.toContain(secret);
    }
  });

  it("redacts agent-scoped Paperclip session keys from logs and public result metadata", async () => {
    const ctx = makeCtx({
      apiBaseUrl: "http://127.0.0.1:8642",
      apiKey: "secret-key",
      sessionKeyStrategy: "agent",
      timeoutSec: 5,
    });
    const agentSessionKey = "paperclip:company:company-1:agent:agent-1";
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) {
        return new Response(JSON.stringify({ run_id: "run-hermes-1", status: "started" }), { status: 200 });
      }
      if (url.endsWith("/events")) {
        return new Response(
          sseStream(
            [
              "event: message.delta",
              `data: {"delta":"session ${agentSessionKey}"}`,
              "",
              "event: run.completed",
              `data: {"status":"completed","output":"session ${agentSessionKey}","session_id":"${agentSessionKey}"}`,
              "",
            ].join("\n"),
          ),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      return new Response(JSON.stringify({ status: "completed" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await execute(ctx);
    const logText = (ctx.onLog as ReturnType<typeof vi.fn>).mock.calls.map(([, line]) => String(line)).join("\n");

    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe("session [redacted-session-key]");
    expect(result.sessionId).toBe("[redacted-session-key]");
    expect(result.sessionDisplayId).toBe("[redacted-session-key]");
    expect(result.resultJson?.session_id).toBe("[redacted-session-key]");
    expect(result.sessionParams).toEqual({
      hermesRunId: "run-hermes-1",
      strategy: "agent",
    });
    expect(logText).toContain("[redacted-session-key]");
    expect(logText).not.toContain(agentSessionKey);
  });

  it("redacts secret echoes from gateway-controlled identifiers, events, models, logs, and result metadata", async () => {
    const secret = "gateway-secret-value";
    const gatewayRunId = `remote-${secret}-run`;
    const eventName = `run.completed.${secret}`;
    const model = `model-${secret}-v1`;
    const ctx = makeCtx({
      apiBaseUrl: "http://127.0.0.1:8642",
      apiKey: secret,
      timeoutSec: 5,
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) {
        return new Response(JSON.stringify({ run_id: gatewayRunId, status: "started" }), { status: 200 });
      }
      if (url.endsWith("/events")) {
        return new Response(
          sseStream(
            [
              `event: ${eventName}`,
              `data: ${JSON.stringify({
                status: "completed",
                output: "safe output",
                model,
                session_id: "safe-session-id",
              })}`,
              "",
            ].join("\n"),
          ),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      return new Response(JSON.stringify({ status: "completed", output: "safe output" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await execute(ctx);
    const logText = (ctx.onLog as ReturnType<typeof vi.fn>).mock.calls.map(([, line]) => String(line)).join("\n");
    const persistedText = JSON.stringify(result);

    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe("safe output");
    expect(result.sessionId).toBe("safe-session-id");
    expect(result.model).toMatch(/^model-\[redacted len=\d+\]-v1$/);
    expect(result.sessionParams?.hermesRunId).toMatch(/^remote-\[redacted len=\d+\]-run$/);
    expect(result.resultJson?.run_id).toBe(result.sessionParams?.hermesRunId);
    expect(result.resultJson?.last_event).toMatch(/^run\.completed\.\[redacted len=\d+\]$/);
    expect(logText).toContain("remote-[redacted len=");
    expect(logText).toContain("run.completed.[redacted len=");
    expect(logText).not.toContain(secret);
    expect(persistedText).not.toContain(secret);
  });

  it("falls back to polling when SSE is unavailable", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) {
        return new Response(JSON.stringify({ run_id: "run-hermes-1", status: "started" }), { status: 200 });
      }
      if (url.endsWith("/events")) {
        return new Response("no stream", { status: 503 });
      }
      return new Response(JSON.stringify({
        status: "completed",
        output: "polled done",
        session_id: "session-polled",
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await execute(makeCtx({
      apiBaseUrl: "http://127.0.0.1:8642",
      apiKey: "secret-key",
      timeoutSec: 5,
      pollIntervalMs: 250,
    }));

    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe("polled done");
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith("/v1/runs/run-hermes-1"))).toBe(true);
  });

  it("maps HTTP auth failures", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "bad key" }), { status: 401 })));
    const result = await execute(makeCtx({
      apiBaseUrl: "http://127.0.0.1:8642",
      apiKey: "secret-key",
    }));
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("hermes_gateway_auth_failed");
    expect(result.errorMessage).toContain("Check adapterConfig.apiKey matches the Hermes API_SERVER_KEY");
  });

  it("includes network causes in connection failure messages", async () => {
    const cause = Object.assign(new Error("getaddrinfo ENOTFOUND host.docker.internal"), { code: "ENOTFOUND" });
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw Object.assign(new Error("fetch failed"), { cause });
    }));

    const result = await execute(makeCtx({
      apiBaseUrl: "http://host.docker.internal:8642",
      apiKey: "secret-key",
      dangerouslyAllowInsecureRemoteHttp: true,
    }));

    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("hermes_gateway_connect_failed");
    expect(result.errorMessage).toContain("ENOTFOUND");
    expect(result.errorMessage).toContain("host.docker.internal");
  });

  it("redacts echoed gateway, Paperclip, and Git auth material from HTTP create errors", async () => {
    const paperclipApiKey = "paperclip-run-token";
    const githubToken = "github-runtime-token";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            message: `Authorization rejected: Bearer secret-key Paperclip ${paperclipApiKey} Git ${githubToken}`,
            detail: "X-Hermes-Session-Key: paperclip:company:company-1:agent:agent-1:issue:issue-1",
            nested: {
              note: "session paperclip:company:company-1:agent:agent-1",
            },
          }),
          { status: 401 },
        )),
    );

    const ctx = makeCtx({
      apiBaseUrl: "http://127.0.0.1:8642",
      apiKey: "secret-key",
      env: { GH_TOKEN: githubToken },
    });
    ctx.authToken = paperclipApiKey;
    const result = await execute(ctx);

    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("hermes_gateway_auth_failed");
    expect(result.errorMeta?.body).toEqual({
      message: "Authorization rejected: Bearer [redacted] Paperclip [redacted len=19] Git [redacted len=20]",
      detail: "X-Hermes-Session-Key: [redacted]",
      nested: {
        note: "session [redacted-session-key]",
      },
    });
    expect(result.errorMessage).not.toContain("secret-key");
    expect(result.errorMessage).not.toContain(paperclipApiKey);
    expect(result.errorMessage).not.toContain(githubToken);
  });

  it("redacts normalized camelCase sensitive keys recursively from HTTP error metadata", async () => {
    const sensitiveValues = {
      accessToken: "http-access-token-value",
      clientSecret: "http-client-secret-value",
      refreshToken: "http-refresh-token-value",
      idToken: "http-id-token-value",
      userPassword: "http-password-value",
      legacyPasswd: "http-passwd-value",
      clientCredential: "http-credential-value",
      proxyAuthorization: "http-authorization-value",
      sessionCookie: "http-cookie-value",
      serviceApiKey: "http-api-key-value",
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      ...sensitiveValues,
      nested: [{ clientSecret: sensitiveValues.clientSecret }, { refresh_token: sensitiveValues.refreshToken }],
      tokenCount: 17,
      secretName: "deployment-signing-secret",
      passwordPolicy: "strict",
      credentialType: "oauth",
      authorizationStatus: "denied",
      cookieDomain: "example.test",
      apiKeyRotationDate: "2026-12-01",
    }), { status: 401 })));

    const result = await execute(makeCtx({
      apiBaseUrl: "http://127.0.0.1:8642",
      apiKey: "hermes-test-key"
    }));
    const persistedText = JSON.stringify(result);

    expect(result.exitCode).toBe(1);
    expect(result.errorMeta?.body).toMatchObject({
      accessToken: expect.stringContaining("[redacted len="),
      clientSecret: expect.stringContaining("[redacted len="),
      refreshToken: expect.stringContaining("[redacted len="),
      idToken: expect.stringContaining("[redacted len="),
      userPassword: expect.stringContaining("[redacted len="),
      legacyPasswd: expect.stringContaining("[redacted len="),
      clientCredential: expect.stringContaining("[redacted len="),
      proxyAuthorization: expect.stringContaining("[redacted len="),
      sessionCookie: expect.stringContaining("[redacted len="),
      serviceApiKey: expect.stringContaining("[redacted len="),
      nested: [
        { clientSecret: expect.stringContaining("[redacted len=") },
        { refresh_token: expect.stringContaining("[redacted len=") },
      ],
      tokenCount: 17,
      secretName: "deployment-signing-secret",
      passwordPolicy: "strict",
      credentialType: "oauth",
      authorizationStatus: "denied",
      cookieDomain: "example.test",
      apiKeyRotationDate: "2026-12-01",
    });
    for (const secret of Object.values(sensitiveValues)) expect(persistedText).not.toContain(secret);
  });

  it("redacts normalized camelCase sensitive keys from event logs while preserving safe metadata", async () => {
    const accessToken = "event-access-token-value";
    const clientSecret = "event-client-secret-value";
    const refreshToken = "event-refresh-token-value";
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) {
        return new Response(JSON.stringify({ run_id: "run-hermes-1", status: "started" }), { status: 200 });
      }
      if (url.endsWith("/events")) {
        return new Response(sseStream([
          "event: message.delta",
          `data: ${JSON.stringify({
            delta: "safe output",
            accessToken,
            nested: { clientSecret, entries: [{ refreshToken }] },
            tokenCount: 3,
            secretName: "safe-secret-label",
          })}`,
          "",
          "event: run.completed",
          `data: ${JSON.stringify({ status: "completed", output: "safe output" })}`,
          "",
        ].join("\n")), { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      return new Response(JSON.stringify({ status: "completed", output: "safe output" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const ctx = makeCtx({ apiBaseUrl: "http://127.0.0.1:8642", apiKey: "hermes-test-key", timeoutSec: 5 });
    const result = await execute(ctx);
    const logText = (ctx.onLog as ReturnType<typeof vi.fn>).mock.calls.map(([, line]) => String(line)).join("\n");

    expect(result.exitCode).toBe(0);
    expect(logText).toContain('\"tokenCount\":3');
    expect(logText).toContain('\"secretName\":\"safe-secret-label\"');
    expect(logText).toContain('\"accessToken\":\"[redacted len=');
    expect(logText).toContain('\"clientSecret\":\"[redacted len=');
    expect(logText).toContain('\"refreshToken\":\"[redacted len=');
    for (const secret of [accessToken, clientSecret, refreshToken]) expect(logText).not.toContain(secret);
  });

  it("redacts normalized camelCase sensitive keys from persisted protocol-error metadata", async () => {
    const accessToken = "result-access-token-value";
    const clientSecret = "result-client-secret-value";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      status: "started",
      accessToken,
      nested: { clientSecret },
      tokenCount: 9,
      credentialType: "service-account",
    }), { status: 200 })));

    const result = await execute(makeCtx({
      apiBaseUrl: "http://127.0.0.1:8642",
      apiKey: "hermes-test-key"
    }));
    const persistedText = JSON.stringify(result);

    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("hermes_gateway_protocol_error");
    expect(result.errorMeta?.response).toMatchObject({
      status: "started",
      accessToken: expect.stringContaining("[redacted len="),
      nested: { clientSecret: expect.stringContaining("[redacted len=") },
      tokenCount: 9,
      credentialType: "service-account",
    });
    expect(persistedText).not.toContain(accessToken);
    expect(persistedText).not.toContain(clientSecret);
  });

  it("redacts configured header values and secret-bearing metadata keys without losing safe metadata", async () => {
    const gatewayApiKey = "gateway-secret-key";
    const paperclipApiKey = "paperclip-run-key";
    const githubToken = "github-runtime-key";
    const sessionKey = "paperclip:company:company-1:agent:agent-1:issue:issue-1";
    const customHeaderValue = "custom-header-one";
    const collidingHeaderValue = "custom-header-two";
    const ordinaryHeaderValue = "ordinary-header-value";
    const shortHeaderValue = "xy";
    const secrets = [
      gatewayApiKey,
      paperclipApiKey,
      githubToken,
      sessionKey,
      customHeaderValue,
      collidingHeaderValue,
      ordinaryHeaderValue,
      shortHeaderValue,
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({
        safe: "preserved",
        [gatewayApiKey]: {
          [paperclipApiKey]: [
            { [githubToken]: "safe nested value" },
            { [sessionKey]: customHeaderValue },
          ],
        },
        [customHeaderValue]: "first collision value",
        [collidingHeaderValue]: "second collision value",
        short: { [shortHeaderValue]: shortHeaderValue },
      }), { status: 401 })),
    );

    const ctx = makeCtx({
      apiBaseUrl: "http://127.0.0.1:8642",
      apiKey: gatewayApiKey,
      env: { GH_TOKEN: githubToken },
      headers: {
        Cookie: customHeaderValue,
        "X-Custom-Trace": collidingHeaderValue,
        [`X-${gatewayApiKey}`]: ordinaryHeaderValue,
        "X-Short": shortHeaderValue,
      },
    });
    ctx.authToken = paperclipApiKey;

    const result = await execute(ctx);
    const logText = (ctx.onLog as ReturnType<typeof vi.fn>).mock.calls.map(([, line]) => String(line)).join("\n");
    const persistedText = JSON.stringify(result);

    expect(result.exitCode).toBe(1);
    expect(logText).toContain("Cookie");
    expect(logText).toContain("X-Custom-Trace");
    expect(logText).toContain("X-[redacted len=18]");
    expect(result.errorMeta?.body).toEqual({
      safe: "preserved",
      "[redacted len=18]": {
        "[redacted len=17]": [
          { "[redacted len=18]": "safe nested value" },
          { "[redacted-session-key]": "[redacted len=17]" },
        ],
      },
      "[redacted len=17]": "first collision value",
      "[redacted len=17] [collision 2]": "second collision value",
      short: { "[redacted len=2]": "[redacted len=2]" },
    });
    for (const secret of secrets) {
      expect(logText).not.toContain(secret);
      expect(persistedText).not.toContain(secret);
    }
  });

  it("drops gateway-controlled Retry-After text that echoes every runtime secret class", async () => {
    const gatewayApiKey = "gateway-api-secret";
    const paperclipApiKey = "paperclip-run-secret";
    const githubToken = "github-runtime-secret";
    const sessionKey = "paperclip:company:company-1:agent:agent-1:issue:issue-1";
    const echoedSecrets = [gatewayApiKey, paperclipApiKey, githubToken, sessionKey];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(
        JSON.stringify({ error: "rate limited" }),
        {
          status: 429,
          headers: { "retry-after": echoedSecrets.join(" | ") },
        },
      )),
    );

    const ctx = makeCtx({
      apiBaseUrl: "http://127.0.0.1:8642",
      apiKey: gatewayApiKey,
      env: { GH_TOKEN: githubToken },
    });
    ctx.authToken = paperclipApiKey;
    const result = await execute(ctx);
    const persistedText = JSON.stringify(result);

    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("hermes_gateway_rate_limited");
    expect(result.retryNotBefore).toBeNull();
    for (const secret of echoedSecrets) {
      expect(persistedText).not.toContain(secret);
    }
  });

  it("normalizes legitimate Retry-After delta-seconds and HTTP-dates", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-05T12:00:00.000Z"));
    try {
      for (const [header, expected] of [
        ["120", "2026-10-05T12:02:00.000Z"],
        ["Mon, 05 Oct 2026 12:03:00 GMT", "2026-10-05T12:03:00.000Z"],
      ] as const) {
        vi.stubGlobal(
          "fetch",
          vi.fn(async () => new Response(
            JSON.stringify({ error: "rate limited" }),
            { status: 429, headers: { "retry-after": header } },
          )),
        );

        const result = await execute(makeCtx({
          apiBaseUrl: "http://127.0.0.1:8642",
          apiKey: "secret-key",
        }));

        expect(result.retryNotBefore).toBe(expected);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("calls stop on timeout", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) {
        return new Response(JSON.stringify({ run_id: "run-slow", status: "started" }), { status: 200 });
      }
      if (url.endsWith("/events")) {
        return new Promise<Response>(() => {});
      }
      if (url.endsWith("/stop")) {
        return new Response(JSON.stringify({ status: "stopping" }), { status: 200 });
      }
      if (init?.method === "GET") {
        return new Response(JSON.stringify({ status: "cancelled", last_event: "run.cancelled" }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: "running" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await execute(makeCtx({
      apiBaseUrl: "http://127.0.0.1:8642",
      apiKey: "secret-key",
      timeoutSec: 0.001,
    }));

    expect(result.timedOut).toBe(true);
    expect(result.errorCode).toBe("hermes_gateway_timeout");
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith("/stop"))).toBe(true);
  });

  it("redacts secret echoes from timeout stop logs and all persisted timeout metadata", async () => {
    const secret = "timeout-secret-value";
    const gatewayRunId = `remote-${secret}-run`;
    const eventName = `progress.${secret}`;
    const ctx = makeCtx({
      apiBaseUrl: "http://127.0.0.1:8642",
      apiKey: secret,
      timeoutSec: 0.05,
      pollIntervalMs: 10_000,
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) {
        return new Response(JSON.stringify({ run_id: gatewayRunId, status: "started" }), { status: 200 });
      }
      if (url.endsWith("/events")) {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(
                [`event: ${eventName}`, "data: {\"status\":\"running\"}", "", ""].join("\n"),
              ));
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      if (url.endsWith("/stop")) {
        return new Response(JSON.stringify({ status: "stopping" }), { status: 200 });
      }
      return new Response(JSON.stringify({
        status: "cancelled",
        run_id: gatewayRunId,
        last_event: eventName,
        model: `model-${secret}`,
        detail: `gateway echoed ${secret}`,
        safe_id: "safe-timeout-id",
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await execute(ctx);
    const logText = (ctx.onLog as ReturnType<typeof vi.fn>).mock.calls.map(([, line]) => String(line)).join("\n");
    const persistedText = JSON.stringify(result);

    expect(result.timedOut).toBe(true);
    expect(result.errorCode).toBe("hermes_gateway_timeout");
    expect(result.sessionParams?.hermesRunId).toMatch(/^remote-\[redacted len=\d+\]-run$/);
    expect(result.resultJson?.run_id).toBe(result.sessionParams?.hermesRunId);
    expect(result.resultJson?.last_event).toMatch(/^progress\.\[redacted len=\d+\]$/);
    expect(result.resultJson?.final_status).toMatchObject({
      status: "cancelled",
      run_id: expect.stringMatching(/^remote-\[redacted len=\d+\]-run$/),
      last_event: expect.stringMatching(/^progress\.\[redacted len=\d+\]$/),
      model: expect.stringMatching(/^model-\[redacted len=\d+\]$/),
      detail: expect.stringMatching(/^gateway echoed \[redacted len=\d+\]$/),
      safe_id: "safe-timeout-id",
    });
    expect(logText).toContain("stop requested for run remote-[redacted len=");
    expect(logText).not.toContain(secret);
    expect(persistedText).not.toContain(secret);
  });
});

describe("testEnvironment", () => {
  it.each([
    "https://gateway-user:gateway-password@hermes.example:8642",
    "https://gateway-user:gateway-password@[invalid-host",
  ])("rejects credential-bearing or malformed apiBaseUrl without reflecting it (%s)", async (apiBaseUrl) => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "hermes_gateway",
      config: { apiBaseUrl, apiKey: "secret-key" },
    });
    const serialized = JSON.stringify(result);

    expect(result.status).toBe("fail");
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "hermes_gateway_api_base_url_invalid", level: "error" }),
    ]));
    expect(serialized).not.toContain(apiBaseUrl);
    expect(serialized).not.toContain("gateway-user");
    expect(serialized).not.toContain("gateway-password");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails remote plain HTTP before probing health", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "hermes_gateway",
      config: {
        apiBaseUrl: "http://hermes.example:8642",
        apiKey: "secret-key",
      },
    });

    expect(result.status).toBe("fail");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "hermes_gateway_plain_http_remote_denied",
          level: "error",
        }),
      ]),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows remote plain HTTP only with the unsafe dev escape hatch", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "hermes_gateway",
      config: {
        apiBaseUrl: "http://hermes.example:8642",
        apiKey: "secret-key",
        dangerouslyAllowInsecureRemoteHttp: true,
      },
    });

    expect(result.status).toBe("warn");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "hermes_gateway_plain_http_remote_unsafe_allowed",
          level: "warn",
        }),
        expect.objectContaining({
          code: "hermes_gateway_health_ok",
        }),
      ]),
    );
    expect(fetchMock).toHaveBeenCalled();
  });

  it("fails test environment checks when Hermes health is unreachable", async () => {
    const cause = Object.assign(new Error("getaddrinfo ENOTFOUND host.docker.internal"), { code: "ENOTFOUND" });
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw Object.assign(new Error("fetch failed"), { cause });
    }));

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "hermes_gateway",
      config: {
        apiBaseUrl: "http://host.docker.internal:8642",
        apiKey: "secret-key",
        dangerouslyAllowInsecureRemoteHttp: true,
      },
    });

    expect(result.status).toBe("fail");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "hermes_gateway_health_unreachable",
          level: "error",
          detail: expect.stringContaining("ENOTFOUND"),
        }),
      ]),
    );
  });

  it("fails test environment checks when Hermes health returns a non-ok status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad key", { status: 401 })));

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "hermes_gateway",
      config: {
        apiBaseUrl: "http://127.0.0.1:8642",
        apiKey: "wrong-key",
      },
    });

    expect(result.status).toBe("fail");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "hermes_gateway_health_failed",
          level: "error",
          message: "Hermes Gateway health endpoint returned HTTP 401.",
        }),
      ]),
    );
  });

  it("tests a bare Hermes dashboard URL on port 9119 through the API prefix", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "hermes_gateway",
      config: {
        apiBaseUrl: "http://127.0.0.1:9119",
        apiKey: "secret-key",
      },
    });

    expect(result.status).toBe("pass");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "hermes_gateway_dashboard_root_mapped",
          level: "info",
          message: "Default Hermes dashboard root mapped to API base http://127.0.0.1:9119/api.",
          hint: expect.stringContaining("/api/v1/runs"),
        }),
      ]),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:9119/api/health",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("tests a Hermes dashboard chat URL on port 9119 through the API prefix", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "hermes_gateway",
      config: {
        apiBaseUrl: "http://127.0.0.1:9119/chat",
        apiKey: "secret-key",
      },
    });

    expect(result.status).toBe("pass");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "hermes_gateway_dashboard_root_mapped",
          level: "info",
          message: "Default Hermes dashboard root mapped to API base http://127.0.0.1:9119/api.",
        }),
      ]),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:9119/api/health",
      expect.objectContaining({ method: "GET" }),
    );
  });
});

describe("mapFinalResultForTest", () => {
  it("maps failed statuses into adapter errors", () => {
    const result = mapFinalResultForTest({
      terminal: {
        runId: "run-1",
        status: "failed",
        payload: { status: "failed", error: "boom" },
      },
      outputChunks: [],
      sessionKey: "session-key",
      strategy: "issue",
    });
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("hermes_gateway_run_failed");
    expect(result.errorMessage).toBe("boom");
  });
});
