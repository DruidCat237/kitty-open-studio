import createNextIntlPlugin from "next-intl/plugin";
import { createRequire } from "node:module";

const withNextIntl = createNextIntlPlugin("./i18n.ts");
const require = createRequire(import.meta.url);
const { version: appVersion } = require("./package.json");

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  turbopack: {
    resolveAlias: {
      // synaudio (audio sync) runs in the browser only; its worker shim's Node build has an import(variable)
      // Turbopack cannot resolve during SSR of the editor (`next dev`). Production builds use webpack.
      "@eshaz/web-worker": "@eshaz/web-worker/cjs/browser.js",
    },
  },
  env: {
    // Baked at build time (shown in the app).
    NEXT_PUBLIC_APP_VERSION: appVersion,
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          {
            key: "Cross-Origin-Opener-Policy",
            value: "same-origin",
          },
          {
            key: "Cross-Origin-Embedder-Policy",
            value: "credentialless",
          },
          {
            key: "X-Content-Type-Options",
            value: "nosniff",
          },
          {
            key: "X-Frame-Options",
            value: "DENY",
          },
          {
            key: "Referrer-Policy",
            value: "strict-origin-when-cross-origin",
          },
          {
            key: "Content-Security-Policy",
            // unsafe-eval required by Remotion + FFmpeg WASM; unsafe-inline required by Next.js styled-jsx
            value: "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data: https: http://127.0.0.1:* http://localhost:*; media-src 'self' blob: data: https: http://127.0.0.1:* http://localhost:*; worker-src 'self' blob:; connect-src 'self' blob: data: https:; font-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'self';",
          },
          {
            key: "Permissions-Policy",
            value: "geolocation=(), microphone=(), camera=(), usb=(), payment=(), interest-cohort=()",
          },
        ],
      },
    ];
  },
};

export default withNextIntl(nextConfig);
