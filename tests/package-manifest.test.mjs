/**
 * Guards on package.json that only fail AFTER publishing, which is the worst
 * time to find out.
 *
 * The motivating bug: `procway-code serve` resolves its static assets as
 * `<packageRoot>/web`, but `web/` was missing from the `files` allowlist. Every
 * local run worked (the directory is right there in the checkout) and every
 * `npm install`ed copy answered 404 to every request, because npm had never
 * shipped the directory. Nothing in the test suite could see the difference —
 * the suite runs against the source tree, which is exactly the tree that hides
 * the fault.
 *
 * So these assertions are about the PACKAGE, not the program: what the manifest
 * promises must exist, and anything the program loads relative to its own
 * install root must be inside `files`.
 */

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(path.join(PKG_ROOT, "package.json"), "utf8"));

/** True when `files` ships `relPath` (entries ending in `/` are prefixes). */
function shippedByFiles(relPath) {
  return (pkg.files ?? []).some((entry) => (
    entry.endsWith("/") ? relPath === entry.slice(0, -1) || relPath.startsWith(entry) : relPath === entry
  ));
}

describe("package.json manifest", () => {
  it("points bin / main / exports at files that exist", () => {
    const targets = [
      ...Object.values(pkg.bin ?? {}),
      pkg.main,
      ...Object.values(pkg.exports ?? {}).filter((v) => typeof v === "string" && !v.includes("*"))
    ].filter(Boolean);

    expect(targets.length).toBeGreaterThan(0);
    for (const target of targets) {
      expect(existsSync(path.join(PKG_ROOT, target)), `${target} is referenced by package.json but missing`).toBe(true);
    }
  });

  it("ships every entry point through `files`", () => {
    const targets = [
      ...Object.values(pkg.bin ?? {}),
      pkg.main
    ].filter(Boolean).map((t) => t.replace(/^\.\//, ""));

    for (const target of targets) {
      expect(shippedByFiles(target), `${target} is an entry point but is not covered by package.json "files"`).toBe(true);
    }
  });

  it("ships the assets the program loads relative to its own install root", () => {
    // `src/adapters/serve/server.mjs` → defaultWebRoot() = <packageRoot>/web.
    // Left out of `files`, `serve` returns 404 for every request once installed.
    for (const asset of ["web", "web/index.html", "web/client.mjs", "web/style.css"]) {
      expect(existsSync(path.join(PKG_ROOT, asset)), `${asset} is missing from the source tree`).toBe(true);
    }
    expect(shippedByFiles("web/index.html"), '"web/" must be in package.json "files" or `serve` 404s when installed').toBe(true);
  });

  it("ships the licence files, including the vendored attribution", () => {
    for (const file of ["LICENSE", "NOTICE", "README.md", "src/auth/oauth/LICENSE.md"]) {
      expect(existsSync(path.join(PKG_ROOT, file)), `${file} is missing`).toBe(true);
      expect(shippedByFiles(file), `${file} must be covered by package.json "files"`).toBe(true);
    }
  });

  it("declares the licence it actually carries", () => {
    expect(pkg.license).toBe("Apache-2.0");
    expect(readFileSync(path.join(PKG_ROOT, "LICENSE"), "utf8")).toContain("Apache License");
  });

  it("keeps the shebang on the bin entry", () => {
    for (const target of Object.values(pkg.bin ?? {})) {
      const first = readFileSync(path.join(PKG_ROOT, target), "utf8").split("\n", 1)[0];
      expect(first, `${target} needs a node shebang to be executable via the bin link`).toBe("#!/usr/bin/env node");
    }
  });

  it("keeps every runtime dependency declared (nothing implicit from the monorepo)", () => {
    // ADR 0030 D2: procway-code must not reach into the monorepo. `undici` is
    // the only thing allowed to be a hard runtime dependency; everything else
    // has to be optional and guarded at its import site.
    expect(Object.keys(pkg.dependencies ?? {})).toEqual(["undici"]);
  });

  it("does not ship OpenTelemetry as an optional dependency", () => {
    // optionalDependencies install BY DEFAULT. The OTel SDK pulls ~35
    // transitive packages (~74 MB) and, at the versions that work with
    // src/telemetry/otel.mjs, carried 19 advisories that every `npm audit`
    // would surface — for a feature gated behind PROCWAY_TELEMETRY, which is
    // off by default. Tracing is documented as a manual install instead
    // (README "Tracing"); otel.mjs already degrades to a no-op controller.
    const optional = Object.keys(pkg.optionalDependencies ?? {});
    expect(optional.filter((name) => name.startsWith("@opentelemetry/"))).toEqual([]);
    expect(optional).toEqual(["keytar"]);
  });
});
