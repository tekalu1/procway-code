import { spawn } from "node:child_process";
import { createEvent } from "../core/events/types.mjs";

/**
 * Hook configuration shape:
 *
 *   {
 *     preToolUse:        Array<{ matcher?: string, command: string, timeoutMs?: number }>,
 *     postToolUse:       Array<{ matcher?: string, command: string, timeoutMs?: number }>,
 *     userPromptSubmit:  Array<{ command: string, timeoutMs?: number }>
 *   }
 *
 * Each hook is run as a shell command; the matching event payload is piped
 * to the child's stdin as a JSON string. Exit code != 0 is "blocking" — the
 * caller treats it as a deny / abort signal.
 */
export class HookRunner {
  constructor({ session, hooks, runner = defaultRunner } = {}) {
    this.session = session;
    this.hooks = hooks ?? {};
    this.runner = runner;
  }

  async runPreToolUse({ toolName, args }) {
    return this.#runMatchingPhase("preToolUse", toolName, { tool: toolName, args });
  }

  async runPostToolUse({ toolName, args, result, ok }) {
    return this.#runMatchingPhase("postToolUse", toolName, { tool: toolName, args, result, ok });
  }

  async runUserPromptSubmit({ messageId, prompt }) {
    return this.#runMatchingPhase("userPromptSubmit", "*", { messageId, prompt });
  }

  async #runMatchingPhase(phase, target, payload) {
    const hooks = Array.isArray(this.hooks?.[phase]) ? this.hooks[phase] : [];
    const matched = hooks.filter((hook) => matchesHook(hook, target));
    const outcomes = [];
    for (const hook of matched) {
      const start = Date.now();
      const result = await this.runner({
        command: hook.command,
        input: JSON.stringify({ phase, payload }),
        timeoutMs: hook.timeoutMs ?? 30_000
      });
      const durationMs = Date.now() - start;
      const event = {
        sessionId: this.session?.sessionId,
        phase,
        matcher: hook.matcher ?? "*",
        command: hook.command,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs
      };
      this.session?.events?.emit(createEvent("hook.executed", event));
      outcomes.push(event);
      if (result.exitCode !== 0 && phase !== "postToolUse") {
        return { blocked: true, exitCode: result.exitCode, outcomes, hook };
      }
    }
    return { blocked: false, exitCode: 0, outcomes };
  }
}

function matchesHook(hook, target) {
  const matcher = hook?.matcher ?? "*";
  if (matcher === "*" || matcher === "" || target === "*") return true;
  const colon = matcher.indexOf(":");
  const head = colon >= 0 ? matcher.slice(0, colon) : matcher;
  if (head === "*") return true;
  if (head === target) return true;
  return false;
}

function defaultRunner({ command, input, timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn(command, { shell: true, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    let timer = null;
    let settled = false;
    const finish = (exitCode) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ exitCode, stdout, stderr });
    };
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => {
      stderr += `\n[hook spawn error] ${error?.message ?? String(error)}`;
      finish(127);
    });
    child.on("exit", (code) => finish(code ?? 0));
    if (typeof timeoutMs === "number" && timeoutMs > 0) {
      timer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* ignore */ }
        stderr += `\n[hook timeout after ${timeoutMs}ms]`;
        finish(124);
      }, timeoutMs);
    }
    if (input != null) {
      try {
        child.stdin.write(input);
        child.stdin.end();
      } catch {
        // ignore
      }
    } else {
      child.stdin.end();
    }
  });
}
