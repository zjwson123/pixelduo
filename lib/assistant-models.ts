// Client-safe assistant model catalog (no Node imports — bundled into the
// workbench). Available assistant LLMs, probed 2026-08-22 with live keys:
// glm-5.2 (DashScope), kimi-k2.6 (modelverse) and deepseek-v4-flash
// (official DeepSeek API) all respond. qwen3.8-max was dropped: the
// DashScope key gets 403 "Access denied by API-Key restrictions" on qwen*.
export interface AssistantModelOption {
  id: string;
  label: string;
}

export const ASSISTANT_MODELS: AssistantModelOption[] = [
  { id: "deepseek", label: "DeepSeek V4 Flash" },
  { id: "glm", label: "GLM 5.2 (thinking)" },
  { id: "kimi", label: "Kimi K2.6" },
];
