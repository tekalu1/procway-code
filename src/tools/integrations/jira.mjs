/**
 * Jira MCP tools (Phase C-1). Read + write surface exposed to
 * procway-code via the host's tool registry.
 *
 * The corresponding dashboard module lives at
 * `dashboard/server/integrations/jira/issues.ts`. Future cleanup
 * (recorded in plan §4.3) is to extract a shared `packages/
 * integrations-core/` module; for the Phase C1 cut we accept some
 * duplication so ai-agent stays import-clean from `dashboard/`.
 *
 * Description handling: when the caller passes a plain string, we wrap
 * it in a minimal ADF doc so Jira's REST v3 accepts it. Pre-built ADF
 * is passed through unchanged.
 */

import { callApi } from "./_auth.mjs";

const ID = "jira";

function toAdf(input) {
  if (typeof input !== "string") return input;
  const lines = input.split(/\r?\n/);
  return {
    type: "doc",
    version: 1,
    content: lines.map((line) => ({
      type: "paragraph",
      content: line ? [{ type: "text", text: line }] : []
    }))
  };
}

function flattenAdfText(doc) {
  if (!doc) return "";
  const blockText = (n) => {
    if (n?.text) return n.text;
    if (!n?.content) return "";
    return n.content.map(blockText).join("");
  };
  return (doc.content || []).map(blockText).join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
}

function clampMax(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 1) return 20;
  return Math.min(Math.floor(v), 100);
}

function projectSummary(r) {
  return {
    id: r.id,
    key: r.key,
    name: r.name,
    projectTypeKey: r.projectTypeKey,
    avatarUrl: r.avatarUrls?.["48x48"]
  };
}

function issueSummary(r, siteUrl) {
  return {
    key: r.key,
    summary: r.fields?.summary ?? "",
    status: r.fields?.status?.name ?? null,
    assignee: r.fields?.assignee?.displayName ?? r.fields?.assignee?.accountId ?? null,
    updated: r.fields?.updated ?? null,
    url: siteUrl ? `${siteUrl.replace(/\/+$/, "")}/browse/${encodeURIComponent(r.key)}` : ""
  };
}

function issueDetail(r, siteUrl) {
  const desc = r.fields?.description ?? null;
  return {
    ...issueSummary(r, siteUrl),
    description: desc,
    descriptionText: desc ? flattenAdfText(desc) : "",
    issueType: r.fields?.issuetype?.name ?? "",
    priority: r.fields?.priority?.name ?? null,
    labels: r.fields?.labels ?? [],
    reporter: r.fields?.reporter?.displayName ?? r.fields?.reporter?.accountId ?? null,
    created: r.fields?.created ?? r.fields?.updated ?? null
  };
}

export async function listProjects({ cwd, fetchImpl } = {}) {
  const out = await callApi({
    cwd, id: ID, fetchImpl,
    path: "/rest/api/3/project/search",
    query: { maxResults: 100, orderBy: "name" }
  });
  const raws = Array.isArray(out) ? out : out?.values ?? [];
  return raws.map(projectSummary);
}

export async function searchIssues({ cwd, jql, maxResults, fields, fetchImpl } = {}) {
  if (!jql || !String(jql).trim()) throw new Error("jql is required");
  const body = {
    jql,
    fields: fields ?? ["summary", "status", "assignee", "updated"],
    maxResults: clampMax(maxResults ?? 20)
  };
  // Enhanced JQL search. Legacy `/rest/api/3/search` was sunset by
  // Atlassian (blocked Oct 2025); `/search/jql` replaces it. `fields`
  // must be explicit, pagination is `nextPageToken`-based, and `total`
  // is dropped. A single bounded page (<=100) preserves prior behaviour.
  const out = await callApi({ cwd, id: ID, method: "POST", path: "/rest/api/3/search/jql", body, fetchImpl });
  // siteUrl is needed for the browse URL — read it from the auth meta by re-resolving.
  const { resolveAuthForConnection } = await import("./_auth.mjs");
  const auth = await resolveAuthForConnection(cwd, ID);
  const site = auth.meta?.siteUrl;
  return (out?.issues ?? []).map((r) => issueSummary(r, site));
}

export async function getIssue({ cwd, key, fetchImpl } = {}) {
  if (!key) throw new Error("key is required");
  const out = await callApi({ cwd, id: ID, path: `/rest/api/3/issue/${encodeURIComponent(key)}`, fetchImpl });
  const { resolveAuthForConnection } = await import("./_auth.mjs");
  const auth = await resolveAuthForConnection(cwd, ID);
  return issueDetail(out, auth.meta?.siteUrl);
}

export async function createIssue({
  cwd, projectKey, summary, description,
  issueTypeName, issueTypeId, labels, assigneeAccountId, fetchImpl
} = {}) {
  if (!projectKey || !summary) throw new Error("projectKey and summary are required");
  if (!issueTypeId && !issueTypeName) throw new Error("one of issueTypeId / issueTypeName is required");
  const fields = {
    project: { key: projectKey },
    summary,
    issuetype: issueTypeId ? { id: issueTypeId } : { name: issueTypeName }
  };
  if (description !== undefined) fields.description = toAdf(description);
  if (labels?.length) fields.labels = labels;
  if (assigneeAccountId) fields.assignee = { accountId: assigneeAccountId };
  const created = await callApi({
    cwd, id: ID, method: "POST", path: "/rest/api/3/issue", body: { fields }, fetchImpl
  });
  return getIssue({ cwd, key: created.key, fetchImpl });
}

export async function updateIssue({
  cwd, key, summary, description, labels, fetchImpl
} = {}) {
  if (!key) throw new Error("key is required");
  const fields = {};
  if (summary !== undefined) fields.summary = summary;
  if (description !== undefined) fields.description = toAdf(description);
  if (labels !== undefined) fields.labels = labels;
  if (Object.keys(fields).length === 0) {
    throw new Error("at least one of summary / description / labels must be provided");
  }
  await callApi({
    cwd, id: ID, method: "PUT", path: `/rest/api/3/issue/${encodeURIComponent(key)}`,
    body: { fields }, fetchImpl
  });
  return getIssue({ cwd, key, fetchImpl });
}

export async function addComment({ cwd, key, body, fetchImpl } = {}) {
  if (!key || !body) throw new Error("key and body are required");
  const created = await callApi({
    cwd, id: ID, method: "POST",
    path: `/rest/api/3/issue/${encodeURIComponent(key)}/comment`,
    body: { body: toAdf(body) }, fetchImpl
  });
  return { id: created.id };
}

export async function listTransitions({ cwd, key, fetchImpl } = {}) {
  if (!key) throw new Error("key is required");
  const out = await callApi({
    cwd, id: ID, path: `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, fetchImpl
  });
  return (out?.transitions ?? []).map((t) => ({ id: t.id, name: t.name, to: t.to }));
}

export async function transitionIssue({ cwd, key, transitionId, fetchImpl } = {}) {
  if (!key || !transitionId) throw new Error("key and transitionId are required");
  await callApi({
    cwd, id: ID, method: "POST",
    path: `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`,
    body: { transition: { id: String(transitionId) } }, fetchImpl
  });
  return { transitioned: true, key, transitionId };
}
