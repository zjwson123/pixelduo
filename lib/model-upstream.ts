// Which upstream gateway serves each app model, and under which real model id.
//
// Split out of lib/model-registry.ts on purpose: that module is imported by a
// 'use client' component (components/workbench.tsx), so everything in it is
// serialized into the browser bundle. The registry's user-facing fields belong
// there; these do not — they name the reseller in front of "GPT Image 2" and the
// exact upstream version of every model, which is supplier information no
// client-side code can use and no user needs. (The upstream per-unit prices that
// used to sit in the registry's `description` strings went for the same reason:
// they describe our cost, not the customer's price.)
//
// Anything importing this must be server-only. It is data, not secrets — a
// leaked copy costs nothing but a supplier list — so a mistake here is a P4, not
// a breach; the split exists to make the internal view the default-off one.
import type { Gateway } from "./model-registry";

export interface UpstreamInfo {
  gateway: Gateway;
  modelId: string;
}

// Keyed by the app's model id. Disabled models stay listed: settlement and
// gallery labels resolve them, and a re-enable is then a one-line change.
export const UPSTREAM: Record<string, UpstreamInfo> = {
  gpt: { gateway: "modelverse", modelId: "gpt-image-2" },
  seedream: { gateway: "ark", modelId: "doubao-seedream-5-0-260128" },
  "wan-image": { gateway: "aliyun", modelId: "wan2.7-image" },
  "wan-image-pro": { gateway: "aliyun", modelId: "wan2.7-image-pro" },
  seedance: { gateway: "ark", modelId: "doubao-seedance-2-0-260128" },
  "seedance-2.5": { gateway: "ark", modelId: "doubao-seedance-2-5-260628" },
  "wan-t2v": { gateway: "aliyun", modelId: "wan2.7-t2v-2026-06-12" },
  "wan-i2v": { gateway: "aliyun", modelId: "wan2.7-i2v-2026-04-25" },
};

export function upstreamFor(appModelId: string): UpstreamInfo | undefined {
  return UPSTREAM[appModelId];
}
