/**
 * Stdio transport for the MCP host server. Reads newline-delimited JSON-RPC
 * messages from stdin, dispatches to the server, writes responses to stdout.
 * Errors and diagnostics go to stderr so they don't pollute the protocol stream.
 *
 * This is the transport sub-CLIs (codex / claude code) use natively when they
 * spawn an MCP server via `[mcp_servers.foo] command="..." args=[...]`.
 */

export function runStdioTransport({ server, stdin = process.stdin, stdout = process.stdout, stderr = process.stderr, trace = () => {} }) {
  let buffer = "";
  let closed = false;

  return new Promise((resolve) => {
    stdin.setEncoding("utf8");

    stdin.on("data", (chunk) => {
      buffer += chunk;
      while (true) {
        const nl = buffer.indexOf("\n");
        if (nl < 0) break;
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch (err) {
          stderr.write(`[mcp-host] failed to parse: ${err.message}\n`);
          continue;
        }
        trace("stdio rx", message?.method ?? "(no method)", "id=" + (message?.id ?? "(none)"));
        // Fire-and-forget; preserves request ordering well enough for the
        // small number of in-flight tool calls a single sub-CLI emits.
        server.handleMessage(message).then((response) => {
          if (response && !closed) {
            trace("stdio tx", "id=" + (response.id ?? "(none)"), response.error ? "error" : "ok");
            stdout.write(`${JSON.stringify(response)}\n`);
          } else if (!response) {
            trace("stdio tx", "(no response, notification)");
          }
        }).catch((err) => {
          stderr.write(`[mcp-host] handler error: ${err.message}\n`);
          trace("stdio tx error", err.message);
        });
      }
    });

    const finish = () => {
      if (closed) return;
      closed = true;
      resolve();
    };
    stdin.on("end", finish);
    stdin.on("close", finish);
  });
}
