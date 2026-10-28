/**
 * SSRF (Server-Side Request Forgery) protection utilities.
 * Shared across all API routes that fetch external URLs.
 */

/** Known safe domains that our app legitimately fetches from */
const ALLOWED_DOMAINS = new Set([
  "storage.googleapis.com",
  "s3.amazonaws.com",
  "s3.us-east-1.amazonaws.com",
]);

/** Check if hostname is a known safe domain or subdomain of one */
function isAllowedDomain(hostname: string): boolean {
  if (ALLOWED_DOMAINS.has(hostname)) return true;
  // Allow subdomains of allowed domains 
  for (const domain of ALLOWED_DOMAINS) {
    if (hostname.endsWith(`.${domain}`)) return true;
  }
  // Allow S3 bucket subdomains
  if (hostname.endsWith(".s3.amazonaws.com") || /\.s3\.[a-z0-9-]+\.amazonaws\.com$/.test(hostname)) return true;
  return false;
}

/** Block requests to private/internal networks */
export function isPrivateUrl(urlString: string): boolean {
  try {
    const parsed = new URL(urlString);
    const hostname = parsed.hostname.toLowerCase();

    // Block non-HTTP(S) protocols
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return true;
    }

    // Block common internal hostnames
    if (
      hostname === "localhost" ||
      hostname === "0.0.0.0" ||
      hostname === "[::1]" ||
      hostname === "[::]" ||
      hostname.endsWith(".local") ||
      hostname.endsWith(".internal") ||
      hostname.endsWith(".localhost")
    ) {
      return true;
    }

    // Block IPv6 private ranges
    if (hostname.startsWith("[")) {
      const ipv6 = hostname.slice(1, -1).toLowerCase();
      // ::1 (loopback)
      if (ipv6 === "::1") return true;
      // :: (unspecified)
      if (ipv6 === "::") return true;
      // fc00::/7 (unique local) — starts with fc or fd
      if (ipv6.startsWith("fc") || ipv6.startsWith("fd")) return true;
      // fe80::/10 (link-local)
      if (ipv6.startsWith("fe80")) return true;
      // ::ffff: IPv4-mapped IPv6 — check the mapped address
      if (ipv6.startsWith("::ffff:")) {
        const mapped = ipv6.slice(7);
        if (isPrivateIpv4(mapped)) return true;
      }
    }

    // Block private IPv4 ranges (dotted decimal only)
    const parts = hostname.split(".");
    if (parts.length === 4 && parts.every((p) => /^\d+$/.test(p))) {
      if (isPrivateIpv4(hostname)) return true;
    }

    // Block octal/hex IP notation (e.g., 0177.0.0.1, 0x7f.0.0.1)
    if (
      parts.length === 4 &&
      parts.some((p) => /^0[0-7]+$/.test(p) || /^0x[0-9a-f]+$/i.test(p))
    ) {
      return true;
    }

    // Block decimal IP notation (e.g., 2130706433 = 127.0.0.1)
    if (/^\d+$/.test(hostname) && hostname.length > 3) {
      return true;
    }

    // Block bare IP addresses that aren't in our allowed list
    // (DNS rebinding defense: only allow named domains we trust)
    if (isIpAddress(hostname) && !isAllowedDomain(hostname)) {
      return true;
    }

    // Block credentials in URL (potential redirect abuse)
    if (parsed.username || parsed.password) {
      return true;
    }

    // Block uncommon ports that could target internal services
    if (parsed.port) {
      const port = parseInt(parsed.port, 10);
      const safePorts = new Set([80, 443, 8080, 8443]);
      if (!safePorts.has(port)) return true;
    }

    return false;
  } catch {
    return true;
  }
}

/** Check if a dotted IPv4 address is in a private range */
function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split(".");
  if (parts.length !== 4) return false;
  const nums = parts.map((p) => parseInt(p, 10));
  if (nums.some((n) => isNaN(n) || n < 0 || n > 255)) return true; // Invalid = block

  const [a, b] = nums;
  if (a === 10) return true;             // 10.0.0.0/8
  if (a === 127) return true;            // 127.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 (link-local/AWS metadata)
  if (a === 0) return true;              // 0.0.0.0/8
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 (CGNAT)
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 (benchmarking)
  if (a >= 224) return true;             // 224.0.0.0+ (multicast/reserved)

  return false;
}

/** Check if a hostname looks like an IP address (v4 or v6) */
function isIpAddress(hostname: string): boolean {
  // IPv6 in brackets
  if (hostname.startsWith("[")) return true;
  // IPv4 dotted decimal
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) return true;
  // Decimal/octal/hex single number
  if (/^\d+$/.test(hostname)) return true;
  if (/^0x[0-9a-f]+$/i.test(hostname)) return true;
  return false;
}
