import { v, ConvexError } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireMember, requirePerm, has } from "./lib/access";
import { audit, nextNumber } from "./lib/system";
import { r2 } from "./lib/money";

// ───────────── Suppliers ─────────────
export const suppliers = query({
  args: { includeInactive: v.optional(v.boolean()) },
  handler: async (ctx, { includeInactive }) => {
    await requireMember(ctx);
    const rows = await ctx.db.query("suppliers").collect();
    return rows.filter((s) => includeInactive || s.active).sort((a, b) => a.name.localeCompare(b.name));
  },
});

export const saveSupplier = mutation({
  args: {
    id: v.optional(v.id("suppliers")),
    name: v.string(),
    contactName: v.optional(v.string()),
    phone: v.optional(v.string()),
    email: v.optional(v.string()),
    address: v.optional(v.string()),
    paymentTermsDays: v.number(),
    creditLimit: v.optional(v.number()),
    currency: v.string(),
    leadTimeDays: v.number(),
    active: v.boolean(),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, { id, ...data }) => {
    const member = await requirePerm(ctx, "suppliers.manage");
    if (!data.name.trim()) throw new ConvexError("Name is required.");
    if (id) {
      await ctx.db.patch(id, data);
      await audit(ctx, member, "supplier.updated", "suppliers", id, data.name);
      return id;
    }
    const code = await nextNumber(ctx, "supplier", "SUP");
    const newId = await ctx.db.insert("suppliers", { ...data, code, balance: 0 });
    await audit(ctx, member, "supplier.created", "suppliers", newId, data.name);
    return newId;
  },
});

export const supplierStatement = query({
  args: { id: v.id("suppliers") },
  handler: async (ctx, { id }) => {
    await requirePerm(ctx, "purchasing.view");
    const supplier = await ctx.db.get(id);
    if (!supplier) return null;
    const bills = await ctx.db.query("supplierBills").withIndex("by_supplier", (q) => q.eq("supplierId", id)).collect();
    const payments = await ctx.db.query("payments").withIndex("by_supplier", (q) => q.eq("supplierId", id)).collect();
    const pos = await ctx.db.query("purchaseOrders").withIndex("by_supplier", (q) => q.eq("supplierId", id)).collect();
    const events = [
      ...bills
        .filter((b) => b.status !== "void")
        .map((b) => ({
          date: b.date,
          type: b.kind === "debit_note" ? "Debit note" : "Bill",
          number: b.number,
          ref: b.supplierRef ?? "",
          charge: b.kind === "debit_note" ? 0 : b.total,
          credit: b.kind === "debit_note" ? b.total : 0,
        })),
      ...payments.map((p) => ({
        date: p.date,
        type: p.direction === "refund" ? "Refund received" : "Payment",
        number: p.number,
        ref: p.reference ?? "",
        charge: p.direction === "refund" ? p.amount : 0,
        credit: p.direction === "refund" ? 0 : p.amount,
      })),
    ].sort((a, b) => a.date - b.date);
    let running = 0;
    const lines = events.map((e) => {
      running = r2(running + e.charge - e.credit);
      return { ...e, balance: running };
    });
    return { supplier, lines, purchaseOrders: pos.sort((a, b) => b.date - a.date).slice(0, 50) };
  },
});

// ───────────── Customers ─────────────
export const customers = query({
  args: { includeInactive: v.optional(v.boolean()) },
  handler: async (ctx, { includeInactive }) => {
    await requireMember(ctx);
    const rows = await ctx.db.query("customers").collect();
    const invoices = await ctx.db.query("salesDocs").withIndex("by_kind_status", (q) => q.eq("kind", "invoice")).collect();
    const now = Date.now();
    return rows
      .filter((c) => includeInactive || c.active)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((c) => {
        const overdue = invoices
          .filter((i) => i.customerId === c._id && (i.status === "open" || i.status === "partial") && (i.dueDate ?? i.date) < now)
          .reduce((a, i) => a + (i.total - i.amountPaid), 0);
        return { ...c, overdue: r2(overdue) };
      });
  },
});

export const saveCustomer = mutation({
  args: {
    id: v.optional(v.id("customers")),
    name: v.string(),
    contactName: v.optional(v.string()),
    phone: v.optional(v.string()),
    email: v.optional(v.string()),
    address: v.optional(v.string()),
    creditLimit: v.number(),
    paymentTermsDays: v.number(),
    priceLevel: v.string(),
    active: v.boolean(),
  },
  handler: async (ctx, { id, ...data }) => {
    const member = await requirePerm(ctx, "customers.manage");
    if (!data.name.trim()) throw new ConvexError("Name is required.");
    if (id) {
      const existing = await ctx.db.get(id);
      if (existing && existing.creditLimit !== data.creditLimit && !has(member, "credit.override")) {
        throw new ConvexError("Only managers can change credit limits.");
      }
      await ctx.db.patch(id, data);
      await audit(ctx, member, "customer.updated", "customers", id, data);
      return id;
    }
    const code = await nextNumber(ctx, "customer", "CUS");
    const newId = await ctx.db.insert("customers", { ...data, code, balance: 0 });
    await audit(ctx, member, "customer.created", "customers", newId, data.name);
    return newId;
  },
});

export const customerStatement = query({
  args: { id: v.id("customers") },
  handler: async (ctx, { id }) => {
    await requirePerm(ctx, "sales.view");
    const customer = await ctx.db.get(id);
    if (!customer) return null;
    const docs = await ctx.db.query("salesDocs").withIndex("by_customer", (q) => q.eq("customerId", id)).collect();
    const payments = await ctx.db.query("payments").withIndex("by_customer", (q) => q.eq("customerId", id)).collect();
    const events = [
      ...docs
        .filter((d) => (d.kind === "invoice" || d.kind === "credit_note") && d.status !== "void")
        .map((d) => ({
          date: d.date,
          type: d.kind === "invoice" ? "Invoice" : "Credit note",
          number: d.number,
          ref: "",
          charge: d.kind === "invoice" ? d.total : 0,
          credit: d.kind === "credit_note" ? d.total : 0,
        })),
      ...payments.map((p) => ({
        date: p.date,
        type: p.direction === "refund" ? "Refund" : "Payment",
        number: p.number,
        ref: p.reference ?? "",
        charge: p.direction === "refund" ? p.amount : 0,
        credit: p.direction === "refund" ? 0 : p.amount,
      })),
    ].sort((a, b) => a.date - b.date);
    let running = 0;
    const lines = events.map((e) => {
      running = r2(running + e.charge - e.credit);
      return { ...e, balance: running };
    });
    const openInvoices = docs.filter((d) => d.kind === "invoice" && (d.status === "open" || d.status === "partial"));
    return { customer, lines, openInvoices, documents: docs.sort((a, b) => b.date - a.date).slice(0, 100) };
  },
});
