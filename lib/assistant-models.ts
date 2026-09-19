// Client-safe assistant model catalog (no Node imports — bundled into the
// workbench). Available assistant LLMs, probed live: glm-5.2 (DashScope),
// kimi-k2.6 (modelverse) and deepseek-flash (official DeepSeek API — the
// /models list as of 2026-09-19 exposes deepseek-flash + deepseek-v4-pro;
// the earlier "deepseek-v4-flash" id was delisted). qwen3.8-max was dropped:
// the DashScope key gets 403 "Access denied by API-Key restrictions" on qwen*.
export interface AssistantModelOption {
  id: string;
  label: string;
}

export const ASSISTANT_MODELS: AssistantModelOption[] = [
  { id: "deepseek", label: "DeepSeek Flash" },
  { id: "glm", label: "GLM 5.2 (thinking)" },
  { id: "kimi", label: "Kimi K2.6" },
];
