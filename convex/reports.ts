import { v } from "convex/values";
import { query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { requireMember, requirePerm, allowedBranches, has, filterByBranch } from "./lib/access";
import { DEBIT_NORMAL } from "./lib/ledger";
import { r2, DAY } from "./lib/money";

/** Main dashboard: KPIs, alerts, branch comparison, pending approvals. */
export const dashboard = query({
  args: { from: v.number(), to: v.number(), branchId: v.optional(v.id("branches")) },
  handler: async (ctx, { from, to, branchId }) => {
    const member = await requireMember(ctx);
    const allowed = allowedBranches(member);
    const inScope = (b?: string) => (!branchId || b === branchId) && (allowed === null || (b !== undefined && allowed.has(b)));

    const accounts = await ctx.db.query("accounts").collect();
    const typeOf = new Map(accounts.map((a) => [a._id as string, a]));
    const periodLines = (await ctx.db.query("journalLines").withIndex("by_date", (q) => q.gte("date", from).lte("date", to)).collect()).filter(
      (l) => !l.branchId || inScope(l.branchId),
    );
    const sumType = (types: string[]) =>
      r2(
        periodLines.reduce((acc, l) => {
          const a = typeOf.get(l.accountId);
          if (!a || !types.includes(a.type)) return acc;
          return acc + (DEBIT_NORMAL.has(a.type) ? l.debit - l.credit : l.credit - l.debit);
        }, 0),
      );
    const revenue = sumType(["revenue"]);
    const cogs = sumType(["cogs"]);
    const expenses = sumType(["expense", "other_expense"]);
    const otherIncome = sumType(["other_income"]);

    // Cash & bank balances (all time)
    const cashAccounts = accounts.filter((a) => a.isCashOrBank);
    const cash = [];
    for (const a of cashAccounts) {
      const ls = (await ctx.db.query("journalLines").withIndex("by_account_date", (q) => q.eq("accountId", a._id)).collect()).filter(
        (l) => !l.branchId || inScope(l.branchId),
      );
      cash.push({ name: a.name, balance: r2(ls.reduce((x, l) => x + l.debit - l.credit, 0)) });
    }

    const balances = (await ctx.db.query("inventoryBalances").collect()).filter((b) => inScope(b.branchId));
    const inventoryValue = r2(balances.reduce((a, b) => a + b.onHand * b.avgCost, 0));

    const now = Date.now();
    const invoices = (await ctx.db.query("salesDocs").withIndex("by_kind_status", (q) => q.eq("kind", "invoice")).collect()).filter((i) =>
      inScope(i.branchId),
    );
    const openInv = invoices.filter((i) => i.status === "open" || i.status === "partial");
    const bills = (await ctx.db.query("supplierBills").collect()).filter((b) => b.kind === "bill" && inScope(b.branchId));
    const openBills = bills.filter((b) => b.status === "open" || b.status === "partial");

    const recs = (await ctx.db.query("reorderRecommendations").collect()).filter(
      (r) => inScope(r.branchId) && (r.status === "recommended" || r.status === "postponed"),
    );

    // Daily sales trend
    const days = Math.min(62, Math.max(1, Math.ceil((to - from) / DAY)));
    const trend: { date: string; sales: number }[] = [];
    for (let i = 0; i < days; i++) {
      const s = from + i * DAY;
      const e = s + DAY;
      trend.push({
        date: new Date(s).toISOString().slice(5, 10),
        sales: r2(invoices.filter((x) => x.status !== "void" && x.date >= s && x.date < e).reduce((a, x) => a + x.total - x.taxAmount, 0)),
      });
    }

    // Branch performance
    const branches = (await ctx.db.query("branches").collect()).filter((b) => allowed === null || allowed.has(b._id));
    const branchPerf = branches.map((b) => {
      const inv = invoices.filter((i) => i.branchId === b._id && i.status !== "void" && i.date >= from && i.date <= to);
      const sales = r2(inv.reduce((a, i) => a + i.subtotal - i.discountTotal, 0));
      const cost = r2(inv.reduce((a, i) => a + i.lines.reduce((x, l) => x + l.qty * (l.unitCost ?? 0), 0), 0));
      return {
        branch: b.name,
        sales,
        grossProfit: r2(sales - cost),
        stockValue: r2(balances.filter((x) => x.branchId === b._id).reduce((a, x) => a + x.onHand * x.avgCost, 0)),
      };
    });

    // Top products by revenue
    const productSales = new Map<string, { qty: number; revenue: number }>();
    for (const i of invoices.filter((x) => x.status !== "void" && x.date >= from && x.date <= to)) {
      for (const l of i.lines) {
        const cur = productSales.get(l.productId) ?? { qty: 0, revenue: 0 };
        cur.qty += l.qty;
        cur.revenue += l.qty * l.unitPrice - l.discount;
        productSales.set(l.productId, cur);
      }
    }
    const products = await ctx.db.query("products").collect();
    const topProducts = [...productSales.entries()]
      .sort((a, b) => b[1].revenue - a[1].revenue)
      .slice(0, 8)
      .map(([id, s]) => ({ name: products.find((p) => p._id === id)?.name ?? "", qty: s.qty, revenue: r2(s.revenue) }));

    // People without financial-report access see operational figures only.
    if (!has(member, "reports.financial")) {
      return {
        kpi: {
          sales: r2(invoices.filter((i) => i.status !== "void" && i.status !== "draft" && i.date >= from && i.date <= to).reduce((a, i) => a + i.subtotal - i.discountTotal, 0)),
          grossProfit: 0,
          grossMargin: 0,
          expenses: 0,
          netProfit: 0,
          inventoryValue,
          receivables: r2(openInv.reduce((a, i) => a + i.total - i.amountPaid, 0)),
          overdueReceivables: r2(openInv.filter((i) => (i.dueDate ?? i.date) < now).reduce((a, i) => a + i.total - i.amountPaid, 0)),
          payables: 0,
          overduePayables: 0,
          lowStock: recs.length,
          critical: recs.filter((r) => r.severity === "critical").length,
        },
        limited: true,
        cash: [],
        trend,
        branchPerf: branchPerf.map((b) => ({ ...b, grossProfit: 0 })),
        topProducts,
        approvals: await countApprovals(ctx, member),
      };
    }

    return {
      limited: false,
      kpi: {
        sales: revenue,
        grossProfit: r2(revenue - cogs),
        grossMargin: revenue ? Math.round(((revenue - cogs) / revenue) * 1000) / 10 : 0,
        expenses,
        netProfit: r2(revenue - cogs - expenses + otherIncome),
        inventoryValue,
        receivables: r2(openInv.reduce((a, i) => a + i.total - i.amountPaid, 0)),
        overdueReceivables: r2(openInv.filter((i) => (i.dueDate ?? i.date) < now).reduce((a, i) => a + i.total - i.amountPaid, 0)),
        payables: r2(openBills.reduce((a, b) => a + b.total - b.amountPaid, 0)),
        overduePayables: r2(openBills.filter((b) => b.dueDate < now).reduce((a, b) => a + b.total - b.amountPaid, 0)),
        lowStock: recs.length,
        critical: recs.filter((r) => r.severity === "critical").length,
      },
      cash,
      trend,
      branchPerf,
      topProducts,
      approvals: await countApprovals(ctx, member),
    };
  },
});

async function countApprovals(ctx: QueryCtx, member: Doc<"members">) {
  const list = await approvalItems(ctx, member);
  return list.length;
}

async function approvalItems(ctx: QueryCtx, member: Doc<"members">) {
  const items: Array<{ type: string; id: string; number: string; title: string; amount: number; branchId: string; date: number; by: string }> = [];
  const members = await ctx.db.query("members").collect();
  const who = (id: Doc<"members">["_id"]) => members.find((m) => m._id === id)?.name ?? "";
  if (has(member, "purchasing.approve")) {
    for (const r of filterByBranch(member, await ctx.db.query("purchaseRequests").withIndex("by_status", (q: any) => q.eq("status", "pending_approval")).collect()))
      items.push({ type: "purchase_request", id: r._id, number: r.number, title: `Purchase request (${r.lines.length} lines)`, amount: r.estTotal, branchId: r.branchId, date: r.date, by: who(r.createdBy) });
    for (const r of filterByBranch(member, await ctx.db.query("purchaseOrders").withIndex("by_status", (q: any) => q.eq("status", "pending_approval")).collect()))
      items.push({ type: "purchase_order", id: r._id, number: r.number, title: "Purchase order", amount: r.total, branchId: r.branchId, date: r.date, by: who(r.createdBy) });
  }
  if (has(member, "transfers.approve")) {
    const ts = (await ctx.db.query("stockTransfers").withIndex("by_status", (q: any) => q.eq("status", "pending_approval")).collect()).filter(
      (t) => has(member, "all_branches") || member.branchIds.includes(t.fromBranchId),
    );
    for (const t of ts)
      items.push({ type: "transfer", id: t._id, number: t.number, title: `Stock transfer (${t.lines.length} lines)`, amount: r2(t.lines.reduce((a, l) => a + l.qty * l.unitCost, 0)), branchId: t.fromBranchId, date: t.date, by: who(t.createdBy) });
  }
  if (has(member, "inventory.approve")) {
    for (const a of filterByBranch(member, await ctx.db.query("stockAdjustments").withIndex("by_status", (q: any) => q.eq("status", "pending_approval")).collect()))
      items.push({ type: "adjustment", id: a._id, number: a.number, title: `Stock ${a.kind}: ${a.reason}`, amount: a.totalValue, branchId: a.branchId, date: a.date, by: who(a.createdBy) });
  }
  if (has(member, "expenses.approve")) {
    for (const e of filterByBranch(member, await ctx.db.query("expenses").withIndex("by_status", (q: any) => q.eq("status", "pending_approval")).collect()))
      items.push({ type: "expense", id: e._id, number: e.number, title: `Expense — ${e.payee}`, amount: r2(e.amount + e.taxAmount), branchId: e.branchId, date: e.date, by: who(e.createdBy) });
  }
  return items.sort((a, b) => a.date - b.date);
}

export const approvals = query({
  args: {},
  handler: async (ctx) => {
    const member = await requireMember(ctx);
    const items = await approvalItems(ctx, member);
    const branches = await ctx.db.query("branches").collect();
    return items.map((i) => ({ ...i, branchName: branches.find((b) => b._id === i.branchId)?.name ?? "" }));
  },
});

// ───────────── Sales reports ─────────────
export const sales = query({
  args: { from: v.number(), to: v.number(), groupBy: v.string(), branchId: v.optional(v.id("branches")) },
  handler: async (ctx, { from, to, groupBy, branchId }) => {
    const member = await requirePerm(ctx, "reports.view");
    const docs = filterByBranch(
      member,
      (await ctx.db.query("salesDocs").withIndex("by_kind_date", (q) => q.eq("kind", "invoice").gte("date", from).lte("date", to)).collect()).filter(
        (d) => d.status !== "void" && d.status !== "draft",
      ),
      branchId,
    );
    const credits = filterByBranch(
      member,
      (await ctx.db.query("salesDocs").withIndex("by_kind_date", (q) => q.eq("kind", "credit_note").gte("date", from).lte("date", to)).collect()).filter(
        (d) => d.status !== "void",
      ),
      branchId,
    );
    const [products, customers, branches, categories] = await Promise.all([
      ctx.db.query("products").collect(),
      ctx.db.query("customers").collect(),
      ctx.db.query("branches").collect(),
      ctx.db.query("categories").collect(),
    ]);
    const map = new Map<string, { key: string; qty: number; revenue: number; cost: number; returns: number; invoices: Set<string> }>();
    const keyOf = (d: any, l: any) => {
      if (groupBy === "customer") return customers.find((c) => c._id === d.customerId)?.name ?? "—";
      if (groupBy === "branch") return branches.find((b) => b._id === d.branchId)?.name ?? "—";
      if (groupBy === "product") {
        const p = products.find((x) => x._id === l.productId);
        return p ? `${p.sku} — ${p.name}` : "—";
      }
      if (groupBy === "category") {
        const p = products.find((x) => x._id === l.productId);
        return categories.find((c) => c._id === p?.categoryId)?.name ?? "Uncategorised";
      }
      const dt = new Date(d.date);
      return groupBy === "month" ? `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}` : dt.toISOString().slice(0, 10);
    };
    for (const d of docs) {
      for (const l of d.lines) {
        const k = keyOf(d, l);
        const row = map.get(k) ?? { key: k, qty: 0, revenue: 0, cost: 0, returns: 0, invoices: new Set<string>() };
        row.qty += l.qty;
        row.revenue += l.qty * l.unitPrice - l.discount;
        row.cost += l.qty * (l.unitCost ?? 0);
        row.invoices.add(d._id);
        map.set(k, row);
      }
    }
    for (const d of credits) {
      for (const l of d.lines) {
        const k = keyOf(d, l);
        const row = map.get(k) ?? { key: k, qty: 0, revenue: 0, cost: 0, returns: 0, invoices: new Set<string>() };
        row.returns += l.qty * l.unitPrice - l.discount;
        row.qty -= l.qty;
        row.cost -= l.qty * (l.unitCost ?? 0);
        map.set(k, row);
      }
    }
    const rows = [...map.values()].map((r) => {
      const net = r2(r.revenue - r.returns);
      return { key: r.key, qty: r.qty, revenue: r2(r.revenue), returns: r2(r.returns), netSales: net, cost: r2(r.cost), grossProfit: r2(net - r.cost), margin: net ? Math.round(((net - r.cost) / net) * 1000) / 10 : 0, invoices: r.invoices.size };
    });
    rows.sort((a, b) => (groupBy === "day" || groupBy === "month" ? a.key.localeCompare(b.key) : b.netSales - a.netSales));
    return rows;
  },
});

// ───────────── Inventory reports ─────────────
export const inventoryValuation = query({
  args: { branchId: v.optional(v.id("branches")), storeId: v.optional(v.id("stores")) },
  handler: async (ctx, { branchId, storeId }) => {
    const member = await requirePerm(ctx, "reports.view");
    const balances = filterByBranch(member, await ctx.db.query("inventoryBalances").collect(), branchId).filter(
      (b) => (!storeId || b.storeId === storeId) && b.onHand !== 0,
    );
    const products = await ctx.db.query("products").collect();
    const stores = await ctx.db.query("stores").collect();
    const rows = balances.map((b) => {
      const p = products.find((x) => x._id === b.productId);
      return { sku: p?.sku ?? "", name: p?.name ?? "", store: stores.find((s) => s._id === b.storeId)?.name ?? "", onHand: b.onHand, avgCost: b.avgCost, value: r2(b.onHand * b.avgCost), retailValue: r2(b.onHand * (p?.retailPrice ?? 0)) };
    });
    rows.sort((a, b) => b.value - a.value);
    // Ledger cross-check
    const inv = await ctx.db.query("accounts").withIndex("by_systemKey", (q) => q.eq("systemKey", "inventory")).first();
    let ledgerValue = 0;
    if (inv && !branchId && !storeId) {
      const ls = await ctx.db.query("journalLines").withIndex("by_account_date", (q) => q.eq("accountId", inv._id)).collect();
      ledgerValue = r2(ls.reduce((a, l) => a + l.debit - l.credit, 0));
    }
    return { rows, total: r2(rows.reduce((a, r) => a + r.value, 0)), ledgerValue: branchId || storeId ? null : ledgerValue };
  },
});

/** Fast / slow / dead stock and stock aging based on sales velocity and last movement. */
export const stockVelocity = query({
  args: { days: v.number(), branchId: v.optional(v.id("branches")) },
  handler: async (ctx, { days, branchId }) => {
    const member = await requirePerm(ctx, "reports.view");
    const since = Date.now() - days * DAY;
    const sales = filterByBranch(
      member,
      (await ctx.db.query("stockMovements").withIndex("by_date", (q) => q.gte("date", since)).collect()).filter((m) => m.type === "sale"),
      branchId,
    );
    const balances = filterByBranch(member, await ctx.db.query("inventoryBalances").collect(), branchId);
    const products = (await ctx.db.query("products").collect()).filter((p) => p.status === "active");
    const rows = products.map((p) => {
      const sold = sales.filter((m) => m.productId === p._id).reduce((a, m) => a - m.quantity, 0);
      const bs = balances.filter((b) => b.productId === p._id);
      const onHand = bs.reduce((a, b) => a + b.onHand, 0);
      const value = r2(bs.reduce((a, b) => a + b.onHand * b.avgCost, 0));
      const last = Math.max(0, ...bs.map((b) => b.lastMovementAt ?? 0));
      const daily = sold / days;
      const daysCover = daily > 0 ? Math.round(onHand / daily) : null;
      const ageDays = last ? Math.floor((Date.now() - last) / DAY) : null;
      let cls = "normal";
      if (sold === 0 && onHand > 0) cls = "dead";
      else if (daysCover !== null && daysCover > 180) cls = "slow";
      else if (daysCover !== null && daysCover < 30 && sold > 0) cls = "fast";
      return { sku: p.sku, name: p.name, sold, onHand, value, dailyDemand: Math.round(daily * 100) / 100, daysCover, lastMovementDays: ageDays, class: cls };
    });
    return rows.sort((a, b) => b.sold - a.sold);
  },
});

// ───────────── Purchasing reports ─────────────
export const purchasing = query({
  args: { from: v.number(), to: v.number() },
  handler: async (ctx, { from, to }) => {
    const member = await requirePerm(ctx, "reports.view");
    const receipts = filterByBranch(member, (await ctx.db.query("goodsReceipts").collect()).filter((g) => g.date >= from && g.date <= to));
    const pos = filterByBranch(member, await ctx.db.query("purchaseOrders").collect());
    const suppliers = await ctx.db.query("suppliers").collect();
    const bySupplier = suppliers.map((s) => {
      const recs = receipts.filter((g) => g.supplierId === s._id);
      const sPos = pos.filter((p) => p.supplierId === s._id && p.date >= from && p.date <= to);
      // Delivery performance: receipts on or before the PO expected date
      let onTime = 0;
      let measured = 0;
      for (const g of recs) {
        const po = pos.find((p) => p._id === g.purchaseOrderId);
        if (po?.expectedDate) {
          measured++;
          if (g.date <= po.expectedDate + DAY) onTime++;
        }
      }
      return {
        supplier: s.name,
        orders: sPos.length,
        ordered: r2(sPos.reduce((a, p) => a + p.total, 0)),
        received: r2(recs.reduce((a, g) => a + g.total, 0)),
        onTimePct: measured ? Math.round((onTime / measured) * 100) : null,
        balance: s.balance,
      };
    });
    const outstanding = pos
      .filter((p) => p.status === "approved" || p.status === "partially_received")
      .map((p) => ({
        number: p.number,
        supplier: suppliers.find((s) => s._id === p.supplierId)?.name ?? "",
        date: p.date,
        expectedDate: p.expectedDate ?? null,
        total: p.total,
        outstandingValue: r2(p.lines.reduce((a, l) => a + (l.qty - l.receivedQty) * l.unitCost, 0)),
        late: !!p.expectedDate && p.expectedDate < Date.now(),
      }));
    return { bySupplier: bySupplier.filter((s) => s.orders || s.received || s.balance).sort((a, b) => b.received - a.received), outstanding };
  },
});

export const priceHistory = query({
  args: { productId: v.id("products") },
  handler: async (ctx, { productId }) => {
    await requirePerm(ctx, "purchasing.view");
    const receipts = await ctx.db.query("goodsReceipts").collect();
    const suppliers = await ctx.db.query("suppliers").collect();
    const rows = [];
    for (const g of receipts) {
      for (const l of g.lines) {
        if (l.productId === productId) {
          rows.push({ date: g.date, number: g.number, supplier: suppliers.find((s) => s._id === g.supplierId)?.name ?? "", qty: l.qty, unitCost: l.unitCost });
        }
      }
    }
    return rows.sort((a, b) => b.date - a.date);
  },
});
