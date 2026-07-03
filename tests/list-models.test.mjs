import { describe, expect, it } from "vitest";
import { listModels, ListModelsError } from "../src/providers/list-models.mjs";

function jsonResponse(payload, init = {}) {
  return new Response(JSON.stringify(payload), {
    status: init.status ?? 200,
    statusText: init.statusText ?? "OK",
    headers: { "content-type": "application/json" }
  });
}

function errorResponse(status, body = "boom") {
  return new Response(body, { status, statusText: `Error ${status}` });
}

describe("listModels (openai-compatible)", () => {
  const provider = {
    type: "openai-compatible",
    apiKeyEnv: "OPENAI_API_KEY",
    baseUrl: "https://example.test/v1"
  };

  it("returns model ids from data[].id", async () => {
    let captured;
    const fetchImpl = async (url, init) => {
      captured = { url, init };
      return jsonResponse({ data: [{ id: "gpt-5.5" }, { id: "gpt-4o" }] });
    };
    const result = await listModels({ provider, fetchImpl, env: { OPENAI_API_KEY: "sk-x" } });
    expect(result.models).toEqual(["gpt-5.5", "gpt-4o"]);
    expect(captured.url).toBe("https://example.test/v1/models");
    expect(captured.init.method).toBe("GET");
    expect(captured.init.headers.Authorization).toBe("Bearer sk-x");
  });

  it("strips trailing slash from baseUrl", async () => {
    let captured;
    const fetchImpl = async (url) => {
      captured = url;
      return jsonResponse({ data: [] });
    };
    await listModels({
      provider: { ...provider, baseUrl: "https://example.test/v1/" },
      fetchImpl,
      env: { OPENAI_API_KEY: "sk-x" }
    });
    expect(captured).toBe("https://example.test/v1/models");
  });

  it("throws unauthorized on 401", async () => {
    const fetchImpl = async () => errorResponse(401, "bad key");
    await expect(listModels({ provider, fetchImpl, env: { OPENAI_API_KEY: "sk-x" } }))
      .rejects.toMatchObject({ name: "ListModelsError", code: "unauthorized", status: 401 });
  });

  it("throws not-implemented on 404", async () => {
    const fetchImpl = async () => errorResponse(404, "no route");
    await expect(listModels({ provider, fetchImpl, env: { OPENAI_API_KEY: "sk-x" } }))
      .rejects.toMatchObject({ code: "not-implemented", status: 404 });
  });

  it("throws unauthorized when api key env var is missing", async () => {
    await expect(listModels({ provider, env: {}, fetchImpl: async () => jsonResponse({ data: [] }) }))
      .rejects.toMatchObject({ code: "unauthorized" });
  });

  it("wraps fetch failures as network errors", async () => {
    const fetchImpl = async () => { throw new Error("ECONNREFUSED"); };
    await expect(listModels({ provider, fetchImpl, env: { OPENAI_API_KEY: "sk-x" } }))
      .rejects.toMatchObject({ code: "network" });
  });
});

describe("listModels (anthropic)", () => {
  const provider = {
    type: "anthropic",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    baseUrl: "https://api.anthropic.com"
  };

  it("calls /v1/models with x-api-key header", async () => {
    let captured;
    const fetchImpl = async (url, init) => {
      captured = { url, init };
      return jsonResponse({ data: [{ id: "claude-sonnet-4-6" }] });
    };
    const result = await listModels({ provider, fetchImpl, env: { ANTHROPIC_API_KEY: "k" } });
    expect(captured.url).toBe("https://api.anthropic.com/v1/models");
    expect(captured.init.headers["x-api-key"]).toBe("k");
    expect(captured.init.headers["anthropic-version"]).toBe("2023-06-01");
    expect(result.models).toEqual(["claude-sonnet-4-6"]);
  });
});

describe("listModels (cli-agent)", () => {
  it("throws not-implemented for cli-agent providers", async () => {
    await expect(listModels({ provider: { type: "cli-agent", command: "x" }, fetchImpl: async () => null }))
      .rejects.toMatchObject({ code: "not-implemented" });
  });
});

describe("ListModelsError", () => {
  it("carries code and optional status", () => {
    const err = new ListModelsError("unauthorized", "msg", { status: 401 });
    expect(err.code).toBe("unauthorized");
    expect(err.status).toBe(401);
    expect(err.name).toBe("ListModelsError");
  });
});
