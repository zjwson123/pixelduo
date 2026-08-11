import fs from "fs";
import path from "path";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// Copy prototype assets into public/templates so the seed can reference them.
function copyAssets() {
  const src = path.join(process.cwd(), "designs", "pixelduo", "assets");
  const dst = path.join(process.cwd(), "public", "templates");
  fs.mkdirSync(dst, { recursive: true });
  for (const f of fs.readdirSync(src)) {
    fs.copyFileSync(path.join(src, f), path.join(dst, f));
  }
}

interface SeedTemplate {
  id: string;
  cat: string;
  title: string;
  prompt: string;
  model: "gpt" | "seedream";
  quality: string;
  credits: number;
  img: string;
}

const T: SeedTemplate[] = [
  // 电商
  { id: "ec1", cat: "电商", title: "极简陶瓷咖啡杯", prompt: "Professional product photography of a minimalist white ceramic coffee mug on a warm beige background, soft studio lighting, high detail, centered composition", model: "gpt", quality: "medium", credits: 8, img: "/templates/gpt_medium_1024.png" },
  { id: "ec2", cat: "电商", title: "暖色商品棚拍", prompt: "Commercial product photo of a ceramic mug, warm beige studio backdrop, soft diffused light, premium e-commerce hero image", model: "seedream", quality: "standard", credits: 6, img: "/templates/seedream_1920.png" },
  { id: "ec3", cat: "电商", title: "赛博科技手表", prompt: "Cyberpunk product mockup of a futuristic smart watch on a neon-lit desk, purple and cyan lighting, dramatic composition, product photography", model: "seedream", quality: "standard", credits: 6, img: "/templates/cyber_2560.png" },
  { id: "ec4", cat: "电商", title: "细节特写主图", prompt: "Extreme close-up product photography of a matte ceramic surface, fine texture detail, soft directional light, premium finish", model: "gpt", quality: "high", credits: 26, img: "/templates/gpt_high_1024.png" },
  // 人像
  { id: "po1", cat: "人像", title: "杂志风人像", prompt: "Editorial fashion portrait of a young woman with sunlit hair, minimal warm studio background, soft golden light, magazine cover quality", model: "gpt", quality: "high", credits: 26, img: "/templates/portrait_1440.png" },
  { id: "po2", cat: "人像", title: "暖调环境肖像", prompt: "Environmental portrait in warm afternoon light, shallow depth of field, natural skin tones, cinematic color grade", model: "seedream", quality: "standard", credits: 6, img: "/templates/portrait_1440.png" },
  { id: "po3", cat: "人像", title: "品牌头像", prompt: "Professional headshot portrait, soft key light, neutral gray background, approachable expression, corporate style", model: "gpt", quality: "medium", credits: 8, img: "/templates/gpt_medium_1024.png" },
  // 海报
  { id: "hs1", cat: "海报", title: "大字号字型海报", prompt: "Bold typographic poster design, large serif headline, abstract gradient shapes, modern Swiss design, high contrast", model: "gpt", quality: "high", credits: 26, img: "/templates/typo_2560.png" },
  { id: "hs2", cat: "海报", title: "极简发布会海报", prompt: "Minimal event poster, generous whitespace, single bold headline, one accent color, editorial grid layout", model: "gpt", quality: "medium", credits: 8, img: "/templates/typo_2560.png" },
  { id: "hs3", cat: "海报", title: "电影感横版海报", prompt: "Cinematic widescreen movie poster style, dramatic lighting, atmospheric haze, deep shadows, teal and orange grade", model: "seedream", quality: "standard", credits: 6, img: "/templates/cyber_2560.png" },
  // 3D
  { id: "d1", cat: "3D", title: "3D 图标 · 橙猫", prompt: "3D render of a cute glossy orange cat icon, soft studio lighting, pastel gradient background, app icon style, high detail", model: "seedream", quality: "standard", credits: 6, img: "/templates/icon3d_1920.png" },
  { id: "d2", cat: "3D", title: "3D 产品陈列", prompt: "3D render of premium skincare bottles on a stone pedestal, soft shadows, beige backdrop, minimalist product render", model: "gpt", quality: "high", credits: 26, img: "/templates/icon3d_1920.png" },
  { id: "d3", cat: "3D", title: "微缩场景", prompt: "Tiny diorama scene, tilt-shift miniature effect, toy-like scale, bright cheerful colors, studio lighting", model: "seedream", quality: "standard", credits: 6, img: "/templates/icon3d_1920.png" },
  // 产品
  { id: "pr1", cat: "产品", title: "高清质感特写", prompt: "Macro product shot emphasizing material texture, crisp focus, soft gradient background, high-end commercial quality", model: "gpt", quality: "high", credits: 26, img: "/templates/gpt_high_1024.png" },
  { id: "pr2", cat: "产品", title: "白底商品图", prompt: "Clean white-background product shot for e-commerce, even lighting, natural shadows, centered, retouched", model: "seedream", quality: "standard", credits: 6, img: "/templates/seedream_1920.png" },
  { id: "pr3", cat: "产品", title: "场景化生活方式图", prompt: "Lifestyle product photography, product in use at a cozy desk, warm morning light, editorial composition", model: "gpt", quality: "medium", credits: 8, img: "/templates/gpt_medium_1024.png" },
  // 插画
  { id: "il1", cat: "插画", title: "扁平插画 · 渐变背景", prompt: "Flat vector-style illustration, soft gradient background, simple shapes, modern palette, no text", model: "seedream", quality: "standard", credits: 6, img: "/templates/typo_2560.png" },
  { id: "il2", cat: "插画", title: "绘本风插画", prompt: "Children's book illustration, warm storybook colors, gentle textures, whimsical scene, soft light", model: "gpt", quality: "high", credits: 26, img: "/templates/icon3d_1920.png" },
  // 壁纸
  { id: "wp1", cat: "壁纸", title: "赛博都市壁纸", prompt: "Cyberpunk city street at night, neon reflections on wet asphalt, cinematic wide composition, ultra detailed", model: "seedream", quality: "standard", credits: 6, img: "/templates/cyber_2560.png" },
  { id: "wp2", cat: "壁纸", title: "抽象渐变壁纸", prompt: "Abstract flowing gradient wallpaper, smooth color transitions, calm and premium, high resolution, no text", model: "gpt", quality: "medium", credits: 8, img: "/templates/typo_2560.png" },
  { id: "wp3", cat: "壁纸", title: "自然光影壁纸", prompt: "Sunlight through leaves, bokeh background, peaceful nature scene, photographic quality, vertical composition", model: "seedream", quality: "standard", credits: 6, img: "/templates/portrait_1440.png" },
  // 国风
  { id: "cn1", cat: "国风", title: "国风山水", prompt: "Chinese ink-wash landscape painting, misty mountains, traditional composition, elegant negative space, muted palette", model: "gpt", quality: "high", credits: 26, img: "/templates/portrait_1440.png" },
  { id: "cn2", cat: "国风", title: "东方器物", prompt: "Traditional Chinese ceramic teapot on bamboo mat, soft window light, wabi-sabi aesthetic, still life photography", model: "seedream", quality: "standard", credits: 6, img: "/templates/gpt_medium_1024.png" },
];

const STYLE_VARIANTS = [
  "cinematic lighting, shallow depth of field",
  "minimal composition, soft shadows, lots of negative space",
  "editorial style, magazine quality, refined color grade",
  "vivid colors, high contrast, bold composition",
  "soft pastel palette, dreamy atmosphere, gentle gradients",
];

const CAT_BASES: Record<string, { bases: string[]; imgs: string[] }> = {
  电商: {
    bases: [
      "Professional product photography, premium e-commerce hero image",
      "Clean product shot on a neutral background, evenly lit, studio quality",
      "Lifestyle product photography in a warm modern interior",
    ],
    imgs: ["/templates/gpt_medium_1024.png", "/templates/seedream_1920.png", "/templates/cyber_2560.png", "/templates/gpt_high_1024.png"],
  },
  人像: {
    bases: [
      "Editorial portrait, natural light, authentic expression",
      "Studio headshot, soft key light, professional retouch",
      "Environmental portrait in a cinematic setting",
    ],
    imgs: ["/templates/portrait_1440.png", "/templates/gpt_medium_1024.png", "/templates/gpt_high_1024.png"],
  },
  海报: {
    bases: [
      "Bold typographic poster, strong hierarchy, generous whitespace",
      "Event poster with dramatic composition and clear focal point",
      "Minimal Swiss-design poster, grid layout, one accent color",
    ],
    imgs: ["/templates/typo_2560.png", "/templates/cyber_2560.png", "/templates/gpt_high_1024.png"],
  },
  "3D": {
    bases: [
      "3D render, soft studio lighting, polished materials",
      "Isometric 3D illustration, clean shapes, pleasant palette",
      "Microscopic-scale 3D product render with dramatic depth",
    ],
    imgs: ["/templates/icon3d_1920.png", "/templates/seedream_1920.png", "/templates/gpt_high_1024.png"],
  },
  产品: {
    bases: [
      "Macro product photography emphasizing material texture",
      "White-background e-commerce product shot, even lighting",
      "Scene-based product shot telling a lifestyle story",
    ],
    imgs: ["/templates/gpt_high_1024.png", "/templates/seedream_1920.png", "/templates/gpt_medium_1024.png"],
  },
  插画: {
    bases: [
      "Flat vector illustration, simple shapes, modern palette",
      "Children's book illustration, warm and whimsical",
      "Storybook watercolor illustration with soft edges",
    ],
    imgs: ["/templates/typo_2560.png", "/templates/icon3d_1920.png", "/templates/portrait_1440.png"],
  },
  壁纸: {
    bases: [
      "Abstract flowing gradient wallpaper, calm and premium",
      "Cinematic landscape wallpaper with dramatic sky",
      "Pattern-based wallpaper, symmetrical, soothing colors",
    ],
    imgs: ["/templates/cyber_2560.png", "/templates/typo_2560.png", "/templates/portrait_1440.png"],
  },
  国风: {
    bases: [
      "Chinese ink-wash painting, misty mountains, elegant negative space",
      "Traditional oriental still life, wabi-sabi aesthetic",
      "Hanfu fashion illustration, flowing fabric, delicate details",
    ],
    imgs: ["/templates/portrait_1440.png", "/templates/gpt_medium_1024.png", "/templates/icon3d_1920.png"],
  },
};

// Expand to 8 categories × 20 templates (curated seeds + generated variants).
const FINAL: SeedTemplate[] = [...T];
for (const [cat, cfg] of Object.entries(CAT_BASES)) {
  const existing = FINAL.filter((t) => t.cat === cat).length;
  for (let i = existing; i < 20; i++) {
    const base = cfg.bases[i % cfg.bases.length];
    const style = STYLE_VARIANTS[i % STYLE_VARIANTS.length];
    const model = i % 2 === 0 ? "gpt" : "seedream";
    const quality = model === "gpt" ? (i % 3 === 0 ? "high" : "medium") : "standard";
    const credits = model === "gpt" ? (quality === "high" ? 26 : 8) : 6;
    FINAL.push({
      id: `gen-${cat}-${i}`,
      cat,
      title: `${cat} · 变体 ${i + 1}`,
      prompt: `${base}, ${style}`,
      model,
      quality,
      credits,
      img: cfg.imgs[i % cfg.imgs.length],
    });
  }
}

async function main() {
  copyAssets();
  await prisma.template.deleteMany({});
  for (const t of FINAL) {
    await prisma.template.create({ data: t });
  }
  const byCat = new Map<string, number>();
  for (const t of FINAL) byCat.set(t.cat, (byCat.get(t.cat) ?? 0) + 1);
  console.log(`seeded ${FINAL.length} templates`);
  console.log([...byCat.entries()].map(([c, n]) => `${c}:${n}`).join(" "));
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
