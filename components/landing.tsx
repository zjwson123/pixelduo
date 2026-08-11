"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

type Locale = "en" | "zh";

const DICT = {
  en: {
    models: "Models",
    features: "Features",
    pricing: "Pricing",
    signIn: "Sign in",
    joinBeta: "Join the beta",
    eyebrow: "Dual-engine AI image studio · Beta",
    heroTitle1: "Two models.",
    heroTitle2: "One prompt.",
    heroTitle3: "Your call.",
    heroSub:
      "PixelDuo runs GPT Image 2 and Seedream 5 side by side — compare in one click, and see exactly what each image costs before you press generate.",
    startFree: "Start creating — free",
    seeModels: "See the models",
    trustFree: "Free beta, no credit card required",
    trustCost: "Transparent per-image cost",
    trustAssistant: "AI prompt assistant included",
    latency: "Latency",
    costPerImage: "Cost / image",
    compareNote: "Same prompt. Two engines. Choose by quality, speed, or price — you see it all up front.",
    powerKicker: "The power of two",
    powerTitle: "One studio, two world-class engines.",
    powerSub:
      "Head-to-head quality without the lock-in. GPT Image 2 for fine details and typography, Seedream 5 for speed and big canvases.",
    gptDesc: "The finishing studio — text rendering, fine detail, and consistent quality for final assets.",
    gpt1: "Typography and non-Latin text that actually renders",
    gpt2: "Flexible sizes and multi-round editing",
    gpt3: "No platform watermark",
    seedDesc: "The fast lane — big canvases in seconds, ideal for drafts, batches, and exploration.",
    seed1: "Native 2K / 3K output for print and big screens",
    seed2: "Reference-image support",
    seed3: "AI-generated label included (transparent compliance)",
    duoTitle: "Not sure which engine? Generate both.",
    duoSub: "One prompt, two outputs, side by side — you pick the winner. Both images are charged separately and clearly.",
    tryCompare: "Try the compare",
    trustKicker: "Built around trust",
    trustTitle: "No black boxes. No surprise bills.",
    trustSub:
      "Every charge is visible before it happens, every model is priced by its real cost, and the AI helps you write better prompts for free.",
    featCost: "Transparent cost preview",
    featCostSub:
      "See exactly how many credits — and dollars — an image will use before you generate. Adjust model, quality, or size to match your budget.",
    featAssistant: "AI prompt assistant",
    featAssistantSub:
      "Type a half-formed thought and get a production-ready prompt — expanded, translated, and styled. Powered by DeepSeek, free on every plan.",
    featTemplates: "Template library",
    featTemplatesSub:
      "E-commerce, portraits, posters, 3D icons — ready-made prompts with the exact model and parameters attached. One click to reuse.",
    featCredits: "Credits + subscription, your way",
    featCreditsSub:
      "Credit packs valid for 12 months, and monthly quotas that roll 30% of what you don't use into next month. Plans from free to studio.",
    pricingKicker: "Fair pricing, no black box · 明码标价",
    pricingTitle: "Plans that respect your wallet.",
    pricingSub: "1 credit = $0.01. Rollover 30% of unused monthly credits. Beta is free while we polish.",
    free: "Free",
    starter: "Starter",
    pro: "Pro",
    studio: "Studio",
    perMonth: "/ month",
    free1: "30 credits on signup",
    free2: "2 credits daily check-in",
    free3: "Watermarked previews",
    startFreeBtn: "Start free",
    starter1: "800 credits / month",
    starter2: "≈ 100–130 images",
    starter3: "No platform watermark",
    pro1: "2,000 credits / month",
    pro2: "≈ 250–330 images",
    pro3: "30% quota rollover",
    studio1: "5,000 credits / month",
    studio2: "Team & privacy mode",
    studio3: "API trial quota",
    comingAtLaunch: "Coming at launch",
    mostPopular: "Most popular",
    ctaTitle: "Ready to see what you can make?",
    ctaSub: "Beta is free. Create an account and start generating in minutes.",
    openWorkbench: "Open the workbench →",
    tagline: "Two models. One prompt. Your call.",
    terms: "Terms",
    privacy: "Privacy",
    footerNote: "© 2026 PixelDuo. Beta product — details may change.",
  },
  zh: {
    models: "模型",
    features: "功能",
    pricing: "价格",
    signIn: "登录",
    joinBeta: "加入 Beta",
    eyebrow: "双引擎 AI 图像工作室 · Beta",
    heroTitle1: "双模型。",
    heroTitle2: "一条提示词。",
    heroTitle3: "你说了算。",
    heroSub: "PixelDuo 并排运行 GPT Image 2 与 Seedream 5——一键对比，生成前就能看到每张图的确切成本。",
    startFree: "免费开始创作",
    seeModels: "看看这两个模型",
    trustFree: "免费 Beta，无需信用卡",
    trustCost: "单图成本透明可见",
    trustAssistant: "内置 AI 提示词助手",
    latency: "延迟",
    costPerImage: "单图成本",
    compareNote: "同一提示词，双引擎出图。按质量、速度或价格选择——一切成本都在生成前透明展示。",
    powerKicker: "双引擎之力",
    powerTitle: "一个工作室，两个世界级引擎。",
    powerSub: "正面比较，无需锁定单一模型。GPT Image 2 擅长精细细节与文字，Seedream 5 擅长速度与大画幅。",
    gptDesc: "精修工作室——文字渲染、细腻细节，以及成品级一致质量。",
    gpt1: "能正确渲染的文字与非拉丁文本",
    gpt2: "灵活尺寸与多轮编辑",
    gpt3: "无平台水印",
    seedDesc: "快车道——数秒出大画幅，适合草图、批量与探索。",
    seed1: "原生 2K / 3K 输出，适合印刷与大屏",
    seed2: "支持参考图",
    seed3: "自带 AI 生成标识（合规透明）",
    duoTitle: "拿不准选哪个引擎？两个都生成。",
    duoSub: "一条提示词、两张输出并排展示——你选赢家。两张图分开、清晰地计费。",
    tryCompare: "试试对比",
    trustKicker: "围绕信任而建",
    trustTitle: "没有黑箱，没有意外账单。",
    trustSub: "每一笔费用在发生前都可见，每个模型按真实成本定价，AI 免费帮你写出更好的提示词。",
    featCost: "透明成本预览",
    featCostSub: "生成前就看到一张图会用掉多少积分与多少钱。按预算调整模型、质量或尺寸。",
    featAssistant: "AI 提示词助手",
    featAssistantSub: "输入一句模糊想法，得到可直接上手的提示词——扩写、翻译、风格化。由 DeepSeek 驱动，所有套餐免费。",
    featTemplates: "模板库",
    featTemplatesSub: "电商、人像、海报、3D 图标——预制提示词并绑定精确模型与参数，一键复用。",
    featCredits: "积分 + 订阅，随你组合",
    featCreditsSub: "充值积分 12 个月有效，月配额未用完部分 30% 结转至下月。套餐从免费到工作室版。",
    pricingKicker: "公平定价，没有黑箱 · Fair pricing",
    pricingTitle: "对钱包友好的套餐。",
    pricingSub: "1 积分 = $0.01。未用完的月配额结转 30%。Beta 阶段免费打磨。",
    free: "免费",
    starter: "入门",
    pro: "专业",
    studio: "工作室",
    perMonth: "/ 月",
    free1: "注册送 30 积分",
    free2: "每日签到 +2 积分",
    free3: "带水印预览",
    startFreeBtn: "免费开始",
    starter1: "800 积分 / 月",
    starter2: "约 100–130 张图",
    starter3: "无平台水印",
    pro1: "2,000 积分 / 月",
    pro2: "约 250–330 张图",
    pro3: "30% 配额结转",
    studio1: "5,000 积分 / 月",
    studio2: "团队与隐私模式",
    studio3: "API 试用配额",
    comingAtLaunch: "上线时开放",
    mostPopular: "最受欢迎",
    ctaTitle: "准备好看看你能创作什么了吗？",
    ctaSub: "Beta 免费。创建账号，几分钟内开始生成。",
    openWorkbench: "打开工作台 →",
    tagline: "双模型。一条提示词。你说了算。",
    terms: "条款",
    privacy: "隐私",
    footerNote: "© 2026 PixelDuo。Beta 产品——细节可能变化。",
  },
} as const;

type Dict = { [K in keyof typeof DICT.en]: string };

export default function Landing() {
  const [locale, setLocale] = useState<Locale>("en");
  useEffect(() => {
    const saved = localStorage.getItem("pd-lang");
    if (saved === "zh" || saved === "en") setLocale(saved);
  }, []);
  const t: Dict = DICT[locale];
  const switchLocale = (l: Locale) => {
    setLocale(l);
    localStorage.setItem("pd-lang", l);
  };

  return (
    <div className="landing">
      <header className="nav">
        <div className="nav-inner">
          <Link className="logo" href="/">
            <span className="logo-mark"><i></i><i></i></span>
            PixelDuo
          </Link>
          <nav className="nav-links">
            <a href="#models">{t.models}</a>
            <a href="#features">{t.features}</a>
            <a href="#pricing">{t.pricing}</a>
          </nav>
          <div className="nav-cta">
            <button className="btn btn-ghost" onClick={() => switchLocale(locale === "en" ? "zh" : "en")}>
              {locale === "en" ? "中文" : "EN"}
            </button>
            <Link className="btn btn-ghost" href="/login">{t.signIn}</Link>
            <Link className="btn btn-dark" href="/register" style={{ marginLeft: 10 }}>{t.joinBeta}</Link>
          </div>
        </div>
      </header>

      <main>
        <section>
          <div className="wrap hero-grid">
            <div>
              <span className="eyebrow"><i></i>{t.eyebrow}</span>
              <h1 className="serif">{t.heroTitle1}<br />{t.heroTitle2} <em>{t.heroTitle3}</em></h1>
              <p className="hero-sub">{t.heroSub}</p>
              <div className="hero-cta">
                <Link className="btn btn-dark" href="/register">{t.startFree}</Link>
                <a className="btn btn-ghost" href="#models">{t.seeModels}</a>
              </div>
              <div className="hero-trust">
                <span>✅ <b>{t.trustFree}</b></span>
                <span>💡 <b>{t.trustCost}</b></span>
                <span>🧠 <b>{t.trustAssistant}</b></span>
              </div>
            </div>
            <div>
              <div className="compare-card">
                <div className="compare-imgs">
                  <figure className="compare-item">
                    <span className="model-tag tag-gpt"><i></i>GPT Image 2</span>
                    <img src="/templates/gpt_medium_1024.png" alt="GPT Image 2 output" width={1024} height={1024} loading="lazy" />
                  </figure>
                  <figure className="compare-item">
                    <span className="model-tag tag-seed"><i></i>Seedream 5</span>
                    <img src="/templates/seedream_1920.png" alt="Seedream 5 output" width={1920} height={1920} loading="lazy" />
                  </figure>
                </div>
                <div className="vs">vs</div>
                <div className="compare-specs">
                  <div className="spec">{t.latency}<b>35s · medium</b></div>
                  <div className="spec">{t.latency}<b>15s · 1920²</b></div>
                  <div className="spec">{t.costPerImage}<b>$0.053</b></div>
                  <div className="spec">{t.costPerImage}<b>¥0.30</b></div>
                </div>
                <p className="compare-note">{t.compareNote}</p>
              </div>
            </div>
          </div>
        </section>

        <section id="models">
          <div className="wrap">
            <div className="sec-head">
              <div className="sec-kicker">{t.powerKicker}</div>
              <h2 className="serif">{t.powerTitle}</h2>
              <p>{t.powerSub}</p>
            </div>
            <div className="models-grid">
              <div className="model-card">
                <h3 style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span className="model-dot" style={{ width: 12, height: 12, borderRadius: 4, background: "var(--indigo)" }}></span>
                  GPT Image 2
                </h3>
                <p className="model-desc">{t.gptDesc}</p>
                <div className="model-stats">
                  <span className="stat-chip">Medium 1024²<b>$0.053 / img</b></span>
                  <span className="stat-chip">High 1024²<b>$0.211 / img</b></span>
                  <span className="stat-chip">{t.latency}<b>35 – 148s</b></span>
                </div>
                <ul className="model-list">
                  <li>{t.gpt1}</li>
                  <li>{t.gpt2}</li>
                  <li>{t.gpt3}</li>
                </ul>
              </div>
              <div className="model-card">
                <h3 style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span className="model-dot" style={{ width: 12, height: 12, borderRadius: 4, background: "var(--orange)" }}></span>
                  Seedream 5
                </h3>
                <p className="model-desc">{t.seedDesc}</p>
                <div className="model-stats">
                  <span className="stat-chip">1920²<b>≈ $0.035 / img</b></span>
                  <span className="stat-chip">Up to 3K<b>3072 × 3072</b></span>
                  <span className="stat-chip">{t.latency}<b>≈ 15s</b></span>
                </div>
                <ul className="model-list">
                  <li>{t.seed1}</li>
                  <li>{t.seed2}</li>
                  <li>{t.seed3}</li>
                </ul>
              </div>
            </div>
            <div className="duo-banner">
              <div>
                <h4>{t.duoTitle}</h4>
                <p>{t.duoSub}</p>
              </div>
              <Link className="btn btn-dark" href="/register" style={{ marginLeft: "auto" }}>{t.tryCompare}</Link>
            </div>
          </div>
        </section>

        <section id="features" style={{ background: "var(--surface)", borderTop: "1px solid var(--line)", borderBottom: "1px solid var(--line)" }}>
          <div className="wrap">
            <div className="sec-head">
              <div className="sec-kicker">{t.trustKicker}</div>
              <h2 className="serif">{t.trustTitle}</h2>
              <p>{t.trustSub}</p>
            </div>
            <div className="feat-grid">
              <div className="feat-card">
                <h3>{t.featCost}</h3>
                <p>{t.featCostSub}</p>
              </div>
              <div className="feat-card">
                <h3>{t.featAssistant}</h3>
                <p>{t.featAssistantSub}</p>
              </div>
              <div className="feat-card">
                <h3>{t.featTemplates}</h3>
                <p>{t.featTemplatesSub}</p>
              </div>
              <div className="feat-card">
                <h3>{t.featCredits}</h3>
                <p>{t.featCreditsSub}</p>
              </div>
            </div>
          </div>
        </section>

        <section className="pricing-band" id="pricing">
          <div className="wrap">
            <div className="sec-head">
              <div className="sec-kicker">{t.pricingKicker}</div>
              <h2 className="serif">{t.pricingTitle}</h2>
              <p>{t.pricingSub}</p>
            </div>
            <div className="plan-grid">
              <div className="plan">
                <h3>{t.free}</h3>
                <div className="price">$0<small>{t.perMonth}</small></div>
                <ul>
                  <li>{t.free1}</li>
                  <li>{t.free2}</li>
                  <li>{t.free3}</li>
                </ul>
                <Link className="btn btn-ghost" href="/register">{t.startFreeBtn}</Link>
              </div>
              <div className="plan">
                <h3>{t.starter}</h3>
                <div className="price">$9<small>{t.perMonth}</small></div>
                <ul>
                  <li>{t.starter1}</li>
                  <li>{t.starter2}</li>
                  <li>{t.starter3}</li>
                </ul>
                <Link className="btn btn-ghost" href="/register">{t.comingAtLaunch}</Link>
              </div>
              <div className="plan featured">
                <span className="badge">{t.mostPopular}</span>
                <h3>{t.pro}</h3>
                <div className="price">$19<small>{t.perMonth}</small></div>
                <ul>
                  <li>{t.pro1}</li>
                  <li>{t.pro2}</li>
                  <li>{t.pro3}</li>
                </ul>
                <Link className="btn btn-dark" href="/register">{t.comingAtLaunch}</Link>
              </div>
              <div className="plan">
                <h3>{t.studio}</h3>
                <div className="price">$39<small>{t.perMonth}</small></div>
                <ul>
                  <li>{t.studio1}</li>
                  <li>{t.studio2}</li>
                  <li>{t.studio3}</li>
                </ul>
                <Link className="btn btn-ghost" href="/register">{t.comingAtLaunch}</Link>
              </div>
            </div>
          </div>
        </section>

        <section className="cta-band">
          <div className="wrap">
            <h2 className="serif">{t.ctaTitle}</h2>
            <p>{t.ctaSub}</p>
            <Link className="btn btn-dark" href="/register">{t.openWorkbench}</Link>
          </div>
        </section>
      </main>

      <footer>
        <div className="wrap foot-inner">
          <span className="logo"><span className="logo-mark"><i></i><i></i></span> PixelDuo</span>
          <span className="muted">pixelduo.ai · {t.tagline}</span>
          <span className="muted">
            <Link className="link" href="/terms" style={{ marginRight: 14 }}>{t.terms}</Link>
            <Link className="link" href="/privacy">{t.privacy}</Link>
          </span>
          <span className="muted" style={{ marginLeft: "auto" }}>{t.footerNote}</span>
        </div>
      </footer>
    </div>
  );
}
