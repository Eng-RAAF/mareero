import { v, ConvexError } from "convex/values";
import { internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";

/**
 * Every table in this app (including sign-in tables). Used by the wipe below.
 * Internal only — callable from the CLI / dashboard, never from the browser:
 *
 *   npx convex run admin:wipeAllData '{"confirm":"DELETE EVERYTHING"}'
 *
 * Deletes in batches and reschedules itself until every table is empty.
 * Uploaded files in storage are deleted too.
 */
const TABLES = [
  "authAccounts",
  "authSessions",
  "authRefreshTokens",
  "authVerificationCodes",
  "authVerifiers",
  "authRateLimits",
  "users",
  "companies",
  "branches",
  "stores",
  "members",
  "categories",
  "brands",
  "products",
  "inventoryBalances",
  "stockMovements",
  "stockAdjustments",
  "stockTransfers",
  "suppliers",
  "customers",
  "purchaseRequests",
  "purchaseOrders",
  "goodsReceipts",
  "supplierBills",
  "salesDocs",
  "payments",
  "accounts",
  "journalEntries",
  "journalLines",
  "expenses",
  "taxRates",
  "fiscalPeriods",
  "bankReconciliations",
  "reorderSettings",
  "reorderRecommendations",
  "auditLogs",
  "notifications",
  "documentSequences",
] as const;

const BATCH = 2000;

export const wipeAllData = internalMutation({
  args: { confirm: v.string() },
  handler: async (ctx, { confirm }) => {
    if (confirm !== "DELETE EVERYTHING") {
      throw new ConvexError('Pass {"confirm":"DELETE EVERYTHING"} to wipe the database.');
    }
    let deleted = 0;
    const counts: Record<string, number> = {};
    for (const table of TABLES) {
      if (deleted >= BATCH) break;
      const docs = await ctx.db.query(table as any).take(BATCH - deleted);
      for (const d of docs) await ctx.db.delete(d._id);
      if (docs.length) counts[table] = docs.length;
      deleted += docs.length;
    }
    if (deleted < BATCH) {
      const files = await ctx.db.system.query("_storage").take(BATCH - deleted);
      for (const f of files) await ctx.storage.delete(f._id);
      if (files.length) counts["_storage"] = files.length;
      deleted += files.length;
    }
    if (deleted >= BATCH) {
      await ctx.scheduler.runAfter(0, internal.admin.wipeAllData, { confirm });
      return { deleted, counts, done: false, note: "More data remains — continuing automatically." };
    }
    return { deleted, counts, done: true };
  },
});
