// Minimal cli-agent fixture: echoes the JSON {prompt} back as the assistant
// answer. Used by headless / streaming integration tests so we never call the
// real network.
let buf = "";
process.stdin.on("data", (chunk) => { buf += chunk.toString(); });
process.stdin.on("end", () => {
  let prompt = buf;
  try {
    const parsed = JSON.parse(buf);
    if (parsed && typeof parsed.prompt === "string") prompt = parsed.prompt;
  } catch {
    // raw text mode — buf is already the prompt
  }
  process.stdout.write(`echo: ${prompt}`);
  process.exit(0);
});
