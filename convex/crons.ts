import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Recalculate replenishment needs for every product/store every hour.
crons.interval("reorder recalculation", { hours: 1 }, internal.reorder.recalculateAll, {});

export default crons;
