import { v, ConvexError } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { requirePerm, assertBranch, filterByBranch } from "./lib/access";
import { audit, nextNumber, notifyPermission } from "./lib/system";
import { r2, DAY } from "./lib/money";

/** Recommendations still moving through the pipeline — never duplicated. */
const ACTIVE = new Set(["pending_approval", "approved", "ordered", "partially_received"]);
const OPEN = new Set(["recommended", "postponed"]);

function roundOrder(qty: number, minOrder: number, multiple: number) {
  if (qty <= 0) return 0;
  let q = Math.max(qty, minOrder || 0);
  const m = multiple > 0 ? multiple : 1;
  q = Math.ceil(q / m) * m;
  return q;
}

/**
 * Core replenishment engine.
 *   Reorder point   = avg daily demand × lead time + safety stock
 *   Projected stock = on hand − reserved + incoming
 *   Suggested qty   = max(0, target − projected), rounded to MOQ / multiples
 * Prefers an internal transfer when another store has enough surplus.
 */
async function recalc(ctx: MutationCtx, storeId?: Id<"stores">) {
  const now = Date.now();
  const settings = storeId
    ? await ctx.db.query("reorderSettings").withIndex("by_store", (q) => q.eq("storeId", storeId)).collect()
    : await ctx.db.query("reorderSettings").collect();
  const allSettings = await ctx.db.query("reorderSettings").collect();
  const balances = await ctx.db.query("inventoryBalances").collect();
  const recs = await ctx.db.query("reorderRecommendations").collect();
  const since = now - 90 * DAY;
  const sales = (await ctx.db.query("stockMovements").withIndex("by_date", (q) => q.gte("date", since)).collect()).filter(
    (m) => m.type === "sale",
  );

  let flagged = 0;
  for (const s of settings) {
    const product = await ctx.db.get(s.productId);
    if (!product || product.status !== "active") continue;

    // Demand from the last 90 days of sales when automatic
    let demand = s.avgDailyDemand;
    if (s.autoDemand) {
      const sold = sales.filter((m) => m.productId === s.productId && m.storeId === s.storeId).reduce((a, m) => a - m.quantity, 0);
      if (sold > 0) demand = Math.round((sold / 90) * 100) / 100;
    }
    const reorderPoint = s.autoReorderPoint ? Math.ceil(demand * s.leadTimeDays + s.safetyStock) : s.reorderPoint;
    if (demand !== s.avgDailyDemand || reorderPoint !== s.reorderPoint) {
      await ctx.db.patch(s._id, { avgDailyDemand: demand, reorderPoint });
    }

    const bal = balances.find((b) => b.productId === s.productId && b.storeId === s.storeId);
    const onHand = bal?.onHand ?? 0;
    const reserved = bal?.reserved ?? 0;
    const incoming = bal?.incoming ?? 0;
    const projected = onHand - reserved + incoming;
    const target = Math.max(s.targetStock, reorderPoint);
    const needs = projected <= reorderPoint;
    const severity = projected <= Math.max(s.minStock, s.safetyStock) || onHand - reserved <= 0 ? "critical" : "below_reorder";

    const mine = recs.filter((r) => r.productId === s.productId && r.storeId === s.storeId);
    if (mine.some((r) => ACTIVE.has(r.status))) continue; // already being handled — no duplicates
    const open = mine.find((r) => OPEN.has(r.status));
    if (open?.status === "postponed" && (open.postponedUntil ?? 0) > now) continue;

    if (!needs) {
      if (open && open.overrides.length === 0) await ctx.db.delete(open._id);
      continue;
    }

    const suggested = roundOrder(Math.max(0, target - projected), s.minOrderQty, s.orderMultiple);
    if (suggested <= 0) continue;
    flagged++;

    // Look for a store with surplus above its own reorder point
    let transferFrom: Id<"stores"> | undefined;
    let bestSurplus = 0;
    for (const other of balances) {
      if (other.productId !== s.productId || other.storeId === s.storeId) continue;
      const os = allSettings.find((x) => x.productId === s.productId && x.storeId === other.storeId);
      const keep = os ? Math.max(os.reorderPoint, os.targetStock * 0.5) : 0;
      const surplus = other.onHand - other.reserved - keep;
      if (surplus >= suggested && surplus > bestSurplus) {
        bestSurplus = surplus;
        transferFrom = other.storeId;
      }
    }

    const estUnitCost = bal?.avgCost || product.purchaseCost;
    const data = {
      supplierId: s.preferredSupplierId ?? product.preferredSupplierId,
      severity,
      action: transferFrom ? "transfer" : "purchase",
      transferFromStoreId: transferFrom,
      onHand,
      reserved,
      incoming,
      projected,
      reorderPoint,
      targetStock: target,
      suggestedQty: suggested,
      estUnitCost,
      updatedAt: now,
    };
    if (open) {
      const finalQty = open.overrides.length ? open.finalQty : suggested;
      await ctx.db.patch(open._id, { ...data, finalQty, estCost: r2(finalQty * estUnitCost), status: "recommended", postponedUntil: undefined });
    } else {
      await ctx.db.insert("reorderRecommendations", {
        ...data,
        productId: s.productId,
        storeId: s.storeId,
        branchId: s.branchId,
        status: "recommended",
        finalQty: suggested,
        estCost: r2(suggested * estUnitCost),
        overrides: [],
        createdAt: now,
      });
    }
  }
  return flagged;
}

export const recalculateAll = internalMutation({
  args: {},
  handler: async (ctx) => {
    const before = (await ctx.db.query("reorderRecommendations").withIndex("by_status", (q) => q.eq("status", "recommended")).collect()).filter(
      (r) => r.severity === "critical",
    ).length;
    const flagged = await recalc(ctx);
    const critical = (await ctx.db.query("reorderRecommendations").withIndex("by_status", (q) => q.eq("status", "recommended")).collect()).filter(
      (r) => r.severity === "critical",
    ).length;
    if (critical > before) {
      await notifyPermission(ctx, "reorder.manage", "Critical stock shortages", `${critical} item(s) are critically low`, "/reorder");
    }
    return flagged;
  },
});

export const recalculate = mutation({
  args: { storeId: v.optional(v.id("stores")) },
  handler: async (ctx, { storeId }) => {
    const member = await requirePerm(ctx, "reorder.manage");
    const n = await recalc(ctx, storeId);
    await audit(ctx, member, "reorder.recalculated", "reorderRecommendations", "", { flagged: n });
    return n;
  },
});

// ───────────── Dashboard ─────────────
export const dashboard = query({
  args: {
    branchId: v.optional(v.id("branches")),
    storeId: v.optional(v.id("stores")),
    supplierId: v.optional(v.id("suppliers")),
    status: v.optional(v.string()),
    view: v.optional(v.string()), // open | pipeline | history
  },
  handler: async (ctx, args) => {
    const member = await requirePerm(ctx, "reorder.view");
    let recs = filterByBranch(member, await ctx.db.query("reorderRecommendations").collect(), args.branchId);
    const view = args.view ?? "open";
    recs = recs.filter((r) => {
      if (args.storeId && r.storeId !== args.storeId) return false;
      if (args.supplierId && r.supplierId !== args.supplierId) return false;
      if (args.status && r.status !== args.status) return false;
      if (view === "open") return OPEN.has(r.status);
      if (view === "pipeline") return ACTIVE.has(r.status);
      return r.status === "completed" || r.status === "rejected";
    });
    const products = await ctx.db.query("products").collect();
    const stores = await ctx.db.query("stores").collect();
    const suppliers = await ctx.db.query("suppliers").collect();
    const prs = await ctx.db.query("purchaseRequests").collect();
    const trfs = await ctx.db.query("stockTransfers").collect();
    const rows = recs
      .map((r) => {
        const p = products.find((x) => x._id === r.productId);
        return {
          ...r,
          sku: p?.sku ?? "",
          name: p?.name ?? "",
          storeName: stores.find((s) => s._id === r.storeId)?.name ?? "",
          fromStoreName: stores.find((s) => s._id === r.transferFromStoreId)?.name ?? "",
          supplierName: suppliers.find((s) => s._id === r.supplierId)?.name ?? "",
          prNumber: prs.find((x) => x._id === r.purchaseRequestId)?.number ?? "",
          transferNumber: trfs.find((x) => x._id === r.transferId)?.number ?? "",
        };
      })
      .sort((a, b) => (a.severity === b.severity ? a.projected - b.projected : a.severity === "critical" ? -1 : 1));

    const all = filterByBranch(member, await ctx.db.query("reorderRecommendations").collect(), args.branchId);
    return {
      rows,
      summary: {
        belowReorder: all.filter((r) => OPEN.has(r.status)).length,
        critical: all.filter((r) => OPEN.has(r.status) && r.severity === "critical").length,
        estCost: r2(all.filter((r) => r.status === "recommended" && r.action === "purchase").reduce((a, r) => a + r.estCost, 0)),
        pendingApproval: all.filter((r) => r.status === "pending_approval").length,
        ordered: all.filter((r) => r.status === "ordered" || r.status === "partially_received").length,
      },
    };
  },
});

export const overrideQty = mutation({
  args: { id: v.id("reorderRecommendations"), qty: v.number(), reason: v.string() },
  handler: async (ctx, { id, qty, reason }) => {
    const member = await requirePerm(ctx, "reorder.manage");
    const r = await ctx.db.get(id);
    if (!r) throw new ConvexError("Recommendation not found.");
    assertBranch(member, r.branchId);
    if (!OPEN.has(r.status)) throw new ConvexError("Only open recommendations can be changed.");
    if (!reason.trim()) throw new ConvexError("Give a reason for the change.");
    if (qty < 0) throw new ConvexError("Quantity cannot be negative.");
    await ctx.db.patch(id, {
      finalQty: qty,
      estCost: r2(qty * r.estUnitCost),
      overrides: [...r.overrides, { memberId: member._id, at: Date.now(), originalQty: r.finalQty, newQty: qty, reason }],
      updatedAt: Date.now(),
    });
    await audit(ctx, member, "reorder.override", "reorderRecommendations", id, { from: r.finalQty, to: qty, reason }, r.branchId);
  },
});

export const setAction = mutation({
  args: { id: v.id("reorderRecommendations"), action: v.string(), supplierId: v.optional(v.id("suppliers")) },
  handler: async (ctx, { id, action, supplierId }) => {
    const member = await requirePerm(ctx, "reorder.manage");
    const r = await ctx.db.get(id);
    if (!r) throw new ConvexError("Recommendation not found.");
    assertBranch(member, r.branchId);
    if (!OPEN.has(r.status)) throw new ConvexError("Only open recommendations can be changed.");
    if (action === "transfer" && !r.transferFromStoreId) throw new ConvexError("No store has surplus for a transfer.");
    await ctx.db.patch(id, { action, supplierId: supplierId ?? r.supplierId, updatedAt: Date.now() });
  },
});

export const postpone = mutation({
  args: { id: v.id("reorderRecommendations"), days: v.number(), reason: v.string() },
  handler: async (ctx, { id, days, reason }) => {
    const member = await requirePerm(ctx, "reorder.manage");
    const r = await ctx.db.get(id);
    if (!r) throw new ConvexError("Recommendation not found.");
    assertBranch(member, r.branchId);
    await ctx.db.patch(id, { status: "postponed", postponedUntil: Date.now() + days * DAY, updatedAt: Date.now() });
    await audit(ctx, member, "reorder.postponed", "reorderRecommendations", id, { days, reason }, r.branchId);
  },
});

export const reject = mutation({
  args: { id: v.id("reorderRecommendations"), reason: v.string() },
  handler: async (ctx, { id, reason }) => {
    const member = await requirePerm(ctx, "reorder.manage");
    const r = await ctx.db.get(id);
    if (!r) throw new ConvexError("Recommendation not found.");
    assertBranch(member, r.branchId);
    if (!OPEN.has(r.status)) throw new ConvexError("Only open recommendations can be rejected.");
    await ctx.db.patch(id, { status: "rejected", updatedAt: Date.now() });
    await audit(ctx, member, "reorder.rejected", "reorderRecommendations", id, reason, r.branchId);
  },
});

/** Group selected purchase recommendations by supplier + store into draft→submitted purchase requests. */
export const createRequests = mutation({
  args: { ids: v.array(v.id("reorderRecommendations")) },
  handler: async (ctx, { ids }) => {
    const member = await requirePerm(ctx, "purchasing.request");
    const groups = new Map<string, Doc<"reorderRecommendations">[]>();
    for (const id of ids) {
      const r = await ctx.db.get(id);
      if (!r) continue;
      assertBranch(member, r.branchId);
      if (r.status !== "recommended") throw new ConvexError("Some recommendations are already being processed. Refresh and try again.");
      if (r.finalQty <= 0) continue;
      const key = `${r.supplierId ?? "none"}|${r.storeId}`;
      groups.set(key, [...(groups.get(key) ?? []), r]);
    }
    const created: Id<"purchaseRequests">[] = [];
    for (const [, recs] of groups) {
      const first = recs[0];
      const lines = recs.map((r) => ({ productId: r.productId, qty: r.finalQty, estUnitCost: r.estUnitCost, recommendationId: r._id }));
      const estTotal = r2(lines.reduce((a, l) => a + l.qty * l.estUnitCost, 0));
      const number = await nextNumber(ctx, "purchaseRequest", "PR");
      const prId = await ctx.db.insert("purchaseRequests", {
        number,
        branchId: first.branchId,
        storeId: first.storeId,
        supplierId: first.supplierId,
        date: Date.now(),
        source: "reorder",
        status: "pending_approval",
        lines,
        estTotal,
        note: "Generated from reorder recommendations",
        createdBy: member._id,
      });
      for (const r of recs) await ctx.db.patch(r._id, { status: "pending_approval", purchaseRequestId: prId, updatedAt: Date.now() });
      await audit(ctx, member, "pr.from_reorder", "purchaseRequests", prId, { number, lines: lines.length }, first.branchId);
      await notifyPermission(ctx, "purchasing.approve", `Reorder request ${number} needs approval`, `${lines.length} item(s), est. ${estTotal}`, "/approvals", first.branchId, member._id);
      created.push(prId);
    }
    return created;
  },
});

// ───────────── Settings ─────────────
export const settings = query({
  args: { storeId: v.id("stores") },
  handler: async (ctx, { storeId }) => {
    const member = await requirePerm(ctx, "reorder.view");
    const store = await ctx.db.get(storeId);
    if (!store) return [];
    assertBranch(member, store.branchId);
    const products = (await ctx.db.query("products").collect()).filter((p) => p.status === "active");
    const rows = await ctx.db.query("reorderSettings").withIndex("by_store", (q) => q.eq("storeId", storeId)).collect();
    const balances = await ctx.db.query("inventoryBalances").withIndex("by_store", (q) => q.eq("storeId", storeId)).collect();
    return products
      .map((p) => ({
        productId: p._id,
        sku: p.sku,
        name: p.name,
        preferredSupplierId: p.preferredSupplierId,
        onHand: balances.find((b) => b.productId === p._id)?.onHand ?? 0,
        setting: rows.find((r) => r.productId === p._id) ?? null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  },
});

export const saveSetting = mutation({
  args: {
    productId: v.id("products"),
    storeId: v.id("stores"),
    minStock: v.number(),
    reorderPoint: v.number(),
    maxStock: v.number(),
    safetyStock: v.number(),
    avgDailyDemand: v.number(),
    autoDemand: v.boolean(),
    autoReorderPoint: v.boolean(),
    leadTimeDays: v.number(),
    targetStock: v.number(),
    minOrderQty: v.number(),
    orderMultiple: v.number(),
    reviewDays: v.number(),
    preferredSupplierId: v.optional(v.id("suppliers")),
  },
  handler: async (ctx, args) => {
    const member = await requirePerm(ctx, "reorder.manage");
    const store = await ctx.db.get(args.storeId);
    if (!store) throw new ConvexError("Store not found.");
    assertBranch(member, store.branchId);
    if (args.maxStock && args.targetStock > args.maxStock) throw new ConvexError("Target stock cannot exceed maximum stock.");
    const reorderPoint = args.autoReorderPoint ? Math.ceil(args.avgDailyDemand * args.leadTimeDays + args.safetyStock) : args.reorderPoint;
    const existing = await ctx.db
      .query("reorderSettings")
      .withIndex("by_product_store", (q) => q.eq("productId", args.productId).eq("storeId", args.storeId))
      .unique();
    const data = { ...args, reorderPoint, branchId: store.branchId };
    if (existing) await ctx.db.patch(existing._id, data);
    else await ctx.db.insert("reorderSettings", data);
    await audit(ctx, member, "reorder.setting", "reorderSettings", `${args.productId}:${args.storeId}`, data, store.branchId);
  },
});

/** Quick start: give every product in a store sensible defaults it doesn't already have. */
export const applyDefaults = mutation({
  args: { storeId: v.id("stores"), leadTimeDays: v.number(), safetyDays: v.number(), coverDays: v.number() },
  handler: async (ctx, args) => {
    const member = await requirePerm(ctx, "reorder.manage");
    const store = await ctx.db.get(args.storeId);
    if (!store) throw new ConvexError("Store not found.");
    assertBranch(member, store.branchId);
    const products = (await ctx.db.query("products").collect()).filter((p) => p.status === "active");
    let created = 0;
    for (const p of products) {
      const existing = await ctx.db
        .query("reorderSettings")
        .withIndex("by_product_store", (q) => q.eq("productId", p._id).eq("storeId", args.storeId))
        .unique();
      if (existing) continue;
      await ctx.db.insert("reorderSettings", {
        productId: p._id,
        storeId: args.storeId,
        branchId: store.branchId,
        minStock: 1,
        reorderPoint: 2,
        maxStock: 0,
        safetyStock: 1,
        avgDailyDemand: 0,
        autoDemand: true,
        autoReorderPoint: true,
        leadTimeDays: args.leadTimeDays,
        targetStock: 2,
        minOrderQty: 1,
        orderMultiple: 1,
        reviewDays: 7,
        preferredSupplierId: p.preferredSupplierId,
      });
      created++;
    }
    // Recompute targets from demand once demand history exists
    await recalc(ctx, args.storeId);
    const settings = await ctx.db.query("reorderSettings").withIndex("by_store", (q) => q.eq("storeId", args.storeId)).collect();
    for (const s of settings) {
      if (s.autoDemand && s.avgDailyDemand > 0) {
        const safety = Math.ceil(s.avgDailyDemand * args.safetyDays);
        const target = Math.ceil(s.avgDailyDemand * (s.leadTimeDays + args.coverDays) + safety);
        await ctx.db.patch(s._id, { safetyStock: safety, minStock: safety, targetStock: target, reorderPoint: Math.ceil(s.avgDailyDemand * s.leadTimeDays + safety) });
      }
    }
    await audit(ctx, member, "reorder.defaults", "reorderSettings", args.storeId, { created }, store.branchId);
    return created;
  },
});
