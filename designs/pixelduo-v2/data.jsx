// data.jsx — 文案与素材数据 (中英双语)
const IMG = (n) => `assets/case${n}.jpg`;

const MARQUEE = [
  { img: IMG(1), alt: "城市生命系统图谱" },
  { img: IMG(338), alt: "赤壁怀古长卷" },
  { img: IMG(373), alt: "高端食材品牌图" },
  { img: IMG(390), alt: "羊毛毡微缩世界" },
  { img: IMG(355), alt: "概念字体海报" },
  { img: IMG(383), alt: "AI 日常抓拍" },
  { img: IMG(166), alt: "卡牌合集" },
  { img: IMG(396), alt: "复古百科海报" },
  { img: IMG(225), alt: "大师级真迹复刻" },
  { img: IMG(402), alt: "3D 资料卡" },
];

const PLANS = [
  { id: "free", name: "Free", price: "$0", per: "", feat: ["30 credits 新人礼", "每日签到 +2", "图像与视频生成", "带水印输出"], cta: "免费开始", hot: false },
  { id: "starter", name: "Starter", price: "$9", per: "/月", feat: ["800 credits / 月", "输出无水印", "视频生成", "优先生成队列"], cta: "选择 Starter", hot: false },
  { id: "pro", name: "Pro", price: "$19", per: "/月", feat: ["2,000 credits / 月", "输出无水印", "30% 额度结转", "批量生成"], cta: "选择 Pro", hot: true },
  { id: "studio", name: "Studio", price: "$39", per: "/月", feat: ["5,000 credits / 月", "团队与隐私模式", "API 试用额度", "优先支持"], cta: "选择 Studio", hot: false },
];

const T = {
  zh: {
    navHow: "工作方式", navModels: "模型", navPricing: "定价",
    signIn: "登录", start: "免费创作",
    heroTitleA: "一个提示词，", heroTitleB: "两种回答", heroTitleC: "。",
    heroSub: "PixelDuo 让 GPT Image 与 Seedream 同题竞技：拖动分割线逐像素对比，生成前看清每一分的去向，作品归属完全属于你。",
    heroCta1: "免费开始创作", heroCta2: "观看演示",
    metaModels: "旗舰模型", metaCost: "最低单张", metaOwn: "作品归属",
    metaModelsV: "双引擎", metaCostV: "$0.04", metaOwnV: "100% 你",
    stripTitle: "由 PixelDuo 出品的一小部分",
    howTitle: "三步，从想法到成片",
    how1t: "写下意图", how1p: "中文或英文都行。提示词助手会把它扩写成导演级的画面描述。",
    how2t: "双引擎同题竞技", how2p: "同一提示词同时交给两个旗舰模型，拖动分割线逐像素对比，留下更好的那张。",
    how3t: "明码标价", how3p: "生成前精确到积分的报价，失败自动全额退款，账本里每一笔都看得见。",
    pricingTitle: "定价透明到积分", pricingSub: "1 credit = $0.01。免费档永久免费，付费档随时可退。",
    ctaTitle: "下一次生成，两个答案。", ctaSub: "免费注册，30 credits 立即到账。",
    footer: "PixelDuo 概念设计稿 v2 · Quiet Gallery 视觉语言",
  },
  en: {
    navHow: "How it works", navModels: "Models", navPricing: "Pricing",
    signIn: "Sign in", start: "Start free",
    heroTitleA: "One prompt,", heroTitleB: "two answers", heroTitleC: ".",
    heroSub: "PixelDuo puts GPT Image and Seedream head to head: drag the divider to compare pixel by pixel, see exact cost before you generate, and keep full ownership of every image.",
    heroCta1: "Start creating free", heroCta2: "Watch the demo",
    metaModels: "Flagship models", metaCost: "From", metaOwn: "Ownership",
    metaModelsV: "Dual", metaCostV: "$0.04", metaOwnV: "100% yours",
    stripTitle: "A small sample, made on PixelDuo",
    howTitle: "Three steps from idea to image",
    how1t: "Describe the intent", how1p: "Chinese or English. The prompt assistant expands it into a director-grade scene description.",
    how2t: "Two engines, one race", how2p: "The same prompt runs on both flagship models. Drag the divider, compare pixel by pixel, keep the better one.",
    how3t: "Priced before you click", how3p: "Exact credit quote upfront, automatic full refund on failure, and a ledger where every movement is visible.",
    pricingTitle: "Pricing, down to the credit", pricingSub: "1 credit = $0.01. Free tier stays free, paid plans cancel anytime.",
    ctaTitle: "Your next generation, two answers.", ctaSub: "Sign up free, 30 credits land instantly.",
    footer: "PixelDuo concept design v2 · Quiet Gallery visual language",
  },
};

Object.assign(window, { IMG, MARQUEE, PLANS, T });
