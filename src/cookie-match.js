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
  const domainOk = domain.startsWith(".")
    ? host === domain.slice(1) || host.endsWith(domain)
    : host === domain;
  if (!domainOk) return false;
  const cookiePath = typeof cookie.path === "string" && cookie.path.startsWith("/") ? cookie.path : "/";
  const requestPath = target.pathname || "/";
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith("/") || requestPath[cookiePath.length] === "/";
}
