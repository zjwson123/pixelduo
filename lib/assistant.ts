import { getDeepSeekKey } from "./keys";

export interface AssistantResult {
  text: string;
  offline: boolean;
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
  const key = getDeepSeekKey();
  if (key) {
    try {
      // Timeout after 30s so a slow/hanging API cannot stall the request.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30_000);
      let res: Response;
      try {
        res = await fetch("https://api.deepseek.com/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
          body: JSON.stringify({
            model: "deepseek-v4-flash",
            messages: [
              { role: "system", content: SYSTEM },
              { role: "user", content: `${MODE_INSTRUCTIONS[mode] ?? MODE_INSTRUCTIONS.expand}\n\n${prompt}` },
            ],
            max_tokens: 320,
            temperature: 0.8,
          }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      if (res.ok) {
        const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
        const text = data.choices?.[0]?.message?.content?.trim();
        if (text) return { text, offline: false };
      }
    } catch {
      // fall through to offline mode
    }
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
