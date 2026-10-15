import { v, ConvexError } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requirePerm, requireMember, assertBranch, canAccessBranch, allowedBranches } from "./lib/access";
import { applyMovement, bumpCounter, findBalance } from "./lib/stock";
import { postJournal } from "./lib/ledger";
import { audit, nextNumber, notifyPermission } from "./lib/system";
import { r2 } from "./lib/money";

export const list = query({
  args: { status: v.optional(v.string()) },
  handler: async (ctx, { status }) => {
    const member = await requireMember(ctx);
    const allowed = allowedBranches(member);
    let rows = status
      ? await ctx.db.query("stockTransfers").withIndex("by_status", (q) => q.eq("status", status)).collect()
      : await ctx.db.query("stockTransfers").collect();
    rows = rows.filter((t) => allowed === null || allowed.has(t.fromBranchId) || allowed.has(t.toBranchId));
    const stores = await ctx.db.query("stores").collect();
    const products = await ctx.db.query("products").collect();
    const members = await ctx.db.query("members").collect();
    return rows
      .sort((a, b) => b._creationTime - a._creationTime)
      .map((t) => ({
        ...t,
        fromStoreName: stores.find((s) => s._id === t.fromStoreId)?.name ?? "",
        toStoreName: stores.find((s) => s._id === t.toStoreId)?.name ?? "",
        createdByName: members.find((m) => m._id === t.createdBy)?.name ?? "",
        totalValue: r2(t.lines.reduce((a, l) => a + (l.dispatchedQty || l.qty) * l.unitCost, 0)),
        lines: t.lines.map((l) => {
          const p = products.find((x) => x._id === l.productId);
          return { ...l, sku: p?.sku ?? "", name: p?.name ?? "" };
        }),
      }));
  },
});

export const create = mutation({
  args: {
    fromStoreId: v.id("stores"),
    toStoreId: v.id("stores"),
    date: v.number(),
    note: v.optional(v.string()),
    lines: v.array(v.object({ productId: v.id("products"), qty: v.number() })),
    recommendationIds: v.optional(v.array(v.id("reorderRecommendations"))),
  },
  handler: async (ctx, args) => {
    const member = await requirePerm(ctx, "transfers.create");
    if (args.fromStoreId === args.toStoreId) throw new ConvexError("Source and destination must differ.");
    const from = await ctx.db.get(args.fromStoreId);
    const to = await ctx.db.get(args.toStoreId);
    if (!from || !to) throw new ConvexError("Store not found.");
    if (!canAccessBranch(member, from.branchId) && !canAccessBranch(member, to.branchId)) {
      throw new ConvexError("You do not have access to either store.");
    }
    const lines = [];
    for (const l of args.lines) {
      if (l.qty <= 0) continue;
      const bal = await findBalance(ctx, l.productId, args.fromStoreId);
      const available = (bal?.onHand ?? 0) - (bal?.reserved ?? 0);
      if (available < l.qty) {
        const p = await ctx.db.get(l.productId);
        throw new ConvexError(`${p?.sku}: only ${available} available in ${from.name}.`);
      }
      lines.push({ productId: l.productId, qty: l.qty, dispatchedQty: 0, receivedQty: 0, damagedQty: 0, unitCost: bal?.avgCost ?? 0 });
    }
    if (lines.length === 0) throw new ConvexError("Add at least one line.");
    const number = await nextNumber(ctx, "transfer", "TRF");
    const id = await ctx.db.insert("stockTransfers", {
      number,
      fromStoreId: args.fromStoreId,
      toStoreId: args.toStoreId,
      fromBranchId: from.branchId,
      toBranchId: to.branchId,
      status: "pending_approval",
      lines,
      date: args.date,
      note: args.note,
      createdBy: member._id,
      recommendationIds: args.recommendationIds,
    });
    for (const rid of args.recommendationIds ?? []) {
      await ctx.db.patch(rid, { status: "pending_approval", transferId: id, updatedAt: Date.now() });
    }
    await audit(ctx, member, "transfer.created", "stockTransfers", id, number, from.branchId);
    await notifyPermission(ctx, "transfers.approve", `Transfer ${number} needs approval`, `${from.name} → ${to.name}`, "/approvals", from.branchId, member._id);
    return id;
  },
});

export const approve = mutation({
  args: { id: v.id("stockTransfers") },
  handler: async (ctx, { id }) => {
    const member = await requirePerm(ctx, "transfers.approve");
    const t = await ctx.db.get(id);
    if (!t) throw new ConvexError("Transfer not found.");
    assertBranch(member, t.fromBranchId);
    if (t.status !== "pending_approval") throw new ConvexError(`Transfer is ${t.status}.`);
    for (const l of t.lines) {
      const bal = await findBalance(ctx, l.productId, t.fromStoreId);
      const available = (bal?.onHand ?? 0) - (bal?.reserved ?? 0);
      if (available < l.qty) {
        const p = await ctx.db.get(l.productId);
        throw new ConvexError(`${p?.sku}: only ${available} available now.`);
      }
      await bumpCounter(ctx, l.productId, t.fromStoreId, "reserved", l.qty);
    }
    await ctx.db.patch(id, { status: "approved", approvedBy: member._id });
    for (const rid of t.recommendationIds ?? []) await ctx.db.patch(rid, { status: "approved", updatedAt: Date.now() });
    await audit(ctx, member, "transfer.approved", "stockTransfers", id, t.number, t.fromBranchId);
    await notifyPermission(ctx, "transfers.dispatch", `Transfer ${t.number} approved`, "Ready to dispatch", "/transfers", t.fromBranchId);
  },
});

export const reject = mutation({
  args: { id: v.id("stockTransfers"), reason: v.string() },
  handler: async (ctx, { id, reason }) => {
    const member = await requirePerm(ctx, "transfers.approve");
    const t = await ctx.db.get(id);
    if (!t) throw new ConvexError("Transfer not found.");
    assertBranch(member, t.fromBranchId);
    if (t.status === "approved") {
      for (const l of t.lines) await bumpCounter(ctx, l.productId, t.fromStoreId, "reserved", -l.qty);
    } else if (t.status !== "pending_approval") {
      throw new ConvexError(`Transfer is ${t.status}.`);
    }
    await ctx.db.patch(id, { status: "rejected", approvedBy: member._id });
    for (const rid of t.recommendationIds ?? []) await ctx.db.patch(rid, { status: "recommended", transferId: undefined, updatedAt: Date.now() });
    await audit(ctx, member, "transfer.rejected", "stockTransfers", id, reason, t.fromBranchId);
  },
});

/** Ship goods: stock leaves the source store and sits in transit. */
export const dispatch = mutation({
  args: {
    id: v.id("stockTransfers"),
    lines: v.array(v.object({ productId: v.id("products"), qty: v.number() })),
  },
  handler: async (ctx, args) => {
    const member = await requirePerm(ctx, "transfers.dispatch");
    const t = await ctx.db.get(args.id);
    if (!t) throw new ConvexError("Transfer not found.");
    assertBranch(member, t.fromBranchId);
    if (t.status !== "approved") throw new ConvexError("Only approved transfers can be dispatched.");
    const now = Date.now();
    let value = 0;
    const lines = [];
    for (const l of t.lines) {
      const sent = args.lines.find((x) => x.productId === l.productId)?.qty ?? l.qty;
      if (sent < 0 || sent > l.qty) throw new ConvexError("Dispatched quantity must be between 0 and the approved quantity.");
      await bumpCounter(ctx, l.productId, t.fromStoreId, "reserved", -l.qty);
      let unitCost = l.unitCost;
      if (sent > 0) {
        const res = await applyMovement(ctx, {
          productId: l.productId,
          storeId: t.fromStoreId,
          qty: -sent,
          type: "transfer_out",
          sourceType: "transfer",
          sourceId: t._id,
          reference: t.number,
          date: now,
          member,
        });
        unitCost = res.unitCost;
        value += sent * unitCost;
        await bumpCounter(ctx, l.productId, t.fromStoreId, "inTransitOut", sent);
        await bumpCounter(ctx, l.productId, t.toStoreId, "incoming", sent);
      }
      lines.push({ ...l, dispatchedQty: sent, unitCost });
    }
    value = r2(value);
    await postJournal(ctx, {
      date: now,
      memo: `Transfer ${t.number} dispatched`,
      sourceType: "transfer",
      sourceId: t._id,
      member,
      lines: [
        { account: "inventory_transit", debit: value, branchId: t.toBranchId },
        { account: "inventory", credit: value, branchId: t.fromBranchId },
      ],
    });
    await ctx.db.patch(t._id, { status: "in_transit", lines, dispatchedAt: now });
    await audit(ctx, member, "transfer.dispatched", "stockTransfers", t._id, { value }, t.fromBranchId);
    await notifyPermission(ctx, "transfers.receive", `Transfer ${t.number} is on the way`, "Confirm receipt when it arrives", "/transfers", t.toBranchId);
  },
});

/** Receive goods at destination. `final` closes the transfer and writes off any shortage. */
export const receive = mutation({
  args: {
    id: v.id("stockTransfers"),
    lines: v.array(v.object({ productId: v.id("products"), receivedQty: v.number(), damagedQty: v.number() })),
    final: v.boolean(),
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const member = await requirePerm(ctx, "transfers.receive");
    const t = await ctx.db.get(args.id);
    if (!t) throw new ConvexError("Transfer not found.");
    assertBranch(member, t.toBranchId);
    if (t.status !== "in_transit" && t.status !== "partially_received") {
      throw new ConvexError("This transfer is not in transit.");
    }
    const now = Date.now();
    let receivedValue = 0;
    let lossValue = 0;
    const lines = [];
    let allDone = true;
    for (const l of t.lines) {
      const input = args.lines.find((x) => x.productId === l.productId) ?? { receivedQty: 0, damagedQty: 0 };
      const outstanding = l.dispatchedQty - l.receivedQty - l.damagedQty;
      const rec = Math.max(0, input.receivedQty);
      const dmg = Math.max(0, input.damagedQty);
      if (rec + dmg > outstanding) throw new ConvexError("Received + damaged exceeds what is still in transit.");
      if (rec > 0) {
        await applyMovement(ctx, {
          productId: l.productId,
          storeId: t.toStoreId,
          qty: rec,
          unitCost: l.unitCost,
          type: "transfer_in",
          sourceType: "transfer",
          sourceId: t._id,
          reference: t.number,
          date: now,
          member,
        });
        receivedValue += rec * l.unitCost;
      }
      let shortage = 0;
      const remaining = outstanding - rec - dmg;
      if (args.final && remaining > 0) shortage = remaining;
      lossValue += (dmg + shortage) * l.unitCost;
      const settled = rec + dmg + shortage;
      await bumpCounter(ctx, l.productId, t.toStoreId, "incoming", -settled);
      await bumpCounter(ctx, l.productId, t.fromStoreId, "inTransitOut", -settled);
      const nl = { ...l, receivedQty: l.receivedQty + rec, damagedQty: l.damagedQty + dmg + shortage };
      if (nl.receivedQty + nl.damagedQty < nl.dispatchedQty) allDone = false;
      lines.push(nl);
    }
    receivedValue = r2(receivedValue);
    lossValue = r2(lossValue);
    await postJournal(ctx, {
      date: now,
      memo: `Transfer ${t.number} received${lossValue > 0 ? " (with discrepancies)" : ""}`,
      sourceType: "transfer",
      sourceId: t._id,
      member,
      lines: [
        { account: "inventory", debit: receivedValue, branchId: t.toBranchId },
        { account: "inventory_adjust", debit: lossValue, branchId: t.toBranchId, memo: "Transfer damage / shortage" },
        { account: "inventory_transit", credit: r2(receivedValue + lossValue), branchId: t.toBranchId },
      ],
    });
    const status = allDone ? "received" : "partially_received";
    await ctx.db.patch(t._id, { lines, status, receivedAt: now, note: args.note ? `${t.note ?? ""}\n${args.note}`.trim() : t.note });
    if (allDone) {
      for (const rid of t.recommendationIds ?? []) await ctx.db.patch(rid, { status: "completed", updatedAt: now });
    }
    await audit(ctx, member, "transfer.received", "stockTransfers", t._id, { receivedValue, lossValue, status }, t.toBranchId);
  },
});

export const cancel = mutation({
  args: { id: v.id("stockTransfers") },
  handler: async (ctx, { id }) => {
    const member = await requirePerm(ctx, "transfers.create");
    const t = await ctx.db.get(id);
    if (!t) throw new ConvexError("Transfer not found.");
    if (!canAccessBranch(member, t.fromBranchId) && !canAccessBranch(member, t.toBranchId)) {
      throw new ConvexError("No access.");
    }
    if (t.status === "approved") {
      for (const l of t.lines) await bumpCounter(ctx, l.productId, t.fromStoreId, "reserved", -l.qty);
    } else if (t.status !== "pending_approval" && t.status !== "draft") {
      throw new ConvexError("Dispatched transfers cannot be cancelled; receive them with discrepancies instead.");
    }
    await ctx.db.patch(id, { status: "cancelled" });
    for (const rid of t.recommendationIds ?? []) await ctx.db.patch(rid, { status: "recommended", transferId: undefined, updatedAt: Date.now() });
    await audit(ctx, member, "transfer.cancelled", "stockTransfers", id, t.number, t.fromBranchId);
  },
});
