import js from "@eslint/js";

/**
 * Lint scope (P4-1).
 *
 * Until Phase 4 this file only looked at `src/core/**`, which is how
 * `renderToolCall` could sit in `src/adapters/tui/` exported, unit-tested and
 * never called by anything that ships. Everything under `src/` and `tests/`
 * is linted now; the core-only I/O restrictions stay scoped to
 * `src/core/**` in the last block below.
 *
 * `globals` is spelled out by hand instead of pulled from the `globals`
 * package: procway-code is published to npm together with its
 * `pnpm-lock.yaml`, so every added dependency — dev ones included — ships to
 * users. This list is the Node 20+ global surface the codebase actually uses.
 */
const nodeGlobals = {
  AbortController: "readonly",
  AbortSignal: "readonly",
  atob: "readonly",
  Blob: "readonly",
  BroadcastChannel: "readonly",
  btoa: "readonly",
  Buffer: "readonly",
  clearImmediate: "readonly",
  clearInterval: "readonly",
  clearTimeout: "readonly",
  console: "readonly",
  crypto: "readonly",
  Event: "readonly",
  EventTarget: "readonly",
  fetch: "readonly",
  File: "readonly",
  FormData: "readonly",
  global: "readonly",
  globalThis: "readonly",
  Headers: "readonly",
  Intl: "readonly",
  MessageChannel: "readonly",
  MessagePort: "readonly",
  performance: "readonly",
  process: "readonly",
  queueMicrotask: "readonly",
  ReadableStream: "readonly",
  Request: "readonly",
  Response: "readonly",
  setImmediate: "readonly",
  setInterval: "readonly",
  setTimeout: "readonly",
  structuredClone: "readonly",
  TextDecoder: "readonly",
  TextEncoder: "readonly",
  TransformStream: "readonly",
  URL: "readonly",
  URLSearchParams: "readonly",
  WebSocket: "readonly",
  WritableStream: "readonly"
};

export default [
  {
    ignores: ["node_modules/**", "web/**", "tests/__snapshots__/**"]
  },
  {
    files: ["src/**/*.mjs", "tests/**/*.mjs", "*.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: nodeGlobals
    },
    rules: {
      ...js.configs.recommended.rules,
      // This is a terminal program: ANSI/OSC handling puts `\x1b` and `\x07`
      // inside regular expressions on purpose (ansi.mjs, markdown-render.mjs
      // and the tests that assert on their output). The rule cannot tell
      // those from an accidental control character, and every hit here is
      // the deliberate kind.
      "no-control-regex": "off",
      // `const { a: _omit, ...rest } = obj` and `(_unused, i) => …` are how
      // this codebase drops a key or an argument. The underscore is the
      // marker; anything unused without one stays an error.
      "no-unused-vars": ["error", {
        args: "after-used",
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
        caughtErrorsIgnorePattern: "^_",
        ignoreRestSiblings: true
      }],
      // A value written and then overwritten before any read is either dead
      // weight or a line that was meant to be used and is not — the second
      // kind is a real bug (P4b-3 audited all of them), so this is an error
      // everywhere rather than a per-directory downgrade. The `src/adapters/
      // tui/**` "known debt" block that used to sit here (P4-1) is gone: all
      // twelve of its warnings were fixed, not exempted.
      "no-useless-assignment": "error"
    }
  },
  // Phase 4: forbid direct stdout/stderr/console use inside `src/core/` at error
  // severity. core/ stays headless — adapters under src/adapters/ and apps
  // under src/cli.mjs handle I/O. `core/index.mjs` is a pure barrel that
  // re-exports values only.
  {
    files: ["src/core/**/*.mjs"],
    rules: {
      "no-console": "error",
      "no-restricted-globals": [
        "error",
        {
          name: "process",
          message: "core/ must not touch process I/O directly. Emit events and let adapters handle output."
        }
      ],
      "no-restricted-properties": [
        "error",
        {
          object: "process",
          property: "stdout",
          message: "core/ must not write to process.stdout. Emit events instead."
        },
        {
          object: "process",
          property: "stderr",
          message: "core/ must not write to process.stderr. Emit events instead."
        }
      ]
    }
  }
];
