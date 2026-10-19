// Whether a CDP cookie would be sent to `url` (RFC 6265 domain, path and secure rules). A cookie read must not trust
// the endpoint to honor the `urls` filter of Network.getCookies: an endpoint that drops it answers with the
// current page's cookies, which would then be sent to another site.

/**
 * @param {{ domain?: string, path?: string, secure?: boolean }} cookie
 * @param {string} url
 * @returns {boolean}
 */
export function cookieAppliesToUrl(cookie, url) {
  let target;
  try {
    target = new URL(url);
  } catch {
    return false;
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") return false;
  if (cookie.secure && target.protocol !== "https:") return false;
  const host = target.hostname.toLowerCase();
  const domain = String(cookie.domain ?? "").toLowerCase();
  if (domain === "") return false;
  const bareHost = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  const bareDomain = domain.startsWith(".") ? domain.slice(1) : domain;
  // RFC 6265 5.1.3: an IP address host matches only the identical domain, never as a suffix.
  // WHATWG URL normalizes an IPv4 host to a dotted quad and keeps an IPv6 host bracketed.
  const isIpHost = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith("[");
  const domainOk = isIpHost
    ? bareHost === bareDomain.replace(/^\[|\]$/g, "")
    : domain.startsWith(".")
      ? host === bareDomain || host.endsWith(domain)
      : host === domain;
  if (!domainOk) return false;
  const cookiePath = typeof cookie.path === "string" && cookie.path.startsWith("/") ? cookie.path : "/";
  const requestPath = target.pathname || "/";
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith("/") || requestPath[cookiePath.length] === "/";
}
