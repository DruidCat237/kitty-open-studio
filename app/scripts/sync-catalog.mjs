// Copies the backend's card catalog and the gallery thumbnails into the app (run before dev and build).
//   backend/workflows/index.json + docs/gallery/showcase.json -> src/data/catalog.json
//   docs/gallery/*                                            -> public/gallery/
// The app ships them inside the build, so it works offline and with any backend (pod, Docker, serverless).
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const app = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = join(app, "..");
const index = JSON.parse(readFileSync(join(root, "backend/workflows/index.json"), "utf8"));
const showcase = JSON.parse(readFileSync(join(root, "docs/gallery/showcase.json"), "utf8"));

const keep = ["id", "title", "category", "summary", "inputs", "min_vram_gb", "est_gpu_minutes", "badges", "prompt_tags",
  "license_note", "note", "hidden", "status"];
const catalog = {
  categories: index.categories,
  badge_labels: index.badge_labels,
  profiles: index.profiles,
  showcase_gpu: showcase.gpu,
  workflows: index.workflows.map((w) => {
    const card = Object.fromEntries(keep.filter((k) => k in w).map((k) => [k, w[k]]));
    card.inputs = (w.inputs || []).map(({ targets, also_set, missing_set, remove_nodes, ...rest }) => rest);
    card.output = w.outputs?.kind ?? "image";
    const shown = showcase.cards[w.id];
    // app_thumb: a frame for a tile when the README's thumb is a side-by-side (SolarRenderer: input over result)
    if (shown) card.showcase = { thumb: `/gallery/${shown.app_thumb ?? shown.thumb}`, seconds: shown.seconds, gpu: shown.gpu, gpu_full: shown.gpu_full };
    return card;
  }),
};
mkdirSync(join(app, "src/data"), { recursive: true });
writeFileSync(join(app, "src/data/catalog.json"), `${JSON.stringify(catalog, null, 1)}\n`);

const gallery = join(root, "docs/gallery");
const target = join(app, "public/gallery");
mkdirSync(target, { recursive: true });
let copied = 0;
for (const file of readdirSync(gallery)) {
  if (/\.(jpg|webp|svg)$/.test(file) && !file.startsWith("badge-")) {
    const dest = join(target, file);
    if (!existsSync(dest)) copied++;
    copyFileSync(join(gallery, file), dest);
  }
}
console.log(`catalog: ${catalog.workflows.length} cards; gallery: ${copied} new thumbnails`);
