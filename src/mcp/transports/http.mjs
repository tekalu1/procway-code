import { parseSseStream } from "../../providers/sse.mjs";

/**
 * Phase 6 §2.2 — HTTP / SSE MCP transport.
 *
 * Compatible with the EventEmitter-style contract used by `StdioMcpTransport`:
 *   - `start()` opens an SSE stream at `<baseUrl>/sse` and returns once the
 *     connection is established.
 *   - `send(message)` POSTs the JSON-RPC request to `<baseUrl>/messages`.
 *   - JSON-RPC responses are pushed back through `onmessage`.
 *
 * Auth modes:
 *   - Bearer:  pre-set headers["Authorization"] = "Bearer <token>"
 *   - OAuth:   `oauth: { tokenEndpoint, clientId, refreshToken? }` triggers a
 *              token grant on `start()` and refresh on 401 responses.
 *   - authProvider: async `() => headers` re-invoked on start() and on 401.
 *              Used by dashboard-distributed connections to re-read the
 *              connections snapshot after the dashboard's refresh sweep
 *              rotates a token (the Pod never holds a refresh token itself).
 */
export class HttpMcpTransport {
  constructor({
    baseUrl,
    headers = {},
    oauth = null,
    authProvider = null,
    fetchImpl,
    sseStreamFactory = null,
    bodyTimeoutMs = 30000
  } = {}) {
    if (typeof baseUrl !== "string" || baseUrl.length === 0) {
      throw new TypeError("HttpMcpTransport: baseUrl is required");
    }
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.headers = { ...headers };
    this.oauth = oauth;
    this.authProvider = authProvider;
    this.fetchImpl = fetchImpl ?? globalThis.fetch;
    this.sseStreamFactory = sseStreamFactory;
    this.bodyTimeoutMs = bodyTimeoutMs;
    this.onmessage = null;
    this.onerror = null;
    this.onclose = null;
    this.abortController = null;
    this.consumer = null;
    this.token = null;
  }

  async applyAuthProvider() {
    if (!this.authProvider) return;
    const fresh = await this.authProvider();
    if (fresh && typeof fresh === "object") {
      this.headers = { ...this.headers, ...fresh };
    }
  }

  async start() {
    await this.applyAuthProvider();
    if (this.oauth) {
      const token = await this.fetchOauthToken();
      this.token = token;
      this.headers.Authorization = `Bearer ${token}`;
    }
    if (this.sseStreamFactory) {
      const stream = await this.sseStreamFactory({ baseUrl: this.baseUrl, headers: this.headers });
      this.consumer = this.consumeSseStream(stream).catch((error) => this.onerror?.(error));
      return;
    }
    this.abortController = new AbortController();
    const response = await this.fetchImpl(`${this.baseUrl}/sse`, {
      method: "GET",
      headers: { ...this.headers, Accept: "text/event-stream" },
      signal: this.abortController.signal
    });
    if (!response.ok) {
      throw new Error(`MCP HTTP transport: SSE handshake failed (${response.status})`);
    }
    this.consumer = this.consumeSseStream(response.body).catch((error) => this.onerror?.(error));
  }

  async send(message) {
    let response = await this.postMessage(message);
    if (response.status === 401 && this.oauth?.refreshToken) {
      const token = await this.fetchOauthToken({ forceRefresh: true });
      this.token = token;
      this.headers.Authorization = `Bearer ${token}`;
      response = await this.postMessage(message);
    } else if (response.status === 401 && this.authProvider) {
      await this.applyAuthProvider();
      response = await this.postMessage(message);
    }
    if (!response.ok) {
      throw new Error(`MCP HTTP transport: POST /messages failed (${response.status})`);
    }
    const contentType = String(response.headers?.get?.("content-type") ?? "").toLowerCase();
    if (contentType.includes("application/json")) {
      const body = await response.json();
      if (body && typeof body === "object" && Object.prototype.hasOwnProperty.call(body, "id")) {
        queueMicrotask(() => this.onmessage?.(body));
      }
    }
    // For SSE-streamed responses the consumer task delivers messages.
  }

  async close() {
    try {
      this.abortController?.abort();
    } catch {
      // ignored
    }
    this.onclose?.();
  }

  async consumeSseStream(stream) {
    if (!stream) return;
    for await (const record of parseSseStream(stream)) {
      if (!record) continue;
      if (record.type === "done") continue;
      const payload = record.data ?? record;
      if (payload && typeof payload === "object" && Object.prototype.hasOwnProperty.call(payload, "id")) {
        this.onmessage?.(payload);
        continue;
      }
      if (record.type && record.type !== "message") continue;
      if (payload && typeof payload === "object") {
        this.onmessage?.(payload);
      }
    }
  }

  async postMessage(message) {
    return this.fetchImpl(`${this.baseUrl}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...this.headers
      },
      body: JSON.stringify(message)
    });
  }

  async fetchOauthToken({ forceRefresh = false } = {}) {
    const oauth = this.oauth;
    if (!oauth?.tokenEndpoint) {
      throw new Error("MCP HTTP transport: oauth.tokenEndpoint is required");
    }
    const params = new URLSearchParams();
    if (oauth.refreshToken && (forceRefresh || !oauth.clientCredentials)) {
      params.set("grant_type", "refresh_token");
      params.set("refresh_token", oauth.refreshToken);
    } else {
      params.set("grant_type", oauth.grantType ?? "client_credentials");
    }
    if (oauth.clientId) params.set("client_id", oauth.clientId);
    if (oauth.clientSecret) params.set("client_secret", oauth.clientSecret);
    if (oauth.scope) params.set("scope", oauth.scope);
    const response = await this.fetchImpl(oauth.tokenEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json"
      },
      body: params.toString()
    });
    if (!response.ok) {
      throw new Error(`MCP HTTP transport: OAuth token endpoint returned ${response.status}`);
    }
    const body = await response.json();
    const token = body?.access_token;
    if (typeof token !== "string" || token.length === 0) {
      throw new Error("MCP HTTP transport: OAuth response missing access_token");
    }
    if (typeof body.refresh_token === "string" && body.refresh_token.length > 0) {
      this.oauth = { ...this.oauth, refreshToken: body.refresh_token };
    }
    return token;
  }
}
