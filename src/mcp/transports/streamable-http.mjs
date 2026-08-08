import { parseSseStream } from "../../providers/sse.mjs";
import { HttpMcpTransport } from "./http.mjs";

/**
 * Streamable HTTP MCP transport (spec 2025-03-26+) — the modern single-
 * endpoint style used by current remote MCP servers (Notion, Linear,
 * GitHub, ...):
 *   - every JSON-RPC message is POSTed to `<baseUrl>` itself
 *   - the response is either `application/json` (single message) or a
 *     `text/event-stream` carrying one or more messages
 *   - the server may issue an `Mcp-Session-Id` on initialize; we echo it
 *     (and the negotiated `MCP-Protocol-Version`) on subsequent requests
 *
 * Legacy interop: when the FIRST request (initialize) comes back 404/405,
 * the server predates Streamable HTTP — per the spec's backwards-
 * compatibility procedure we fall back to the legacy HTTP+SSE transport
 * (`GET <baseUrl>/sse` + `POST <baseUrl>/messages`) and delegate to it from
 * then on. Existing `transport: "http"` settings against legacy servers
 * therefore keep working.
 *
 * Auth: static `headers`, plus an optional `authProvider` — an async
 * `() => headers` re-invoked on start and on 401 responses. Used by
 * dashboard-distributed connections to re-read the snapshot after the
 * dashboard's refresh sweep rotates a token.
 */
export class StreamableHttpMcpTransport {
  constructor({
    baseUrl,
    headers = {},
    authProvider = null,
    fetchImpl,
    legacyFallback = true
  } = {}) {
    if (typeof baseUrl !== "string" || baseUrl.length === 0) {
      throw new TypeError("StreamableHttpMcpTransport: baseUrl is required");
    }
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.staticHeaders = { ...headers };
    this.authHeaders = {};
    this.authProvider = authProvider;
    this.fetchImpl = fetchImpl ?? globalThis.fetch;
    this.legacyFallback = legacyFallback;
    this.onmessage = null;
    this.onerror = null;
    this.onclose = null;
    this.sessionId = null;
    this.protocolVersion = null;
    this.initialized = false;
    this.legacy = null;
    this.consumers = new Set();
  }

  async start() {
    await this.refreshAuthHeaders();
    // No eager connection: Streamable HTTP has no handshake before the
    // first POST (initialize), which the McpClient sends via send().
  }

  async refreshAuthHeaders() {
    if (!this.authProvider) return;
    try {
      const fresh = await this.authProvider();
      this.authHeaders = fresh && typeof fresh === "object" ? { ...fresh } : {};
    } catch (error) {
      this.onerror?.(error);
    }
  }

  requestHeaders() {
    return {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(this.sessionId ? { "Mcp-Session-Id": this.sessionId } : {}),
      ...(this.protocolVersion ? { "MCP-Protocol-Version": this.protocolVersion } : {}),
      ...this.staticHeaders,
      ...this.authHeaders
    };
  }

  async send(message) {
    if (this.legacy) return this.legacy.send(message);
    let response = await this.post(message);
    if (response.status === 401 && this.authProvider) {
      await response.body?.cancel?.().catch(() => {});
      await this.refreshAuthHeaders();
      response = await this.post(message);
    }
    if (
      this.legacyFallback
      && !this.initialized
      && (response.status === 404 || response.status === 405)
      && message?.method === "initialize"
    ) {
      await response.body?.cancel?.().catch(() => {});
      await this.enterLegacyMode();
      return this.legacy.send(message);
    }
    if (response.status === 202) {
      // Notification/response accepted with no body (e.g. notifications/initialized).
      await response.body?.cancel?.().catch(() => {});
      return;
    }
    if (!response.ok) {
      await response.body?.cancel?.().catch(() => {});
      throw new Error(`MCP Streamable HTTP transport: POST failed (${response.status})`);
    }
    const sid = response.headers?.get?.("mcp-session-id");
    if (sid) this.sessionId = sid;
    const contentType = String(response.headers?.get?.("content-type") ?? "").toLowerCase();
    if (contentType.includes("application/json")) {
      const body = await response.json();
      this.noteInitializeResult(message, body);
      if (body && typeof body === "object" && Object.prototype.hasOwnProperty.call(body, "id")) {
        queueMicrotask(() => this.onmessage?.(body));
      }
      return;
    }
    if (contentType.includes("text/event-stream")) {
      const consumer = this.consumeSseStream(response.body, message)
        .catch((error) => this.onerror?.(error));
      this.consumers.add(consumer);
      consumer.finally(() => this.consumers.delete(consumer));
      return;
    }
    // Bodyless success (204 etc.) — nothing to deliver.
    await response.body?.cancel?.().catch(() => {});
  }

  async post(message) {
    return this.fetchImpl(this.baseUrl, {
      method: "POST",
      headers: this.requestHeaders(),
      body: JSON.stringify(message)
    });
  }

  noteInitializeResult(request, body) {
    if (request?.method !== "initialize") return;
    const negotiated = body?.result?.protocolVersion;
    if (typeof negotiated === "string" && negotiated.length > 0) {
      this.protocolVersion = negotiated;
    }
    this.initialized = true;
  }

  async consumeSseStream(stream, request) {
    if (!stream) return;
    for await (const record of parseSseStream(stream)) {
      if (!record) continue;
      if (record.type === "done") continue;
      const payload = record.data ?? record;
      if (payload && typeof payload === "object") {
        this.noteInitializeResult(request, payload);
        if (Object.prototype.hasOwnProperty.call(payload, "id")) {
          this.onmessage?.(payload);
          continue;
        }
        if (!record.type || record.type === "message") {
          this.onmessage?.(payload);
        }
      }
    }
  }

  async enterLegacyMode() {
    const legacy = new HttpMcpTransport({
      baseUrl: this.baseUrl,
      headers: { ...this.staticHeaders, ...this.authHeaders },
      authProvider: this.authProvider,
      fetchImpl: this.fetchImpl
    });
    legacy.onmessage = (m) => this.onmessage?.(m);
    legacy.onerror = (e) => this.onerror?.(e);
    legacy.onclose = () => this.onclose?.();
    await legacy.start();
    this.legacy = legacy;
  }

  async close() {
    if (this.legacy) return this.legacy.close();
    if (this.sessionId) {
      // Best-effort session termination (spec: client SHOULD send DELETE).
      try {
        await this.fetchImpl(this.baseUrl, {
          method: "DELETE",
          headers: this.requestHeaders()
        });
      } catch {
        // ignored
      }
    }
    this.onclose?.();
  }
}
