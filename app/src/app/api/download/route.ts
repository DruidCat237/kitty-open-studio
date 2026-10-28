import type { NextRequest } from "next/server";
import { isPrivateUrl } from "@/lib/ssrf";
import { createRateLimiter, getClientKey } from "@/lib/rate-limit";

// Force dynamic - never cache this route
export const dynamic = "force-dynamic";

// Rate limit: 120 requests per minute (media-heavy app needs headroom for thumbnails/previews)
const limiter = createRateLimiter({ windowMs: 60_000, maxRequests: 120 });

export const GET = async (req: NextRequest) => {
  const limited = limiter.check(getClientKey(req));
  if (limited) return limited;

  const url = req.nextUrl.searchParams.get("url");
  if (!url) {
    return new Response("Missing 'url' query parameter", {
      status: 400,
    });
  }
  try {
    // Validate URL format without altering encoding
    new URL(url);

    // SSRF protection — block private/internal network access
    if (isPrivateUrl(url)) {
      return new Response("Access denied", { status: 403 });
    }

    // Forward Range header for video/audio seeking support
    const headers: Record<string, string> = {};
    const rangeHeader = req.headers.get("Range");
    if (rangeHeader) {
      headers["Range"] = rangeHeader;
    }

    // Use the raw URL string for fetch to preserve exact encoding
    // (important for S3 presigned URLs where %2F must stay as %2F)
    // redirect: "manual" so we can validate redirect targets against SSRF
    let response = await fetch(url, {
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(120_000), // 2 min timeout
    });

    // Follow redirects safely — validate each hop against SSRF blocklist
    // CDN accelerators (e.g. Alibaba OSS) often redirect to regional endpoints
    let redirectCount = 0;
    while (response.status >= 300 && response.status < 400 && redirectCount < 5) {
      const location = response.headers.get("Location");
      if (!location) break;
      const redirectUrl = new URL(location, url).toString();
      if (isPrivateUrl(redirectUrl)) {
        return new Response("Redirect to private network blocked", { status: 403 });
      }
      response = await fetch(redirectUrl, {
        headers,
        redirect: "manual",
        signal: AbortSignal.timeout(120_000),
      });
      redirectCount++;
    }
    // If still redirecting after max hops, block
    if (response.status >= 300 && response.status < 400) {
      return new Response("Too many redirects", { status: 403 });
    }

    if (!response.ok && response.status !== 206) {
      // Log S3/upstream error details for debugging
      const errorBody = await response.text();
      console.error(
        `[Download Proxy] Upstream ${response.status} for ${url.substring(0, 120)}:`,
        errorBody.substring(0, 300),
      );
      return new Response(errorBody, {
        status: response.status,
        headers: {
          "Content-Type":
            response.headers.get("Content-Type") || "text/plain",
        },
      });
    }

    // Build response headers — restrict CORS to same origin
    const origin = req.headers.get("Origin") || "";
    const isSameOrigin =
      origin === req.nextUrl.origin ||
      /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
    const allowOrigin = isSameOrigin ? origin : req.nextUrl.origin;

    const respHeaders: Record<string, string> = {
      "Content-Type":
        response.headers.get("Content-Type") || "application/octet-stream",
      "Cache-Control": "public, max-age=86400",
      "Access-Control-Allow-Origin": allowOrigin,
      "Accept-Ranges": "bytes",
    };

    const contentLength = response.headers.get("Content-Length");
    if (contentLength) respHeaders["Content-Length"] = contentLength;

    const contentRange = response.headers.get("Content-Range");
    if (contentRange) respHeaders["Content-Range"] = contentRange;

    // Stream the response, preserving 206 status for Range requests
    return new Response(response.body, {
      status: response.status,
      headers: respHeaders,
    });
  } catch (error) {
    console.error("[Download Proxy] Error:", error);
    return new Response("Invalid 'url' query parameter", {
      status: 400,
    });
  }
};
