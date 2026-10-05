/** Loopback/local-development hosts that may advertise plain HTTP (Prototype Profile §12.1). */
export function isLocalDevelopmentHost(hostname: string): boolean {
  const host = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  return host === "localhost" || host.endsWith(".localhost") || host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host);
}

/**
 * Validates the origin used to build the advertised `assetBaseUri`: absolute
 * HTTPS, or HTTP only for loopback/local development.
 */
export function validateAssetOrigin(origin: string): URL {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new Error(`Asset origin is not an absolute URL: ${origin}`);
  }
  if (url.protocol === "https:") return url;
  if (url.protocol === "http:" && isLocalDevelopmentHost(url.hostname)) return url;
  throw new Error(`P1 requires HTTPS for asset origins outside loopback/local development: ${origin}`);
}

export function originForBindHost(host: string, port?: number): string {
  const authority = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${authority}${port === undefined ? "" : `:${port}`}`;
}
