// Phase 4: forbid direct stdout/stderr/console use inside `src/core/` at error
// severity. core/ stays headless — adapters under src/adapters/ and apps
// under src/cli.mjs handle I/O. `core/index.mjs` is a pure barrel that
// re-exports values only.
export default [
  {
    files: ["src/core/**/*.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module"
    },
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
