/**
 * Read a secret from a TTY without echoing it.
 *
 * P2-1 scope note: inside the REPL this is NOT used any more — hidden input is
 * a mode of the single input controller (`InputController#readSecret`), so the
 * `suspendDataListeners` trick below (detach the owner's `data` listeners, read
 * the secret, put them back) is no longer needed there. It survives for the
 * one-shot, non-REPL path `procway-code config set-secret <ENV>`, where nothing
 * else owns stdin. Pausing an interface alone was never enough: resuming stdin
 * for the secret also wakes the owner and makes it repaint the raw token.
 */
export async function readSecretInput({
  input = process.stdin,
  output = process.stdout,
  prompt = "",
  suspendDataListeners = false
} = {}) {
  if (!input.isTTY || typeof input.setRawMode !== "function") {
    const chunks = [];
    for await (const chunk of input) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString("utf8").replace(/[\r\n]+$/, "");
  }

  const suspended = suspendDataListeners ? input.listeners("data") : [];
  for (const listener of suspended) input.removeListener("data", listener);
  const wasRaw = input.isRaw === true;
  output.write(prompt);
  input.setRawMode(true);
  input.resume();

  return new Promise((resolve, reject) => {
    let value = "";
    let settled = false;
    const cleanup = () => {
      if (settled) return;
      settled = true;
      input.removeListener("data", onData);
      input.setRawMode(wasRaw);
      if (!wasRaw) input.pause();
      for (const listener of suspended) input.on("data", listener);
    };
    const finish = (result, error = null) => {
      cleanup();
      output.write("\n");
      if (error) reject(error);
      else resolve(result);
    };
    const onData = (chunk) => {
      for (const char of chunk.toString("utf8")) {
        if (char === "\u0003") {
          finish(null, new Error("Secret input cancelled"));
          return;
        }
        if (char === "\r" || char === "\n") {
          finish(value);
          return;
        }
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
        else if (char >= " ") value += char;
      }
    };
    input.on("data", onData);
  });
}
