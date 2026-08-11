import { recoverStuckJobs } from "../lib/queue";

async function main() {
  const n = await recoverStuckJobs();
  console.log(`[recover] recovered ${n} stuck job(s)`);
}

main().catch((e) => {
  console.error("[recover] failed:", e);
  process.exit(1);
});
