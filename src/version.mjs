// The package version, read from package.json at the install root. npm always
// ships package.json, so this resolves the same way in a checkout and in an
// installed copy.
import fs from "node:fs";

export const PACKAGE_VERSION = JSON.parse(
  fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")
).version;
