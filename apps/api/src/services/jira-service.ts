import { intranetFetch } from "./intranet-fetch.js";

export interface JiraIssueDetails {
  key: string;
  title: string;
  description: string;
  url: string;
}

function normalizeBaseUrl(value: string): string {
  const withScheme = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  const url = new URL(withScheme);
  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/+$/, "");
}

function joinJiraPath(baseUrl: string, path: string): string {
  return `${normalizeBaseUrl(baseUrl)}${path.startsWith("/") ? path : `/${path}`}`;
}

function jiraHeaders(pat: string): Record<string, string> {
  return {
    Authorization: `Bearer ${pat}`,
    Accept: "application/json",
    "User-Agent": "Optio",
  };
}

function adfToText(value: unknown): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(adfToText).filter(Boolean).join("\n");
  if (typeof value !== "object") return "";

  const node = value as {
    type?: string;
    text?: string;
    content?: unknown[];
  };
  if (node.text) return node.text;
  const text = (node.content ?? [])
    .map(adfToText)
    .filter(Boolean)
    .join(node.type === "paragraph" ? " " : "\n");
  return text;
}

export async function fetchJiraIssue(
  baseUrl: string,
  pat: string,
  issueKey: string,
): Promise<JiraIssueDetails> {
  const normalizedBase = normalizeBaseUrl(baseUrl);
  const encodedKey = encodeURIComponent(issueKey.trim().toUpperCase());
  let lastStatus = 0;

  for (const apiVersion of ["2", "3"]) {
    const res = await intranetFetch(
      joinJiraPath(normalizedBase, `/rest/api/${apiVersion}/issue/${encodedKey}`),
      {
        headers: jiraHeaders(pat),
      },
    );
    lastStatus = res.status;
    if (!res.ok) continue;

    const body = (await res.json()) as {
      key?: string;
      fields?: {
        summary?: string;
        description?: unknown;
      };
    };
    const key = body.key ?? issueKey.trim().toUpperCase();
    const title = body.fields?.summary?.trim() || key;
    return {
      key,
      title,
      description: adfToText(body.fields?.description).trim(),
      url: joinJiraPath(normalizedBase, `/browse/${encodeURIComponent(key)}`),
    };
  }

  throw new Error(`Jira issue fetch failed with ${lastStatus || "unknown status"}`);
}
