// One-command check for the webhook notification channel — the symmetric twin of
// scripts/verify-mail.ts, and the channel that needs no provider account at all.
//
//   FEEDBACK_WEBHOOK_URL="https://open.feishu.cn/open-apis/bot/v2/hook/xxx" \
//   npx tsx scripts/verify-webhook.ts [--print]
//
// Posts the real notification payload to the configured group bot and reports
// what the endpoint answered (Feishu/WeCom/DingTalk put their refusal reason in
// the body, sometimes with HTTP 200, so the body is part of the verdict).
// Exit code 0 only on success, so it works as a deploy gate. `--print` shows the
// exact JSON without sending anything.
import { buildWebhookBody, buildWebhookText, postWebhook, webhookKind, webhookUrl } from "../lib/notify";
import { maskSecretUrl } from "../lib/mail-check";

// The message an operator sees in the group; deliberately the same shape as a
// real notification (including the reference line) so nothing about the format
// is discovered only in production.
const sample = buildWebhookText({
  ref: "verify-webhook-0000abcd",
  category: "other",
  message: "Pre-flight check from scripts/verify-webhook.ts — no action needed. If you can read this, the feedback channel reaches this group.",
  email: "verify-webhook@pixelduo.ai",
  userId: null,
  plan: null,
  page: "/scripts/verify-webhook",
  locale: "en",
});

function hint(body: string | undefined, error: string | undefined): string | null {
  const text = `${body ?? ""} ${error ?? ""}`;
  if (/19021|sign|signature/i.test(text)) {
    return "The bot has signature verification enabled — either disable it or add the secret to the bot config; a plain webhook URL cannot sign.";
  }
  if (/310000|keyword|关键词/i.test(text)) {
    return "The group requires a keyword in every message. Regenerate the bot without the keyword requirement, or set FEEDBACK_WEBHOOK_KIND appropriately for your provider.";
  }
  if (/93000|invalid webhook|invalid key|token/i.test(text)) {
    return "The webhook URL/token is wrong or the bot was deleted — copy it again from the group's robot settings.";
  }
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|fetch failed/i.test(text)) {
    return "Could not reach the webhook host — check the URL and outbound network access from the deployment.";
  }
  return null;
}

async function main() {
  const url = webhookUrl();
  // Masked: for Feishu/DingTalk/WeCom this URL is the bearer secret itself, and
  // this script's output is exactly what the deploy docs tell the operator to
  // relay. `--print` below is the deliberate way to see the payload, not the URL.
  console.log(`webhook:  ${url ? maskSecretUrl(url) : "(none — FEEDBACK_WEBHOOK_URL is unset)"}`);
  console.log(`kind:     ${webhookKind()}`);

  if (process.argv.includes("--print")) {
    console.log("\npayload that would be sent:");
    console.log(JSON.stringify(buildWebhookBody(webhookKind(), sample), null, 2));
    console.log("\n(not sent — --print was given)");
    return;
  }

  if (!url) {
    console.error(
      "\n[FAIL] FEEDBACK_WEBHOOK_URL is not set, so nothing is pushed anywhere.\n" +
        "       Add a group robot to Feishu/WeCom/DingTalk, create a custom bot, and set\n" +
        '       FEEDBACK_WEBHOOK_URL="https://…" (plus FEEDBACK_WEBHOOK_KIND=feishu|wecom|dingtalk|raw).\n' +
        "       This channel needs no domain, no SPF and no password — it is the shortest path to a human.",
    );
    process.exit(1);
  }

  const result = await postWebhook(sample);
  if (result.ok) {
    console.log(`\nendpoint: ${result.status} ${result.body ?? ""}`.trimEnd());
    console.log("\n[OK] the group bot accepted the message — check the group chat. Feedback will now reach it.");
    process.exit(0);
  }

  console.error(`\n[FAIL] ${result.error ?? `endpoint answered ${result.status ?? "?"}${result.body ? `: ${result.body}` : ""}`}`);
  const h = hint(result.body, result.error);
  if (h) console.error(`       ${h}`);
  process.exit(1);
}

void main();
