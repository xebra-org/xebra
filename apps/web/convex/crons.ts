import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval("prune old rate windows", { minutes: 1 }, internal.rateLimit.pruneOld);

export default crons;
