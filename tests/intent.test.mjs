import { describe, expect, it } from "vitest";
import {
  buildTaskCompletionRetryPrompt,
  extractProcwayMeta,
  hasMutationToolResult,
  hasTaskCompletionToolResult,
  requiresFileMutation,
  requiresTaskCompletion,
  shouldRemindTaskCompletion,
} from "../src/agent/intent.mjs";

describe("file mutation intent", () => {
  it("detects file creation requests", () => {
    expect(requiresFileMutation("temporaryに改修計画のmdを作成してください")).toBe(true);
    expect(requiresFileMutation("このリポジトリを説明してください")).toBe(false);
  });

  it("detects successful mutation tool results", () => {
    expect(hasMutationToolResult([
      { role: "tool", content: "{\"path\":\"temporary/plan.md\",\"bytes\":10}" }
    ])).toBe(true);
    expect(hasMutationToolResult([
      { role: "tool", content: "{\"skipped\":true,\"path\":\"temporary/plan.md\"}" }
    ])).toBe(false);
  });

});

describe("procway task-completion intent", () => {
  const workerPrompt = `do the work\n\n## Meta\n\n\`\`\`json\n{\n  "ticket": "TK-139",\n  "task": "dev-env-setup",\n  "project": "procway",\n  "role": "worker"\n}\n\`\`\`\n`;
  const reviewerPrompt = workerPrompt.replace('"worker"', '"reviewer"');

  it("requiresTaskCompletion: only worker prompts with Meta block", () => {
    expect(requiresTaskCompletion(workerPrompt)).toBe(true);
    expect(requiresTaskCompletion(reviewerPrompt)).toBe(false);
    expect(requiresTaskCompletion("plain prompt without Meta")).toBe(false);
    expect(requiresTaskCompletion("")).toBe(false);
    expect(requiresTaskCompletion(null)).toBe(false);
  });

  it("extractProcwayMeta: parses ticket/task/project from Meta block", () => {
    expect(extractProcwayMeta(workerPrompt)).toEqual({
      ticket: "TK-139",
      task: "dev-env-setup",
      project: "procway",
      interactive: false,
    });
    expect(extractProcwayMeta("## Meta\n\n{ not json }")).toBeNull();
    expect(extractProcwayMeta("no meta heading")).toBeNull();
  });

  it("extractProcwayMeta: missing project returns null project (not throws)", () => {
    const noProject = `## Meta\n\n\`\`\`json\n{ "ticket": "TK-1", "task": "x" }\n\`\`\``;
    expect(extractProcwayMeta(noProject)).toEqual({ ticket: "TK-1", task: "x", project: null, interactive: false });
  });

  it("extractProcwayMeta: carries interactive: true through from the Meta block", () => {
    const interactivePrompt = `## Meta\n\n\`\`\`json\n{ "ticket": "TK-1", "task": "requirements-elicitation", "project": "p", "role": "worker", "interactive": true }\n\`\`\``;
    expect(extractProcwayMeta(interactivePrompt)).toEqual({
      ticket: "TK-1",
      task: "requirements-elicitation",
      project: "p",
      interactive: true,
    });
  });

  it("hasTaskCompletionToolResult: matches successful run_shell with task complete + ids", () => {
    const messages = [
      {
        role: "tool",
        content: [
          {
            kind: "tool_result",
            ok: true,
            result: {
              data: {
                command: 'node "$PROCWAY_CLI" task complete procway TK-139 dev-env-setup --memo "done"',
                exitCode: 0,
                stdout: '{"completed":true,"ticketId":"TK-139","taskId":"dev-env-setup"}\n',
                stderr: "",
              },
            },
          },
        ],
      },
    ];
    expect(hasTaskCompletionToolResult(messages, { ticket: "TK-139", task: "dev-env-setup" })).toBe(true);
  });

  it("hasTaskCompletionToolResult: rejects non-zero exit, wrong task, background, missing ids", () => {
    const failedExit = [{ role: "tool", content: [{ kind: "tool_result", ok: true, result: { data: { command: "node x task complete proj TK-139 dev-env-setup", exitCode: 1, stdout: "", stderr: "Error" } } }] }];
    expect(hasTaskCompletionToolResult(failedExit, { ticket: "TK-139", task: "dev-env-setup" })).toBe(false);

    const wrongTask = [{ role: "tool", content: [{ kind: "tool_result", ok: true, result: { data: { command: "node x task complete proj TK-139 implementation", exitCode: 0, stdout: "{\"completed\":true}", stderr: "" } } }] }];
    expect(hasTaskCompletionToolResult(wrongTask, { ticket: "TK-139", task: "dev-env-setup" })).toBe(false);

    const bg = [{ role: "tool", content: [{ kind: "tool_result", ok: true, result: { data: { command: "node x task complete proj TK-139 dev-env-setup", exitCode: 0, stdout: "ok", stderr: "", runInBackground: true } } }] }];
    expect(hasTaskCompletionToolResult(bg, { ticket: "TK-139", task: "dev-env-setup" })).toBe(false);

    expect(hasTaskCompletionToolResult([], { ticket: "TK-139", task: "dev-env-setup" })).toBe(false);
    expect(hasTaskCompletionToolResult([{ role: "tool", content: [] }], {})).toBe(false);
  });

  it("hasTaskCompletionToolResult: silent exit-0 with empty stdout+stderr is rejected", () => {
    // Reproduces the `$PROCWAY_CLI` unset → `node ""` → exit 0 / empty pipes
    // failure mode. Both pipes empty means the CLI never actually ran and the
    // worker must retry.
    const silentExit = [{
      role: "tool",
      content: [{
        kind: "tool_result",
        ok: true,
        result: {
          data: {
            command: 'node "$PROCWAY_CLI" task complete procway TK-139 dev-env-setup --memo "done"',
            exitCode: 0,
            stdout: "",
            stderr: "",
          },
        },
      }],
    }];
    expect(hasTaskCompletionToolResult(silentExit, { ticket: "TK-139", task: "dev-env-setup" })).toBe(false);
  });

  it("hasTaskCompletionToolResult: accepts a failed run whose stderr carries ALREADY_COMPLETED", () => {
    // The task was completed outside this session (UI / human CLI) or the
    // success record was lost to compaction — the server's ALREADY_COMPLETED
    // rejection is authoritative proof the task is done, so the retry loop
    // must stand down instead of demanding an unwinnable exit-0.
    const alreadyCompleted = [{
      role: "tool",
      content: [{
        kind: "tool_result",
        ok: true,
        result: {
          data: {
            command: 'node "$PROCWAY_CLI" task complete procway TK-139 dev-env-setup --memo "done"',
            exitCode: 1,
            stdout: "",
            stderr: 'Error (400 ALREADY_COMPLETED): Task "dev-env-setup" is already completed\n',
          },
        },
      }],
    }];
    expect(hasTaskCompletionToolResult(alreadyCompleted, { ticket: "TK-139", task: "dev-env-setup" })).toBe(true);
  });

  it("hasTaskCompletionToolResult: ALREADY_COMPLETED message-text fallback (pre-code CLI format)", () => {
    // Older CLI builds print only the server message, without the code token.
    const messageOnly = [{
      role: "tool",
      content: [{
        kind: "tool_result",
        ok: true,
        result: {
          data: {
            command: 'node "$PROCWAY_CLI" task complete procway TK-139 dev-env-setup',
            exitCode: 1,
            stdout: "",
            stderr: 'Error (400): Task "dev-env-setup" is already completed\n',
          },
        },
      }],
    }];
    expect(hasTaskCompletionToolResult(messageOnly, { ticket: "TK-139", task: "dev-env-setup" })).toBe(true);
  });

  it("hasTaskCompletionToolResult: ALREADY_COMPLETED for a different task does not count", () => {
    const otherTask = [{
      role: "tool",
      content: [{
        kind: "tool_result",
        ok: true,
        result: {
          data: {
            command: 'node "$PROCWAY_CLI" task complete procway TK-139 implementation',
            exitCode: 1,
            stdout: "",
            stderr: 'Error (400 ALREADY_COMPLETED): Task "implementation" is already completed\n',
          },
        },
      }],
    }];
    expect(hasTaskCompletionToolResult(otherTask, { ticket: "TK-139", task: "dev-env-setup" })).toBe(false);
  });

  it("hasTaskCompletionToolResult: other failure stderr (checklist gate) still does not count", () => {
    const blocked = [{
      role: "tool",
      content: [{
        kind: "tool_result",
        ok: true,
        result: {
          data: {
            command: 'node "$PROCWAY_CLI" task complete procway TK-139 dev-env-setup',
            exitCode: 1,
            stdout: "",
            stderr: "❌ タスク完了がブロックされました: 未チェック項目があります\n",
          },
        },
      }],
    }];
    expect(hasTaskCompletionToolResult(blocked, { ticket: "TK-139", task: "dev-env-setup" })).toBe(false);
  });

  it("hasTaskCompletionToolResult: accepts a background run confirmed via shell_status exit 0", () => {
    const messages = [
      // 1. background start — exit unknown, must NOT count on its own
      {
        role: "tool",
        content: [{
          kind: "tool_result",
          ok: true,
          result: { data: { tool: "run_shell", command: 'node "$PROCWAY_CLI" task complete procway TK-139 dev-env-setup --memo "done"', runInBackground: true, shellId: "abc", status: "running" } },
        }],
      },
      // 2. shell_status poll — exited 0 with output → counts as completion
      {
        role: "tool",
        content: [{
          kind: "tool_result",
          ok: true,
          result: { data: { tool: "shell_status", shellId: "abc", command: 'node "$PROCWAY_CLI" task complete procway TK-139 dev-env-setup --memo "done"', status: "exited", exitCode: 0, stdoutBytes: 64, stderrBytes: 0 } },
        }],
      },
    ];
    expect(hasTaskCompletionToolResult(messages, { ticket: "TK-139", task: "dev-env-setup" })).toBe(true);
  });

  it("hasTaskCompletionToolResult: rejects shell_status still running, non-zero exit, or no output", () => {
    const base = { tool: "shell_status", shellId: "abc", command: 'task complete procway TK-139 dev-env-setup' };
    const running = [{ role: "tool", content: [{ kind: "tool_result", ok: true, result: { data: { ...base, status: "running", exitCode: null, stdoutBytes: 0, stderrBytes: 0 } } }] }];
    expect(hasTaskCompletionToolResult(running, { ticket: "TK-139", task: "dev-env-setup" })).toBe(false);

    const nonZero = [{ role: "tool", content: [{ kind: "tool_result", ok: true, result: { data: { ...base, status: "exited", exitCode: 1, stdoutBytes: 0, stderrBytes: 32 } } }] }];
    expect(hasTaskCompletionToolResult(nonZero, { ticket: "TK-139", task: "dev-env-setup" })).toBe(false);

    const silent = [{ role: "tool", content: [{ kind: "tool_result", ok: true, result: { data: { ...base, status: "exited", exitCode: 0, stdoutBytes: 0, stderrBytes: 0 } } }] }];
    expect(hasTaskCompletionToolResult(silent, { ticket: "TK-139", task: "dev-env-setup" })).toBe(false);
  });

  it("buildTaskCompletionRetryPrompt: instructs background + poll", () => {
    const text = buildTaskCompletionRetryPrompt({ project: "procway", ticket: "TK-139", task: "ui-design" });
    expect(text).toContain('runInBackground:true');
    expect(text).toContain('timeoutMs: 900000');
    expect(text).toContain('shell_job');
  });

  it("hasTaskCompletionToolResult: accepts legacy string-content tool messages", () => {
    const legacy = [{
      role: "tool",
      content: '{"command":"node procway-cli task complete procway TK-139 dev-env-setup","exitCode":0,"stdout":"{\\"completed\\":true}"}',
    }];
    expect(hasTaskCompletionToolResult(legacy, { ticket: "TK-139", task: "dev-env-setup" })).toBe(true);
  });

  it("hasTaskCompletionToolResult: legacy string with empty stdout is rejected", () => {
    const legacySilent = [{
      role: "tool",
      content: '{"command":"node procway-cli task complete procway TK-139 dev-env-setup","exitCode":0,"stdout":""}',
    }];
    expect(hasTaskCompletionToolResult(legacySilent, { ticket: "TK-139", task: "dev-env-setup" })).toBe(false);
  });

  it("buildTaskCompletionRetryPrompt: includes project/ticket/task in the CLI command", () => {
    const text = buildTaskCompletionRetryPrompt({ project: "procway", ticket: "TK-139", task: "ui-design" });
    expect(text).toContain('task complete procway TK-139 ui-design');
    expect(text).toContain('FOREGROUND');
  });

  it("buildTaskCompletionRetryPrompt: directs blocked reviews to re-review, forbids worker review-resolve", () => {
    const text = buildTaskCompletionRetryPrompt({ project: "procway", ticket: "TK-139", task: "ui-design" });
    expect(text).toContain("task re-review");
    expect(text).toContain("Do NOT use `task review-resolve`");
  });

  it("buildTaskCompletionRetryPrompt: gracefully handles missing fields", () => {
    const text = buildTaskCompletionRetryPrompt({});
    expect(text).toContain('<project>');
    expect(text).toContain('<ticket>');
    expect(text).toContain('<task>');
  });

  it("shouldRemindTaskCompletion: true when worker session never called task complete", () => {
    const session = {
      procwayMeta: { project: "procway", ticket: "TK-139", task: "ui-design" },
      messages: [{ role: "assistant", content: [{ kind: "text", text: "I think I'm done" }] }],
    };
    expect(shouldRemindTaskCompletion(session)).toBe(true);
  });

  it("shouldRemindTaskCompletion: false when task complete tool result is present", () => {
    const session = {
      procwayMeta: { project: "procway", ticket: "TK-139", task: "ui-design" },
      messages: [
        {
          role: "tool",
          content: [{
            kind: "tool_result",
            ok: true,
            result: { data: { command: 'node x task complete procway TK-139 ui-design', exitCode: 0, stdout: '{"completed":true}', stderr: "" } },
          }],
        },
      ],
    };
    expect(shouldRemindTaskCompletion(session)).toBe(false);
  });

  it("shouldRemindTaskCompletion: false when no procwayMeta (not a worker session)", () => {
    expect(shouldRemindTaskCompletion({ messages: [] })).toBe(false);
    expect(shouldRemindTaskCompletion({ procwayMeta: null, messages: [] })).toBe(false);
    expect(shouldRemindTaskCompletion(null)).toBe(false);
  });

  it("shouldRemindTaskCompletion: false when procwayMeta is malformed", () => {
    expect(shouldRemindTaskCompletion({ procwayMeta: {}, messages: [] })).toBe(false);
    expect(shouldRemindTaskCompletion({ procwayMeta: { ticket: 1, task: 2 }, messages: [] })).toBe(false);
  });

  // Phase 4c hearing hand-off: an interactive worker ending a turn without
  // `task complete` is awaiting user input, not stalled — the reminder must
  // stand down or it forces the worker to self-answer the hearing.
  it("shouldRemindTaskCompletion: false for interactive (hearing) sessions", () => {
    const session = {
      procwayMeta: { project: "procway", ticket: "TK-139", task: "requirements-elicitation", interactive: true },
      messages: [{ role: "assistant", content: [{ kind: "text", text: "質問: 1) … 2) …" }] }],
    };
    expect(shouldRemindTaskCompletion(session)).toBe(false);
  });
});
