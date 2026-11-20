// Import cases from the awesome-gpt-image-2 repository into the Template
// table. Run after `docker compose up -d db redis storage` and a migrate.
//
//   npx tsx scripts/import-cases.ts [--limit N] [--dry-run]
//
// Images are downloaded from raw.githubusercontent.com and stored in the
// configured object storage (local dir / S3 / MinIO), so the Explore page
// doesn't depend on GitHub CDN availability in production.
//
// Model is heuristically assigned: cases involving text, logos, UI, or
// typography → "gpt" (GPT Image 2 is strongest at text rendering); realistic
// photos / portraits / product shots → "seedream" (faster, cheaper).
import fs from "fs";
import fsp from "fs/promises";
import type { FileHandle } from "fs/promises";
import path from "path";
import { PrismaClient } from "@prisma/client";
import { getStorage, newStorageKey } from "../lib/storage";
import { storeContentType, extensionForContentType } from "../lib/media-type";
import { fetchPublicBuffer } from "../lib/store";
import { resolveLocalImagesDir, safeCaseFilename } from "./import-case-local";
import { isSafeCaseImage } from "./import-case-image";

// Largest case image worth storing; also the streaming read cap below.
const MAX_CASE_BYTES = 25 * 1024 * 1024;

// Template sourceUrl is rendered as an href to every logged-in user: only
// accept plain https URLs so a poisoned upstream repo can't store a
// javascript:/data: link (stored XSS).
function safeSourceUrl(u: unknown): string | null {
  if (typeof u !== "string") return null;
  try {
    const parsed = new URL(u);
    return parsed.protocol === "https:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}


const prisma = new PrismaClient();
const RAW_BASE = "https://raw.githubusercontent.com/freestylefly/awesome-gpt-image-2/main/data/images";
// Local clone path — if the repo is cloned nearby, read images from disk
// instead of GitHub raw (avoids CDN rate-limiting on bulk import). The images
// directory is validated as a real subdirectory of this root before any file is
// opened; see scripts/import-case-local.ts.
const LOCAL_CLONE = "/tmp/awesome-gpt-image-2";

interface CaseEntry {
  id: number;
  title: string;
  image: string; // /images/caseN.jpg
  imageAlt?: string;
  sourceLabel?: string;
  sourceUrl?: string;
  prompt: string;
  category: string;
  styles: string[];
  scenes: string[];
  featured: boolean;
}

// Category label → bilingual short label for the Explore page filter
const CAT_ZH: Record<string, string> = {
  "UI & Interfaces": "UI 与界面",
  "Charts & Infographics": "图表信息图",
  "Posters & Typography": "海报排版",
  "Products & E-commerce": "商品电商",
  "Brand & Logos": "品牌标志",
  "Architecture & Spaces": "建筑空间",
  "Photography & Realism": "摄影写实",
  "Illustration & Art": "插画艺术",
  "Characters & People": "人物角色",
  "Scenes & Storytelling": "场景叙事",
  "History & Classical Themes": "历史古风",
  "Documents & Publishing": "文档出版",
  "Other Use Cases": "其他应用",
};

// Heuristic: text/logos/UI/typography-heavy → gpt; realistic/photo → seedream
function pickModel(c: CaseEntry): "gpt" | "seedream" {
  const text = `${c.title} ${c.prompt} ${c.styles.join(" ")} ${c.category}`.toLowerCase();
  const gptCues = [
    "ui", "界面", "截图", "screenshot", "interface", "dashboard",
    "海报", "poster", "typography", "字体", "logo", "品牌", "brand",
    "text", "文字", "排版", "typograph", "信息图", "infographic",
    "document", "文档", "白皮书", "manual",
  ];
  const seedCues = ["摄影", "photo", "realistic", "人像", "portrait", "写实", "人", "girl", "woman", "coffee"];
  if (gptCues.some((k) => text.includes(k))) return "gpt";
  if (seedCues.some((k) => text.includes(k))) return "seedream";
  // Default to gpt — the upstream cases are all gpt-image-2 outputs
  return "gpt";
}

function costFor(model: "gpt" | "seedream"): { credits: number; quality: string } {
  return model === "gpt"
    ? { credits: 8, quality: "medium" }
    : { credits: 6, quality: "standard" };
}

async function downloadImage(caseId: number, srcPath: string): Promise<string | null> {
  // srcPath is "/images/caseN.jpg"
  const filename = safeCaseFilename(srcPath);
  if (!filename) {
    console.warn(`[import] skipping case ${caseId}: unusable image path`);
    return null;
  }
  let buf: Buffer | null = null;

  // 1. Local clone — fastest, no rate limits. The DIRECTORY is validated first
  // (pass 61): O_NOFOLLOW closes a symlinked file, not a symlinked `data/images`.
  // A third-party clone whose images directory links to the importer's repo
  // root made `data/images/.env` a regular file below the checked path, and its
  // bytes became a Template served to every signed-in account.
  const localDir = resolveLocalImagesDir(LOCAL_CLONE);
  const localPath = localDir ? path.join(localDir, filename) : null;
  // lstat, not stat: this script's own instructions tell the operator to clone a
  // THIRD-PARTY repository, and git stores and restores symlinks. A
  // `data/images/caseN.jpg` that is a symlink to `/app/.env` was followed by
  // readFileSync and its bytes were stored as an object and registered as a
  // Template row — which /api/files serves to ANY signed-in account or API key,
  // publishing NEXTAUTH_SECRET (enough to forge an admin session), DATABASE_URL
  // and every provider credential. path.basename stops `../..`, not a symlink.
  // The size cap below also ran after the read, so a link to a huge file was a
  // heap spike and a link to a FIFO hung the import.
  //
  // The lstat→readFile pair was still a TOCTOU and ignored HARDLINKS: a regular
  // file with another name (e.g. a link to the repo .env) passes isFile(), and
  // the path can be swapped after the check. Open once with O_NOFOLLOW and
  // decide from the fd's own fstat; nlink === 1 rejects a hardlink, and
  // O_NONBLOCK keeps a FIFO from hanging the open.
  let localFd: FileHandle | null = null;
  if (localPath) {
    try {
      localFd = await fsp.open(
        localPath,
        fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0),
      );
    } catch (e) {
      // Missing is the normal "use the GitHub fallback" path. Anything else —
      // ELOOP from O_NOFOLLOW on a symlink, a device/FIFO refusal — is a
      // deliberate refusal, not a reason to quietly fetch from the network.
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(`[import] skipping ${filename}: not a regular file (symlink/device?)`);
        return null;
      }
      localFd = null;
    }
  }
  if (localFd) {
    try {
      const st = await localFd.stat();
      if (!st.isFile() || st.nlink !== 1) {
        console.warn(`[import] skipping ${filename}: not a regular file (symlink/hardlink/device?)`);
        return null;
      }
      if (st.size > MAX_CASE_BYTES) {
        console.warn(`[import] skipping ${filename}: over the ${MAX_CASE_BYTES}-byte cap`);
        return null;
      }
      buf = await localFd.readFile();
    } finally {
      await localFd.close().catch(() => undefined);
    }
  } else {
    // 2. GitHub raw fallback
    //
    // Through the shared hardened downloader, not the global fetch (pass 59):
    // Node's fetch follows up to 20 cross-origin redirects with NO re-check,
    // and whatever comes back is stored as a Template object that /api/files
    // serves to every signed-in account and API key. A redirect to an internal
    // service (metadata, Redis, an admin port) would publish those bytes as a
    // shared image. fetchPublicBuffer re-validates scheme/port/public-IP on
    // every hop, refuses redirects without a Location, pins DNS at connect
    // time, and caps the body while streaming — the same helper every app
    // download uses.
    const url = `${RAW_BASE}/${filename}`;
    try {
      buf = await fetchPublicBuffer(url, { timeoutMs: 30_000, maxBytes: MAX_CASE_BYTES });
    } catch {
      return null;
    }
  }
  if (!buf || buf.length > MAX_CASE_BYTES) return null;
  // Bytes, not just the path, are untrusted here (pass 65): the upstream repo
  // is third-party, and a Template image is served to every signed-in account
  // and rendered in every visitor's Explore grid. Require a real raster whose
  // decoded size is bounded, exactly as the provider-image path does. SVG/HTML
  // would otherwise be hosted under the app's origin, and a decompression bomb
  // would be cached client-side for a year.
  if (!(await isSafeCaseImage(buf))) {
    console.warn(`[import] skipping case ${caseId}: ${filename} is not a safe raster image`);
    return null;
  }
  // Key extension AND recorded type follow the bytes, not the assumption that
  // GitHub serves JPEG. This hardcoded `newStorageKey("jpg")` + "image/jpeg" for
  // whatever arrived, which is one of the ways an object ends up whose
  // extension, stored type and magic bytes disagree — the state /api/files' mid-
  // file Range path answers from the extension.
  const contentType = storeContentType(buf, "image/jpeg");
  const key = newStorageKey(extensionForContentType(contentType));
  await getStorage().put(key, buf, contentType);
  return key;
}

async function main() {
  const args = process.argv.slice(2);
  const limitIdx = args.indexOf("--limit");
  const limit = limitIdx >= 0 && args[limitIdx + 1] ? parseInt(args[limitIdx + 1], 10) : undefined;
  const dryRun = args.includes("--dry-run");

  const casesPath = path.join(process.cwd(), "data", "cases.json");
  if (!fs.existsSync(casesPath)) {
    console.error(`cases.json not found at ${casesPath} — run:
  git clone --depth 1 https://github.com/freestylefly/awesome-gpt-image-2.git /tmp/awesome-gpt-image-2
  cp /tmp/awesome-gpt-image-2/data/cases.json data/cases.json`);
    process.exit(1);
  }
  const data = JSON.parse(fs.readFileSync(casesPath, "utf8")) as { cases: CaseEntry[] };
  let cases = data.cases;
  if (limit) cases = cases.slice(0, limit);
  console.log(`[import] ${cases.length} cases${dryRun ? " (dry run)" : ""}`);

  let imported = 0;
  let skipped = 0;
  let failed = 0;
  for (const c of cases) {
    const id = String(c.id);
    const existing = await prisma.template.findUnique({ where: { id } }).catch(() => null);
    // A seeded placeholder is NOT an imported case. `prisma/seed.ts` inserts
    // numeric ids that overlap the upstream case ids, all pointing at the seven
    // bundled `/templates/*.png` placeholders. Treating such a row as "already
    // imported" updated its title/prompt but kept the placeholder image forever
    // — the whole Explore grid rendered as the same white mug after a database
    // rebuild that ran the seed and then the import (probed pass 39). Fall
    // through to the download+upsert path for those rows; a real imported key
    // (img/…) still takes the metadata-only path.
    const placeholder = existing?.img.startsWith("/templates/") ?? false;
    if (existing && !dryRun && !placeholder) {
      // Already imported — skip the image download, just update metadata.
      // The model is recomputed too: leaving the old one while credits/quality
      // came from a different heuristic produced rows whose price and model
      // disagreed.
      const model = pickModel(c);
      const { credits, quality } = costFor(model);
      await prisma.template.update({
        where: { id },
        data: {
          cat: CAT_ZH[c.category] ?? c.category,
          title: c.title,
          prompt: c.prompt,
          model,
          sourceUrl: safeSourceUrl(c.sourceUrl),
          tags: { styles: c.styles, scenes: c.scenes, category: c.category } as object,
          featured: c.featured,
          credits,
          quality,
        },
      });
      imported++;
      continue;
    }
    if (placeholder) console.log(`  [replace] #${c.id} placeholder image → case image`);
    if (dryRun) {
      console.log(`  [dry] #${c.id} ${c.title} (${c.category})`);
      continue;
    }

    // Download + store the image
    const imgKey = await downloadImage(c.id, c.image);
    if (!imgKey) {
      console.warn(`  [skip] #${c.id} image download failed: ${c.image}`);
      failed++;
      continue;
    }
    const model = pickModel(c);
    const { credits, quality } = costFor(model);
    await prisma.template.upsert({
      where: { id },
      create: {
        id,
        cat: CAT_ZH[c.category] ?? c.category,
        title: c.title,
        prompt: c.prompt,
        model,
        quality,
        credits,
        img: imgKey,
        sourceUrl: safeSourceUrl(c.sourceUrl),
        tags: { styles: c.styles, scenes: c.scenes, category: c.category } as object,
        featured: c.featured,
      },
      update: {
        cat: CAT_ZH[c.category] ?? c.category,
        title: c.title,
        prompt: c.prompt,
        model,
        quality,
        credits,
        img: imgKey,
        sourceUrl: safeSourceUrl(c.sourceUrl),
        tags: { styles: c.styles, scenes: c.scenes, category: c.category } as object,
        featured: c.featured,
      },
    });
    imported++;
    if (imported % 20 === 0) console.log(`  …${imported} imported`);
  }

  console.log(`[import] done: ${imported} imported, ${skipped} skipped, ${failed} failed`);
}

main()
  .catch((e) => {
    console.error("[import] FAILED:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
