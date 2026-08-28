"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { signOut } from "next-auth/react";
import Link from "next/link";
import { estimateGenerationCost, estimateModelCost, type Quality } from "@/lib/cost";
import { PLANS, PACKS } from "@/lib/catalog";
import { MODELS, getModel, getImageModels, getVideoModels } from "@/lib/model-registry";
import { ASSISTANT_MODELS } from "@/lib/assistant-models";

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
  sourceUrl?: string | null;
  tags?: { styles?: string[]; scenes?: string[]; category?: string } | null;
  featured?: boolean;
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
  mediaType?: "image" | "video"; // absent on very old payloads
  isEdit?: boolean; // image job created from the Edit tab
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

// Edit tab: enabled image models that accept a reference image
const EDIT_MODEL_OPTIONS: Array<{ value: string; label: string }> = IMAGE_MODELS
  .filter((m) => m.supportsImageInput)
  .map((m) => ({ value: m.id, label: m.displayName }));

const ASSISTANT_MODEL_OPTIONS: Array<{ value: string; label: string }> = ASSISTANT_MODELS.map(
  (m) => ({ value: m.id, label: m.label }),
);

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
      create: { title: "Create", desc: "Twin image engines — pick the best for your prompt. Cost shown before you commit." },
      edit: { title: "Edit", desc: "Upload a reference image and describe what to change." },
      video: { title: "Video", desc: "Text-to-video and image-to-video, powered by Seedance 2.0." },
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
    emptyEdit: "Upload an image to start editing", emptyEditDesc: "Supported: GPT Image 2 edits, Seedream reference.",
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
      create: { title: "创作", desc: "双图像引擎 — 为你的提示词选最佳模型，生成前透明计费。" },
      edit: { title: "编辑", desc: "上传参考图，描述要修改的内容。" },
      video: { title: "视频", desc: "文生视频和图生视频，由 Seedance 2.0 驱动。" },
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
    emptyEdit: "上传图片开始编辑", emptyEditDesc: "支持 GPT Image 2 编辑、Seedream 参考图。",
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
  // Full catalog (incl. disabled models) so historical records keep their labels
  const labels: Record<string, string> = Object.fromEntries(MODELS.map((m) => [m.id, m.displayName]));
  const cls = model === "gpt" || model.startsWith("wan") ? "gpt" : "seed";
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

  const [tab, setTabState] = useState<Tab>("create");
  // Keep the active tab in the URL hash so a page refresh (or shared link)
  // restores it instead of always landing on Create
  const setTab = (tb: Tab) => {
    setTabState(tb);
    history.replaceState(null, "", `#${tb}`);
  };
  useEffect(() => {
    const hash = window.location.hash.replace(/^#/, "");
    if (TABS.some((t) => t.id === hash)) setTabState(hash as Tab);
  }, []);
  const [me, setMe] = useState<Me | null>(null);
  const [prompt, setPrompt] = useState("a minimalist ceramic coffee mug on a warm beige background");
  const [model, setModel] = useState<string>("gpt");
  const [quality, setQuality] = useState<Quality>("medium");
  const [count, setCount] = useState(1);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [cat, setCat] = useState("全部");
  const [search, setSearch] = useState("");
  const [tmplPage, setTmplPage] = useState(1);
  const [tmplTotalPages, setTmplTotalPages] = useState(1);
  const [tmplTotal, setTmplTotal] = useState(0);
  const [showFeaturedOnly, setShowFeaturedOnly] = useState(false);
  const [gallery, setGallery] = useState<GalleryImage[]>([]);
  const [ledger, setLedger] = useState<LedgerRow[]>([]);
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [expiring, setExpiring] = useState<ExpiringCredit[]>([]);
  // All tracked jobs for this session (in-flight AND recently finished),
  // newest first. Submitting is never blocked by a running job — the queue
  // allows up to 5 concurrent jobs per user (server-enforced).
  const [jobs, setJobs] = useState<JobStatus[]>([]);
  const finishedNotifiedRef = useRef<Set<string>>(new Set());
  const [assistantOut, setAssistantOut] = useState("");
  const [assistantModel, setAssistantModel] = useState("deepseek");
  const [toast, setToast] = useState("");
  const [lightbox, setLightbox] = useState<string | null>(null);
  // Per-panel submitting guard — prevents double-click double-charge.
  // The server generates its own idempotency key when none is sent, so
  // two clicks create two distinct jobs and bill twice.
  const [submitting, setSubmitting] = useState<null | "create" | "edit" | "video">(null);
  const [checkout, setCheckout] = useState<null | { kind: "pack" | "plan"; itemId: string; name: string; price: number; credits: number }>(null);
  const [method, setMethod] = useState("Card");

  // Edit tab state
  const [editModel, setEditModel] = useState("gpt");
  const [editPrompt, setEditPrompt] = useState("add a red hat, keep the background unchanged");
  const [editImage, setEditImage] = useState<string | null>(null);
  const [editImageName, setEditImageName] = useState<string>("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Video tab state
  const [videoModel, setVideoModel] = useState(VIDEO_MODEL_OPTIONS[0]?.value ?? "seedance");
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

  // Refresh templates when Explore filters change (category / search / page / featured).
  // Search is debounced 300ms; stale responses are cancelled via AbortController
  // so fast typing doesn't overwrite newer results with older data.
  useEffect(() => {
    const params = new URLSearchParams({ pageSize: "30", page: String(tmplPage) });
    if (cat !== "全部") params.set("cat", cat);
    if (search.trim()) params.set("q", search.trim());
    if (showFeaturedOnly) params.set("featured", "1");
    const controller = new AbortController();
    const handle = setTimeout(() => {
      fetch(`/api/templates?${params}`, { signal: controller.signal })
        .then((res) => res.json())
        .then((d: { templates: Template[]; total: number; totalPages: number }) => {
          setTemplates(d.templates);
          setTmplTotal(d.total);
          setTmplTotalPages(d.totalPages);
        })
        .catch(() => undefined);
    }, 300);
    return () => {
      clearTimeout(handle);
      controller.abort();
    };
  }, [cat, search, tmplPage, showFeaturedOnly]);

  const friendlyError = (e: unknown) => {
    const msg = e instanceof Error ? e.message : "";
    if (msg === "verify-email-required") return "Verify your email first to start generating.";
    if (msg === "insufficient-credits") return "Insufficient credits — top up first";
    if (msg.startsWith("queue-full")) return "Too many jobs in flight (max 5) — wait for one to finish";
    if (msg === "Unauthorized" || msg.includes("401")) return "Session expired — please sign in again";
    if (msg.includes("Failed to fetch") || msg.includes("NetworkError")) return "Network error — please retry";
    return msg || "Something went wrong";
  };

  // Track a freshly submitted job (prepend, cap the session list)
  const trackJob = async (jobId: string) => {
    try {
      const poll = await api<{ job: JobStatus }>(`/api/jobs/${jobId}`);
      setJobs((prev) => [poll.job, ...prev.filter((p) => p.id !== poll.job.id)].slice(0, 8));
    } catch {
      // fetch failed — mount-resume will pick the job up on next navigation
    }
    refreshMe(); // balance already reflects the pre-auth hold
  };

  useEffect(() => {
    refreshMe();
    refreshGallery();
    refreshLedger();
    refreshOrders();
    api<{ expiring: ExpiringCredit[] }>("/api/credits/expiring")
      .then((d) => setExpiring(d.expiring))
      .catch(() => undefined);
    // Resume tracking in-flight jobs (navigation/refresh unmounts this
    // component and its state — the jobs themselves keep running server-side)
    api<{ jobs: JobStatus[] }>("/api/jobs")
      .then((d) => {
        if (d.jobs.length) {
          setJobs((prev) => [...d.jobs, ...prev.filter((p) => !d.jobs.some((r) => r.id === p.id))]);
        }
      })
      .catch(() => undefined);
  }, [refreshMe, refreshGallery, refreshLedger, refreshOrders]);

  useEffect(() => {
    if (!toast) return;
    const tm = setTimeout(() => setToast(""), 2600);
    return () => clearTimeout(tm);
  }, [toast]);

  // Esc closes the image lightbox
  useEffect(() => {
    if (!lightbox) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setLightbox(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lightbox]);

  // Poll every in-flight tracked job on a fixed interval. An interval (not a
  // state-chained timeout) guarantees polling continues even when a tick
  // observes no status change — long video tasks would otherwise stall the
  // chain. Submission stays open while jobs run.
  const jobsRef = useRef(jobs);
  useEffect(() => {
    jobsRef.current = jobs;
  }, [jobs]);
  useEffect(() => {
    const iv = setInterval(async () => {
      const pending = jobsRef.current.filter((j) => j.status === "queued" || j.status === "running" || j.status === "polling");
      if (!pending.length) return;
      const updates: Array<JobStatus | { id: string; gone: true } | null> = await Promise.all(
        pending.map((j) =>
          api<{ job: JobStatus }>(`/api/jobs/${j.id}`)
            .then((r) => r.job)
            .catch((e: unknown) => {
              const msg = e instanceof Error ? e.message : "";
              // Session expired — stop polling this job, let the user re-auth
              if (msg.includes("Unauthorized") || msg.includes("401")) return null;
              // Job vanished (e.g. admin cleanup) — stop tracking it
              if (msg.includes("job-not-found")) return ({ id: j.id, gone: true } as const);
              return null;
            }),
        ),
      );
      setJobs((prev) =>
        prev
          .filter((p) => {
            const u = updates.find((u) => u && u.id === p.id);
            return !(u && "gone" in u); // vanished (e.g. admin cleanup) — stop tracking
          })
          .map((p) => {
            const u = updates.find((u) => u && u.id === p.id);
            return u && !("gone" in u) && u.status !== p.status ? u : p;
          }),
      );
    }, 2500);
    return () => clearInterval(iv);
  }, []);

  // Terminal transitions: refresh balances/history once per job, surface failures.
  // Prune the notification set for jobs no longer tracked (done/failed slide off
  // the session list over time) so the Set doesn't grow without bound.
  useEffect(() => {
    const trackedIds = new Set(jobs.map((j) => j.id));
    for (const id of finishedNotifiedRef.current) {
      if (!trackedIds.has(id)) finishedNotifiedRef.current.delete(id);
    }
    for (const j of jobs) {
      if ((j.status === "done" || j.status === "failed") && !finishedNotifiedRef.current.has(j.id)) {
        finishedNotifiedRef.current.add(j.id);
        if (j.status === "failed") {
          const prompt = j.prompt.length > 40 ? `${j.prompt.slice(0, 40)}…` : j.prompt;
          setToast(`${prompt} — ${j.mediaType === "video" ? t.videoFailed : t.genFailed} (${t.charged} ${t.credits} refunded)`);
        }
        refreshMe();
        refreshGallery();
        refreshLedger();
        refreshOrders();
      }
    }
  }, [jobs, t, refreshMe, refreshGallery, refreshLedger, refreshOrders]);

  const generate = async () => {
    if (submitting) return;
    if (!prompt.trim()) return setToast(t.writePrompt);
    if (me && !me.emailVerified) return setToast(t.verifyFirst);
    if (me && me.credits < costCredits) return setToast(t.insufficient);
    setAssistantOut("");
    setSubmitting("create");
    try {
      const data = await api<{ jobId: string }>("/api/generate", {
        method: "POST",
        body: JSON.stringify({ prompt: prompt.trim(), model, quality, count, idempotencyKey: crypto.randomUUID() }),
      });
      await trackJob(data.jobId);
    } catch (e) {
      setToast(friendlyError(e));
    } finally {
      setSubmitting(null);
    }
  };

  const generateEdit = async () => {
    if (submitting) return;
    if (!editPrompt.trim()) return setToast(t.writePrompt);
    if (!editImage) return setToast(t.clickUpload);
    if (me && !me.emailVerified) return setToast(t.verifyFirst);
    const editCost = estimateModelCost(editModel, 1, quality);
    if (me && me.credits < editCost.credits) return setToast(t.insufficient);
    setSubmitting("edit");
    try {
      const data = await api<{ jobId: string }>("/api/edit", {
        method: "POST",
        body: JSON.stringify({
          prompt: editPrompt.trim(),
          model: editModel,
          quality,
          image: editImage,
          idempotencyKey: crypto.randomUUID(),
        }),
      });
      await trackJob(data.jobId);
    } catch (e) {
      setToast(friendlyError(e));
    } finally {
      setSubmitting(null);
    }
  };

  const generateVideo = async () => {
    if (submitting) return;
    if (!videoPrompt.trim()) return setToast(t.writePrompt);
    if (me && !me.emailVerified) return setToast(t.verifyFirst);
    // Pure i2v models need a first frame; seedance-style models take one optionally
    if (getModel(videoModel)?.requiresImageInput && !videoImage) return setToast(t.clickUpload);
    const vCost = estimateModelCost(videoModel, 1, "standard", videoDuration);
    if (me && me.credits < vCost.credits) return setToast(t.insufficient);
    setSubmitting("video");
    try {
      const data = await api<{ jobId: string }>("/api/video", {
        method: "POST",
        body: JSON.stringify({
          prompt: videoPrompt.trim(),
          model: videoModel,
          duration: videoDuration,
          idempotencyKey: crypto.randomUUID(),
          ...(videoImage ? { image: videoImage } : {}),
        }),
      });
      await trackJob(data.jobId);
      setToast("Video generation started — this may take 1-3 minutes");
    } catch (e) {
      setToast(friendlyError(e));
    } finally {
      setSubmitting(null);
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

  const isVideoModel = (model: string) => getModel(model)?.mediaType === "video" || model === "seedance" || model === "wan-t2v" || model === "wan-i2v";

  // Render a media element (image or video) for a gallery/recent item
  const renderMedia = (url: string, model: string, prompt: string, onZoom?: () => void) => {
    if (isVideoModel(model)) {
      return <video src={url} controls style={{ width: "100%", borderRadius: 8 }} />;
    }
    return (
      <img
        src={url}
        alt={prompt}
        style={{ cursor: "zoom-in" }}
        onClick={onZoom ?? (() => setLightbox(url))}
      />
    );
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

  // Explore categories — stable list so the filter bar renders even before
  // the first fetch returns (the API filters server-side now)
  const EXPLORE_CATS = ["全部", "UI 与界面", "图表信息图", "海报排版", "商品电商", "品牌标志", "建筑空间", "摄影写实", "插画艺术", "人物角色", "场景叙事", "历史古风", "文档出版", "其他应用"];

  // Session job list, split per workbench panel (create / edit / video)
  const isTerminal = (j: JobStatus) => j.status === "done" || j.status === "failed";
  const jobPanel = (j: JobStatus): "create" | "edit" | "video" => {
    if (j.mediaType === "video") return "video";
    return j.isEdit ? "edit" : "create";
  };
  const panelJobs = (panel: "create" | "edit" | "video") => jobs.filter((j) => jobPanel(j) === panel);
  const inFlightLabel = (j: JobStatus) =>
    j.mediaType === "video" && j.status === "polling" ? t.videoPolling : t.generating;

  const renderInFlight = (j: JobStatus) => (
    <div key={j.id} className="gen-steps" style={{ marginBottom: 14 }}>
      <div className="gen-step active"><span className="dot"></span>{inFlightLabel(j)}</div>
      <div className="gen-step"><span className="dot"></span>{t.charged} {j.costCredits} {t.credits} — refunded on failure</div>
      <div style={{ fontSize: 12, color: "var(--ink-3)" }}>
        <ModelPill model={j.model} /> {j.prompt.slice(0, 90)}{j.prompt.length > 90 ? "…" : ""}
      </div>
    </div>
  );

  const renderFailed = (j: JobStatus) => (
    <div key={j.id} className="empty" style={{ marginBottom: 14 }}>
      <span className="serif">{j.mediaType === "video" ? t.videoFailed : t.genFailed}</span>
      <span>{j.prompt.slice(0, 90)} — {j.error ?? "Unknown error"} · {t.charged} {j.costCredits} {t.credits} refunded.</span>
    </div>
  );

  const renderResultCard = (j: JobStatus, src: string, i: number) => (
    <div key={`${j.id}-${i}`} className="result-card" style={j.mediaType === "video" ? { gridColumn: "1 / -1" } : undefined}>
      {j.mediaType === "video" ? (
        <video src={src} controls style={{ width: "100%", borderRadius: 8 }} />
      ) : (
        <img src={src} alt={j.prompt} style={{ cursor: "zoom-in" }} onClick={() => setLightbox(src)} />
      )}
      {me?.plan === "free" && <div className="wm-badge">PixelDuo · AI 生成</div>}
      <div className="result-actions">
        <a className="result-btn" href={`${src}?download=1`} download aria-label={t.download} title={t.download}>↓</a>
      </div>
      <div className="result-meta">
        <ModelPill model={j.model} />
      </div>
    </div>
  );

  const renderFinished = (j: JobStatus) =>
    j.status === "failed" ? (
      renderFailed(j)
    ) : (
      <div key={j.id} style={{ marginBottom: 18 }}>
        <div className="results-head">
          <h2>{jobPanel(j) === "video" ? t.videoResult : jobPanel(j) === "edit" ? t.editResult : t.latestResults}</h2>
          <span className="count">
            {j.images.length} {j.mediaType === "video" ? t.videos : t.imagesVideo} · {j.costCredits} {t.credits}
          </span>
        </div>
        <div className="results-grid">
          {j.images.map((src, i) => renderResultCard(j, src, i))}
        </div>
      </div>
    );

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
                  {IMAGE_MODELS.find((m) => m.id === model) && (
                    <div style={{ marginTop: 6, fontSize: 12, color: "var(--ink-3)" }}>
                      {IMAGE_MODELS.find((m) => m.id === model)?.description ?? ""}
                    </div>
                  )}
                </div>

                {IMAGE_MODELS.find((m) => m.id === model)?.supportsQuality && (
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

                <button className="generate" disabled={submitting === "create"} onClick={generate}>
                  {submitting === "create" ? t.generating : t.generate}
                </button>
              </div>

              <div className="card results">
                {(() => {
                  const tracked = panelJobs("create");
                  if (tracked.length) {
                    return (
                      <>
                        {tracked.filter((j) => !isTerminal(j)).map(renderInFlight)}
                        {tracked.filter(isTerminal).map(renderFinished)}
                      </>
                    );
                  }
                  if (gallery.length === 0) {
                    return (
                      <div className="empty">
                        <span className="serif">{t.emptyCreate}</span>
                        <span>{t.emptyCreateDesc}</span>
                      </div>
                    );
                  }
                  return (
                    <>
                      <div className="results-head">
                        <h2>{t.recentImages}</h2>
                        <span className="count">{gallery.length} {t.total}</span>
                      </div>
                      <div className="results-grid">
                        {gallery.slice(0, 8).map((g) => (
                          <div key={g.id} className="result-card">
                            {renderMedia(g.url, g.model, g.prompt)}
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
                  );
                })()}
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

                {IMAGE_MODELS.find((m) => m.id === editModel)?.supportsQuality && (
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

                <button className="generate" disabled={!editImage || submitting === "edit"} onClick={generateEdit}>
                  {submitting === "edit" ? t.generating : t.editImage}
                </button>
              </div>

              <div className="card results">
                {(() => {
                  const tracked = panelJobs("edit");
                  if (tracked.length) {
                    return (
                      <>
                        {tracked.filter((j) => !isTerminal(j)).map(renderInFlight)}
                        {tracked.filter(isTerminal).map(renderFinished)}
                      </>
                    );
                  }
                  return (
                    <div className="empty">
                      <span className="serif">{t.emptyEdit}</span>
                      <span>{t.emptyEditDesc}</span>
                    </div>
                  );
                })()}
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
                      <button key={m.value} className={`chip${videoModel === m.value ? " on" : ""}`} onClick={() => {
                        setVideoModel(m.value);
                        // Clamp duration to the new model's valid range
                        const r = getModel(m.value)?.durationSecRange;
                        if (r) setVideoDuration((d) => Math.max(r.min, Math.min(r.max, d)));
                        // Clear uploaded reference image if the new model doesn't use one
                        if (!getModel(m.value)?.supportsImageInput) setVideoImage(null);
                      }}>
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
                    <Seg
                      options={
                        // Only offer durations the selected model accepts
                        // (Seedance 2.0: 4-15s — a 3s request is provider-rejected)
                        DURATION_OPTIONS
                          .filter((d) => {
                            const r = getModel(videoModel)?.durationSecRange;
                            return !r || (d >= r.min && d <= r.max);
                          })
                          .map((d) => ({ value: d, label: `${d}${t.sec}` }))
                      }
                      value={videoDuration}
                      onChange={setVideoDuration}
                    />
                  </div>
                </div>

                {VIDEO_MODELS.find((m) => m.id === videoModel)?.supportsImageInput && (
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

                <button className="generate" disabled={submitting === "video"} onClick={generateVideo}>
                  {submitting === "video" ? t.genVideoing : t.genVideo}
                </button>
              </div>

              <div className="card results">
                {(() => {
                  const tracked = panelJobs("video");
                  if (tracked.length) {
                    return (
                      <>
                        {tracked.filter((j) => !isTerminal(j)).map(renderInFlight)}
                        {tracked.filter(isTerminal).map(renderFinished)}
                      </>
                    );
                  }
                  return (
                    <div className="empty">
                      <span className="serif">{t.emptyVideo}</span>
                      <span>{t.emptyVideoDesc}</span>
                    </div>
                  );
                })()}
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
              <span className="chip" style={{ cursor: "default" }}>{tmplTotal} {locale === "zh" ? "个案例" : "cases"}</span>
            </div>
            <div style={{ display: "flex", gap: 10, marginBottom: 14, flexWrap: "wrap", alignItems: "center" }}>
              <input
                type="search"
                placeholder={locale === "zh" ? "搜索标题或提示词…" : "Search title or prompt…"}
                value={search}
                onChange={(e) => { setSearch(e.target.value); setTmplPage(1); }}
                style={{ flex: 1, minWidth: 200, padding: "8px 12px", borderRadius: 8, border: "1px solid var(--ink-4)", fontSize: 13.5 }}
              />
              <button
                className={`chip${showFeaturedOnly ? " on" : ""}`}
                onClick={() => { setShowFeaturedOnly((v) => !v); setTmplPage(1); }}
              >
                ★ {locale === "zh" ? "精选" : "Featured"}
              </button>
            </div>
            <div className="cat-row">
              {EXPLORE_CATS.map((c) => (
                <button
                  key={c}
                  className={`chip${cat === c ? " on" : ""}`}
                  onClick={() => { setCat(c); setTmplPage(1); }}
                >
                  {c}
                </button>
              ))}
            </div>
            <div className="tmpl-grid">
              {templates.map((tm) => (
                <div key={tm.id} className="card tmpl-card" onClick={() => pickTemplate(tm)}>
                  <img
                    src={tm.img}
                    alt={tm.title}
                    style={{ cursor: "zoom-in" }}
                    onClick={(e) => { e.stopPropagation(); setLightbox(tm.img); }}
                  />
                  {tm.featured && <div className="feat-badge">★</div>}
                  <div className="tmpl-body">
                    <h3>{tm.title}</h3>
                    <p>{tm.prompt}</p>
                    <div className="tmpl-foot">
                      <ModelPill model={tm.model} />
                      <span>{tm.credits} {t.credits}</span>
                      {tm.sourceUrl && (
                        <a
                          href={tm.sourceUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          style={{ fontSize: 11, color: "var(--ink-3)" }}
                        >
                          ↗ {locale === "zh" ? "来源" : "source"}
                        </a>
                      )}
                      <span className="spacer"></span>
                      <span style={{ color: "var(--indigo)", fontWeight: 700 }}>Use →</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
            {tmplTotalPages > 1 && (
              <div style={{ display: "flex", justifyContent: "center", gap: 8, marginTop: 18, alignItems: "center" }}>
                <button
                  className="btn btn-ghost btn-sm"
                  disabled={tmplPage <= 1}
                  onClick={() => setTmplPage((p) => Math.max(1, p - 1))}
                >
                  ←
                </button>
                <span style={{ fontSize: 13, color: "var(--ink-2)" }}>
                  {tmplPage} / {tmplTotalPages}
                </span>
                <button
                  className="btn btn-ghost btn-sm"
                  disabled={tmplPage >= tmplTotalPages}
                  onClick={() => setTmplPage((p) => Math.min(tmplTotalPages, p + 1))}
                >
                  →
                </button>
              </div>
            )}
            <div style={{ textAlign: "center", fontSize: 11.5, color: "var(--ink-3)", marginTop: 18 }}>
              {locale === "zh"
                ? "案例来源：awesome-gpt-image-2 (MIT License) · 529+ 工业级 GPT-Image-2 提示词案例"
                : "Cases from awesome-gpt-image-2 (MIT License) · 529+ industrial-grade GPT-Image-2 prompt cases"}
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
                    {renderMedia(g.url, g.model, g.prompt)}
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

      {lightbox && (
        <div className="lightbox" onClick={() => setLightbox(null)}>
          <button className="lightbox-close" aria-label="Close preview" onClick={(e) => { e.stopPropagation(); setLightbox(null); }}>✕</button>
          <img src={lightbox} alt="preview" onClick={(e) => e.stopPropagation()} />
          <a
            className="result-btn lightbox-dl"
            href={`${lightbox}?download=1`}
            download
            onClick={(e) => e.stopPropagation()}
          >
            ↓ Download
          </a>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
