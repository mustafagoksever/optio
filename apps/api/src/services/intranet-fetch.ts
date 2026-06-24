import http from "node:http";
import https from "node:https";
import { retrieveSecret } from "./secret-service.js";

async function readCompanyCa(workspaceId?: string | null): Promise<string | null> {
  try {
    return await retrieveSecret("COMPANY_CA_PEM", "global", workspaceId ?? undefined);
  } catch {
    return null;
  }
}

function headersToObject(headers?: HeadersInit): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) {
    const obj: Record<string, string> = {};
    headers.forEach((value, key) => {
      obj[key] = value;
    });
    return obj;
  }
  if (Array.isArray(headers)) return Object.fromEntries(headers);
  return headers as Record<string, string>;
}

function nodeHeadersToFetchHeaders(headers: http.IncomingHttpHeaders): Headers {
  const fetchHeaders = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const item of value) fetchHeaders.append(key, item);
    } else if (value !== undefined) {
      fetchHeaders.set(key, String(value));
    }
  }
  return fetchHeaders;
}

async function bodyToNodeChunk(body: BodyInit | null | undefined): Promise<Buffer | string | null> {
  if (!body) return null;
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  if (body instanceof Blob) return Buffer.from(await body.arrayBuffer());
  return null;
}

async function nodeFetch(url: URL, init: RequestInit, ca: string): Promise<Response> {
  const transport = url.protocol === "http:" ? http : https;
  const body = await bodyToNodeChunk(init.body ?? null);
  if (init.body && body === null) return fetch(url, init);

  return new Promise((resolve, reject) => {
    const req = transport.request(
      url,
      {
        method: init.method ?? "GET",
        headers: headersToObject(init.headers),
        ...(url.protocol === "https:" ? { ca } : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        res.on("end", () => {
          resolve(
            new Response(Buffer.concat(chunks), {
              status: res.statusCode ?? 0,
              statusText: res.statusMessage,
              headers: nodeHeadersToFetchHeaders(res.headers),
            }),
          );
        });
      },
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

export async function intranetFetch(
  input: string | URL,
  init: RequestInit = {},
  workspaceId?: string | null,
): Promise<Response> {
  const ca = await readCompanyCa(workspaceId);
  if (!ca) return fetch(input, init);
  const url = input instanceof URL ? input : new URL(String(input));
  if (url.protocol !== "https:" && url.protocol !== "http:") return fetch(input, init);
  return nodeFetch(url, init, ca);
}
