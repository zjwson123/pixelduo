import { clampPage, ok, fail } from "@/lib/api";
import { requireAdmin } from "@/lib/admin";
import { prisma } from "@/lib/prisma";
import { mailDeliverable } from "@/lib/mail";

const PAGE_SIZE = 50;

// Operator inbox for POST /api/feedback. Newest first, optionally filtered to
// the unhandled ones; the counts let the console badge the tab without a second
// request. `mailDeliverable` says whether notifications actually leave the box
// (without SMTP_URL the app prints them to its log) — an operator who believes
// mail is being sent and never checks this tab would miss every message.
export async function GET(req: Request) {
  try {
    await requireAdmin();
    const params = new URL(req.url).searchParams;
    const status = params.get("status") === "all" ? null : "new";
    const page = clampPage(params.get("page"));
    const [rows, total, unhandled] = await Promise.all([
      prisma.feedback.findMany({
        where: status ? { status } : {},
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
        select: {
          id: true,
          userId: true,
          email: true,
          category: true,
          message: true,
          status: true,
          page: true,
          locale: true,
          plan: true,
          userAgent: true,
          createdAt: true,
          handledAt: true,
        },
      }),
      prisma.feedback.count({ where: status ? { status } : {} }),
      prisma.feedback.count({ where: { status: "new" } }),
    ]);
    return ok({ feedback: rows, total, unhandled, page, pageSize: PAGE_SIZE, mailDeliverable: mailDeliverable() });
  } catch (e) {
    return fail(e);
  }
}
