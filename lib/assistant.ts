import { getDeepSeekKey, getDeepSeekBaseUrl } from "./keys";
import { readJsonCapped, outboundTimeoutMs } from "./store";
import { sliceCodePoints } from "./untrusted-text";

export interface AssistantResult {
  text: string;
  offline: boolean;
  model?: string;
}

const SYSTEM =
  "You are a world-class prompt engineer for AI image models. Turn a user's rough idea into a detailed, production-ready English image prompt. Include subject, composition, lighting, style, mood, and camera/lens details where helpful. Keep it under 120 words. Return only the prompt text.";

const MODE_INSTRUCTIONS: Record<string, string> = {
  expand: "Expand and enrich the following rough idea into a detailed English image prompt:",
  translate: "If the text is Chinese, translate it into a polished English image prompt. If it is already English, make it more vivid and specific:",
  style: "Rewrite the following prompt with a strong, named art direction (photography style, lighting, palette, mood):",
  inspire: "Read the idea below and produce 5 distinct creative directions, each as a one-line image prompt:",
};

const STYLE_HINTS = [
  "soft studio lighting, high detail, shallow depth of field",
  "editorial, magazine quality, natural light",
  "cyberpunk, neon accents, dramatic composition",
  "minimal, warm neutral palette, centered composition",
];

export async function improvePrompt(prompt: string, mode: string): Promise<AssistantResult> {
  // Single backend model (official DeepSeek "deepseek-flash", the id for
  // v4.1-flash per the /models list probed 2026-09-19). The model is
  // deliberately not surfaced to users — the assistant is just "AI 润色".
  const apiKey = getDeepSeekKey();
  if (!apiKey) return { text: offlineExpand(prompt, mode), offline: true };
  const apiUrl = `${getDeepSeekBaseUrl()}/chat/completions`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), outboundTimeoutMs(30_000));
    let res: Response;
    try {
      res = await fetch(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: "deepseek-flash",
          messages: [
            { role: "system", content: SYSTEM },
            { role: "user", content: `${MODE_INSTRUCTIONS[mode] ?? MODE_INSTRUCTIONS.expand}\n\n${prompt}` },
          ],
          max_tokens: 320,
          temperature: 0.8,
          // Flash is a non-thinking-by-default model; keep it explicit so a
          // default change upstream cannot silently 3x the latency.
          thinking: { type: "disabled" },
        }),
        signal: controller.signal,
        // No redirects — see callWithKeys in providers/index.ts.
        redirect: "manual",
      });
      // Body read inside the armed-timer window — see callWithKeys in
      // providers/index.ts for why clearing it after the headers is not enough.
      if (res.ok) {
        const data = (await readJsonCapped(res, 8 * 1024 * 1024)) as unknown as { choices?: Array<{ message?: { content?: string } }> };
        const text = data.choices?.[0]?.message?.content?.trim();
        // Bound what a gateway can hand back: max_tokens is a request, not a
        // guarantee, and the response body is read up to 8 MB. A real reply is
        // a prompt expansion (a few hundred tokens), so this is generous. The
        // bound never splits a surrogate pair (pass 32): the workbench copies
        // this text into the next prompt verbatim, and an ill-formed tail made
        // /api/generate answer malformed-text for a string the app produced.
        if (text) return { text: sliceCodePoints(text, 4000), offline: false };
      } else {
        // Cancel the unread body — see lib/router.ts for why.
        await res.body?.cancel().catch(() => undefined);
      }
    } finally {
      clearTimeout(timer);
    }
  } catch {
    // fall through
  }
  return { text: offlineExpand(prompt, mode), offline: true };
}

function offlineExpand(prompt: string, mode: string): string {
  const p = prompt.trim() || "a ceramic coffee mug";
  if (mode === "translate") {
    const isCJK = /[\u4e00-\u9fff]/.test(p);
    return isCJK
      ? `English prompt: Professional ${p} in ${STYLE_HINTS[0]}, centered composition.`
      : `中文版：专业 ${p} 摄影，${STYLE_HINTS[3].replace(", centered composition", "")}，居中构图。`;
  }
  if (mode === "style") return `${p} in ${STYLE_HINTS[2]} style.`;
  if (mode === "inspire") {
    return `1. ${p} — editorial portrait style\n2. ${p} — product hero, studio lighting\n3. ${p} — typographic poster\n4. ${p} — 3D icon render\n5. ${p} — cinematic wide shot`;
  }
  return `Professional ${p}, ${STYLE_HINTS[0]}, centered composition, warm neutral palette.`;
}
