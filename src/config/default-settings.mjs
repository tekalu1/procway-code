import { DEFAULT_LONG_RUNNING_SHELL_TIMEOUT_MS } from "../safety/command-classifier.mjs";

export const DEFAULT_SETTINGS = Object.freeze({
  defaultProvider: "openai-main",
  approvalMode: "auto-readonly",
  permissions: {
    allow: ["read_file:*", "list_files:*", "search_files:*", "shell_status:*", "shell_logs:*", "shell_wait:*"],
    deny: ["run_shell:rm -rf *", "run_shell:rm -fr *", "run_shell:git push --force*", "run_shell:git reset --hard*"],
    ask: ["write_file:*", "apply_patch:*", "edit:*", "run_shell:*", "spawn_agent:*", "mcp:*", "shell_kill:*", "write_memory:*", "plan_apply:*"]
  },
  agents: {
    maxDepth: 3,
    maxConcurrentAgents: 4,
    defaultTimeoutMs: 300000,
    isolation: "inline"
  },
  usage: {
    trackCost: true,
    pricing: {
      "anthropic:claude-opus-4-7":   { inputPer1k: 0.015,  outputPer1k: 0.075 },
      "anthropic:claude-sonnet-4-6": { inputPer1k: 0.003,  outputPer1k: 0.015 },
      "openai:gpt-5.4":              { inputPer1k: 0.0025, outputPer1k: 0.010 },
      "openai:gpt-4o":               { inputPer1k: 0.0025, outputPer1k: 0.010 },
      "openrouter:deepseek/deepseek-v4-flash": { inputPer1k: 0.00014, outputPer1k: 0.00028 }
    }
  },
  tools: {
    maxParallelTools: 8,
    maxToolRounds: 150,
    // Deferred-tool tier (token reduction): the heavy tail of the catalog
    // (browser/desktop/shell_job/Atlassian, ~9.8KB of schema JSON) is
    // withheld from the per-round tool list until the session loads it via
    // the `load_tools` meta-tool (or calls one directly — auto-loaded).
    // false restores the full catalog on every round.
    deferredLoading: true,
    // Stale tool-result condensation (egress-only): tool results older than
    // the last `keepRecent` tool messages AND bigger than `maxChars`
    // (serialized) are sent to the provider as head+tail+note instead of the
    // full payload. Stored history is untouched. `false` disables.
    staleToolResults: {
      enabled: true,
      keepRecent: 10,
      maxChars: 6000,
      headChars: 2000,
      tailChars: 500
    },
    writeLock: true,
    shellTimeoutMs: 120000,
    // Failsafe ceiling for long-running orchestration commands (procway run
    // loop / run task). These drive many sub-turns and can run for hours, so the
    // short foreground shell wall-clock must not kill them; liveness is governed
    // by the turn-idle watchdog + the CLI's own per-task timeouts. Applied in
    // shell.mjs and turn-orchestrator via command-classifier isLongRunningCommand.
    longRunningShellTimeoutMs: DEFAULT_LONG_RUNNING_SHELL_TIMEOUT_MS,
    // Wall-clock ceiling per tool call. Internal failsafe so one hung tool
    // can't strand a whole round (see scheduler.mjs / TK-15 incident).
    toolTimeoutMs: 60000
  },
  providers: {
    "openai-main": {
      type: "openai",
      apiKeyEnv: "OPENAI_API_KEY",
      baseUrl: "https://api.openai.com/v1",
      defaultModel: "gpt-5.4"
    },
    "anthropic-main": {
      type: "anthropic",
      apiKeyEnv: "ANTHROPIC_API_KEY",
      baseUrl: "https://api.anthropic.com",
      defaultModel: "claude-sonnet-4-6"
    }
  },
  mcpServers: {},
  session: {
    enabled: true,
    autoCompact: {
      enabled: false,
      messageCount: 40,
      estimatedTokens: 60000,
      keepLastMessages: 10,
      strategy: "llm-summary",
      dropToolResults: false
    },
    encryption: {
      provider: "none"
    },
    redaction: {
      patterns: []
    },
    snapshot: {
      intervalEvents: 50,
      intervalMs: 30000
    }
  },
  context: {
    compatibilityMode: "claude",
    instructionPriority: ["cli", "workspace", "claude", "codex", "user"],
    conflictPolicy: "prefer-claude",
    instructionScanners: [
      {
        id: "claude-md",
        type: "instruction-file",
        filenames: ["CLAUDE.md"],
        walk: "up",
        // Claude Code 相当: プロジェクト直下の ./CLAUDE.md に加え、プロジェクト
        // の ./.claude/CLAUDE.md とユーザースコープの ~/.claude/CLAUDE.md も読む。
        // activeInModes は claude/mixed のままなので、codex 互換では読み込まない
        // (Codex に合わせて AGENTS.md のみ — agents-md が担当)。
        subdirs: [".claude"],
        userScope: true,
        compatibility: "claude",
        activeInModes: ["claude", "mixed"],
        enabled: true
      },
      {
        id: "agents-md",
        type: "instruction-file",
        filenames: ["AGENTS.md"],
        walk: "up",
        compatibility: "codex",
        activeInModes: ["codex", "mixed"],
        enabled: true
      }
    ],
    skillScanners: [
      {
        id: "workspace-skills",
        roots: ["./skills"],
        glob: "*/SKILL.md",
        compatibility: "shared",
        activeInModes: ["claude", "codex", "mixed"],
        priority: 80,
        enabled: true
      },
      {
        id: "claude-skills",
        roots: ["./.claude/skills"],
        glob: "*/SKILL.md",
        compatibility: "claude",
        activeInModes: ["claude", "mixed"],
        priority: 70,
        enabled: true
      },
      {
        id: "workspace-procway-skills",
        roots: ["./.procway/ai-agent/skills"],
        glob: "*/SKILL.md",
        compatibility: "shared",
        activeInModes: ["claude", "codex", "mixed"],
        priority: 90,
        enabled: true
      },
      {
        id: "user-procway-skills",
        roots: ["~/.procway/ai-agent/skills"],
        glob: "*/SKILL.md",
        compatibility: "shared",
        activeInModes: ["claude", "codex", "mixed"],
        priority: 50,
        enabled: true
      }
    ]
  }
});
