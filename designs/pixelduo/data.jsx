// PixelDuo prototype data + cost model

const ASSETS = {
  gptMedium: "assets/gpt_medium_1024.png",
  gptHigh: "assets/gpt_high_1024.png",
  seed: "assets/seedream_1920.png",
  portrait: "assets/portrait_1440.png",
  cyber: "assets/cyber_2560.png",
  typo: "assets/typo_2560.png",
  icon3d: "assets/icon3d_1920.png",
};

// 1 credit = $0.01. Draft pricing calibrated by dark test (research/darktest/report.md).
function estimateCost(model, quality) {
  if (model === "seedream") {
    return { credits: 6, usd: 0.06, label: "Seedream 5 · standard" };
  }
  if (model === "both") {
    const g = estimateCost("gpt", quality);
    return { credits: g.credits + 6, usd: g.usd + 0.06, label: "GPT " + g.label + " + Seedream 5" };
  }
  const table = {
    low: { credits: 2, usd: 0.02, label: "low · 1024²" },
    medium: { credits: 8, usd: 0.08, label: "medium · 1024²" },
    high: { credits: 26, usd: 0.26, label: "high · 1024²" },
  };
  const t = table[quality] || table.medium;
  return { credits: t.credits, usd: t.usd, label: t.label };
}

const CATEGORIES = ["全部", "电商", "人像", "海报", "3D", "产品"];

const TEMPLATES = [
  {
    id: "t1", cat: "电商", title: "极简陶瓷咖啡杯",
    prompt: "Professional product photography of a minimalist white ceramic coffee mug on a warm beige background, soft studio lighting, high detail, centered composition",
    model: "gpt", quality: "medium", credits: 8, img: ASSETS.gptMedium,
  },
  {
    id: "t2", cat: "电商", title: "暖色商品棚拍",
    prompt: "Commercial product photo of a ceramic mug, warm beige studio backdrop, soft diffused light, premium e-commerce hero image",
    model: "seedream", quality: "standard", credits: 6, img: ASSETS.seed,
  },
  {
    id: "t3", cat: "电商", title: "赛博科技手表",
    prompt: "Cyberpunk product mockup of a futuristic smart watch on a neon-lit desk, purple and cyan lighting, dramatic composition, product photography",
    model: "seedream", quality: "standard", credits: 6, img: ASSETS.cyber,
  },
  {
    id: "t4", cat: "人像", title: "杂志风人像",
    prompt: "Editorial fashion portrait of a young woman with sunlit hair, minimal warm studio background, soft golden light, magazine cover quality",
    model: "gpt", quality: "high", credits: 26, img: ASSETS.portrait,
  },
  {
    id: "t5", cat: "海报", title: "大字号字型海报",
    prompt: "Bold typographic poster design, large serif headline, abstract gradient shapes, modern Swiss design, high contrast",
    model: "gpt", quality: "high", credits: 26, img: ASSETS.typo,
  },
  {
    id: "t6", cat: "3D", title: "3D 图标 · 橙猫",
    prompt: "3D render of a cute glossy orange cat icon, soft studio lighting, pastel gradient background, app icon style, high detail",
    model: "seedream", quality: "standard", credits: 6, img: ASSETS.icon3d,
  },
  {
    id: "t7", cat: "产品", title: "细节特写 · 高清",
    prompt: "Extreme close-up product photography of a matte ceramic surface, fine texture detail, soft directional light, premium finish",
    model: "gpt", quality: "high", credits: 26, img: ASSETS.gptHigh,
  },
];

const GALLERY_ITEMS = [
  { id: "g1", prompt: "极简陶瓷咖啡杯 · 电商主图", model: "gpt", quality: "medium", credits: 8, time: "2 min ago", img: ASSETS.gptMedium },
  { id: "g2", prompt: "暖色商品棚拍 · 详情页首图", model: "seedream", credits: 6, time: "18 min ago", img: ASSETS.seed },
  { id: "g3", prompt: "杂志风人像 · 封面候选", model: "gpt", quality: "high", credits: 26, time: "1 h ago", img: ASSETS.portrait },
  { id: "g4", prompt: "赛博手表 · 产品发布图", model: "seedream", credits: 6, time: "3 h ago", img: ASSETS.cyber },
  { id: "g5", prompt: "3D 橙猫 · 应用图标", model: "seedream", credits: 6, time: "yesterday", img: ASSETS.icon3d },
  { id: "g6", prompt: "字型海报 · 提案素材", model: "gpt", quality: "high", credits: 26, time: "yesterday", img: ASSETS.typo },
];

const PLANS = [
  { id: "free", name: "Free", price: 0, credits: "30 on signup", features: ["2 credits daily check-in", "Watermarked previews", "Prompt assistant (limited)"], featured: false },
  { id: "starter", name: "Starter", price: 9, credits: "800 / month", features: ["≈ 100–130 images", "No platform watermark", "Priority queue"], featured: false },
  { id: "pro", name: "Pro", price: 19, credits: "2,000 / month", features: ["≈ 250–330 images", "30% quota rollover", "Batch generation"], featured: true },
  { id: "studio", name: "Studio", price: 39, credits: "5,000 / month", features: ["Team & privacy mode", "API trial quota", "Priority support"], featured: false },
];

const PACKS = [
  { id: "p1", price: 4.99, credits: 400, bonus: 0 },
  { id: "p2", price: 9.99, credits: 1050, bonus: "+5%" },
  { id: "p3", price: 19.99, credits: 2300, bonus: "+15%" },
  { id: "p4", price: 49.99, credits: 6000, bonus: "+20%" },
];

const STYLE_HINTS = ["soft studio lighting, high detail", "editorial, magazine quality", "cyberpunk, neon accents", "minimal, warm neutral palette"];

const SUGGESTIONS = [
  { label: "扩写", fn: (p) => "Professional " + (p || "product photography") + ", " + STYLE_HINTS[0] + ", shallow depth of field, centered composition" },
  { label: "翻译成英文", fn: (p) => (p || "A ceramic coffee mug, warm tones") + " — enhanced English prompt: " + "Professional product photography of " + (p || "a ceramic mug") + ", " + STYLE_HINTS[3] },
  { label: "风格化", fn: (p) => (p || "Subject") + " in " + STYLE_HINTS[2] + " style, dramatic composition" },
  { label: "灵感", fn: () => "Editorial portrait · product hero · typographic poster · 3D icon — pick one and I'll craft a full prompt" },
];

Object.assign(window, { ASSETS, estimateCost, CATEGORIES, TEMPLATES, GALLERY_ITEMS, PLANS, PACKS, SUGGESTIONS, STYLE_HINTS });
