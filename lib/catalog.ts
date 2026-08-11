export interface Plan {
  id: string;
  name: string;
  price: number;
  credits: number;
  features: string[];
  featured: boolean;
}

export interface Pack {
  id: string;
  price: number;
  credits: number;
  bonus: string;
}

export const PLANS: Plan[] = [
  { id: "free", name: "Free", price: 0, credits: 0, features: ["30 credits on signup", "2 credits daily check-in", "Watermarked previews"], featured: false },
  { id: "starter", name: "Starter", price: 9, credits: 800, features: ["≈ 100–130 images", "No platform watermark", "Priority queue"], featured: false },
  { id: "pro", name: "Pro", price: 19, credits: 2000, features: ["≈ 250–330 images", "30% quota rollover", "Batch generation"], featured: true },
  { id: "studio", name: "Studio", price: 39, credits: 5000, features: ["Team & privacy mode", "API trial quota", "Priority support"], featured: false },
];

export const PACKS: Pack[] = [
  { id: "p1", price: 4.99, credits: 400, bonus: "" },
  { id: "p2", price: 9.99, credits: 1050, bonus: "+5%" },
  { id: "p3", price: 19.99, credits: 2300, bonus: "+15%" },
  { id: "p4", price: 49.99, credits: 6000, bonus: "+20%" },
];

export function getPlan(id: string): Plan | undefined {
  return PLANS.find((p) => p.id === id);
}

export function getPack(id: string): Pack | undefined {
  return PACKS.find((p) => p.id === id);
}
