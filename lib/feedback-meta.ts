// Shared by the feedback form (client), its route (server) and the admin inbox
// table. Deliberately dependency-free: the form is a client component, so this
// must not import prisma/mail or anything server-only.
export type FeedbackCategory = "idea" | "bug" | "billing" | "other";

export const FEEDBACK_CATEGORIES: Array<{ id: FeedbackCategory; en: string; zh: string }> = [
  { id: "idea", en: "Feature idea", zh: "功能建议" },
  { id: "bug", en: "Something's broken", zh: "遇到问题" },
  { id: "billing", en: "Billing & credits", zh: "计费与积分" },
  { id: "other", en: "Something else", zh: "其他" },
];

export const FEEDBACK_CATEGORY_IDS = FEEDBACK_CATEGORIES.map((c) => c.id) as [
  FeedbackCategory,
  ...FeedbackCategory[],
];

export const FEEDBACK_MESSAGE_MIN = 10;
export const FEEDBACK_MESSAGE_MAX = 2000;

export function isFeedbackCategory(value: unknown): value is FeedbackCategory {
  return typeof value === "string" && FEEDBACK_CATEGORY_IDS.includes(value as FeedbackCategory);
}

export function feedbackCategoryLabel(id: string, locale: "en" | "zh"): string {
  const found = FEEDBACK_CATEGORIES.find((c) => c.id === id);
  return found ? found[locale] : id;
}
