/**
 * Confluence MCP tools (Phase C-1).
 *
 * Surface: list spaces, search content (CQL or text), get page (as
 * markdown-ish text), create/update pages.
 *
 * Storage format: Confluence stores page bodies as either `storage`
 * (XHTML-based) or `atlas_doc_format` (ADF). For create/update we send
 * `storage` with a literal `<p>...</p>` wrap when the caller passes
 * plain text — no full markdown→storage conversion. Callers that need
 * rich content can pass a raw `storage` value via `bodyStorage` to
 * bypass the wrap.
 */

import { callApi, resolveAuthForConnection } from "./_auth.mjs";

const ID = "confluence";

function escapeXml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function toStorageBody({ bodyText, bodyStorage }) {
  if (bodyStorage) return bodyStorage;
  if (typeof bodyText === "string") {
    return bodyText
      .split(/\r?\n\r?\n/) // double-newline → paragraph break
      .map((para) => `<p>${escapeXml(para).replace(/\r?\n/g, "<br/>")}</p>`)
      .join("");
  }
  return "";
}

function pageSummary(r) {
  return {
    id: r.id,
    title: r.title,
    spaceKey: r.space?.key ?? r._expandable?.space?.split("/").pop(),
    type: r.type,
    url: r._links?.webui ? r._links.webui : undefined,
    version: r.version?.number ?? undefined
  };
}

export async function listSpaces({ cwd, fetchImpl } = {}) {
  const out = await callApi({
    cwd, id: ID, fetchImpl,
    path: "/rest/api/space",
    query: { limit: 50 }
  });
  return (out?.results ?? []).map((s) => ({
    id: s.id,
    key: s.key,
    name: s.name,
    type: s.type
  }));
}

/**
 * Search pages via CQL or free-text. When `cql` is provided, it goes
 * verbatim. Otherwise we construct `text ~ "<term>" AND type = page`.
 */
export async function searchPages({ cwd, cql, query, limit, fetchImpl } = {}) {
  const effective = cql || (query ? `text ~ "${String(query).replace(/"/g, '\\"')}" AND type = page` : "");
  if (!effective) throw new Error("one of cql / query is required");
  const out = await callApi({
    cwd, id: ID, fetchImpl,
    path: "/rest/api/content/search",
    query: { cql: effective, limit: Math.min(Math.max(Number(limit) || 20, 1), 50) }
  });
  const auth = await resolveAuthForConnection(cwd, ID);
  const site = auth.meta?.siteUrl;
  return (out?.results ?? []).map((r) => {
    const sum = pageSummary(r);
    return {
      ...sum,
      url: site && sum.url ? `${site.replace(/\/+$/, "")}${sum.url}` : sum.url
    };
  });
}

export async function getPage({ cwd, pageId, fetchImpl } = {}) {
  if (!pageId) throw new Error("pageId is required");
  const out = await callApi({
    cwd, id: ID, fetchImpl,
    path: `/rest/api/content/${encodeURIComponent(pageId)}`,
    query: { expand: "body.storage,version,space" }
  });
  const sum = pageSummary(out);
  const auth = await resolveAuthForConnection(cwd, ID);
  const site = auth.meta?.siteUrl;
  return {
    ...sum,
    url: site && sum.url ? `${site.replace(/\/+$/, "")}${sum.url}` : sum.url,
    bodyStorage: out?.body?.storage?.value ?? "",
    version: out?.version?.number ?? sum.version
  };
}

export async function createPage({
  cwd, spaceKey, title, bodyText, bodyStorage, parentId, fetchImpl
} = {}) {
  if (!spaceKey || !title) throw new Error("spaceKey and title are required");
  const body = {
    type: "page",
    title,
    space: { key: spaceKey },
    body: { storage: { value: toStorageBody({ bodyText, bodyStorage }), representation: "storage" } }
  };
  if (parentId) body.ancestors = [{ id: String(parentId) }];
  const created = await callApi({
    cwd, id: ID, method: "POST", path: "/rest/api/content", body, fetchImpl
  });
  return getPage({ cwd, pageId: created.id, fetchImpl });
}

/**
 * Update a page. Confluence requires the new version number to be
 * `currentVersion + 1` — we read the current version internally so
 * callers don't have to.
 */
export async function updatePage({
  cwd, pageId, title, bodyText, bodyStorage, fetchImpl
} = {}) {
  if (!pageId) throw new Error("pageId is required");
  const current = await getPage({ cwd, pageId, fetchImpl });
  const nextVersion = (current.version ?? 1) + 1;
  const body = {
    type: "page",
    title: title ?? current.title,
    version: { number: nextVersion },
    body: {
      storage: {
        value: bodyText || bodyStorage
          ? toStorageBody({ bodyText, bodyStorage })
          : current.bodyStorage,
        representation: "storage"
      }
    }
  };
  await callApi({
    cwd, id: ID, method: "PUT",
    path: `/rest/api/content/${encodeURIComponent(pageId)}`,
    body, fetchImpl
  });
  return getPage({ cwd, pageId, fetchImpl });
}
