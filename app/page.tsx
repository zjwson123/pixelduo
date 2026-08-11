import type { Metadata } from "next";
import Landing from "@/components/landing";

export const metadata: Metadata = {
  title: "PixelDuo — Two models. One prompt. Your call.",
  description:
    "Compare GPT Image 2 and Seedream 5 side by side, see the exact cost before you generate, and keep full ownership of your AI images.",
};

export default function LandingPage() {
  return <Landing />;
}
