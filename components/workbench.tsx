"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { signOut } from "next-auth/react";
import Link from "next/link";
import { estimateGenerationCost, estimateModelCost, type ModelId, type Quality } from "@/lib/cost";
import { PLANS, PACKS } from "@/lib/catalog";
import { MODELS, getImageModels, getVideoModels } from "@/lib/model-registry";

interface Me {
  credits: number;
  plan: string;
  planRenewsAt: string | null;
  emailVerified: string | null;
  role: string;
  name: string;
  email: string;
}

interface Template {
  id: string;
  cat: string;
  title: string;
  prompt: string;
  model: string;
  quality: string;
  credits: number;
  img: string;
}

interface GalleryImage {
  id: string;
  url: string;
  model: string;
  quality: string;
  prompt: string;
  credits: number;
  createdAt: string;
}

interface LedgerRow {
  id: string;
  type: string;
  creditsDelta: number;
  balanceAfter: number;
  note: string | null;
  createdAt: string;
}

interface ExpiringCredit {
  id: string;
  source: string;
  remaining: number;
  expiresAt: string;
  daysLeft: number;
}

interface JobStatus {
  id: string;
  status: string;
  model: string;
  quality: string;
  count: number;
  prompt: string;
  costCredits: number;
  images: string[];
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}

type Tab = "create" | "edit" | "video" | "explore" | "gallery" | "ledger" | "orders" | "pricing";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "create", label: "Create" },
  { id: "edit", label: "Edit" },
  { id: "video", label: "Video" },
  { id: "explore", label: "Explore" },
  { id: "gallery", label: "Gallery" },
  { id: "ledger", label: "Ledger" },
  { id: "orders", label: "Orders" },
  { id: "pricing", label: "Pricing" },
];

const IMAGE_MODELS = getImageModels();
const VIDEO_MODELS = getVideoModels();

const MODEL_OPTIONS: Array<{ value: string; label: string }> = [
  ...IMAGE_MODELS.map((m) => ({ value: m.id, label: m.displayName })),
  { value: "both", label: "Both ⇄" },
];

const QUALITY_OPTIONS: Array<{ value: Quality; label: string }> = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
];

const COUNT_OPTIONS = [1, 2, 4];

const VIDEO_MODEL_OPTIONS: Array<{ value: string; label: string }> = VIDEO_MODELS.map((m) => ({
  value: m.id,
  label: m.displayName,
}));

const DURATION_OPTIONS = [3, 5, 10, 15];

const EDIT_MODEL_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "gpt", label: "GPT Image 2" },
  { value: "seedream", label: "Seedream 5" },
  { value: "wan-image", label: "Wan 2.7" },
  { value: "wan-image-pro", label: "Wan 2.7 Pro" },
];

const ASSISTANT_MODEL_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "deepseek", label: "DeepSeek" },
  { value: "glm", label: "GLM 5.2" },
  { value: "qwen", label: "Qwen 3.8" },
  { value: "kimi", label: "Kimi K2.6" },
];

const STYLE_HINTS = [
  "soft studio lighting, high detail",
  "editorial, magazine quality",
  "cyberpunk, neon accents",
  "minimal, warm neutral palette",
];

interface OrderRow {
  id: string;
  kind: "pack" | "plan";
  provider: string;
  amountUsd: number;
  credits: number;
  planId: string | null;
  status: string;
  createdAt: string;
  paidAt: string | null;
}

type Locale = "en" | "zh";
const LOCALE_STRINGS: Record<Locale, {
  tabs: Record<Tab, string>;
  credits: string; topUp: string; signOut: string; generate: string; generating: string; beta: string;
  orderStatus: Record<string, string>;
  ledgerLabels: Record<string, string>;
  pageHead: {
    create: { title: string; desc: string };
    edit: { title: string; desc: string };
    video: { title: string; desc: string };
    explore: { title: string; desc: string };
    gallery: { title: string; desc: string };
    ledger: { title: string; desc: string };
    orders: { title: string; desc: string };
    pricing: { title: string; desc: string };
  };
  prompt: string; chars: string; model: string; quality: string; count: string;
  balance: string; insufficient: string; smartRoute: string;
  assistantHead: string; assistantFree: string;
  expand: string; translate: string; style: string; inspire: string;
  usePrompt: string; writePrompt: string; verifyFirst: string;
  uploadImage: string; clickUpload: string; editInstruction: string; editModel: string; editImage: string;
  videoPrompt: string; duration: string; refImage: string; genVideo: string; genVideoing: string;
  videoCreating: string; videoPolling: string; videoWait: string;
  emptyCreate: string; emptyCreateDesc: string; emptyEdit: string; emptyEditDesc: string; emptyVideo: string; emptyVideoDesc: string;
  latestResults: string; recentImages: string; total: string; editResult: string; videoResult: string;
  genFailed: string; videoFailed: string; charged: string; download: string;
  backToWorkbench: string; plansCredits: string; signup: string; checkin: string; dailyCheckin: string;
  topupPacks: string; validMonths: string; currentPlan: string; choose: string; free: string;
  checkoutTitle: string; item: string; creditsLabel: string; totalLabel: string; paymentMethod: string;
  betaNote: string; confirm: string; verifyBanner: string; resend: string; expiryBanner: string; expiryDay: string; expiryDays: string;
  ledgerTable: { time: string; type: string; note: string; delta: string; balanceCol: string };
  ordersTable: { time: string; item: string; amount: string; creditsCol: string; status: string; provider: string };
  noOrders: string; imagesVideo: string; videos: string; sec: string;
}> = {
  en: {
    tabs: { create: "Create", edit: "Edit", video: "Video", explore: "Explore", gallery: "Gallery", ledger: "Ledger", orders: "Orders", pricing: "Pricing" },
    credits: "credits", topUp: "Top up", signOut: "Sign out", generate: "Generate", generating: "Generating…", beta: "Beta · free",
    orderStatus: { paid: "Paid", pending: "Pending", refunded: "Refunded" },
    ledgerLabels: { SIGNUP_BONUS: "Signup bonus", CHECKIN: "Daily check-in", PURCHASE: "Credit pack", SUBSCRIPTION: "Plan subscription", PRE_AUTH: "Generation (pre-auth)", SETTLE: "Generation settled", REFUND: "Refund (failure)", REVOKE: "Refund (payment)", EXPIRE: "Expired", ADMIN: "Adjustment" },
    pageHead: {
      create: { title: "Create", desc: "Four image engines — pick the best for your prompt. Cost shown before you commit." },
      edit: { title: "Edit", desc: "Upload a reference image and describe what to change." },
      video: { title: "Video", desc: "Text-to-video and image-to-video. Powered by Seedance 2.0 and Wan 2.7." },
      explore: { title: "Explore", desc: "Ready-made prompts with the exact model and parameters attached." },
      gallery: { title: "Gallery", desc: "Your history — every image and video keeps its prompt, engine, and exact cost." },
      ledger: { title: "Ledger", desc: "Every credit movement, in one transparent log." },
      orders: { title: "Orders", desc: "Your purchases and payment status." },
      pricing: { title: "Plans & credits", desc: "1 credit = $0.01 · unused monthly quota rolls 30% into next month." },
    },
    prompt: "Prompt", chars: "chars", model: "Model", quality: "Quality", count: "Count",
    balance: "Balance", insufficient: "Insufficient credits", smartRoute: "✦ Smart route",
    assistantHead: "Prompt assistant", assistantFree: "free",
    expand: "Expand", translate: "Translate", style: "Style", inspire: "Inspire",
    usePrompt: "✓ Use this prompt", writePrompt: "Write a prompt first", verifyFirst: "Verify your email first to start generating.",
    uploadImage: "Reference image", clickUpload: "Click to upload an image (max 5MB)",
    editInstruction: "Edit instruction", editModel: "Edit model", editImage: "Edit Image",
    videoPrompt: "Prompt", duration: "Duration", refImage: "Reference image (first frame)", genVideo: "Generate Video", genVideoing: "Generating video… (1-3 min)",
    videoCreating: "Creating video task…", videoPolling: "Polling video task…", videoWait: "This may take 1-3 minutes",
    emptyCreate: "Your canvas is empty", emptyCreateDesc: "Type a prompt, pick an engine, and press Generate.",
    emptyEdit: "Upload an image to start editing", emptyEditDesc: "Supported: GPT Image 2, Wan 2.7 Pro, Seedream reference.",
    emptyVideo: "Create your first video", emptyVideoDesc: "Text-to-video or image-to-video.",
    latestResults: "Latest results", recentImages: "Recent images", total: "total", editResult: "Edit result", videoResult: "Video result",
    genFailed: "Generation failed", videoFailed: "Video generation failed", charged: "Charged", download: "Download",
    backToWorkbench: "← Back to workbench", plansCredits: "Plans & credits",
    signup: "Signup bonus", checkin: "Daily check-in", dailyCheckin: "daily check-in +2",
    topupPacks: "Top-up packs", validMonths: "valid 12 months", currentPlan: "Current plan", choose: "Choose", free: "Free",
    checkoutTitle: "Checkout · 结账壳子", item: "Item", creditsLabel: "Credits", totalLabel: "Total", paymentMethod: "Payment method",
    betaNote: "Beta 壳子：当前为免费邀请制内测，不产生真实扣款。",
    verifyBanner: "⚠️ Verify your email to unlock generation and your 30 free credits.", resend: "Resend email",
    expiryBanner: "⏳ credits expire in", expiryDay: "day", expiryDays: "days",
    ledgerTable: { time: "Time", type: "Type", note: "Note", delta: "Δ", balanceCol: "Balance" },
    ordersTable: { time: "Time", item: "Item", amount: "Amount", creditsCol: "Credits", status: "Status", provider: "Provider" },
    noOrders: "No orders yet.", imagesVideo: "images", videos: "video", sec: "s",
    confirm: "Confirm",
  },
  zh: {
    tabs: { create: "创作", edit: "编辑", video: "视频", explore: "灵感库", gallery: "画廊", ledger: "账本", orders: "订单", pricing: "定价" },
    credits: "积分", topUp: "充值", signOut: "退出", generate: "生成", generating: "生成中…", beta: "Beta · 免费",
    orderStatus: { paid: "已支付", pending: "待支付", refunded: "已退款" },
    ledgerLabels: { SIGNUP_BONUS: "注册奖励", CHECKIN: "每日签到", PURCHASE: "积分包", SUBSCRIPTION: "订阅", PRE_AUTH: "生成（预扣）", SETTLE: "生成完成", REFUND: "退款（失败）", REVOKE: "退款（支付）", EXPIRE: "已过期", ADMIN: "管理员调整" },
    pageHead: {
      create: { title: "创作", desc: "四大图像引擎 — 为你的提示词选最佳模型，生成前透明计费。" },
      edit: { title: "编辑", desc: "上传参考图，描述要修改的内容。" },
      video: { title: "视频", desc: "文生视频和图生视频，由 Seedance 2.0 和万相 2.7 驱动。" },
      explore: { title: "灵感库", desc: "精选模板，附带模型与参数，一键复用。" },
      gallery: { title: "画廊", desc: "你的历史记录 — 每张图都保留提示词、引擎和精确成本。" },
      ledger: { title: "账本", desc: "每一笔积分变动，透明可查。余额 = 流水汇总。" },
      orders: { title: "订单", desc: "你的购买记录和支付状态。" },
      pricing: { title: "定价与积分", desc: "1 积分 = $0.01 · 月度配额未用完 30% 可结转下月。" },
    },
    prompt: "提示词", chars: "字符", model: "模型", quality: "质量", count: "数量",
    balance: "余额", insufficient: "积分不足", smartRoute: "✦ 智能路由",
    assistantHead: "提示词助手", assistantFree: "免费",
    expand: "扩写", translate: "翻译", style: "风格化", inspire: "灵感",
    usePrompt: "✓ 使用此提示词", writePrompt: "请先输入提示词", verifyFirst: "请先验证邮箱才能开始生成。",
    uploadImage: "参考图片", clickUpload: "点击上传图片（最大 5MB）",
    editInstruction: "编辑指令", editModel: "编辑模型", editImage: "编辑图片",
    videoPrompt: "提示词", duration: "时长", refImage: "参考图（首帧）", genVideo: "生成视频", genVideoing: "视频生成中…（1-3 分钟）",
    videoCreating: "正在创建视频任务…", videoPolling: "正在轮询视频任务…", videoWait: "预计需要 1-3 分钟",
    emptyCreate: "画布还是空的", emptyCreateDesc: "输入提示词，选择引擎，点击生成。",
    emptyEdit: "上传图片开始编辑", emptyEditDesc: "支持 GPT Image 2、万相 2.7 Pro、Seedream 参考图。",
    emptyVideo: "创建你的第一个视频", emptyVideoDesc: "文生视频或图生视频。",
    latestResults: "最新结果", recentImages: "最近图片", total: "共", editResult: "编辑结果", videoResult: "视频结果",
    genFailed: "生成失败", videoFailed: "视频生成失败", charged: "已扣", download: "下载",
    backToWorkbench: "← 返回工作台", plansCredits: "定价与积分",
    signup: "注册奖励", checkin: "每日签到", dailyCheckin: "每日签到 +2",
    topupPacks: "积分包", validMonths: "12 个月有效", currentPlan: "当前套餐", choose: "选择", free: "免费",
    checkoutTitle: "结账 · 结账壳子", item: "商品", creditsLabel: "积分", totalLabel: "合计", paymentMethod: "支付方式",
    betaNote: "Beta 壳子：当前为免费邀请制内测，不产生真实扣款。",
    verifyBanner: "⚠️ 验证邮箱后即可生成图片并获得 30 积分。", resend: "重发邮件",
    expiryBanner: "⏳ 积分将在", expiryDay: "天后过期", expiryDays: "天后过期",
    ledgerTable: { time: "时间", type: "类型", note: "备注", delta: "变动", balanceCol: "余额" },
    ordersTable: { time: "时间", item: "商品", amount: "金额", creditsCol: "积分", status: "状态", provider: "渠道" },
    noOrders: "暂无订单", imagesVideo: "张图片", videos: "个视频", sec: "秒",
    confirm: "确认",
  },
};

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const data = (await res.json()) as T & { ok?: boolean; error?: string };
  if (!data.ok) throw new Error(data.error ?? "request failed");
  return data;
}

function Icon({ d, size = 16 }: { d: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  );
}

function Seg<T extends string | number>({ options, value, onChange, tone }: {
  options: Array<{ value: T; label: string }>;
  value: T;
  onChange: (v: T) => void;
  tone?: "gpt" | "seed";
}) {
  return (
    <div className="seg" role="tablist">
      {options.map((o) => (
        <button
          key={String(o.value)}
          className={(value === o.value ? "on" : "") + (tone && value === o.value ? ` ${tone}` : "")}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function ModelPill({ model }: { model: string }) {
  const labels: Record<string, string> = {
    gpt: "GPT Image 2",
    seedream: "Seedream 5",
    "wan-image": "Wan 2.7",
    "wan-image-pro": "Wan 2.7 Pro",
    seedance: "Seedance 2.0",
    "wan-t2v": "Wan T2V",
    "wan-i2v": "Wan I2V",
  };
  const cls = model === "gpt" ? "gpt" : model.startsWith("wan") ? "gpt" : "seed";
  return (
    <span className={`model-pill ${cls}`}>
      <i></i>
      {labels[model] ?? model}
    </span>
  );
}

export function Workbench() {
  const [locale, setLocale] = useState<Locale>("en");
  useEffect(() => {
    const saved = localStorage.getItem("pd-lang");
    if (saved === "zh" || saved === "en") setLocale(saved);
  }, []);
  const t = LOCALE_STRINGS[locale];
  const LEDGER_LABELS = t.ledgerLabels;
  const switchLocale = (l: Locale) => {
    setLocale(l);
    localStorage.setItem("pd-lang", l);
  };

  const [tab, setTab] = useState<Tab>("create");
  const [me, setMe] = useState<Me | null>(null);
  const [prompt, setPrompt] = useState("a minimalist ceramic coffee mug on a warm beige background");
  const [model, setModel] = useState<string>("gpt");
  const [quality, setQuality] = useState<Quality>("medium");
  const [count, setCount] = useState(1);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [cat, setCat] = useState("全部");
  const [gallery, setGallery] = useState<GalleryImage[]>([]);
  const [ledger, setLedger] = useState<LedgerRow[]>([]);
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [expiring, setExpiring] = useState<ExpiringCredit[]>([]);
  const [activeJob, setActiveJob] = useState<JobStatus | null>(null);
  const [assistantOut, setAssistantOut] = useState("");
  const [assistantModel, setAssistantModel] = useState("deepseek");
  const [toast, setToast] = useState("");
  const [checkout, setCheckout] = useState<null | { kind: "pack" | "plan"; itemId: string; name: string; price: number; credits: number }>(null);
  const [method, setMethod] = useState("Card");
  const idemKeyRef = useRef<string | null>(null);

  // Edit tab state
  const [editModel, setEditModel] = useState("gpt");
  const [editPrompt, setEditPrompt] = useState("add a red hat, keep the background unchanged");
  const [editImage, setEditImage] = useState<string | null>(null);
  const [editImageName, setEditImageName] = useState<string>("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Video tab state
  const [videoModel, setVideoModel] = useState("wan-t2v");
  const [videoPrompt, setVideoPrompt] = useState("a golden retriever running through a sunlit wheat field, cinematic wide shot");
  const [videoDuration, setVideoDuration] = useState(5);
  const [videoImage, setVideoImage] = useState<string | null>(null);

  const cost = model === "both"
    ? estimateGenerationCost("both", quality, count)
    : estimateModelCost(model, count, quality);
  const costCredits = "totalCredits" in cost ? cost.totalCredits : cost.credits;
  const costUsd = "totalUsd" in cost ? cost.totalUsd : cost.usd;

  const refreshMe = useCallback(async () => {
    try {
      const data = await api<{ user: Me }>("/api/me");
      setMe(data.user);
    } catch {}
  }, []);

  const refreshGallery = useCallback(async () => {
    try {
      const data = await api<{ images: GalleryImage[] }>("/api/gallery");
      setGallery(data.images);
    } catch {}
  }, []);

  const refreshLedger = useCallback(async () => {
    try {
      const data = await api<{ entries: LedgerRow[] }>("/api/ledger");
      setLedger(data.entries);
    } catch {}
  }, []);

  const refreshOrders = useCallback(async () => {
    try {
      const data = await api<{ orders: OrderRow[] }>("/api/orders");
      setOrders(data.orders);
    } catch {}
  }, []);

  const resendVerification = async () => {
    try {
      await api("/api/auth/request-verification", { method: "POST" });
      setToast("Verification email sent — check your inbox.");
    } catch (e) {
      setToast(e instanceof Error ? e.message : "Failed to send verification email");
    }
  };

  const friendlyError = (e: unknown) => {
    const msg = e instanceof Error ? e.message : "";
    if (msg === "verify-email-required") return "Verify your email first to start generating.";
    if (msg === "insufficient-credits") return "Insufficient credits — top up first";
    return msg || "Something went wrong";
  };

  useEffect(() => {
    refreshMe();
    refreshGallery();
    refreshLedger();
    refreshOrders();
    api<{ expiring: ExpiringCredit[] }>("/api/credits/expiring")
      .then((d) => setExpiring(d.expiring))
      .catch(() => undefined);
    api<{ templates: Template[] }>("/api/templates")
      .then((d) => setTemplates(d.templates))
      .catch(() => undefined);
  }, [refreshMe, refreshGallery, refreshLedger, refreshOrders]);

  useEffect(() => {
    if (!toast) return;
    const tm = setTimeout(() => setToast(""), 2600);
    return () => clearTimeout(tm);
  }, [toast]);

  // Poll active job until terminal state
  useEffect(() => {
    if (!activeJob) return;
    if (activeJob.status === "done" || activeJob.status === "failed") {
      if (activeJob.status === "failed") setToast(t.genFailed + " — credits refunded.");
      refreshMe();
      refreshGallery();
      refreshLedger();
      refreshOrders();
      return;
    }
    const tm = setTimeout(async () => {
      try {
        const data = await api<{ job: JobStatus }>(`/api/jobs/${activeJob.id}`);
        setActiveJob(data.job);
      } catch {}
    }, 2500);
    return () => clearTimeout(tm);
  }, [activeJob, refreshMe, refreshGallery, refreshLedger, refreshOrders]);

  const generate = async () => {
    if (!prompt.trim()) return setToast(t.writePrompt);
    if (me && !me.emailVerified) return setToast(t.verifyFirst);
    if (me && me.credits < costCredits) return setToast(t.insufficient);
    setAssistantOut("");
    try {
      if (!idemKeyRef.current) idemKeyRef.current = crypto.randomUUID();
      const data = await api<{ jobId: string }>("/api/generate", {
        method: "POST",
        body: JSON.stringify({ prompt: prompt.trim(), model, quality, count, idempotencyKey: idemKeyRef.current }),
      });
      idemKeyRef.current = null;
      const poll = await api<{ job: JobStatus }>(`/api/jobs/${data.jobId}`);
      setActiveJob(poll.job);
    } catch (e) {
      setToast(friendlyError(e));
    }
  };

  const generateEdit = async () => {
    if (!editPrompt.trim()) return setToast(t.writePrompt);
    if (!editImage) return setToast(t.clickUpload);
    if (me && !me.emailVerified) return setToast(t.verifyFirst);
    const editCost = estimateModelCost(editModel, 1, quality);
    if (me && me.credits < editCost.credits) return setToast(t.insufficient);
    try {
      const data = await api<{ jobId: string }>("/api/edit", {
        method: "POST",
        body: JSON.stringify({
          prompt: editPrompt.trim(),
          model: editModel,
          quality,
          image: editImage,
        }),
      });
      const poll = await api<{ job: JobStatus }>(`/api/jobs/${data.jobId}`);
      setActiveJob(poll.job);
      setToast("Edit job submitted");
    } catch (e) {
      setToast(friendlyError(e));
    }
  };

  const generateVideo = async () => {
    if (!videoPrompt.trim()) return setToast("Write a video prompt");
    if (me && !me.emailVerified) return setToast(t.verifyFirst);
    const isI2V = videoModel === "wan-i2v" || videoModel === "seedance";
    if (isI2V && !videoImage) return setToast(t.clickUpload);
    const vCost = estimateModelCost(videoModel, 1, "standard", videoDuration);
    if (me && me.credits < vCost.credits) return setToast(t.insufficient);
    try {
      const data = await api<{ jobId: string }>("/api/video", {
        method: "POST",
        body: JSON.stringify({
          prompt: videoPrompt.trim(),
          model: videoModel,
          duration: videoDuration,
          image: videoImage,
        }),
      });
      const poll = await api<{ job: JobStatus }>(`/api/jobs/${data.jobId}`);
      setActiveJob(poll.job);
      setToast("Video generation started — this may take 1-3 minutes");
    } catch (e) {
      setToast(friendlyError(e));
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>, setter: (val: string) => void) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      setToast("Image too large (max 5MB)");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      setter(result);
      if (setter === setEditImage) setEditImageName(file.name);
    };
    reader.readAsDataURL(file);
  };

  const runSmartRoute = async () => {
    if (!prompt.trim()) return;
    try {
      const data = await api<{ recommendedModel: string; reason: string }>("/api/route", {
        method: "POST",
        body: JSON.stringify({ prompt: prompt.trim() }),
      });
      setModel(data.recommendedModel);
      setToast(`Smart route: ${data.recommendedModel} — ${data.reason}`);
    } catch {
      setToast("Smart routing unavailable");
    }
  };

  const runAssistant = async (mode: string) => {
    try {
      const data = await api<{ text: string; offline: boolean }>("/api/assistant", {
        method: "POST",
        body: JSON.stringify({ prompt, mode, model: assistantModel }),
      });
      setAssistantOut(data.text + (data.offline ? "\n\n(offline mode)" : ""));
    } catch {
      setToast("Assistant unavailable");
    }
  };

  const pickTemplate = (tm: Template) => {
    setPrompt(tm.prompt);
    setModel(tm.model);
    if (tm.quality !== "standard") setQuality(tm.quality as Quality);
    setTab("create");
    setToast("Template applied");
  };

  const checkin = async () => {
    try {
      const data = await api<{ claimed: boolean; credits: number }>("/api/checkin", { method: "POST" });
      setToast(data.claimed ? `+${data.credits} ${t.credits} (${t.checkin})` : (locale === "zh" ? "今日已签到" : "Already checked in today"));
      refreshMe();
      refreshLedger();
    } catch (e) {
      setToast(friendlyError(e));
    }
  };

  const openCheckout = (kind: "pack" | "plan", itemId: string) => {
    if (kind === "pack") {
      const p = PACKS.find((x) => x.id === itemId);
      if (!p) return;
      setCheckout({ kind, itemId, name: `${locale === "zh" ? "积分包" : "Credit pack"} · ${p.credits}`, price: p.price, credits: p.credits });
    } else {
      const pl = PLANS.find((x) => x.id === itemId);
      if (!pl) return;
      setCheckout({ kind, itemId, name: `${pl.name} ${locale === "zh" ? "套餐" : "plan"}`, price: pl.price, credits: pl.credits });
    }
  };

  const confirmCheckout = async () => {
    if (!checkout) return;
    try {
      const data = await api<{ status: string; mock?: boolean; checkoutUrl?: string }>("/api/checkout", {
        method: "POST",
        body: JSON.stringify({ kind: checkout.kind, itemId: checkout.itemId }),
      });
      if (data.checkoutUrl) {
        window.location.href = data.checkoutUrl;
        return;
      }
      setToast(data.status === "paid" ? (locale === "zh" ? `Beta 模拟支付 — +${checkout.credits} 积分` : `Beta mock paid — +${checkout.credits} credits`) : (locale === "zh" ? "订单已创建（待支付）" : "Order created (pending)"));
      setCheckout(null);
      refreshMe();
      refreshLedger();
      refreshOrders();
    } catch (e) {
      setToast(e instanceof Error ? e.message : "Checkout failed");
    }
  };

  const filteredTemplates = cat === "全部" ? templates : templates.filter((tm) => tm.cat === cat);
  const cats = ["全部", ...Array.from(new Set(templates.map((tm) => tm.cat)))];

  const generating = activeJob !== null && (activeJob.status === "queued" || activeJob.status === "running" || activeJob.status === "polling");
  const isVideoJob = activeJob !== null && (activeJob.model === "seedance" || activeJob.model === "wan-t2v" || activeJob.model === "wan-i2v");

  return (
    <div>
      <header className="topbar">
        <Link className="logo" href="/">
          <span className="logo-mark"><i></i><i></i></span>
          PixelDuo
        </Link>
        <nav className="tabs">
          {TABS.map((tb) => (
            <button key={tb.id} className={`tab${tab === tb.id ? " active" : ""}`} onClick={() => setTab(tb.id)}>
              <span>{t.tabs[tb.id]}</span>
            </button>
          ))}
        </nav>
        <div className="top-right">
          <button className="balance" onClick={checkin} title={t.checkin + " +2"}>
            <span className="coin">P</span>
            {me?.credits ?? "…"} <small>{t.credits}</small>
          </button>
          <button className="btn btn-ghost btn-sm" onClick={() => setTab("pricing")}>{t.topUp}</button>
          <button className="btn btn-ghost btn-sm" onClick={() => switchLocale(locale === "en" ? "zh" : "en")}>{locale === "en" ? "中文" : "EN"}</button>
          <Link className="btn btn-ghost btn-sm" href="/account/security">Security</Link>
          <Link className="btn btn-ghost btn-sm" href="/account/api">API Keys</Link>
          {me?.role === "admin" && <Link className="btn btn-ghost btn-sm" href="/admin">Admin</Link>}
          <button className="btn btn-ghost btn-sm" onClick={() => signOut({ callbackUrl: "/" })}>{t.signOut}</button>
        </div>
      </header>

      {me && !me.emailVerified && (
        <div className="verify-banner">
          <span>{t.verifyBanner}</span>
          <button className="btn btn-ghost btn-sm" onClick={resendVerification}>{t.resend}</button>
        </div>
      )}

      {expiring.length > 0 && (
        <div className="expiry-banner">
          <span>
            {t.expiryBanner} {Math.min(...expiring.map((g) => g.daysLeft))} {Math.min(...expiring.map((g) => g.daysLeft)) > 1 ? t.expiryDays : t.expiryDay}
          </span>
          <button className="btn btn-ghost btn-sm" onClick={() => setTab("pricing")}>{t.topUp}</button>
        </div>
      )}

      <main className="main">
        {/* === CREATE TAB === */}
        {tab === "create" && (
          <>
            <div className="page-head">
              <div>
                <h1>{t.pageHead.create.title}</h1>
                <p>{t.pageHead.create.desc}</p>
              </div>
              <span className="chip on" style={{ cursor: "default" }}>{t.beta}</span>
            </div>
            <div className="create-grid">
              <div className="card composer">
                <div>
                  <div className="field-label">{t.prompt}</div>
                  <div className="prompt-box">
                    <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder={locale === "zh" ? "描述你想创建的内容…" : "Describe what you want to create…"} />
                    <div className="prompt-meta">
                      <span>{prompt.length} {t.chars}</span>
                      <button className="mini-btn" onClick={runSmartRoute} style={{ cursor: "pointer" }}>{t.smartRoute}</button>
                    </div>
                  </div>
                  <div className="chips" style={{ marginTop: 8 }}>
                    {STYLE_HINTS.map((s) => (
                      <button key={s} className="chip" onClick={() => setPrompt(prompt ? `${prompt}, ${s}` : s)}>{s}</button>
                    ))}
                  </div>
                </div>

                <div className="assistant">
                  <div className="assistant-head">
                    <span className="spark">✦</span>
                    {t.assistantHead}
                    <select value={assistantModel} onChange={(e) => setAssistantModel(e.target.value)} style={{ marginLeft: "auto", fontSize: 12, padding: "2px 6px", borderRadius: 4, border: "1px solid var(--ink-4)" }}>
                      {ASSISTANT_MODEL_OPTIONS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                    </select>
                  </div>
                  <div className="assistant-body">
                    <div className="assist-actions">
                      {[["expand", t.expand], ["translate", t.translate], ["style", t.style], ["inspire", t.inspire]].map(([mode, label]) => (
                        <button key={mode} className="mini-btn" onClick={() => runAssistant(mode)}>✦ {label}</button>
                      ))}
                    </div>
                    {assistantOut && (
                      <div className="assistant-output">
                        {assistantOut}
                        <button className="mini-btn" style={{ marginTop: 8 }} onClick={() => { setPrompt(assistantOut.split("\n\n")[0]); setAssistantOut(""); }}>
                          {t.usePrompt}
                        </button>
                      </div>
                    )}
                  </div>
                </div>

                <div>
                  <div className="field-label" style={{ marginBottom: 8 }}>{t.model}</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {MODEL_OPTIONS.map((m) => (
                      <button key={m.value} className={`chip${model === m.value ? " on" : ""}`} onClick={() => setModel(m.value)}>
                        {m.label}
                      </button>
                    ))}
                  </div>
                  {model !== "both" && model !== "seedream" && model !== "wan-image" && model !== "wan-image-pro" && (
                    <div style={{ marginTop: 6, fontSize: 12, color: "var(--ink-3)" }}>
                      {IMAGE_MODELS.find((m) => m.id === model)?.description ?? ""}
                    </div>
                  )}
                </div>

                {model !== "seedream" && model !== "wan-image" && model !== "wan-image-pro" && model !== "both" && (
                  <div className="opt-row">
                    <span className="field-label">{t.quality}</span>
                    <div style={{ width: 230 }}><Seg options={QUALITY_OPTIONS} value={quality} onChange={setQuality} tone="gpt" /></div>
                  </div>
                )}

                <div className="opt-row">
                  <span className="field-label">{t.count}</span>
                  <div style={{ width: 140 }}><Seg options={COUNT_OPTIONS.map((c) => ({ value: c, label: String(c) }))} value={count} onChange={setCount} /></div>
                </div>

                <div className="costbar">
                  <span>
                    {model === "both"
                      ? `GPT + Seedream`
                      : IMAGE_MODELS.find((m) => m.id === model)?.displayName ?? model}
                    <span className="amount"> {costCredits} <small>{t.credits} ≈ ${costUsd.toFixed(2)}</small></span>
                  </span>
                  {me && me.credits >= costCredits ? (
                    <span style={{ color: "var(--ink-2)" }}>{t.balance} {me.credits}</span>
                  ) : (
                    <span className="warn">{t.insufficient}</span>
                  )}
                </div>

                <button className="generate" disabled={generating} onClick={generate}>
                  {generating ? t.generating : t.generate}
                </button>
              </div>

              <div className="card results">
                {generating ? (
                  <div className="gen-steps">
                    <div className="gen-step active"><span className="dot"></span>{isVideoJob ? t.genVideoing : t.generating}</div>
                    <div className="gen-step"><span className="dot"></span>{t.charged} {activeJob!.costCredits} {t.credits} — refunded on failure</div>
                  </div>
                ) : activeJob && activeJob.status === "failed" ? (
                  <div className="empty">
                    <span className="serif">{t.genFailed}</span>
                    <span>{activeJob.error ?? "Unknown error"} — credits refunded.</span>
                  </div>
                ) : activeJob && activeJob.status === "done" ? (
                  <>
                    <div className="results-head">
                      <h2>{isVideoJob ? t.videoResult : t.latestResults}</h2>
                      <span className="count">{activeJob.images.length} {isVideoJob ? t.videos : t.imagesVideo} · {activeJob.costCredits} {t.credits}</span>
                    </div>
                    <div className="results-grid">
                      {activeJob.images.map((src, i) => (
                        <div key={i} className="result-card">
                          {isVideoJob ? (
                            <video src={src} controls style={{ width: "100%", borderRadius: 8 }} />
                          ) : (
                            <img src={src} alt={activeJob.prompt} />
                          )}
                          {me?.plan === "free" && !isVideoJob && <div className="wm-badge">PixelDuo · AI 生成</div>}
                          <div className="result-actions">
                            <a className="result-btn" href={`${src}?download=1`} download aria-label={t.download} title={t.download}>↓</a>
                          </div>
                          <div className="result-meta">
                            <ModelPill model={activeJob.model} />
                          </div>
                        </div>
                      ))}
                    </div>
                  </>
                ) : gallery.length === 0 ? (
                  <div className="empty">
                    <span className="serif">{t.emptyCreate}</span>
                    <span>{t.emptyCreateDesc}</span>
                  </div>
                ) : (
                  <>
                    <div className="results-head">
                      <h2>{t.recentImages}</h2>
                      <span className="count">{gallery.length} {t.total}</span>
                    </div>
                    <div className="results-grid">
                      {gallery.slice(0, 8).map((g) => (
                        <div key={g.id} className="result-card">
                          <img src={g.url} alt={g.prompt} />
                          {me?.plan === "free" && <div className="wm-badge">PixelDuo · AI 生成</div>}
                          <div className="result-actions">
                            <a className="result-btn" href={`${g.url}?download=1`} download aria-label={t.download} title={t.download}>↓</a>
                          </div>
                          <div className="result-meta">
                            <ModelPill model={g.model} />
                            <span style={{ marginLeft: "auto" }}>{g.credits} {t.credits}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </div>
            </div>
          </>
        )}

        {/* === EDIT TAB === */}
        {tab === "edit" && (
          <>
            <div className="page-head">
              <div>
                <h1>{t.pageHead.edit.title}</h1>
                <p>{t.pageHead.edit.desc}</p>
              </div>
            </div>
            <div className="create-grid">
              <div className="card composer">
                <div>
                  <div className="field-label">{t.uploadImage}</div>
                  <input ref={fileInputRef} type="file" accept="image/*" style={{ display: "none" }} onChange={(e) => handleFileUpload(e, setEditImage)} />
                  <div className="upload-area" onClick={() => fileInputRef.current?.click()} style={{ border: "2px dashed var(--ink-4)", borderRadius: 8, padding: 20, textAlign: "center", cursor: "pointer", marginBottom: 12 }}>
                    {editImage ? (
                      <div>
                        <img src={editImage} alt="reference" style={{ maxWidth: "100%", maxHeight: 200, borderRadius: 4 }} />
                        <div style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 4 }}>{editImageName}</div>
                      </div>
                    ) : (
                      <div style={{ color: "var(--ink-3)" }}>{t.clickUpload}</div>
                    )}
                  </div>
                </div>

                <div>
                  <div className="field-label">{t.editInstruction}</div>
                  <div className="prompt-box">
                    <textarea value={editPrompt} onChange={(e) => setEditPrompt(e.target.value)} placeholder={locale === "zh" ? "描述要修改的内容…" : "Describe what to change…"} />
                  </div>
                </div>

                <div>
                  <div className="field-label" style={{ marginBottom: 8 }}>{t.editModel}</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {EDIT_MODEL_OPTIONS.map((m) => (
                      <button key={m.value} className={`chip${editModel === m.value ? " on" : ""}`} onClick={() => setEditModel(m.value)}>
                        {m.label}
                      </button>
                    ))}
                  </div>
                </div>

                {editModel === "gpt" && (
                  <div className="opt-row">
                    <span className="field-label">{t.quality}</span>
                    <div style={{ width: 230 }}><Seg options={QUALITY_OPTIONS} value={quality} onChange={setQuality} tone="gpt" /></div>
                  </div>
                )}

                <div className="costbar">
                  <span>
                    {EDIT_MODEL_OPTIONS.find((m) => m.value === editModel)?.label}
                    <span className="amount"> {estimateModelCost(editModel, 1, quality).credits} <small>{t.credits}</small></span>
                  </span>
                </div>

                <button className="generate" disabled={generating || !editImage} onClick={generateEdit}>
                  {generating ? t.generating : t.editImage}
                </button>
              </div>

              <div className="card results">
                {activeJob && activeJob.status === "done" ? (
                  <>
                    <div className="results-head">
                      <h2>{t.editResult}</h2>
                    </div>
                    <div className="results-grid">
                      {activeJob.images.map((src, i) => (
                        <div key={i} className="result-card">
                          <img src={src} alt={activeJob.prompt} />
                          <div className="result-actions">
                            <a className="result-btn" href={`${src}?download=1`} download>↓</a>
                          </div>
                          <div className="result-meta">
                            <ModelPill model={activeJob.model} />
                          </div>
                        </div>
                      ))}
                    </div>
                  </>
                ) : (
                  <div className="empty">
                    <span className="serif">{t.emptyEdit}</span>
                    <span>{t.emptyEditDesc}</span>
                  </div>
                )}
              </div>
            </div>
          </>
        )}

        {/* === VIDEO TAB === */}
        {tab === "video" && (
          <>
            <div className="page-head">
              <div>
                <h1>{t.pageHead.video.title}</h1>
                <p>{t.pageHead.video.desc}</p>
              </div>
              <span className="chip" style={{ cursor: "default", background: "var(--warn-bg)", color: "var(--warn)" }}>Beta</span>
            </div>
            <div className="create-grid">
              <div className="card composer">
                <div>
                  <div className="field-label">{t.prompt}</div>
                  <div className="prompt-box">
                    <textarea value={videoPrompt} onChange={(e) => setVideoPrompt(e.target.value)} placeholder={locale === "zh" ? "描述你想要的视频…" : "Describe the video you want…"} style={{ minHeight: 80 }} />
                    <div className="prompt-meta">
                      <span>{videoPrompt.length} {t.chars}</span>
                      <span>{locale === "zh" ? "支持多镜头叙事" : "Multi-shot narrative supported"}</span>
                    </div>
                  </div>
                </div>

                <div>
                  <div className="field-label" style={{ marginBottom: 8 }}>{t.model}</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {VIDEO_MODEL_OPTIONS.map((m) => (
                      <button key={m.value} className={`chip${videoModel === m.value ? " on" : ""}`} onClick={() => setVideoModel(m.value)}>
                        {m.label}
                      </button>
                    ))}
                  </div>
                  <div style={{ marginTop: 6, fontSize: 12, color: "var(--ink-3)" }}>
                    {VIDEO_MODELS.find((m) => m.id === videoModel)?.description ?? ""}
                  </div>
                </div>

                <div className="opt-row">
                  <span className="field-label">{t.duration}</span>
                  <div style={{ width: 200 }}>
                    <Seg options={DURATION_OPTIONS.map((d) => ({ value: d, label: `${d}${t.sec}` }))} value={videoDuration} onChange={setVideoDuration} />
                  </div>
                </div>

                {(videoModel === "wan-i2v" || videoModel === "seedance") && (
                  <div>
                    <div className="field-label">{t.refImage}</div>
                    <input type="file" accept="image/*" style={{ display: "none" }} id="video-file-input" onChange={(e) => handleFileUpload(e, setVideoImage)} />
                    <div onClick={() => document.getElementById("video-file-input")?.click()} style={{ border: "2px dashed var(--ink-4)", borderRadius: 8, padding: 16, textAlign: "center", cursor: "pointer" }}>
                      {videoImage ? (
                        <img src={videoImage} alt="first frame" style={{ maxWidth: "100%", maxHeight: 150, borderRadius: 4 }} />
                      ) : (
                        <div style={{ color: "var(--ink-3)" }}>{locale === "zh" ? "点击上传首帧图片" : "Click to upload first frame image"}</div>
                      )}
                    </div>
                  </div>
                )}

                <div className="costbar">
                  <span>
                    {VIDEO_MODELS.find((m) => m.id === videoModel)?.displayName}
                    <span className="amount"> {estimateModelCost(videoModel, 1, "standard", videoDuration).credits} <small>{t.credits} ≈ ${estimateModelCost(videoModel, 1, "standard", videoDuration).usd.toFixed(2)}</small></span>
                  </span>
                  {me && me.credits >= estimateModelCost(videoModel, 1, "standard", videoDuration).credits ? (
                    <span style={{ color: "var(--ink-2)" }}>{t.balance} {me.credits}</span>
                  ) : (
                    <span className="warn">{t.insufficient}</span>
                  )}
                </div>

                <button className="generate" disabled={generating} onClick={generateVideo}>
                  {generating ? t.genVideoing : t.genVideo}
                </button>
              </div>

              <div className="card results">
                {activeJob && (activeJob.model === "seedance" || activeJob.model === "wan-t2v" || activeJob.model === "wan-i2v") ? (
                  activeJob.status === "done" ? (
                    <>
                      <div className="results-head">
                        <h2>{t.videoResult}</h2>
                        <span className="count">{activeJob.costCredits} {t.credits}</span>
                      </div>
                      <div className="results-grid">
                        {activeJob.images.map((src, i) => (
                          <div key={i} className="result-card" style={{ gridColumn: "1 / -1" }}>
                            <video src={src} controls style={{ width: "100%", borderRadius: 8 }} />
                            <div className="result-actions">
                              <a className="result-btn" href={`${src}?download=1`} download>↓</a>
                            </div>
                            <div className="result-meta">
                              <ModelPill model={activeJob.model} />
                            </div>
                          </div>
                        ))}
                      </div>
                    </>
                  ) : activeJob.status === "failed" ? (
                    <div className="empty">
                      <span className="serif">{t.videoFailed}</span>
                      <span>{activeJob.error ?? "Unknown error"} — credits refunded.</span>
                    </div>
                  ) : (
                    <div className="gen-steps">
                      <div className="gen-step active"><span className="dot"></span>{activeJob.status === "polling" ? t.videoPolling : t.videoCreating}</div>
                      <div className="gen-step"><span className="dot"></span>{t.videoWait}</div>
                    </div>
                  )
                ) : (
                  <div className="empty">
                    <span className="serif">{t.emptyVideo}</span>
                    <span>{t.emptyVideoDesc}</span>
                  </div>
                )}
              </div>
            </div>
          </>
        )}

        {/* === EXPLORE TAB === */}
        {tab === "explore" && (
          <>
            <div className="page-head">
              <div>
                <h1>{t.pageHead.explore.title}</h1>
                <p>{t.pageHead.explore.desc}</p>
              </div>
            </div>
            <div className="cat-row">
              {cats.map((c) => (
                <button key={c} className={`chip${cat === c ? " on" : ""}`} onClick={() => setCat(c)}>{c}</button>
              ))}
            </div>
            <div className="tmpl-grid">
              {filteredTemplates.map((tm) => (
                <div key={tm.id} className="card tmpl-card" onClick={() => pickTemplate(tm)}>
                  <img src={tm.img} alt={tm.title} />
                  <div className="tmpl-body">
                    <h3>{tm.title}</h3>
                    <p>{tm.prompt}</p>
                    <div className="tmpl-foot">
                      <ModelPill model={tm.model} />
                      <span>{tm.credits} {t.credits}</span>
                      <span className="spacer"></span>
                      <span style={{ color: "var(--indigo)", fontWeight: 700 }}>Use →</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        {/* === GALLERY TAB === */}
        {tab === "gallery" && (
          <>
            <div className="page-head">
              <div>
                <h1>{t.pageHead.gallery.title}</h1>
                <p>{t.pageHead.gallery.desc}</p>
              </div>
            </div>
            {gallery.length === 0 ? (
              <div className="card"><div className="empty"><span className="serif">Nothing here yet</span><span>{locale === "zh" ? "生成的图片会出现在这里。" : "Generated images will appear here."}</span></div></div>
            ) : (
              <div className="gallery-grid">
                {gallery.map((g) => (
                  <div key={g.id} className="card gal-card">
                    <img src={g.url} alt={g.prompt} />
                    <div className="gal-body">
                      <div className="prompt">{g.prompt}</div>
                      <div className="gal-meta">
                        <ModelPill model={g.model} />
                        <span>{g.credits} {t.credits}</span>
                        <span className="spacer"></span>
                        <a className="dl-link" href={`${g.url}?download=1`} download>{t.download}</a>
                        <span>{new Date(g.createdAt).toLocaleString()}</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {/* === LEDGER TAB === */}
        {tab === "ledger" && (
          <>
            <div className="page-head">
              <div>
                <h1>{t.pageHead.ledger.title}</h1>
                <p>{t.pageHead.ledger.desc}</p>
              </div>
              <span className="balance" style={{ cursor: "default" }}>
                <span className="coin">P</span>
                {me?.credits ?? 0} <small>{t.credits}</small>
              </span>
            </div>
            <div className="table-wrap">
              <table className="ledger">
                <thead>
                  <tr><th>{t.ledgerTable.time}</th><th>{t.ledgerTable.type}</th><th>{t.ledgerTable.note}</th><th>{t.ledgerTable.delta}</th><th>{t.ledgerTable.balanceCol}</th></tr>
                </thead>
                <tbody>
                  {ledger.map((row) => (
                    <tr key={row.id}>
                      <td>{new Date(row.createdAt).toLocaleString()}</td>
                      <td>{LEDGER_LABELS[row.type] ?? row.type}</td>
                      <td>{row.note ?? ""}</td>
                      <td className={row.creditsDelta >= 0 ? "pos" : "neg"}>{row.creditsDelta >= 0 ? `+${row.creditsDelta}` : row.creditsDelta}</td>
                      <td>{row.balanceAfter}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        {/* === ORDERS TAB === */}
        {tab === "orders" && (
          <>
            <div className="page-head">
              <div>
                <h1>{t.pageHead.orders.title}</h1>
                <p>{t.pageHead.orders.desc}</p>
              </div>
              <span className="balance" style={{ cursor: "default" }}>
                <span className="coin">P</span>
                {me?.credits ?? 0} <small>{t.credits}</small>
              </span>
            </div>
            <div className="table-wrap">
              <table className="ledger">
                <thead>
                  <tr><th>{t.ordersTable.time}</th><th>{t.ordersTable.item}</th><th>{t.ordersTable.amount}</th><th>{t.ordersTable.creditsCol}</th><th>{t.ordersTable.status}</th><th>{t.ordersTable.provider}</th></tr>
                </thead>
                <tbody>
                  {orders.length === 0 && (
                    <tr><td colSpan={6} style={{ textAlign: "center", color: "var(--ink-3)" }}>{t.noOrders}</td></tr>
                  )}
                  {orders.map((o) => (
                    <tr key={o.id}>
                      <td>{new Date(o.createdAt).toLocaleString()}</td>
                      <td>{o.kind === "plan" ? `${o.planId ?? "plan"} ${locale === "zh" ? "套餐" : "plan"}` : `${o.credits} ${t.credits} ${locale === "zh" ? "包" : "pack"}`}</td>
                      <td>${o.amountUsd.toFixed(2)}</td>
                      <td>+{o.credits}</td>
                      <td>
                        <span className={`status status-${o.status}`}>
                          {t.orderStatus[o.status] ?? o.status}
                        </span>
                      </td>
                      <td>{o.provider}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        {/* === PRICING TAB === */}
        {tab === "pricing" && (
          <>
            <div className="page-head">
              <div>
                <h1>{t.pageHead.pricing.title}</h1>
                <p>{t.pageHead.pricing.desc}</p>
              </div>
              <button className="btn btn-ghost" onClick={() => setTab("create")}>{t.backToWorkbench}</button>
            </div>
            <div className="card" style={{ padding: 18, marginBottom: 18, display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
              <span className="coin" style={{ width: 34, height: 34, fontSize: 15 }}>P</span>
              <div>
                <div style={{ fontWeight: 800, fontSize: 18 }}>{me?.credits ?? 0} {t.credits}</div>
                <div style={{ fontSize: 12.5, color: "var(--ink-2)" }}>{me?.plan ?? "free"} {locale === "zh" ? "套餐 · " : "plan · "}{t.dailyCheckin}</div>
              </div>
              <span style={{ marginLeft: "auto", fontSize: 12.5, color: "var(--ink-3)" }}>{locale === "zh" ? "Beta 壳子 · 不产生真实扣款" : "Beta shell · no real charge"}</span>
            </div>
            <div className="pricing-grid">
              {PLANS.map((p) => (
                <div key={p.id} className={`card plan-card${p.featured ? " featured" : ""}`}>
                  <h3>{p.name}</h3>
                  <div className="price">${p.price}<small> / month</small></div>
                  <div style={{ fontSize: 12.5, color: "var(--ink-2)" }}>{p.credits} {t.credits}</div>
                  <ul>{p.features.map((f) => <li key={f}>{f}</li>)}</ul>
                  <button className={p.featured ? "btn btn-dark" : "btn btn-ghost"} onClick={() => openCheckout("plan", p.id)}>
                    {p.id === me?.plan ? t.currentPlan : p.price === 0 ? t.free : t.choose}
                  </button>
                </div>
              ))}
            </div>
            <div className="field-label" style={{ marginBottom: 10 }}>{t.topupPacks} · {t.validMonths}</div>
            <div className="pack-row">
              {PACKS.map((p) => (
                <button key={p.id} className="pack" onClick={() => openCheckout("pack", p.id)}>
                  <span className="price">${p.price}</span>
                  <span className="credits">{p.credits} {t.credits}</span>
                  {p.bonus && <span className="bonus">{p.bonus} bonus</span>}
                </button>
              ))}
            </div>
          </>
        )}
      </main>

      {checkout && (
        <div className="overlay" onClick={() => setCheckout(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h2>{t.checkoutTitle}</h2>
              <button className="icon-btn" onClick={() => setCheckout(null)}>✕</button>
            </div>
            <div className="modal-body">
              <div className="order-row"><span className="lbl">{t.item}</span><span className="val">{checkout.name}</span></div>
              <div className="order-row"><span className="lbl">{t.creditsLabel}</span><span className="val">{checkout.credits}</span></div>
              <div className="order-row order-total"><span className="lbl">{t.totalLabel}</span><span className="val">${checkout.price.toFixed(2)}</span></div>
              <div>
                <div className="field-label" style={{ marginBottom: 8 }}>{t.paymentMethod}</div>
                <div className="pay-methods">
                  {["Card", "PayPal", "Alipay", "WeChat Pay"].map((m) => (
                    <button key={m} className={`pay-chip${method === m ? " on" : ""}`} onClick={() => setMethod(m)}>{m}</button>
                  ))}
                </div>
              </div>
              <div className="beta-note">
                <b>{t.betaNote}</b>
              </div>
              <button className="btn btn-dark" style={{ width: "100%" }} onClick={confirmCheckout}>
                ✓ {t.confirm} {method} · ${checkout.price.toFixed(2)}
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
