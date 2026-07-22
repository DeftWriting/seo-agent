import { isIP, type LookupFunction } from "node:net";
import { resolve4, resolve6 } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { SitePage } from "../types.js";

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;

export interface SafeFetchOptions {
  signal?: AbortSignal | undefined;
  method?: "GET" | "HEAD" | undefined;
  timeoutMs?: number | undefined;
  maxBytes?: number | undefined;
  maxRedirects?: number | undefined;
  headers?: Record<string, string> | undefined;
}

export interface SafeFetchResult {
  url: string;
  status: number;
  ok: boolean;
  headers: Headers;
  text: string;
}

interface PublicTarget {
  url: URL;
  address: string;
  family: 4 | 6;
}

function parseIpv4(address: string): number[] | null {
  const pieces = address.split(".");
  if (pieces.length !== 4) return null;
  const bytes = pieces.map(Number);
  return bytes.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    ? bytes
    : null;
}

function isBlockedIpv4(address: string): boolean {
  const bytes = parseIpv4(address);
  if (!bytes) return true;
  const [a, b, c] = bytes as [number, number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function expandIpv6(address: string): number[] | null {
  const normalized = address.toLowerCase().split("%")[0] ?? "";
  const ipv4Tail = normalized.match(/(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  let source = normalized;
  if (ipv4Tail) {
    const bytes = parseIpv4(ipv4Tail);
    if (!bytes) return null;
    source = source.replace(
      ipv4Tail,
      `${((bytes[0]! << 8) | bytes[1]!).toString(16)}:${((bytes[2]! << 8) | bytes[3]!).toString(16)}`,
    );
  }
  const halves = source.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  const groups = [...left, ...Array(missing).fill("0"), ...right].map((part) =>
    Number.parseInt(part || "0", 16),
  );
  return groups.length === 8 && groups.every((group) => group >= 0 && group <= 0xffff)
    ? groups
    : null;
}

function isBlockedIpv6(address: string): boolean {
  const groups = expandIpv6(address);
  if (!groups) return true;
  if (groups.every((group) => group === 0)) return true;
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) return true;
  if ((groups[0]! & 0xfe00) === 0xfc00) return true; // fc00::/7
  if ((groups[0]! & 0xffc0) === 0xfe80) return true; // fe80::/10
  if ((groups[0]! & 0xff00) === 0xff00) return true; // multicast
  if (groups[0] === 0x2001 && groups[1] === 0x0db8) return true; // documentation
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    const mapped = `${groups[6]! >> 8}.${groups[6]! & 255}.${groups[7]! >> 8}.${groups[7]! & 255}`;
    return isBlockedIpv4(mapped);
  }
  return false;
}

export function isPublicIpAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !isBlockedIpv4(address);
  if (family === 6) return !isBlockedIpv6(address);
  return false;
}

async function resolvePublicTarget(input: string | URL): Promise<PublicTarget> {
  const url = input instanceof URL ? new URL(input) : new URL(input);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Only HTTP and HTTPS URLs are allowed.");
  }
  if (url.username || url.password) throw new Error("URLs containing credentials are not allowed.");
  if (url.port && url.port !== "80" && url.port !== "443") {
    throw new Error("Only standard HTTP and HTTPS ports are allowed.");
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new Error("Local hostnames are not allowed.");
  }
  const literalFamily = isIP(hostname);
  if (literalFamily) {
    if (!isPublicIpAddress(hostname)) throw new Error("Private or reserved IP addresses are not allowed.");
    return { url, address: hostname, family: literalFamily as 4 | 6 };
  }

  const [v4, v6] = await Promise.all([
    resolve4(hostname).catch(() => []),
    resolve6(hostname).catch(() => []),
  ]);
  const addresses = [...v4, ...v6];
  if (!addresses.length) throw new Error(`Could not resolve ${hostname}.`);
  if (addresses.some((address) => !isPublicIpAddress(address))) {
    throw new Error(`Host ${hostname} resolves to a private or reserved address.`);
  }
  const address = addresses[0];
  if (!address) throw new Error(`Could not resolve ${hostname}.`);
  return { url, address, family: isIP(address) as 4 | 6 };
}

export async function assertPublicUrl(input: string | URL): Promise<URL> {
  return (await resolvePublicTarget(input)).url;
}

export async function resolvePublicRedirect(current: URL, location: string): Promise<URL> {
  return (await resolvePublicTarget(new URL(location, current))).url;
}

async function requestPinned(
  target: PublicTarget,
  options: SafeFetchOptions,
  signal: AbortSignal,
): Promise<SafeFetchResult> {
  const requester = target.url.protocol === "https:" ? httpsRequest : httpRequest;
  const pinnedLookup: LookupFunction = (_hostname, lookupOptions, callback) => {
    if (lookupOptions.all) callback(null, [{ address: target.address, family: target.family }]);
    else callback(null, target.address, target.family);
  };
  return new Promise((resolve, reject) => {
    const request = requester(target.url, {
      method: options.method ?? "GET",
      headers: {
        "User-Agent": "DeftSEOAgent/1.0 (+https://deftwriting.com/seo-agent)",
        Accept: "text/html,application/xhtml+xml,application/xml,text/plain;q=0.9,*/*;q=0.1",
        ...options.headers,
      },
      signal,
      lookup: pinnedLookup,
    }, (response) => {
      const status = response.statusCode ?? 0;
      const headers = new Headers();
      for (const [name, value] of Object.entries(response.headers)) {
        if (Array.isArray(value)) for (const item of value) headers.append(name, item);
        else if (value !== undefined) headers.set(name, String(value));
      }
      if (options.method === "HEAD") {
        response.resume();
        resolve({ url: target.url.toString(), status, ok: status >= 200 && status < 300, headers, text: "" });
        return;
      }

      const chunks: Buffer[] = [];
      let total = 0;
      const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
      response.on("data", (chunk: Buffer) => {
        total += chunk.byteLength;
        if (total > maxBytes) {
          response.destroy(new Error(`Response exceeded the ${maxBytes}-byte safety limit.`));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        resolve({
          url: target.url.toString(),
          status,
          ok: status >= 200 && status < 300,
          headers,
          text: Buffer.concat(chunks).toString("utf8"),
        });
      });
      response.on("error", reject);
    });
    request.on("error", reject);
    request.end();
  });
}

export async function safeFetch(
  input: string | URL,
  options: SafeFetchOptions = {},
): Promise<SafeFetchResult> {
  let current = input instanceof URL ? new URL(input) : new URL(input);
  const redirects = options.maxRedirects ?? 3;
  for (let hop = 0; hop <= redirects; hop += 1) {
    const target = await resolvePublicTarget(current);
    const timeout = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    const response = await requestPinned(target, options, signal);
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (hop === redirects) throw new Error("Too many redirects.");
      const location = response.headers.get("location");
      if (!location) throw new Error("Redirect response omitted its destination.");
      current = await resolvePublicRedirect(current, location);
      continue;
    }
    return {
      ...response,
    };
  }
  throw new Error("Redirect handling failed.");
}

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");
}

// Page chrome — nav labels, cookie bars, newsletter CTAs, footer link lists — is indistinguishable from
// prose once the surrounding tags are gone, and a writer downstream will happily open a section with
// "Join the Newsletter". Strip these elements before flattening so that phrasing never enters the
// pipeline. Applied to convergence (not just once) because a non-greedy match on nested identical tags
// otherwise stops at the first closing tag and leaves the outer one as literal text.
const CHROME_ELEMENTS = /<(script|style|noscript|svg|template|nav|header|footer|aside|form|dialog)\b[^>]*>[\s\S]*?<\/\1>/gi;

export function htmlToText(html: string): { title: string; text: string } {
  const title = decodeEntities(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "")
    .replace(/\s+/g, " ")
    .trim();
  let stripped = html;
  for (let pass = 0; pass < 3; pass += 1) {
    const next = stripped.replace(CHROME_ELEMENTS, " ");
    if (next === stripped) break;
    stripped = next;
  }
  const text = decodeEntities(
    stripped
      .replace(/<!--([\s\S]*?)-->/g, " ")
      .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/section|\/article)>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
  return { title, text: text.slice(0, 30_000) };
}

function sitemapLocations(xml: string): string[] {
  return [...xml.matchAll(/<loc[^>]*>([\s\S]*?)<\/loc>/gi)].map((match) =>
    decodeEntities((match[1] ?? "").trim()),
  );
}

export async function crawlWebsite(
  websiteUrl: string,
  maxPages = 8,
  signal?: AbortSignal,
): Promise<SitePage[]> {
  const root = await assertPublicUrl(websiteUrl);
  root.pathname = root.pathname || "/";
  const homepage = await safeFetch(root, { signal });
  if (!homepage.ok) throw new Error(`The website returned HTTP ${homepage.status}.`);
  const homeText = htmlToText(homepage.text);
  const pages: SitePage[] = [{ url: homepage.url, ...homeText }];
  if (maxPages <= 1) return pages;

  const origin = new URL(homepage.url).origin;
  const robots = await safeFetch(new URL("/robots.txt", origin), { signal }).catch(() => null);
  const sitemapCandidates = robots?.text
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*Sitemap:\s*(\S+)/i)?.[1])
    .filter((value): value is string => Boolean(value)) ?? [];
  if (!sitemapCandidates.length) sitemapCandidates.push(new URL("/sitemap.xml", origin).toString());

  const queued = new Set<string>();
  for (const candidate of sitemapCandidates.slice(0, 3)) {
    const sitemap = await safeFetch(candidate, { signal }).catch(() => null);
    if (!sitemap?.ok) continue;
    let locations = sitemapLocations(sitemap.text);
    if (/<sitemapindex[\s>]/i.test(sitemap.text)) {
      const childMaps = await Promise.all(
        locations.slice(0, 5).map(async (location) => {
          try {
            if (new URL(location).origin !== origin) return [];
          } catch {
            return [];
          }
          const child = await safeFetch(location, { signal }).catch(() => null);
          return child?.ok ? sitemapLocations(child.text) : [];
        }),
      );
      locations = childMaps.flat();
    }
    for (const location of locations.slice(0, 200)) {
      try {
        const pageUrl = new URL(location);
        if (pageUrl.origin === origin) queued.add(pageUrl.toString());
      } catch {
        // Ignore malformed sitemap entries.
      }
    }
  }

  const targets = [...queued].filter((url) => url !== homepage.url).slice(0, maxPages - 1);
  const fetched = await Promise.all(
    targets.map(async (url): Promise<SitePage | null> => {
      const response = await safeFetch(url, { signal }).catch(() => null);
      if (!response?.ok || !response.headers.get("content-type")?.match(/html|text/)) return null;
      return { url: response.url, ...htmlToText(response.text) };
    }),
  );
  pages.push(...fetched.filter((page): page is SitePage => page !== null));
  return pages;
}

export async function isReachablePublicUrl(url: string, signal?: AbortSignal): Promise<boolean> {
  const head = await safeFetch(url, { method: "HEAD", signal }).catch(() => null);
  if (head?.ok) return true;
  const get = await safeFetch(url, { method: "GET", maxBytes: 128 * 1024, signal }).catch(
    () => null,
  );
  return Boolean(get?.ok);
}
