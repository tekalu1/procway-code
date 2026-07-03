import { describe, expect, it } from "vitest";
import {
  hydrateImageRefs,
  isImageMime,
  inferImageMime,
  isInlineImageBlock,
  imageBlockToDataUrl
} from "../src/providers/image-hydration.mjs";

function fakeReader(map) {
  return async (resolved) => {
    for (const [key, value] of Object.entries(map)) {
      if (resolved === key || resolved.endsWith(key)) return Buffer.from(value);
    }
    const err = new Error(`ENOENT: ${resolved}`);
    err.code = "ENOENT";
    throw err;
  };
}

function fakeStat(map) {
  return async (resolved) => {
    for (const [key, value] of Object.entries(map)) {
      if (resolved === key || resolved.endsWith(key)) return { size: Buffer.from(value).length };
    }
    const err = new Error(`ENOENT: ${resolved}`);
    err.code = "ENOENT";
    throw err;
  };
}

describe("image-hydration", () => {
  it("infers image mime from extension and honors explicit mime", () => {
    expect(inferImageMime("/a/b.png")).toBe("image/png");
    expect(inferImageMime("/a/b.JPG")).toBe("image/jpeg");
    expect(inferImageMime("/a/b.webp")).toBe("image/webp");
    expect(inferImageMime("/a/b.txt")).toBeNull();
    expect(inferImageMime("/a/b.bin", "image/png")).toBe("image/png");
    expect(isImageMime("image/gif")).toBe(true);
    expect(isImageMime("application/pdf")).toBe(false);
  });

  it("returns the same array (no copy) when there is nothing to hydrate", async () => {
    const messages = [{ role: "user", content: [{ kind: "text", text: "hi" }] }];
    const out = await hydrateImageRefs(messages, { readFile: fakeReader({}) });
    expect(out).toBe(messages);
  });

  it("replaces an image file_ref with an inline base64 image block", async () => {
    const messages = [{
      role: "user",
      content: [
        { kind: "text", text: "look" },
        { kind: "file_ref", path: "/ws/shot.png" }
      ]
    }];
    const out = await hydrateImageRefs(messages, { readFile: fakeReader({ "/ws/shot.png": "PNGBYTES" }) });
    expect(out).not.toBe(messages); // copied
    expect(out[0].content[0]).toEqual({ kind: "text", text: "look" });
    const img = out[0].content[1];
    expect(isInlineImageBlock(img)).toBe(true);
    expect(img.mime).toBe("image/png");
    expect(img.dataBase64).toBe(Buffer.from("PNGBYTES").toString("base64"));
    expect(imageBlockToDataUrl(img)).toBe(`data:image/png;base64,${img.dataBase64}`);
  });

  it("leaves non-image file_refs untouched", async () => {
    const messages = [{
      role: "user",
      content: [{ kind: "file_ref", path: "/ws/notes.txt" }]
    }];
    const out = await hydrateImageRefs(messages, { readFile: fakeReader({ "/ws/notes.txt": "x" }) });
    expect(out).toBe(messages);
  });

  it("degrades to a text note when the file cannot be read", async () => {
    const messages = [{
      role: "tool",
      content: [
        { kind: "tool_result", toolCallId: "t1", ok: true, result: { kind: "view_image", summary: "s", data: {} } },
        { kind: "file_ref", path: "/ws/missing.png" }
      ]
    }];
    const out = await hydrateImageRefs(messages, { readFile: fakeReader({}) });
    const note = out[0].content[1];
    expect(note.kind).toBe("text");
    expect(note.text).toContain("missing.png");
    expect(note.text).toContain("unavailable");
  });

  it("degrades to a text note when the image exceeds the byte cap", async () => {
    const messages = [{ role: "user", content: [{ kind: "file_ref", path: "/ws/big.png" }] }];
    const out = await hydrateImageRefs(messages, {
      readFile: fakeReader({ "/ws/big.png": "abcdef" }),
      maxBytes: 3
    });
    const note = out[0].content[0];
    expect(note.kind).toBe("text");
    expect(note.text).toContain("exceeds");
  });

  it("bounds cumulative image bytes: keeps the newest, degrades older to text", async () => {
    const messages = [
      { role: "user", content: [{ kind: "file_ref", path: "/ws/a.png" }] }, // oldest
      { role: "user", content: [{ kind: "file_ref", path: "/ws/b.png" }] },
      { role: "user", content: [{ kind: "file_ref", path: "/ws/c.png" }] } // newest
    ];
    const files = { "/ws/a.png": "AAAA", "/ws/b.png": "BBBB", "/ws/c.png": "CCCC" }; // 4 bytes each
    const out = await hydrateImageRefs(messages, {
      readFile: fakeReader(files),
      stat: fakeStat(files),
      maxTotalBytes: 9 // fits the two newest (8 bytes); the oldest is dropped
    });
    expect(out[0].content[0].kind).toBe("text"); // a.png degraded
    expect(out[0].content[0].text).toContain("a.png");
    expect(out[0].content[0].text).toContain("omitted to bound");
    expect(isInlineImageBlock(out[1].content[0])).toBe(true); // b.png kept
    expect(isInlineImageBlock(out[2].content[0])).toBe(true); // c.png kept
  });

  it("keeps the single newest image even if it alone exceeds the cumulative budget", async () => {
    const messages = [{ role: "user", content: [{ kind: "file_ref", path: "/ws/huge.png" }] }];
    const files = { "/ws/huge.png": "ABCDEFGHIJ" }; // 10 bytes
    const out = await hydrateImageRefs(messages, {
      readFile: fakeReader(files),
      stat: fakeStat(files),
      maxTotalBytes: 3
    });
    expect(isInlineImageBlock(out[0].content[0])).toBe(true);
  });

  it("no cumulative cap by default (unbounded, prior behavior)", async () => {
    const messages = [
      { role: "user", content: [{ kind: "file_ref", path: "/ws/a.png" }] },
      { role: "user", content: [{ kind: "file_ref", path: "/ws/b.png" }] }
    ];
    const files = { "/ws/a.png": "AAAA", "/ws/b.png": "BBBB" };
    const out = await hydrateImageRefs(messages, { readFile: fakeReader(files), stat: fakeStat(files) });
    expect(isInlineImageBlock(out[0].content[0])).toBe(true);
    expect(isInlineImageBlock(out[1].content[0])).toBe(true);
  });
});

// attachment_ref hydration: bytes come from the dashboard over HTTP — the
// single attachment transport. No shared-volume path is ever consulted.
describe("image-hydration: attachment_ref (HTTP fetch)", () => {
  function fakeFetch(responder) {
    const calls = [];
    const impl = async (url, init) => {
      calls.push({ url, init });
      return responder(url, init);
    };
    impl.calls = calls;
    return impl;
  }

  function okImageResponse(bytes, mime = "image/png") {
    const buf = Buffer.from(bytes);
    return {
      ok: true,
      status: 200,
      headers: { get: (k) => (k.toLowerCase() === "content-type" ? mime : null) },
      arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
    };
  }

  const baseOpts = { dashboardUrl: "http://dashboard:3333", proxyToken: "tok-1" };

  it("fetches the bytes by id and inlines a base64 image block", async () => {
    const fetchImpl = fakeFetch(() => okImageResponse("PNGDATA", "image/png"));
    const messages = [{
      role: "user",
      content: [
        { kind: "text", text: "see attached" },
        { kind: "attachment_ref", id: "att-1", mime: "image/png" }
      ]
    }];
    const out = await hydrateImageRefs(messages, { ...baseOpts, fetchImpl });
    expect(out[0].content[1]).toEqual({
      kind: "image",
      mime: "image/png",
      dataBase64: Buffer.from("PNGDATA").toString("base64")
    });
    // Single transport: the dashboard endpoint, authenticated with the
    // session token header.
    expect(fetchImpl.calls).toHaveLength(1);
    expect(fetchImpl.calls[0].url).toBe("http://dashboard:3333/api/ai/attachments/att-1");
    expect(fetchImpl.calls[0].init.headers["x-procway-session"]).toBe("tok-1");
  });

  it("prefers the response Content-Type over the block mime", async () => {
    const fetchImpl = fakeFetch(() => okImageResponse("WEBP", "image/webp"));
    const messages = [{ role: "user", content: [{ kind: "attachment_ref", id: "att-2", mime: "image/png" }] }];
    const out = await hydrateImageRefs(messages, { ...baseOpts, fetchImpl });
    expect(out[0].content[0].mime).toBe("image/webp");
  });

  it("omits the token header when no proxy token is set (local mode)", async () => {
    const fetchImpl = fakeFetch(() => okImageResponse("X"));
    const messages = [{ role: "user", content: [{ kind: "attachment_ref", id: "att-3" }] }];
    await hydrateImageRefs(messages, { dashboardUrl: "http://localhost:3333", proxyToken: undefined, fetchImpl });
    expect(fetchImpl.calls[0].init.headers["x-procway-session"]).toBeUndefined();
  });

  it("degrades to a text note on a non-2xx response", async () => {
    const fetchImpl = fakeFetch(() => ({ ok: false, status: 404, statusText: "Not Found", headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) }));
    const messages = [{ role: "user", content: [{ kind: "attachment_ref", id: "att-4" }] }];
    const out = await hydrateImageRefs(messages, { ...baseOpts, fetchImpl });
    expect(out[0].content[0].kind).toBe("text");
    expect(out[0].content[0].text).toContain("att-4");
    expect(out[0].content[0].text).toContain("404");
  });

  it("degrades to a text note when PROCWAY_DASHBOARD_URL is missing", async () => {
    const fetchImpl = fakeFetch(() => okImageResponse("X"));
    const messages = [{ role: "user", content: [{ kind: "attachment_ref", id: "att-5" }] }];
    const out = await hydrateImageRefs(messages, { dashboardUrl: undefined, proxyToken: undefined, fetchImpl });
    expect(out[0].content[0].kind).toBe("text");
    expect(out[0].content[0].text).toContain("PROCWAY_DASHBOARD_URL");
    expect(fetchImpl.calls).toHaveLength(0);
  });

  it("enforces the per-image byte cap on fetched attachments", async () => {
    const fetchImpl = fakeFetch(() => okImageResponse("0123456789"));
    const messages = [{ role: "user", content: [{ kind: "attachment_ref", id: "att-6" }] }];
    const out = await hydrateImageRefs(messages, { ...baseOpts, fetchImpl, maxBytes: 4 });
    expect(out[0].content[0].kind).toBe("text");
    expect(out[0].content[0].text).toContain("exceeds 4 byte limit");
  });
});
