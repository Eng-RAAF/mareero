import { v, ConvexError } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireMember, requirePerm, allowedBranches, has } from "./lib/access";
import { audit } from "./lib/system";
import { ROLES } from "./lib/permissions";

// ───────────── Company ─────────────
export const updateCompany = mutation({
  args: {
    name: v.string(),
    address: v.optional(v.string()),
    phone: v.optional(v.string()),
    email: v.optional(v.string()),
    taxId: v.optional(v.string()),
    currency: v.string(),
    defaultTaxRate: v.number(),
    fiscalYearStartMonth: v.number(),
    allowNegativeStock: v.boolean(),
    requireApprovalAbove: v.number(),
  },
  handler: async (ctx, args) => {
    const member = await requirePerm(ctx, "settings.manage");
    const company = await ctx.db.query("companies").first();
    if (!company) throw new ConvexError("Company not set up.");
    await ctx.db.patch(company._id, args);
    await audit(ctx, member, "company.updated", "companies", company._id, args);
  },
});

export const generateUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    await requireMember(ctx);
    return await ctx.storage.generateUploadUrl();
  },
});

export const setLogo = mutation({
  args: { storageId: v.id("_storage") },
  handler: async (ctx, { storageId }) => {
    const member = await requirePerm(ctx, "settings.manage");
    const company = await ctx.db.query("companies").first();
    if (!company) throw new ConvexError("Company not set up.");
    await ctx.db.patch(company._id, { logoStorageId: storageId });
    await audit(ctx, member, "company.logo", "companies", company._id);
  },
});

export const logoUrl = query({
  args: {},
  handler: async (ctx) => {
    const company = await ctx.db.query("companies").first();
    if (!company?.logoStorageId) return null;
    return await ctx.storage.getUrl(company.logoStorageId);
  },
});

// ───────────── Branches & stores ─────────────
export const listBranches = query({
  args: {},
  handler: async (ctx) => {
    const member = await requireMember(ctx);
    const allowed = allowedBranches(member);
    const branches = (await ctx.db.query("branches").collect()).filter(
      (b) => allowed === null || allowed.has(b._id),
    );
    const stores = await ctx.db.query("stores").collect();
    const members = await ctx.db.query("members").collect();
    return branches.map((b) => ({
      ...b,
      manager: members.find((m) => m._id === b.managerMemberId)?.name ?? null,
      stores: stores
        .filter((s) => s.branchId === b._id)
        .map((s) => ({ ...s, manager: members.find((m) => m._id === s.managerMemberId)?.name ?? null })),
    }));
  },
});

/** Every active store in the company (for choosing a transfer source/destination). */
export const allStores = query({
  args: {},
  handler: async (ctx) => {
    await requireMember(ctx);
    const branches = await ctx.db.query("branches").collect();
    return (await ctx.db.query("stores").collect())
      .filter((s) => s.active)
      .map((s) => ({ _id: s._id, name: s.name, branchId: s.branchId, branchName: branches.find((b) => b._id === s.branchId)?.name ?? "" }));
  },
});

export const saveBranch = mutation({
  args: {
    id: v.optional(v.id("branches")),
    name: v.string(),
    code: v.string(),
    address: v.optional(v.string()),
    phone: v.optional(v.string()),
    managerMemberId: v.optional(v.id("members")),
    isHeadOffice: v.boolean(),
    active: v.boolean(),
  },
  handler: async (ctx, { id, ...data }) => {
    const member = await requirePerm(ctx, "branches.manage");
    data.code = data.code.trim().toUpperCase();
    const dup = await ctx.db.query("branches").withIndex("by_code", (q) => q.eq("code", data.code)).first();
    if (dup && dup._id !== id) throw new ConvexError(`Branch code ${data.code} is already used.`);
    if (id) {
      await ctx.db.patch(id, data);
      await audit(ctx, member, "branch.updated", "branches", id, data, id);
      return id;
    }
    const newId = await ctx.db.insert("branches", data);
    await ctx.db.insert("stores", {
      branchId: newId,
      name: `${data.name} Main Store`,
      code: `${data.code}-MAIN`,
      kind: "main",
      active: true,
    });
    await audit(ctx, member, "branch.created", "branches", newId, data, newId);
    return newId;
  },
});

export const saveStore = mutation({
  args: {
    id: v.optional(v.id("stores")),
    branchId: v.id("branches"),
    name: v.string(),
    code: v.string(),
    kind: v.string(),
    managerMemberId: v.optional(v.id("members")),
    active: v.boolean(),
  },
  handler: async (ctx, { id, ...data }) => {
    const member = await requirePerm(ctx, "branches.manage");
    data.code = data.code.trim().toUpperCase();
    const dup = await ctx.db.query("stores").withIndex("by_code", (q) => q.eq("code", data.code)).first();
    if (dup && dup._id !== id) throw new ConvexError(`Store code ${data.code} is already used.`);
    if (id) {
      await ctx.db.patch(id, data);
      await audit(ctx, member, "store.updated", "stores", id, data, data.branchId);
      return id;
    }
    const newId = await ctx.db.insert("stores", data);
    await audit(ctx, member, "store.created", "stores", newId, data, data.branchId);
    return newId;
  },
});

// ───────────── Users / members ─────────────
export const listMembers = query({
  args: {},
  handler: async (ctx) => {
    await requirePerm(ctx, "users.manage");
    const members = await ctx.db.query("members").collect();
    return members.map((m) => ({ ...m, roleLabel: ROLES[m.role]?.label ?? m.role, joined: !!m.userId }));
  },
});

/** Lightweight list for pickers (managers, approvers). */
export const memberOptions = query({
  args: {},
  handler: async (ctx) => {
    await requireMember(ctx);
    const members = await ctx.db.query("members").collect();
    return members.filter((m) => m.active).map((m) => ({ _id: m._id, name: m.name, role: m.role }));
  },
});

export const roles = query({
  args: {},
  handler: async () =>
    Object.entries(ROLES).map(([key, r]) => ({ key, label: r.label, permissions: r.permissions })),
});

export const saveMember = mutation({
  args: {
    id: v.optional(v.id("members")),
    name: v.string(),
    email: v.string(),
    role: v.string(),
    branchIds: v.array(v.id("branches")),
    active: v.boolean(),
  },
  handler: async (ctx, { id, ...data }) => {
    const admin = await requirePerm(ctx, "users.manage");
    if (!ROLES[data.role]) throw new ConvexError("Unknown role.");
    data.email = data.email.trim().toLowerCase();
    const dup = await ctx.db.query("members").withIndex("by_email", (q) => q.eq("email", data.email)).first();
    if (dup && dup._id !== id) throw new ConvexError("A user with this email already exists.");
    if (id) {
      if (id === admin._id && (data.role !== admin.role || !data.active)) {
        throw new ConvexError("You cannot change your own role or deactivate yourself.");
      }
      await ctx.db.patch(id, data);
      await audit(ctx, admin, "member.updated", "members", id, data);
      return id;
    }
    const newId = await ctx.db.insert("members", { ...data, userId: undefined });
    await audit(ctx, admin, "member.invited", "members", newId, data);
    return newId;
  },
});

// ───────────── Notifications ─────────────
export const notifications = query({
  args: {},
  handler: async (ctx) => {
    const member = await requireMember(ctx);
    const unread = await ctx.db
      .query("notifications")
      .withIndex("by_member", (q) => q.eq("memberId", member._id).eq("read", false))
      .order("desc")
      .take(50);
    const read = await ctx.db
      .query("notifications")
      .withIndex("by_member", (q) => q.eq("memberId", member._id).eq("read", true))
      .order("desc")
      .take(30);
    return [...unread, ...read];
  },
});

export const markNotificationsRead = mutation({
  args: { ids: v.optional(v.array(v.id("notifications"))) },
  handler: async (ctx, { ids }) => {
    const member = await requireMember(ctx);
    const rows = ids
      ? await Promise.all(ids.map((id) => ctx.db.get(id)))
      : await ctx.db
          .query("notifications")
          .withIndex("by_member", (q) => q.eq("memberId", member._id).eq("read", false))
          .collect();
    for (const n of rows) {
      if (n && n.memberId === member._id && !n.read) await ctx.db.patch(n._id, { read: true });
    }
  },
});

// ───────────── Audit log ─────────────
export const auditLog = query({
  args: { entityType: v.optional(v.string()), limit: v.optional(v.number()) },
  handler: async (ctx, { entityType, limit }) => {
    const member = await requirePerm(ctx, "audit.view");
    const rows = await ctx.db.query("auditLogs").withIndex("by_at").order("desc").take(limit ?? 300);
    const allowed = allowedBranches(member);
    return rows.filter(
      (r) =>
        (!entityType || r.entityType === entityType) &&
        (allowed === null || !r.branchId || allowed.has(r.branchId) || has(member, "all_branches")),
    );
  },
});
