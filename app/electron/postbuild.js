/**
 * Post-build step: copy static assets into Next.js standalone directory.
 * Standalone output doesn't include public/, .next/static/, or messages/ by default.
 */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const standalone = path.join(root, ".next", "standalone");

function copyDir(src, dest) {
  if (!fs.existsSync(src)) {
    console.log(`[postbuild] Skip (not found): ${src}`);
    return;
  }
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// Remove user data directories that Next.js file tracing may pull into standalone.
// These are runtime data folders, not app code — they inflate the installer by GBs.
for (const dataDir of ["media", "local-media"]) {
  const dirPath = path.join(standalone, dataDir);
  if (fs.existsSync(dirPath)) {
    fs.rmSync(dirPath, { recursive: true, force: true });
    console.log(`[postbuild] Removed ${dataDir}/ from standalone (user data, not app code)`);
  }
}

console.log("[postbuild] Copying static assets into standalone...");
copyDir(path.join(root, ".next", "static"), path.join(standalone, ".next", "static"));
copyDir(path.join(root, "public"), path.join(standalone, "public"));
copyDir(path.join(root, "messages"), path.join(standalone, "messages"));

// Remove dev-only packages that Next.js standalone tracing incorrectly includes.
// These are build tools never needed at runtime — saves ~200MB from the installer.
const devOnlyPackages = [
  "webpack", "terser-webpack-plugin", "terser", "caniuse-lite",
  "typescript", "@webassemblyjs", "ajv-formats", "ajv",
  "jest-worker", "webpack-sources", "source-map-support",
  "watchpack", "browserslist", "update-browserslist-db",
  "enhanced-resolve", "tapable", "@jridgewell",
];
const nmDir = path.join(standalone, "node_modules");
if (fs.existsSync(nmDir)) {
  let removedSize = 0;
  for (const pkg of devOnlyPackages) {
    const pkgPath = path.join(nmDir, pkg);
    if (fs.existsSync(pkgPath)) {
      // Estimate size before removal
      try {
        const stat = fs.statSync(pkgPath);
        removedSize += stat.size || 0;
      } catch {}
      fs.rmSync(pkgPath, { recursive: true, force: true });
    }
  }
  console.log(`[postbuild] Removed ${devOnlyPackages.length} dev-only packages from standalone`);
}

// Rename node_modules → _modules so electron-builder doesn't silently exclude it.
// electron-builder skips any directory called "node_modules" in extraResources.
// electron/main.ts sets NODE_PATH=<appDir>/_modules so require() still resolves.
const nmSrc = path.join(standalone, "node_modules");
const nmDest = path.join(standalone, "_modules");
if (fs.existsSync(nmSrc)) {
  if (fs.existsSync(nmDest)) {
    fs.rmSync(nmDest, { recursive: true, force: true });
  }
  // Retry rename — Windows can hold handles briefly after build
  let renamed = false;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.renameSync(nmSrc, nmDest);
      renamed = true;
      break;
    } catch (err) {
      if (attempt < 4) {
        console.log(`[postbuild] Rename attempt ${attempt + 1} failed (${err.code}), retrying in 2s...`);
        const start = Date.now();
        while (Date.now() - start < 2000) { /* busy wait */ }
      } else {
        console.log("[postbuild] Rename failed after 5 attempts, falling back to copy...");
      }
    }
  }
  if (!renamed) {
    // Fallback: copy then delete
    copyDir(nmSrc, nmDest);
    fs.rmSync(nmSrc, { recursive: true, force: true });
  }
  console.log("[postbuild] Renamed node_modules → _modules (electron-builder workaround)");
}

console.log("[postbuild] Done.");
