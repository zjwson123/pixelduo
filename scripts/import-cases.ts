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
import path from "path";
import { PrismaClient } from "@prisma/client";
import { getStorage, newStorageKey } from "../lib/storage";

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
// instead of GitHub raw (avoids CDN rate-limiting on bulk import).
const LOCAL_IMAGES = "/tmp/awesome-gpt-image-2/data/images";

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
  const filename = path.basename(srcPath);
  let buf: Buffer | null = null;

  // 1. Local clone — fastest, no rate limits
  const localPath = path.join(LOCAL_IMAGES, filename);
  if (fs.existsSync(localPath)) {
    buf = fs.readFileSync(localPath);
  } else {
    // 2. GitHub raw fallback
    const url = `${RAW_BASE}/${filename}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) return null;
      buf = Buffer.from(await res.arrayBuffer());
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
  if (!buf || buf.length > 25 * 1024 * 1024) return null;
  const key = newStorageKey("jpg");
  await getStorage().put(key, buf, "image/jpeg");
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
    if (existing && !dryRun) {
      // Already imported — skip the image download, just update metadata
      const { credits, quality } = costFor(pickModel(c));
      await prisma.template.update({
        where: { id },
        data: {
          cat: CAT_ZH[c.category] ?? c.category,
          title: c.title,
          prompt: c.prompt,
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
