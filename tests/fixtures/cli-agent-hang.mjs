#!/usr/bin/env node
// Test fixture: a cli-agent that consumes its request and then NEVER responds,
// simulating an upstream that goes silent (the turn produces no further agent
// events). Exits on SIGTERM/SIGINT so an abort() — including the turn idle
// watchdog — can reclaim it instead of leaking the process.
let _buf = "";
process.stdin.on("data", (c) => { _buf += c; });
process.stdin.resume();
process.on("SIGTERM", () => process.exit(143));
process.on("SIGINT", () => process.exit(130));
// Stay alive, emit nothing.
setInterval(() => {}, 1 << 30);
