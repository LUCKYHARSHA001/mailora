/**
 * jobCron.service.js
 * -------------------
 * Cron job that runs every 24 hours:
 *   1. Delete ALL existing job records  (jobs.deleteMany)
 *   2. Fire 7 parallel SerpAPI calls    (Promise.allSettled)
 *   3. Bulk-insert the results into MongoDB
 */

const cron = require("node-cron");
const Job = require("../models/job.model");
const { fetchJobsForRole, ROLE_QUERIES } = require("./serpapi.service");

/**
 * Core refresh logic (exported so it can also be triggered manually via API).
 */
async function refreshJobs() {
  const start = Date.now();
  console.log("[CRON] ⏳  Job refresh started …");

  /* ── Step 1: Fan-out 7 parallel SerpAPI calls ────────────── */
  const roles = Object.keys(ROLE_QUERIES);

  const settled = await Promise.allSettled(
    roles.map((role) => fetchJobsForRole(role))
  );

  /* ── Step 2: Collect results ─────────────────────────────── */
  const allJobs = [];

  settled.forEach((result, idx) => {
    if (result.status === "fulfilled") {
      console.log(
        `[CRON] ✅  ${roles[idx]} → ${result.value.length} job(s)`
      );
      allJobs.push(...result.value);
    } else {
      console.error(
        `[CRON] ❌  ${roles[idx]} failed:`,
        result.reason?.message
      );
    }
  });

  /* ── Step 3: Atomic replace: only wipe old records if new ones were fetched ── */
  if (allJobs.length > 0) {
    const { deletedCount } = await Job.deleteMany({});
    console.log(`[CRON] 🗑️  Replaced ${deletedCount} old job(s) with ${allJobs.length} new ones`);
    await Job.insertMany(allJobs, { ordered: false });
  } else {
    console.warn("[CRON] ⚠️  No jobs retrieved from SerpAPI. Existing jobs were preserved.");
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(
    `[CRON] 🎉  Refresh complete – ${allJobs.length} jobs stored in ${elapsed}s`
  );

  return { inserted: allJobs.length, elapsed };
}

/**
 * Schedule the cron:  "0 0 * * *"  = midnight every day (server tz).
 * Only fires immediately at boot if SERPAPI_KEY is configured.
 */
function startJobCron() {
  // Only run immediate boot refresh if SERPAPI_KEY is configured
  if (process.env.SERPAPI_KEY) {
    refreshJobs().catch((err) =>
      console.error("[CRON] Boot refresh failed:", err.message)
    );
  } else {
    console.log("[CRON] ⚠️  SERPAPI_KEY is not configured — skipping boot refresh.");
  }

  // Then every 24 h
  cron.schedule("0 0 * * *", () => {
    if (process.env.SERPAPI_KEY) {
      refreshJobs().catch((err) =>
        console.error("[CRON] Scheduled refresh failed:", err.message)
      );
    }
  });

  console.log("[CRON] 🕛  Job cron scheduled (every 24 h)");
}

module.exports = { startJobCron, refreshJobs };
