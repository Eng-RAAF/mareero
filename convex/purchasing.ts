import { v, ConvexError } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import {
  requirePerm,
  assertBranch,
  filterByBranch,
  assertCanApproveAmount,
  has,
  getCompany,
} from "./lib/access";
import { applyMovement, bumpCounter } from "./lib/stock";
import { postJournal, reverseJournal } from "./lib/ledger";
import { audit, nextNumber, notifyPermission } from "./lib/system";
import { r2, r4, DAY } from "./lib/money";

async function names(ctx: MutationCtx | any) {
  const [products, suppliers, stores, branches, members] = await Promise.all([
    ctx.db.query("products").collect(),
    ctx.db.query("suppliers").collect(),
    ctx.db.query("stores").collect(),
    ctx.db.query("branches").collect(),
    ctx.db.query("members").collect(),
  ]);
  const find = (arr: any[], id: any) => arr.find((x) => x._id === id);
  return {
    product: (id: any) => find(products, id) as Doc<"products"> | undefined,
    supplier: (id: any) => (find(suppliers, id)?.name as string) ?? "",
    store: (id: any) => (find(stores, id)?.name as string) ?? "",
    branch: (id: any) => (find(branches, id)?.name as string) ?? "",
    member: (id: any) => (find(members, id)?.name as string) ?? "",
  };
}

// ═════════════ Purchase requests ═════════════
export const listRequests = query({
  args: { status: v.optional(v.string()) },
  handler: async (ctx, { status }) => {
    const member = await requirePerm(ctx, "purchasing.view");
    let rows = status
      ? await ctx.db.query("purchaseRequests").withIndex("by_status", (q) => q.eq("status", status)).collect()
      : await ctx.db.query("purchaseRequests").collect();
    rows = filterByBranch(member, rows);
    const n = await names(ctx);
    return rows
      .sort((a, b) => b._creationTime - a._creationTime)
      .map((r) => ({
        ...r,
        supplierName: n.supplier(r.supplierId),
        storeName: n.store(r.storeId),
        branchName: n.branch(r.branchId),
        createdByName: n.member(r.createdBy),
        lines: r.lines.map((l) => ({ ...l, sku: n.product(l.productId)?.sku ?? "", name: n.product(l.productId)?.name ?? "" })),
      }));
  },
});

export const saveRequest = mutation({
  args: {
    id: v.optional(v.id("purchaseRequests")),
    storeId: v.id("stores"),
    supplierId: v.optional(v.id("suppliers")),
    date: v.number(),
    note: v.optional(v.string()),
    lines: v.array(v.object({ productId: v.id("products"), qty: v.number(), estUnitCost: v.number() })),
    submit: v.boolean(),
  },
  handler: async (ctx, args) => {
    const member = await requirePerm(ctx, "purchasing.request");
    const store = await ctx.db.get(args.storeId);
    if (!store) throw new ConvexError("Store not found.");
    assertBranch(member, store.branchId);
    const lines = args.lines.filter((l) => l.qty > 0);
    if (lines.length === 0) throw new ConvexError("Add at least one line.");
    const estTotal = r2(lines.reduce((a, l) => a + l.qty * l.estUnitCost, 0));
    const status = args.submit ? "pending_approval" : "draft";
    let id = args.id;
    if (id) {
      const existing = await ctx.db.get(id);
      if (!existing || existing.status !== "draft") throw new ConvexError("Only drafts can be edited.");
      await ctx.db.patch(id, { storeId: args.storeId, branchId: store.branchId, supplierId: args.supplierId, date: args.date, note: args.note, lines, estTotal, status });
    } else {
      const number = await nextNumber(ctx, "purchaseRequest", "PR");
      id = await ctx.db.insert("purchaseRequests", {
        number,
        branchId: store.branchId,
        storeId: args.storeId,
        supplierId: args.supplierId,
        date: args.date,
        source: "manual",
        status,
        lines,
        estTotal,
        note: args.note,
        createdBy: member._id,
      });
    }
    const pr = (await ctx.db.get(id))!;
    await audit(ctx, member, args.submit ? "pr.submitted" : "pr.saved", "purchaseRequests", id, { number: pr.number, estTotal }, store.branchId);
    if (args.submit) {
      await notifyPermission(ctx, "purchasing.approve", `Purchase request ${pr.number} needs approval`, `Estimated ${estTotal}`, "/approvals", store.branchId, member._id);
    }
    return id;
  },
});

export const approveRequest = mutation({
  args: { id: v.id("purchaseRequests") },
  handler: async (ctx, { id }) => {
    const member = await requirePerm(ctx, "purchasing.approve");
    const pr = await ctx.db.get(id);
    if (!pr) throw new ConvexError("Request not found.");
    assertBranch(member, pr.branchId);
    if (pr.status !== "pending_approval") throw new ConvexError(`Request is ${pr.status}.`);
    await assertCanApproveAmount(ctx, member, pr.estTotal);
    await ctx.db.patch(id, { status: "approved", approvedBy: member._id });
    for (const l of pr.lines) {
      if (l.recommendationId) await ctx.db.patch(l.recommendationId, { status: "approved", updatedAt: Date.now() });
    }
    await audit(ctx, member, "pr.approved", "purchaseRequests", id, pr.number, pr.branchId);
    await notifyPermission(ctx, "purchasing.order", `Purchase request ${pr.number} approved`, "Convert it to a purchase order", "/purchasing/requests", pr.branchId);
  },
});

export const rejectRequest = mutation({
  args: { id: v.id("purchaseRequests"), reason: v.string() },
  handler: async (ctx, { id, reason }) => {
    const member = await requirePerm(ctx, "purchasing.approve");
    const pr = await ctx.db.get(id);
    if (!pr) throw new ConvexError("Request not found.");
    assertBranch(member, pr.branchId);
    if (pr.status !== "pending_approval" && pr.status !== "draft") throw new ConvexError(`Request is ${pr.status}.`);
    await ctx.db.patch(id, { status: "rejected", approvedBy: member._id, note: `${pr.note ?? ""}\nRejected: ${reason}`.trim() });
    for (const l of pr.lines) {
      if (l.recommendationId) await ctx.db.patch(l.recommendationId, { status: "rejected", updatedAt: Date.now() });
    }
    await audit(ctx, member, "pr.rejected", "purchaseRequests", id, reason, pr.branchId);
  },
});

/** Approved request → purchase order. Idempotent: a request converts only once. */
export const convertRequest = mutation({
  args: { id: v.id("purchaseRequests"), supplierId: v.optional(v.id("suppliers")), expectedDate: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const member = await requirePerm(ctx, "purchasing.order");
    const pr = await ctx.db.get(args.id);
    if (!pr) throw new ConvexError("Request not found.");
    assertBranch(member, pr.branchId);
    if (pr.status === "converted" || pr.purchaseOrderId) {
      throw new ConvexError("This request has already been converted to a purchase order.");
    }
    if (pr.status !== "approved") throw new ConvexError("Only approved requests can be converted.");
    const supplierId = args.supplierId ?? pr.supplierId;
    if (!supplierId) throw new ConvexError("Choose a supplier.");
    const supplier = await ctx.db.get(supplierId);
    const company = await getCompany(ctx);
    const lines = pr.lines.map((l) => ({ productId: l.productId, qty: l.qty, unitCost: l.estUnitCost, receivedQty: 0, billedQty: 0 }));
    const subtotal = r2(lines.reduce((a, l) => a + l.qty * l.unitCost, 0));
    const number = await nextNumber(ctx, "purchaseOrder", "PO");
    const now = Date.now();
    const poId = await ctx.db.insert("purchaseOrders", {
      number,
      supplierId,
      branchId: pr.branchId,
      storeId: pr.storeId,
      date: now,
      expectedDate: args.expectedDate ?? now + (supplier?.leadTimeDays ?? 7) * DAY,
      // The request was already approved, so the PO is issued directly.
      status: "approved",
      lines,
      subtotal,
      taxAmount: 0,
      total: subtotal,
      purchaseRequestId: pr._id,
      note: pr.note,
      createdBy: member._id,
      approvedBy: pr.approvedBy,
    });
    for (const l of lines) await bumpCounter(ctx, l.productId, pr.storeId, "incoming", l.qty);
    await ctx.db.patch(pr._id, { status: "converted", purchaseOrderId: poId });
    for (const l of pr.lines) {
      if (l.recommendationId) await ctx.db.patch(l.recommendationId, { status: "ordered", updatedAt: now });
    }
    void company;
    await audit(ctx, member, "po.created_from_pr", "purchaseOrders", poId, { number, from: pr.number }, pr.branchId);
    return poId;
  },
});

// ═════════════ Purchase orders ═════════════
export const listOrders = query({
  args: { status: v.optional(v.string()), supplierId: v.optional(v.id("suppliers")) },
  handler: async (ctx, { status, supplierId }) => {
    const member = await requirePerm(ctx, "purchasing.view");
    let rows = status
      ? await ctx.db.query("purchaseOrders").withIndex("by_status", (q) => q.eq("status", status)).collect()
      : await ctx.db.query("purchaseOrders").collect();
    rows = filterByBranch(member, rows).filter((r) => !supplierId || r.supplierId === supplierId);
    const n = await names(ctx);
    return rows
      .sort((a, b) => b._creationTime - a._creationTime)
      .map((r) => ({
        ...r,
        supplierName: n.supplier(r.supplierId),
        storeName: n.store(r.storeId),
        branchName: n.branch(r.branchId),
        createdByName: n.member(r.createdBy),
        receivedPct: Math.round(
          (100 * r.lines.reduce((a, l) => a + l.receivedQty, 0)) / Math.max(1, r.lines.reduce((a, l) => a + l.qty, 0)),
        ),
        lines: r.lines.map((l) => ({ ...l, sku: n.product(l.productId)?.sku ?? "", name: n.product(l.productId)?.name ?? "" })),
      }));
  },
});

export const getOrder = query({
  args: { id: v.id("purchaseOrders") },
  handler: async (ctx, { id }) => {
    const member = await requirePerm(ctx, "purchasing.view");
    const po = await ctx.db.get(id);
    if (!po) return null;
    assertBranch(member, po.branchId);
    const n = await names(ctx);
    const receipts = await ctx.db.query("goodsReceipts").withIndex("by_po", (q) => q.eq("purchaseOrderId", id)).collect();
    const bills = await ctx.db.query("supplierBills").withIndex("by_po", (q) => q.eq("purchaseOrderId", id)).collect();
    const supplier = await ctx.db.get(po.supplierId);
    return {
      ...po,
      supplier,
      supplierName: n.supplier(po.supplierId),
      storeName: n.store(po.storeId),
      branchName: n.branch(po.branchId),
      createdByName: n.member(po.createdBy),
      approvedByName: n.member(po.approvedBy),
      lines: po.lines.map((l) => ({
        ...l,
        sku: n.product(l.productId)?.sku ?? "",
        name: n.product(l.productId)?.name ?? "",
        unit: n.product(l.productId)?.unit ?? "",
      })),
      receipts,
      bills,
    };
  },
});

export const saveOrder = mutation({
  args: {
    id: v.optional(v.id("purchaseOrders")),
    supplierId: v.id("suppliers"),
    storeId: v.id("stores"),
    date: v.number(),
    expectedDate: v.optional(v.number()),
    taxAmount: v.number(),
    note: v.optional(v.string()),
    lines: v.array(v.object({ productId: v.id("products"), qty: v.number(), unitCost: v.number() })),
    submit: v.boolean(),
  },
  handler: async (ctx, args) => {
    const member = await requirePerm(ctx, "purchasing.order");
    const store = await ctx.db.get(args.storeId);
    if (!store) throw new ConvexError("Store not found.");
    assertBranch(member, store.branchId);
    const lines = args.lines
      .filter((l) => l.qty > 0)
      .map((l) => ({ ...l, unitCost: r4(l.unitCost), receivedQty: 0, billedQty: 0 }));
    if (lines.length === 0) throw new ConvexError("Add at least one line.");
    const subtotal = r2(lines.reduce((a, l) => a + l.qty * l.unitCost, 0));
    const total = r2(subtotal + args.taxAmount);
    const status = args.submit ? "pending_approval" : "draft";
    let id = args.id;
    if (id) {
      const existing = await ctx.db.get(id);
      if (!existing || existing.status !== "draft") throw new ConvexError("Only draft purchase orders can be edited.");
      await ctx.db.patch(id, {
        supplierId: args.supplierId,
        storeId: args.storeId,
        branchId: store.branchId,
        date: args.date,
        expectedDate: args.expectedDate,
        taxAmount: args.taxAmount,
        note: args.note,
        lines,
        subtotal,
        total,
        status,
      });
    } else {
      const number = await nextNumber(ctx, "purchaseOrder", "PO");
      id = await ctx.db.insert("purchaseOrders", {
        number,
        supplierId: args.supplierId,
        branchId: store.branchId,
        storeId: args.storeId,
        date: args.date,
        expectedDate: args.expectedDate,
        status,
        lines,
        subtotal,
        taxAmount: args.taxAmount,
        total,
        note: args.note,
        createdBy: member._id,
      });
    }
    const po = (await ctx.db.get(id))!;
    await audit(ctx, member, args.submit ? "po.submitted" : "po.saved", "purchaseOrders", id, { number: po.number, total }, store.branchId);
    if (args.submit) {
      await notifyPermission(ctx, "purchasing.approve", `Purchase order ${po.number} needs approval`, `Total ${total}`, "/approvals", store.branchId, member._id);
    }
    return id;
  },
});

export const approveOrder = mutation({
  args: { id: v.id("purchaseOrders") },
  handler: async (ctx, { id }) => {
    const member = await requirePerm(ctx, "purchasing.approve");
    const po = await ctx.db.get(id);
    if (!po) throw new ConvexError("Purchase order not found.");
    assertBranch(member, po.branchId);
    if (po.status !== "pending_approval") throw new ConvexError(`Purchase order is ${po.status}.`);
    await assertCanApproveAmount(ctx, member, po.total);
    if (po.createdBy === member._id && !has(member, "approvals.high_value")) {
      throw new ConvexError("You cannot approve your own purchase order.");
    }
    for (const l of po.lines) await bumpCounter(ctx, l.productId, po.storeId, "incoming", l.qty);
    await ctx.db.patch(id, { status: "approved", approvedBy: member._id });
    await audit(ctx, member, "po.approved", "purchaseOrders", id, po.number, po.branchId);
    await notifyPermission(ctx, "purchasing.receive", `PO ${po.number} approved`, "Goods can be received against it", "/purchasing/orders", po.branchId);
  },
});

export const rejectOrder = mutation({
  args: { id: v.id("purchaseOrders"), reason: v.string() },
  handler: async (ctx, { id, reason }) => {
    const member = await requirePerm(ctx, "purchasing.approve");
    const po = await ctx.db.get(id);
    if (!po) throw new ConvexError("Purchase order not found.");
    assertBranch(member, po.branchId);
    if (po.status !== "pending_approval") throw new ConvexError(`Purchase order is ${po.status}.`);
    await ctx.db.patch(id, { status: "draft", note: `${po.note ?? ""}\nReturned: ${reason}`.trim() });
    await audit(ctx, member, "po.returned_to_draft", "purchaseOrders", id, reason, po.branchId);
  },
});

/** Cancel (nothing received) or short-close (partly received). Releases expected stock. */
export const closeOrder = mutation({
  args: { id: v.id("purchaseOrders"), reason: v.string() },
  handler: async (ctx, { id, reason }) => {
    const member = await requirePerm(ctx, "purchasing.order");
    const po = await ctx.db.get(id);
    if (!po) throw new ConvexError("Purchase order not found.");
    assertBranch(member, po.branchId);
    if (["closed", "cancelled", "received"].includes(po.status)) throw new ConvexError(`Purchase order is ${po.status}.`);
    const wasIssued = po.status === "approved" || po.status === "partially_received";
    if (wasIssued) {
      for (const l of po.lines) {
        const outstanding = l.qty - l.receivedQty;
        if (outstanding > 0) await bumpCounter(ctx, l.productId, po.storeId, "incoming", -outstanding);
      }
    }
    const anyReceived = po.lines.some((l) => l.receivedQty > 0);
    await ctx.db.patch(id, { status: anyReceived ? "closed" : "cancelled", note: `${po.note ?? ""}\nClosed: ${reason}`.trim() });
    await audit(ctx, member, "po.closed", "purchaseOrders", id, reason, po.branchId);
  },
});

// ═════════════ Goods receipts ═════════════
export const listReceipts = query({
  args: {},
  handler: async (ctx) => {
    const member = await requirePerm(ctx, "purchasing.view");
    const rows = filterByBranch(member, await ctx.db.query("goodsReceipts").collect());
    const n = await names(ctx);
    const pos = await ctx.db.query("purchaseOrders").collect();
    return rows
      .sort((a, b) => b._creationTime - a._creationTime)
      .map((r) => ({
        ...r,
        poNumber: pos.find((p) => p._id === r.purchaseOrderId)?.number ?? "",
        supplierName: n.supplier(r.supplierId),
        storeName: n.store(r.storeId),
        createdByName: n.member(r.createdBy),
        lines: r.lines.map((l) => ({ ...l, sku: n.product(l.productId)?.sku ?? "", name: n.product(l.productId)?.name ?? "" })),
      }));
  },
});

export const receiveGoods = mutation({
  args: {
    purchaseOrderId: v.id("purchaseOrders"),
    date: v.number(),
    note: v.optional(v.string()),
    freight: v.optional(v.number()), // landed cost, allocated by line value
    lines: v.array(v.object({ productId: v.id("products"), qty: v.number() })),
  },
  handler: async (ctx, args) => {
    const member = await requirePerm(ctx, "purchasing.receive");
    const po = await ctx.db.get(args.purchaseOrderId);
    if (!po) throw new ConvexError("Purchase order not found.");
    assertBranch(member, po.branchId);
    if (po.status !== "approved" && po.status !== "partially_received") {
      throw new ConvexError("Goods can only be received against an approved purchase order.");
    }
    const receiving = args.lines.filter((l) => l.qty > 0);
    if (receiving.length === 0) throw new ConvexError("Enter quantities received.");
    const baseValue = receiving.reduce((a, l) => {
      const pl = po.lines.find((x) => x.productId === l.productId);
      return a + l.qty * (pl?.unitCost ?? 0);
    }, 0);
    const freight = r2(args.freight ?? 0);

    const number = await nextNumber(ctx, "goodsReceipt", "GRN");
    const grnId = await ctx.db.insert("goodsReceipts", {
      number,
      purchaseOrderId: po._id,
      supplierId: po.supplierId,
      storeId: po.storeId,
      branchId: po.branchId,
      date: args.date,
      lines: [],
      total: 0,
      note: args.note,
      createdBy: member._id,
    });

    const grnLines = [];
    let total = 0;
    const poLines = po.lines.map((l) => ({ ...l }));
    for (const r of receiving) {
      const pl = poLines.find((x) => x.productId === r.productId);
      if (!pl) throw new ConvexError("Product is not on this purchase order.");
      const outstanding = pl.qty - pl.receivedQty;
      if (r.qty > outstanding) {
        const p = await ctx.db.get(r.productId);
        throw new ConvexError(`${p?.sku}: receiving ${r.qty} but only ${outstanding} outstanding.`);
      }
      const lineBase = r.qty * pl.unitCost;
      const share = baseValue > 0 ? (freight * lineBase) / baseValue : 0;
      const landedUnit = r4(pl.unitCost + share / r.qty);
      await applyMovement(ctx, {
        productId: r.productId,
        storeId: po.storeId,
        qty: r.qty,
        unitCost: landedUnit,
        type: "receipt",
        sourceType: "goods_receipt",
        sourceId: grnId,
        reference: `${number} / ${po.number}`,
        date: args.date,
        member,
      });
      await bumpCounter(ctx, r.productId, po.storeId, "incoming", -r.qty);
      pl.receivedQty += r.qty;
      grnLines.push({ productId: r.productId, qty: r.qty, unitCost: landedUnit });
      total += r.qty * landedUnit;
    }
    total = r2(total);
    const goodsValue = r2(total - freight);
    const journalEntryId = await postJournal(ctx, {
      date: args.date,
      memo: `Goods received ${number} against ${po.number}`,
      sourceType: "grn",
      sourceId: grnId,
      branchId: po.branchId,
      member,
      lines: [
        { account: "inventory", debit: total },
        { account: "grni", credit: goodsValue, partyType: "supplier", partyId: po.supplierId },
        { account: "grni", credit: freight, memo: "Freight / landed cost accrued" },
      ],
    });
    await ctx.db.patch(grnId, { lines: grnLines, total, journalEntryId });

    const fully = poLines.every((l) => l.receivedQty >= l.qty);
    await ctx.db.patch(po._id, { lines: poLines, status: fully ? "received" : "partially_received" });

    // Reorder recommendations linked through the request
    if (po.purchaseRequestId) {
      const pr = await ctx.db.get(po.purchaseRequestId);
      for (const l of pr?.lines ?? []) {
        if (l.recommendationId) {
          await ctx.db.patch(l.recommendationId, { status: fully ? "completed" : "partially_received", updatedAt: Date.now() });
        }
      }
    }
    await audit(ctx, member, "grn.posted", "goodsReceipts", grnId, { number, po: po.number, total }, po.branchId);
    return grnId;
  },
});

// ═════════════ Supplier bills & returns ═════════════
export const listBills = query({
  args: { status: v.optional(v.string()), supplierId: v.optional(v.id("suppliers")) },
  handler: async (ctx, { status, supplierId }) => {
    const member = await requirePerm(ctx, "purchasing.view");
    let rows = status
      ? await ctx.db.query("supplierBills").withIndex("by_status", (q) => q.eq("status", status)).collect()
      : await ctx.db.query("supplierBills").collect();
    rows = filterByBranch(member, rows).filter((b) => !supplierId || b.supplierId === supplierId);
    const n = await names(ctx);
    const pos = await ctx.db.query("purchaseOrders").collect();
    const now = Date.now();
    return rows
      .sort((a, b) => b.date - a.date)
      .map((b) => ({
        ...b,
        supplierName: n.supplier(b.supplierId),
        branchName: n.branch(b.branchId),
        poNumber: pos.find((p) => p._id === b.purchaseOrderId)?.number ?? "",
        balanceDue: r2(b.total - b.amountPaid),
        overdue: b.kind === "bill" && (b.status === "open" || b.status === "partial") && b.dueDate < now,
      }));
  },
});

export const createBill = mutation({
  args: {
    supplierId: v.id("suppliers"),
    branchId: v.id("branches"),
    purchaseOrderId: v.optional(v.id("purchaseOrders")),
    supplierRef: v.optional(v.string()),
    date: v.number(),
    dueDate: v.optional(v.number()),
    taxAmount: v.number(),
    note: v.optional(v.string()),
    lines: v.array(
      v.object({
        description: v.string(),
        productId: v.optional(v.id("products")),
        accountId: v.optional(v.id("accounts")),
        qty: v.number(),
        unitCost: v.number(),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const member = await requirePerm(ctx, "bills.manage");
    assertBranch(member, args.branchId);
    const supplier = await ctx.db.get(args.supplierId);
    if (!supplier) throw new ConvexError("Supplier not found.");
    if (args.supplierRef) {
      const dup = (await ctx.db.query("supplierBills").withIndex("by_supplier", (q) => q.eq("supplierId", args.supplierId)).collect()).find(
        (b) => b.supplierRef === args.supplierRef && b.status !== "void",
      );
      if (dup) throw new ConvexError(`Supplier invoice ${args.supplierRef} is already entered as ${dup.number}.`);
    }
    const po = args.purchaseOrderId ? await ctx.db.get(args.purchaseOrderId) : null;
    if (args.purchaseOrderId && (!po || po.supplierId !== args.supplierId)) throw new ConvexError("Purchase order does not match the supplier.");

    const lines = args.lines
      .filter((l) => l.qty !== 0)
      .map((l) => ({ ...l, amount: r2(l.qty * l.unitCost) }));
    if (lines.length === 0) throw new ConvexError("Add at least one line.");
    const subtotal = r2(lines.reduce((a, l) => a + l.amount, 0));
    const total = r2(subtotal + args.taxAmount);

    const journal: Array<{ account: any; debit?: number; credit?: number; memo?: string }> = [];
    const poLines = po ? po.lines.map((l) => ({ ...l })) : [];
    for (const l of lines) {
      if (l.productId && po) {
        const pl = poLines.find((x) => x.productId === l.productId);
        if (!pl) throw new ConvexError(`${l.description} is not on ${po.number}.`);
        if (pl.billedQty + l.qty > pl.qty) throw new ConvexError(`${l.description}: billing more than ordered.`);
        pl.billedQty += l.qty;
        const grniValue = r2(l.qty * pl.unitCost);
        journal.push({ account: "grni", debit: grniValue, memo: l.description });
        const variance = r2(l.amount - grniValue);
        if (variance !== 0) journal.push({ account: "price_variance", debit: variance, memo: `Price variance ${l.description}` });
      } else if (l.accountId) {
        journal.push({ account: l.accountId, debit: l.amount, memo: l.description });
      } else {
        throw new ConvexError(`Line "${l.description}" needs an account (or link the bill to a purchase order).`);
      }
    }
    if (args.taxAmount) journal.push({ account: "tax_input", debit: args.taxAmount });
    journal.push({ account: "ap", credit: total });

    const number = await nextNumber(ctx, "supplierBill", "BILL");
    const billId = await ctx.db.insert("supplierBills", {
      number,
      kind: "bill",
      supplierRef: args.supplierRef,
      supplierId: args.supplierId,
      branchId: args.branchId,
      purchaseOrderId: args.purchaseOrderId,
      date: args.date,
      dueDate: args.dueDate ?? args.date + supplier.paymentTermsDays * DAY,
      lines,
      subtotal,
      taxAmount: args.taxAmount,
      total,
      amountPaid: 0,
      status: "open",
      note: args.note,
      createdBy: member._id,
    });
    const journalEntryId = await postJournal(ctx, {
      date: args.date,
      memo: `Bill ${number} — ${supplier.name}${args.supplierRef ? ` (${args.supplierRef})` : ""}`,
      sourceType: "bill",
      sourceId: billId,
      branchId: args.branchId,
      member,
      lines: journal.map((j) => ({ ...j, partyType: "supplier", partyId: args.supplierId })),
    });
    await ctx.db.patch(billId, { journalEntryId });
    if (po) await ctx.db.patch(po._id, { lines: poLines });
    await ctx.db.patch(supplier._id, { balance: r2(supplier.balance + total) });
    await audit(ctx, member, "bill.posted", "supplierBills", billId, { number, total }, args.branchId);
    return billId;
  },
});

export const voidBill = mutation({
  args: { id: v.id("supplierBills"), reason: v.string() },
  handler: async (ctx, { id, reason }) => {
    const member = await requirePerm(ctx, "bills.manage");
    const bill = await ctx.db.get(id);
    if (!bill) throw new ConvexError("Bill not found.");
    assertBranch(member, bill.branchId);
    if (bill.kind !== "bill") throw new ConvexError("Use the supplier return screen for debit notes.");
    if (bill.status === "void") throw new ConvexError("Already void.");
    if (bill.amountPaid > 0) throw new ConvexError("Remove payments before voiding this bill.");
    if (bill.journalEntryId) await reverseJournal(ctx, bill.journalEntryId, member, `Void bill ${bill.number}: ${reason}`);
    if (bill.purchaseOrderId) {
      const po = await ctx.db.get(bill.purchaseOrderId);
      if (po) {
        const lines = po.lines.map((pl) => {
          const billed = bill.lines.filter((l) => l.productId === pl.productId).reduce((a, l) => a + l.qty, 0);
          return { ...pl, billedQty: Math.max(0, pl.billedQty - billed) };
        });
        await ctx.db.patch(po._id, { lines });
      }
    }
    const supplier = await ctx.db.get(bill.supplierId);
    if (supplier) await ctx.db.patch(supplier._id, { balance: r2(supplier.balance - bill.total) });
    await ctx.db.patch(id, { status: "void" });
    await audit(ctx, member, "bill.voided", "supplierBills", id, reason, bill.branchId);
  },
});

/** Return goods to a supplier: stock leaves at average cost, supplier owes us (debit note). */
export const supplierReturn = mutation({
  args: {
    supplierId: v.id("suppliers"),
    storeId: v.id("stores"),
    date: v.number(),
    reason: v.string(),
    lines: v.array(v.object({ productId: v.id("products"), qty: v.number(), creditUnitPrice: v.number() })),
  },
  handler: async (ctx, args) => {
    const member = await requirePerm(ctx, "purchasing.receive");
    const store = await ctx.db.get(args.storeId);
    if (!store) throw new ConvexError("Store not found.");
    assertBranch(member, store.branchId);
    const supplier = await ctx.db.get(args.supplierId);
    if (!supplier) throw new ConvexError("Supplier not found.");
    const number = await nextNumber(ctx, "debitNote", "DN");
    const billId = await ctx.db.insert("supplierBills", {
      number,
      kind: "debit_note",
      supplierId: args.supplierId,
      branchId: store.branchId,
      storeId: args.storeId,
      date: args.date,
      dueDate: args.date,
      lines: [],
      subtotal: 0,
      taxAmount: 0,
      total: 0,
      amountPaid: 0,
      status: "open",
      note: args.reason,
      createdBy: member._id,
    });
    let costValue = 0;
    const lines = [];
    for (const l of args.lines) {
      if (l.qty <= 0) continue;
      const p = await ctx.db.get(l.productId);
      const { totalCost } = await applyMovement(ctx, {
        productId: l.productId,
        storeId: args.storeId,
        qty: -l.qty,
        type: "supplier_return",
        sourceType: "supplier_return",
        sourceId: billId,
        reference: number,
        date: args.date,
        member,
        note: args.reason,
      });
      costValue += -totalCost;
      lines.push({ description: p?.name ?? "Item", productId: l.productId, qty: l.qty, unitCost: l.creditUnitPrice, amount: r2(l.qty * l.creditUnitPrice) });
    }
    if (lines.length === 0) throw new ConvexError("Add at least one line.");
    costValue = r2(costValue);
    const total = r2(lines.reduce((a, l) => a + l.amount, 0));
    const journalEntryId = await postJournal(ctx, {
      date: args.date,
      memo: `Supplier return ${number} — ${supplier.name}`,
      sourceType: "bill",
      sourceId: billId,
      branchId: store.branchId,
      member,
      lines: [
        { account: "ap", debit: total, partyType: "supplier", partyId: supplier._id },
        { account: "inventory", credit: costValue },
        { account: "price_variance", credit: r2(total - costValue) },
      ],
    });
    await ctx.db.patch(billId, { lines, subtotal: total, total, journalEntryId, status: "paid", amountPaid: total });
    await ctx.db.patch(supplier._id, { balance: r2(supplier.balance - total) });
    await audit(ctx, member, "supplier_return.posted", "supplierBills", billId, { number, total }, store.branchId);
    return billId;
  },
});
