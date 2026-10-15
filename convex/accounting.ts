import { v, ConvexError } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { requirePerm, requireMember, allowedBranches, assertBranch } from "./lib/access";
import { postJournal, reverseJournal, DEBIT_NORMAL } from "./lib/ledger";
import { audit } from "./lib/system";
import { r2, DAY } from "./lib/money";

const TYPE_ORDER = ["asset", "liability", "equity", "revenue", "cogs", "expense", "other_income", "other_expense"];
const TYPE_LABEL: Record<string, string> = {
  asset: "Assets",
  liability: "Liabilities",
  equity: "Equity",
  revenue: "Revenue",
  cogs: "Cost of Goods Sold",
  expense: "Operating Expenses",
  other_income: "Other Income",
  other_expense: "Other Expenses",
};

/** Lines visible to this member, optionally filtered by branch and date range. */
async function lines(
  ctx: QueryCtx,
  member: Doc<"members">,
  opts: { from?: number; to?: number; branchId?: Id<"branches"> },
) {
  const all = await ctx.db
    .query("journalLines")
    .withIndex("by_date", (q) => {
      if (opts.from !== undefined && opts.to !== undefined) return q.gte("date", opts.from).lte("date", opts.to);
      if (opts.to !== undefined) return q.lte("date", opts.to);
      if (opts.from !== undefined) return q.gte("date", opts.from);
      return q;
    })
    .collect();
  const allowed = allowedBranches(member);
  return all.filter(
    (l) =>
      (!opts.branchId || l.branchId === opts.branchId) &&
      (allowed === null || !l.branchId || allowed.has(l.branchId)),
  );
}

function balanceOf(type: string, debit: number, credit: number) {
  return r2(DEBIT_NORMAL.has(type) ? debit - credit : credit - debit);
}

// ───────────── Chart of accounts ─────────────
export const accounts = query({
  args: { withBalances: v.optional(v.boolean()) },
  handler: async (ctx, { withBalances }) => {
    const member = await requirePerm(ctx, "accounting.view");
    const accts = await ctx.db.query("accounts").collect();
    const sums = new Map<string, { d: number; c: number }>();
    if (withBalances) {
      for (const l of await lines(ctx, member, {})) {
        const s = sums.get(l.accountId) ?? { d: 0, c: 0 };
        s.d += l.debit;
        s.c += l.credit;
        sums.set(l.accountId, s);
      }
    }
    return accts
      .sort((a, b) => a.code.localeCompare(b.code))
      .map((a) => {
        const s = sums.get(a._id) ?? { d: 0, c: 0 };
        return { ...a, typeLabel: TYPE_LABEL[a.type] ?? a.type, balance: balanceOf(a.type, s.d, s.c) };
      });
  },
});

/** Cash & bank accounts for payment pickers (any signed-in member who records money). */
export const cashAccounts = query({
  args: {},
  handler: async (ctx) => {
    await requireMember(ctx);
    const accts = await ctx.db.query("accounts").collect();
    return accts.filter((a) => a.isCashOrBank && a.active).sort((a, b) => a.code.localeCompare(b.code));
  },
});

export const expenseAccounts = query({
  args: {},
  handler: async (ctx) => {
    await requirePerm(ctx, "expenses.create");
    const accts = await ctx.db.query("accounts").collect();
    return accts
      .filter((a) => a.active && (a.type === "expense" || a.type === "other_expense" || a.type === "cogs" || a.subtype === "fixed"))
      .sort((a, b) => a.code.localeCompare(b.code));
  },
});

export const saveAccount = mutation({
  args: {
    id: v.optional(v.id("accounts")),
    code: v.string(),
    name: v.string(),
    type: v.string(),
    subtype: v.optional(v.string()),
    isCashOrBank: v.boolean(),
    description: v.optional(v.string()),
    active: v.boolean(),
  },
  handler: async (ctx, { id, ...data }) => {
    const member = await requirePerm(ctx, "accounting.journal");
    if (!TYPE_ORDER.includes(data.type)) throw new ConvexError("Unknown account type.");
    const dup = await ctx.db.query("accounts").withIndex("by_code", (q) => q.eq("code", data.code)).first();
    if (dup && dup._id !== id) throw new ConvexError(`Account code ${data.code} already exists.`);
    if (id) {
      const existing = await ctx.db.get(id);
      if (existing?.systemKey && (existing.type !== data.type || !data.active)) {
        throw new ConvexError("System accounts cannot change type or be deactivated.");
      }
      await ctx.db.patch(id, data);
      await audit(ctx, member, "account.updated", "accounts", id, data);
      return id;
    }
    const newId = await ctx.db.insert("accounts", data);
    await audit(ctx, member, "account.created", "accounts", newId, data);
    return newId;
  },
});

// ───────────── Journals ─────────────
export const journals = query({
  args: { from: v.optional(v.number()), to: v.optional(v.number()), sourceType: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const member = await requirePerm(ctx, "accounting.view");
    let entries = await ctx.db
      .query("journalEntries")
      .withIndex("by_date", (q) => (args.from !== undefined ? q.gte("date", args.from) : q))
      .order("desc")
      .take(500);
    entries = entries.filter((e) => (!args.to || e.date <= args.to) && (!args.sourceType || e.sourceType === args.sourceType));
    const allowed = allowedBranches(member);
    entries = entries.filter((e) => allowed === null || !e.branchId || allowed.has(e.branchId));
    const accts = await ctx.db.query("accounts").collect();
    const members = await ctx.db.query("members").collect();
    const result = [];
    for (const e of entries) {
      const ls = await ctx.db.query("journalLines").withIndex("by_entry", (q) => q.eq("entryId", e._id)).collect();
      result.push({
        ...e,
        createdByName: members.find((m) => m._id === e.createdBy)?.name ?? "System",
        lines: ls.map((l) => {
          const a = accts.find((x) => x._id === l.accountId);
          return { ...l, accountCode: a?.code ?? "", accountName: a?.name ?? "" };
        }),
      });
    }
    return result;
  },
});

export const createJournal = mutation({
  args: {
    date: v.number(),
    memo: v.string(),
    branchId: v.optional(v.id("branches")),
    lines: v.array(
      v.object({ accountId: v.id("accounts"), debit: v.number(), credit: v.number(), memo: v.optional(v.string()) }),
    ),
  },
  handler: async (ctx, args) => {
    const member = await requirePerm(ctx, "accounting.journal");
    if (args.branchId) assertBranch(member, args.branchId);
    if (!args.memo.trim()) throw new ConvexError("A memo is required.");
    for (const l of args.lines) {
      const a = await ctx.db.get(l.accountId);
      if (a?.systemKey && ["ar", "ap", "inventory"].includes(a.systemKey)) {
        throw new ConvexError(
          `${a.name} is a control account. Use invoices, bills, payments or stock adjustments so sub-ledgers stay reconciled.`,
        );
      }
    }
    const id = await postJournal(ctx, {
      date: args.date,
      memo: args.memo,
      sourceType: "manual",
      branchId: args.branchId,
      member,
      lines: args.lines.map((l) => ({ account: l.accountId, debit: l.debit, credit: l.credit, memo: l.memo })),
    });
    if (!id) throw new ConvexError("Enter at least one amount.");
    await audit(ctx, member, "journal.posted", "journalEntries", id, args.memo, args.branchId);
    return id;
  },
});

export const reverseEntry = mutation({
  args: { id: v.id("journalEntries"), reason: v.string() },
  handler: async (ctx, { id, reason }) => {
    const member = await requirePerm(ctx, "accounting.journal");
    const entry = await ctx.db.get(id);
    if (!entry) throw new ConvexError("Entry not found.");
    if (entry.sourceType !== "manual") {
      throw new ConvexError("Only manual journals can be reversed here. Void or credit the source document instead.");
    }
    const rid = await reverseJournal(ctx, id, member, reason);
    await audit(ctx, member, "journal.reversed", "journalEntries", id, reason, entry.branchId);
    return rid;
  },
});

// ───────────── General ledger ─────────────
export const ledger = query({
  args: { accountId: v.id("accounts"), from: v.number(), to: v.number(), branchId: v.optional(v.id("branches")) },
  handler: async (ctx, args) => {
    const member = await requirePerm(ctx, "accounting.view");
    const account = await ctx.db.get(args.accountId);
    if (!account) return null;
    const allowed = allowedBranches(member);
    const all = (
      await ctx.db.query("journalLines").withIndex("by_account_date", (q) => q.eq("accountId", args.accountId).lte("date", args.to)).collect()
    ).filter((l) => (!args.branchId || l.branchId === args.branchId) && (allowed === null || !l.branchId || allowed.has(l.branchId)));
    const before = all.filter((l) => l.date < args.from);
    const opening = balanceOf(account.type, before.reduce((a, l) => a + l.debit, 0), before.reduce((a, l) => a + l.credit, 0));
    let running = opening;
    const rows = [];
    for (const l of all.filter((x) => x.date >= args.from).sort((a, b) => a.date - b.date || a._creationTime - b._creationTime)) {
      const e = await ctx.db.get(l.entryId);
      running = r2(running + (DEBIT_NORMAL.has(account.type) ? l.debit - l.credit : l.credit - l.debit));
      rows.push({ ...l, entryNumber: e?.number ?? "", memo: l.memo ?? e?.memo ?? "", sourceType: e?.sourceType ?? "", balance: running });
    }
    return { account, opening, closing: running, rows };
  },
});

// ───────────── Financial statements ─────────────
export const trialBalance = query({
  args: { asOf: v.number(), branchId: v.optional(v.id("branches")) },
  handler: async (ctx, { asOf, branchId }) => {
    const member = await requirePerm(ctx, "reports.financial");
    const accts = await ctx.db.query("accounts").collect();
    const sums = new Map<string, { d: number; c: number }>();
    for (const l of await lines(ctx, member, { to: asOf, branchId })) {
      const s = sums.get(l.accountId) ?? { d: 0, c: 0 };
      s.d += l.debit;
      s.c += l.credit;
      sums.set(l.accountId, s);
    }
    const rows = accts
      .map((a) => {
        const s = sums.get(a._id) ?? { d: 0, c: 0 };
        const net = r2(s.d - s.c);
        return { _id: a._id, code: a.code, name: a.name, type: a.type, debit: net > 0 ? net : 0, credit: net < 0 ? -net : 0 };
      })
      .filter((r) => r.debit || r.credit)
      .sort((a, b) => a.code.localeCompare(b.code));
    return {
      rows,
      totalDebit: r2(rows.reduce((a, r) => a + r.debit, 0)),
      totalCredit: r2(rows.reduce((a, r) => a + r.credit, 0)),
    };
  },
});

async function pnl(ctx: QueryCtx, member: Doc<"members">, from: number, to: number, branchId?: Id<"branches">) {
  const accts = await ctx.db.query("accounts").collect();
  const sums = new Map<string, { d: number; c: number }>();
  for (const l of await lines(ctx, member, { from, to, branchId })) {
    const s = sums.get(l.accountId) ?? { d: 0, c: 0 };
    s.d += l.debit;
    s.c += l.credit;
    sums.set(l.accountId, s);
  }
  const section = (type: string) =>
    accts
      .filter((a) => a.type === type)
      .map((a) => {
        const s = sums.get(a._id) ?? { d: 0, c: 0 };
        return { _id: a._id, code: a.code, name: a.name, amount: balanceOf(type, s.d, s.c) };
      })
      .filter((x) => x.amount !== 0)
      .sort((a, b) => a.code.localeCompare(b.code));
  const revenue = section("revenue");
  const cogs = section("cogs");
  const expenses = section("expense");
  const otherIncome = section("other_income");
  const otherExpenses = section("other_expense");
  const t = (xs: { amount: number }[]) => r2(xs.reduce((a, x) => a + x.amount, 0));
  const totalRevenue = t(revenue);
  const totalCogs = t(cogs);
  const grossProfit = r2(totalRevenue - totalCogs);
  const totalExpenses = t(expenses);
  const operatingProfit = r2(grossProfit - totalExpenses);
  const netProfit = r2(operatingProfit + t(otherIncome) - t(otherExpenses));
  return {
    revenue, cogs, expenses, otherIncome, otherExpenses,
    totalRevenue, totalCogs, grossProfit, totalExpenses, operatingProfit,
    totalOtherIncome: t(otherIncome), totalOtherExpenses: t(otherExpenses), netProfit,
    grossMargin: totalRevenue ? Math.round((grossProfit / totalRevenue) * 1000) / 10 : 0,
  };
}

export const profitAndLoss = query({
  args: { from: v.number(), to: v.number(), branchId: v.optional(v.id("branches")) },
  handler: async (ctx, { from, to, branchId }) => {
    const member = await requirePerm(ctx, "reports.financial");
    return await pnl(ctx, member, from, to, branchId);
  },
});

/** Profit by branch for the period (branch profitability). */
export const branchProfitability = query({
  args: { from: v.number(), to: v.number() },
  handler: async (ctx, { from, to }) => {
    const member = await requirePerm(ctx, "reports.financial");
    const allowed = allowedBranches(member);
    const branches = (await ctx.db.query("branches").collect()).filter((b) => allowed === null || allowed.has(b._id));
    const out = [];
    for (const b of branches) {
      const p = await pnl(ctx, member, from, to, b._id);
      out.push({ branchId: b._id, branch: b.name, revenue: p.totalRevenue, cogs: p.totalCogs, grossProfit: p.grossProfit, expenses: p.totalExpenses, netProfit: p.netProfit, grossMargin: p.grossMargin });
    }
    return out;
  },
});

export const balanceSheet = query({
  args: { asOf: v.number(), branchId: v.optional(v.id("branches")) },
  handler: async (ctx, { asOf, branchId }) => {
    const member = await requirePerm(ctx, "reports.financial");
    const company = await ctx.db.query("companies").first();
    const accts = await ctx.db.query("accounts").collect();
    const sums = new Map<string, { d: number; c: number }>();
    for (const l of await lines(ctx, member, { to: asOf, branchId })) {
      const s = sums.get(l.accountId) ?? { d: 0, c: 0 };
      s.d += l.debit;
      s.c += l.credit;
      sums.set(l.accountId, s);
    }
    const section = (type: string) =>
      accts
        .filter((a) => a.type === type)
        .map((a) => {
          const s = sums.get(a._id) ?? { d: 0, c: 0 };
          return { _id: a._id, code: a.code, name: a.name, subtype: a.subtype ?? "", amount: balanceOf(type, s.d, s.c) };
        })
        .filter((x) => x.amount !== 0)
        .sort((a, b) => a.code.localeCompare(b.code));

    // Fiscal-year start for "current year earnings"
    const d = new Date(asOf);
    const startMonth = (company?.fiscalYearStartMonth ?? 1) - 1;
    let fyYear = d.getFullYear();
    if (d.getMonth() < startMonth) fyYear -= 1;
    const fyStart = new Date(fyYear, startMonth, 1).getTime();

    const allPnl = await pnl(ctx, member, 0, asOf, branchId);
    const yearPnl = await pnl(ctx, member, fyStart, asOf, branchId);
    const assets = section("asset");
    const liabilities = section("liability");
    const equity = section("equity");
    const priorEarnings = r2(allPnl.netProfit - yearPnl.netProfit);
    if (priorEarnings) equity.push({ _id: "prior" as any, code: "", name: "Retained earnings (prior years)", subtype: "", amount: priorEarnings });
    equity.push({ _id: "current" as any, code: "", name: "Current year earnings", subtype: "", amount: yearPnl.netProfit });
    const t = (xs: { amount: number }[]) => r2(xs.reduce((a, x) => a + x.amount, 0));
    const totalAssets = t(assets);
    const totalLiabilities = t(liabilities);
    const totalEquity = t(equity);
    return {
      assets, liabilities, equity, totalAssets, totalLiabilities, totalEquity,
      totalLiabilitiesAndEquity: r2(totalLiabilities + totalEquity),
      balanced: Math.abs(totalAssets - totalLiabilities - totalEquity) < 0.01,
    };
  },
});

/** Direct-method cash flow: classifies every cash/bank movement by its counterpart accounts. */
export const cashFlow = query({
  args: { from: v.number(), to: v.number(), branchId: v.optional(v.id("branches")) },
  handler: async (ctx, { from, to, branchId }) => {
    const member = await requirePerm(ctx, "reports.financial");
    const accts = await ctx.db.query("accounts").collect();
    const acc = (id: string) => accts.find((a) => a._id === id);
    const cashIds = new Set(accts.filter((a) => a.isCashOrBank).map((a) => a._id as string));
    const periodLines = await lines(ctx, member, { from, to, branchId });
    const byEntry = new Map<string, typeof periodLines>();
    for (const l of periodLines) byEntry.set(l.entryId, [...(byEntry.get(l.entryId) ?? []), l]);
    const buckets: Record<string, number> = {};
    const add = (k: string, n: number) => (buckets[k] = r2((buckets[k] ?? 0) + n));
    for (const [, ls] of byEntry) {
      const cash = ls.filter((l) => cashIds.has(l.accountId));
      if (!cash.length) continue;
      const netCash = cash.reduce((a, l) => a + l.debit - l.credit, 0);
      if (Math.abs(netCash) < 0.005) continue; // transfer between cash accounts
      const others = ls.filter((l) => !cashIds.has(l.accountId));
      const a = acc(others[0]?.accountId ?? "");
      let k = "Other operating";
      if (a?.systemKey === "ar" || a?.type === "revenue") k = "Receipts from customers";
      else if (a?.systemKey === "ap" || a?.systemKey === "grni" || a?.systemKey === "inventory") k = "Payments to suppliers";
      else if (a?.type === "expense" || a?.type === "cogs" || a?.type === "other_expense") k = "Operating expenses paid";
      else if (a?.systemKey === "tax_payable" || a?.systemKey === "tax_input") k = "Taxes";
      else if (a?.subtype === "fixed") k = "Investing: fixed assets";
      else if (a?.type === "equity" || a?.subtype === "long_term") k = "Financing: owners & loans";
      else if (a?.type === "other_income") k = "Other income received";
      add(k, netCash);
    }
    const opening = await lines(ctx, member, { to: from - 1, branchId });
    const openingCash = r2(opening.filter((l) => cashIds.has(l.accountId)).reduce((a, l) => a + l.debit - l.credit, 0));
    const netChange = r2(Object.values(buckets).reduce((a, n) => a + n, 0));
    const isOp = (k: string) => !k.startsWith("Investing") && !k.startsWith("Financing");
    return {
      operating: Object.entries(buckets).filter(([k]) => isOp(k)).map(([label, amount]) => ({ label, amount })),
      investing: Object.entries(buckets).filter(([k]) => k.startsWith("Investing")).map(([label, amount]) => ({ label, amount })),
      financing: Object.entries(buckets).filter(([k]) => k.startsWith("Financing")).map(([label, amount]) => ({ label, amount })),
      openingCash,
      netChange,
      closingCash: r2(openingCash + netChange),
    };
  },
});

// ───────────── Aging ─────────────
function bucket(daysOverdue: number) {
  if (daysOverdue <= 0) return "current";
  if (daysOverdue <= 30) return "d1_30";
  if (daysOverdue <= 60) return "d31_60";
  if (daysOverdue <= 90) return "d61_90";
  return "d90_plus";
}

export const receivablesAging = query({
  args: { asOf: v.optional(v.number()) },
  handler: async (ctx, { asOf }) => {
    const member = await requirePerm(ctx, "reports.view");
    const now = asOf ?? Date.now();
    const allowed = allowedBranches(member);
    const invoices = (await ctx.db.query("salesDocs").withIndex("by_kind_status", (q) => q.eq("kind", "invoice")).collect()).filter(
      (i) => (i.status === "open" || i.status === "partial") && (allowed === null || allowed.has(i.branchId)),
    );
    const customers = await ctx.db.query("customers").collect();
    const map = new Map<string, any>();
    for (const i of invoices) {
      const due = r2(i.total - i.amountPaid);
      const b = bucket(Math.floor((now - (i.dueDate ?? i.date)) / DAY));
      const row = map.get(i.customerId) ?? { customerId: i.customerId, name: customers.find((c) => c._id === i.customerId)?.name ?? "", current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0, total: 0 };
      row[b] = r2(row[b] + due);
      row.total = r2(row.total + due);
      map.set(i.customerId, row);
    }
    return [...map.values()].sort((a, b) => b.total - a.total);
  },
});

export const payablesAging = query({
  args: { asOf: v.optional(v.number()) },
  handler: async (ctx, { asOf }) => {
    const member = await requirePerm(ctx, "reports.view");
    const now = asOf ?? Date.now();
    const allowed = allowedBranches(member);
    const bills = (await ctx.db.query("supplierBills").collect()).filter(
      (b) => b.kind === "bill" && (b.status === "open" || b.status === "partial") && (allowed === null || allowed.has(b.branchId)),
    );
    const suppliers = await ctx.db.query("suppliers").collect();
    const map = new Map<string, any>();
    for (const bill of bills) {
      const due = r2(bill.total - bill.amountPaid);
      const b = bucket(Math.floor((now - bill.dueDate) / DAY));
      const row = map.get(bill.supplierId) ?? { supplierId: bill.supplierId, name: suppliers.find((s) => s._id === bill.supplierId)?.name ?? "", current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0, total: 0 };
      row[b] = r2(row[b] + due);
      row.total = r2(row.total + due);
      map.set(bill.supplierId, row);
    }
    return [...map.values()].sort((a, b) => b.total - a.total);
  },
});

// ───────────── Fiscal periods ─────────────
export const periods = query({
  args: {},
  handler: async (ctx) => {
    await requirePerm(ctx, "accounting.view");
    return (await ctx.db.query("fiscalPeriods").collect()).sort((a, b) => a.startDate - b.startDate);
  },
});

export const setPeriodStatus = mutation({
  args: { id: v.id("fiscalPeriods"), status: v.string() },
  handler: async (ctx, { id, status }) => {
    const member = await requirePerm(ctx, "accounting.periods");
    if (status !== "open" && status !== "closed") throw new ConvexError("Invalid status.");
    const p = await ctx.db.get(id);
    if (!p) throw new ConvexError("Period not found.");
    await ctx.db.patch(id, { status, closedBy: status === "closed" ? member._id : undefined, closedAt: status === "closed" ? Date.now() : undefined });
    await audit(ctx, member, `period.${status}`, "fiscalPeriods", id, p.name);
  },
});

export const addFiscalYear = mutation({
  args: { startYear: v.number() },
  handler: async (ctx, { startYear }) => {
    const member = await requirePerm(ctx, "accounting.periods");
    const company = await ctx.db.query("companies").first();
    const m = (company?.fiscalYearStartMonth ?? 1) - 1;
    const existing = await ctx.db.query("fiscalPeriods").collect();
    let added = 0;
    for (let i = 0; i < 12; i++) {
      const start = new Date(startYear, m + i, 1).getTime();
      if (existing.some((p) => p.startDate === start)) continue;
      await ctx.db.insert("fiscalPeriods", {
        name: new Date(start).toLocaleString("en-US", { month: "short", year: "numeric" }),
        startDate: start,
        endDate: new Date(startYear, m + i + 1, 1).getTime() - 1,
        status: "open",
      });
      added++;
    }
    await audit(ctx, member, "period.year_added", "fiscalPeriods", String(startYear), { added });
    return added;
  },
});

// ───────────── Bank reconciliation ─────────────
export const reconciliationData = query({
  args: { accountId: v.id("accounts"), statementDate: v.number() },
  handler: async (ctx, { accountId, statementDate }) => {
    await requirePerm(ctx, "accounting.reconcile");
    const account = await ctx.db.get(accountId);
    if (!account?.isCashOrBank) return null;
    const recs = await ctx.db.query("bankReconciliations").withIndex("by_account", (q) => q.eq("accountId", accountId)).collect();
    const cleared = new Set(recs.filter((r) => r.status === "completed").flatMap((r) => r.clearedLineIds as string[]));
    const all = await ctx.db.query("journalLines").withIndex("by_account_date", (q) => q.eq("accountId", accountId).lte("date", statementDate)).collect();
    const clearedBalance = r2(all.filter((l) => cleared.has(l._id)).reduce((a, l) => a + l.debit - l.credit, 0));
    const bookBalance = r2(all.reduce((a, l) => a + l.debit - l.credit, 0));
    const open = [];
    for (const l of all.filter((x) => !cleared.has(x._id)).sort((a, b) => a.date - b.date)) {
      const e = await ctx.db.get(l.entryId);
      open.push({ ...l, entryNumber: e?.number ?? "", memo: l.memo ?? e?.memo ?? "" });
    }
    return { account, clearedBalance, bookBalance, open, history: recs.sort((a, b) => b.statementDate - a.statementDate) };
  },
});

export const completeReconciliation = mutation({
  args: { accountId: v.id("accounts"), statementDate: v.number(), statementBalance: v.number(), clearedLineIds: v.array(v.id("journalLines")) },
  handler: async (ctx, args) => {
    const member = await requirePerm(ctx, "accounting.reconcile");
    const prev = await ctx.db.query("bankReconciliations").withIndex("by_account", (q) => q.eq("accountId", args.accountId)).collect();
    const already = new Set(prev.filter((r) => r.status === "completed").flatMap((r) => r.clearedLineIds as string[]));
    let cleared = 0;
    for (const id of [...already]) {
      const l = await ctx.db.get(id as Id<"journalLines">);
      if (l) cleared += l.debit - l.credit;
    }
    for (const id of args.clearedLineIds) {
      if (already.has(id)) continue;
      const l = await ctx.db.get(id);
      if (!l || l.accountId !== args.accountId) throw new ConvexError("Invalid line.");
      cleared += l.debit - l.credit;
    }
    const difference = r2(args.statementBalance - cleared);
    if (Math.abs(difference) > 0.009) {
      throw new ConvexError(`Not reconciled: cleared balance ${r2(cleared)} differs from statement by ${difference}.`);
    }
    const all = await ctx.db.query("journalLines").withIndex("by_account_date", (q) => q.eq("accountId", args.accountId).lte("date", args.statementDate)).collect();
    const id = await ctx.db.insert("bankReconciliations", {
      accountId: args.accountId,
      statementDate: args.statementDate,
      statementBalance: args.statementBalance,
      bookBalance: r2(all.reduce((a, l) => a + l.debit - l.credit, 0)),
      clearedLineIds: args.clearedLineIds.filter((x) => !already.has(x)),
      difference: 0,
      status: "completed",
      createdBy: member._id,
    });
    await audit(ctx, member, "bank.reconciled", "bankReconciliations", id, { statementBalance: args.statementBalance });
    return id;
  },
});
