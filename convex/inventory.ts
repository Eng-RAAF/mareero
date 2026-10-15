import { v, ConvexError } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { requirePerm, assertBranch, allowedBranches, has, filterByBranch } from "./lib/access";
import { applyMovement, findBalance } from "./lib/stock";
import { postJournal } from "./lib/ledger";
import { audit, nextNumber, notifyPermission } from "./lib/system";
import { r2 } from "./lib/money";

/** Stock on hand by product × store. */
export const stockOnHand = query({
  args: {
    storeId: v.optional(v.id("stores")),
    branchId: v.optional(v.id("branches")),
    search: v.optional(v.string()),
    onlyLow: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const member = await requirePerm(ctx, "inventory.view");
    let balances = await ctx.db.query("inventoryBalances").collect();
    balances = filterByBranch(member, balances, args.branchId).filter(
      (b) => !args.storeId || b.storeId === args.storeId,
    );
    const products = await ctx.db.query("products").collect();
    const stores = await ctx.db.query("stores").collect();
    const branches = await ctx.db.query("branches").collect();
    const settings = await ctx.db.query("reorderSettings").collect();
    const s = args.search?.trim().toLowerCase();
    const rows = balances
      .map((b) => {
        const p = products.find((x) => x._id === b.productId);
        const rs = settings.find((x) => x.productId === b.productId && x.storeId === b.storeId);
        const available = b.onHand - b.reserved;
        return {
          _id: b._id,
          productId: b.productId,
          storeId: b.storeId,
          branchId: b.branchId,
          sku: p?.sku ?? "",
          name: p?.name ?? "",
          partNumber: p?.partNumber ?? "",
          unit: p?.unit ?? "",
          storeName: stores.find((x) => x._id === b.storeId)?.name ?? "",
          branchName: branches.find((x) => x._id === b.branchId)?.name ?? "",
          onHand: b.onHand,
          reserved: b.reserved,
          available,
          incoming: b.incoming,
          inTransitOut: b.inTransitOut,
          avgCost: b.avgCost,
          value: r2(b.onHand * b.avgCost),
          reorderPoint: rs?.reorderPoint ?? null,
          low: rs ? available + b.incoming <= rs.reorderPoint : false,
          searchText: p?.searchText ?? "",
          lastMovementAt: b.lastMovementAt ?? null,
        };
      })
      .filter((r) => (!s || r.searchText.includes(s)) && (!args.onlyLow || r.low));
    return rows.sort((a, b) => a.name.localeCompare(b.name));
  },
});

export const movements = query({
  args: {
    storeId: v.optional(v.id("stores")),
    productId: v.optional(v.id("products")),
    type: v.optional(v.string()),
    from: v.optional(v.number()),
    to: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const member = await requirePerm(ctx, "inventory.view");
    let rows;
    if (args.productId) {
      rows = await ctx.db
        .query("stockMovements")
        .withIndex("by_product", (q) => q.eq("productId", args.productId!))
        .order("desc")
        .take(1000);
    } else if (args.storeId) {
      rows = await ctx.db
        .query("stockMovements")
        .withIndex("by_store", (q) => q.eq("storeId", args.storeId!))
        .order("desc")
        .take(1000);
    } else {
      rows = await ctx.db.query("stockMovements").withIndex("by_date").order("desc").take(1000);
    }
    rows = filterByBranch(member, rows).filter(
      (m) =>
        (!args.storeId || m.storeId === args.storeId) &&
        (!args.type || m.type === args.type) &&
        (!args.from || m.date >= args.from) &&
        (!args.to || m.date <= args.to),
    );
    const products = await ctx.db.query("products").collect();
    const stores = await ctx.db.query("stores").collect();
    const members = await ctx.db.query("members").collect();
    return rows.map((m) => ({
      ...m,
      sku: products.find((p) => p._id === m.productId)?.sku ?? "",
      productName: products.find((p) => p._id === m.productId)?.name ?? "",
      storeName: stores.find((s) => s._id === m.storeId)?.name ?? "",
      by: members.find((x) => x._id === m.memberId)?.name ?? "System",
    }));
  },
});

// ───────────── Adjustments, counts, damage, opening stock ─────────────
export const listAdjustments = query({
  args: { status: v.optional(v.string()) },
  handler: async (ctx, { status }) => {
    const member = await requirePerm(ctx, "inventory.view");
    let rows = status
      ? await ctx.db.query("stockAdjustments").withIndex("by_status", (q) => q.eq("status", status)).collect()
      : await ctx.db.query("stockAdjustments").collect();
    rows = filterByBranch(member, rows);
    const stores = await ctx.db.query("stores").collect();
    const members = await ctx.db.query("members").collect();
    const products = await ctx.db.query("products").collect();
    return rows
      .sort((a, b) => b._creationTime - a._creationTime)
      .map((a) => ({
        ...a,
        storeName: stores.find((s) => s._id === a.storeId)?.name ?? "",
        createdByName: members.find((m) => m._id === a.createdBy)?.name ?? "",
        approvedByName: members.find((m) => m._id === a.approvedBy)?.name ?? "",
        lines: a.lines.map((l) => {
          const p = products.find((x) => x._id === l.productId);
          return { ...l, sku: p?.sku ?? "", name: p?.name ?? "" };
        }),
      }));
  },
});

export const createAdjustment = mutation({
  args: {
    storeId: v.id("stores"),
    kind: v.string(), // adjustment | count | damage | opening
    reason: v.string(),
    date: v.number(),
    lines: v.array(
      v.object({
        productId: v.id("products"),
        qtyChange: v.optional(v.number()),
        countedQty: v.optional(v.number()),
        unitCost: v.optional(v.number()),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const member = await requirePerm(ctx, "inventory.adjust");
    const store = await ctx.db.get(args.storeId);
    if (!store) throw new ConvexError("Store not found.");
    assertBranch(member, store.branchId);
    if (!args.reason.trim()) throw new ConvexError("A reason is required.");
    if (args.lines.length === 0) throw new ConvexError("Add at least one line.");

    const lines = [];
    for (const l of args.lines) {
      const bal = await findBalance(ctx, l.productId, args.storeId);
      const product = await ctx.db.get(l.productId);
      const systemQty = bal?.onHand ?? 0;
      let qtyChange: number;
      if (args.kind === "count") {
        if (l.countedQty === undefined) throw new ConvexError("Counted quantity is required for stock counts.");
        qtyChange = l.countedQty - systemQty;
      } else if (args.kind === "damage") {
        qtyChange = -Math.abs(l.qtyChange ?? 0);
      } else {
        qtyChange = l.qtyChange ?? 0;
      }
      const unitCost = l.unitCost ?? bal?.avgCost ?? product?.purchaseCost ?? 0;
      lines.push({ productId: l.productId, systemQty, countedQty: l.countedQty, qtyChange, unitCost });
    }
    const totalValue = r2(lines.reduce((a, l) => a + l.qtyChange * l.unitCost, 0));
    const number = await nextNumber(ctx, "adjustment", "ADJ");
    const id = await ctx.db.insert("stockAdjustments", {
      number,
      storeId: args.storeId,
      branchId: store.branchId,
      date: args.date,
      kind: args.kind,
      reason: args.reason,
      status: "pending_approval",
      lines,
      totalValue,
      createdBy: member._id,
    });
    await audit(ctx, member, "adjustment.created", "stockAdjustments", id, { number, totalValue }, store.branchId);
    await notifyPermission(
      ctx,
      "inventory.approve",
      `Stock ${args.kind} ${number} needs approval`,
      `${store.name}: ${lines.length} line(s), value ${totalValue}`,
      "/approvals",
      store.branchId,
      member._id,
    );
    return id;
  },
});

async function postAdjustment(ctx: MutationCtx, adj: Doc<"stockAdjustments">, member: Doc<"members">) {
  let net = 0;
  const finalLines = [];
  for (const line of adj.lines) {
    const l = { ...line };
    if (adj.kind === "count" && l.countedQty !== undefined) {
      // stock may have moved since the count was entered — post against the current balance
      const bal = await findBalance(ctx, l.productId, adj.storeId);
      l.systemQty = bal?.onHand ?? 0;
      l.qtyChange = l.countedQty - l.systemQty;
    }
    finalLines.push(l);
    if (l.qtyChange === 0) continue;
    const { totalCost } = await applyMovement(ctx, {
      productId: l.productId,
      storeId: adj.storeId,
      qty: l.qtyChange,
      unitCost: l.qtyChange > 0 ? l.unitCost : undefined,
      type: adj.kind,
      sourceType: "adjustment",
      sourceId: adj._id,
      reference: adj.number,
      date: adj.date,
      member,
      note: adj.reason,
      allowNegative: false,
    });
    net += totalCost;
  }
  net = r2(net);
  const offset = adj.kind === "opening" ? "opening_equity" : "inventory_adjust";
  const journalEntryId = await postJournal(ctx, {
    date: adj.date,
    memo: `Stock ${adj.kind} ${adj.number}: ${adj.reason}`,
    sourceType: "adjustment",
    sourceId: adj._id,
    branchId: adj.branchId,
    member,
    lines:
      net >= 0
        ? [
            { account: "inventory", debit: net },
            { account: offset, credit: net },
          ]
        : [
            { account: offset, debit: -net },
            { account: "inventory", credit: -net },
          ],
  });
  await ctx.db.patch(adj._id, {
    status: "posted",
    approvedBy: member._id,
    journalEntryId,
    totalValue: net,
    lines: finalLines,
  });
}

export const approveAdjustment = mutation({
  args: { id: v.id("stockAdjustments") },
  handler: async (ctx, { id }) => {
    const member = await requirePerm(ctx, "inventory.approve");
    const adj = await ctx.db.get(id);
    if (!adj) throw new ConvexError("Adjustment not found.");
    assertBranch(member, adj.branchId);
    if (adj.status !== "pending_approval") throw new ConvexError(`Adjustment is ${adj.status}.`);
    if (adj.createdBy === member._id && !has(member, "approvals.high_value")) {
      throw new ConvexError("You cannot approve your own adjustment.");
    }
    await postAdjustment(ctx, adj, member);
    await audit(ctx, member, "adjustment.approved", "stockAdjustments", id, adj.number, adj.branchId);
  },
});

export const rejectAdjustment = mutation({
  args: { id: v.id("stockAdjustments"), reason: v.string() },
  handler: async (ctx, { id, reason }) => {
    const member = await requirePerm(ctx, "inventory.approve");
    const adj = await ctx.db.get(id);
    if (!adj) throw new ConvexError("Adjustment not found.");
    assertBranch(member, adj.branchId);
    if (adj.status !== "pending_approval") throw new ConvexError(`Adjustment is ${adj.status}.`);
    await ctx.db.patch(id, { status: "rejected", approvedBy: member._id });
    await audit(ctx, member, "adjustment.rejected", "stockAdjustments", id, reason, adj.branchId);
  },
});

/** Count sheet: every product with its system quantity in a store. */
export const countSheet = query({
  args: { storeId: v.id("stores") },
  handler: async (ctx, { storeId }) => {
    const member = await requirePerm(ctx, "inventory.view");
    const store = await ctx.db.get(storeId);
    if (!store) return [];
    const allowed = allowedBranches(member);
    if (allowed !== null && !allowed.has(store.branchId)) return [];
    const products = (await ctx.db.query("products").collect()).filter((p) => p.status === "active");
    const balances = await ctx.db.query("inventoryBalances").withIndex("by_store", (q) => q.eq("storeId", storeId)).collect();
    return products
      .map((p) => {
        const b = balances.find((x) => x.productId === p._id);
        return { productId: p._id as Id<"products">, sku: p.sku, name: p.name, systemQty: b?.onHand ?? 0, avgCost: b?.avgCost ?? p.purchaseCost };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  },
});
