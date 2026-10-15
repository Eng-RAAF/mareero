import { v, ConvexError } from "convex/values";
import { mutation, query } from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";
import { DEFAULT_ACCOUNTS } from "./lib/ledger";
import { ROLES } from "./lib/permissions";
import { audit } from "./lib/system";
import { getMember, requirePerm, allowedBranches } from "./lib/access";
import { applyMovement } from "./lib/stock";
import { postJournal } from "./lib/ledger";
import { nextNumber } from "./lib/system";
import { r2 } from "./lib/money";

/** What the app needs to decide which screen to show. */
export const status = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    const company = await ctx.db.query("companies").first();
    if (!userId) return { signedIn: false, hasCompany: !!company } as const;
    const user = await ctx.db.get(userId);
    const member = await getMember(ctx);
    let pendingInvite = false;
    if (!member && user?.email) {
      const invite = await ctx.db
        .query("members")
        .withIndex("by_email", (q) => q.eq("email", user.email!.toLowerCase()))
        .first();
      pendingInvite = !!invite && !invite.userId;
    }
    return {
      signedIn: true,
      hasCompany: !!company,
      email: user?.email ?? null,
      hasMember: !!member,
      pendingInvite,
    } as const;
  },
});

/** Current member, permissions, company and the branches/stores they can use. */
export const me = query({
  args: {},
  handler: async (ctx) => {
    const member = await getMember(ctx);
    if (!member) return null;
    const company = await ctx.db.query("companies").first();
    const allowed = allowedBranches(member);
    const branches = (await ctx.db.query("branches").collect()).filter(
      (b) => allowed === null || allowed.has(b._id),
    );
    const branchSet = new Set(branches.map((b) => b._id as string));
    const stores = (await ctx.db.query("stores").collect()).filter((s) => branchSet.has(s.branchId));
    const unread = await ctx.db
      .query("notifications")
      .withIndex("by_member", (q) => q.eq("memberId", member._id).eq("read", false))
      .collect();
    return {
      member,
      roleLabel: ROLES[member.role]?.label ?? member.role,
      permissions: ROLES[member.role]?.permissions ?? [],
      company,
      branches,
      stores,
      unreadNotifications: unread.length,
    };
  },
});

/** First run: create company, head office, main store, chart of accounts, periods, admin. */
export const initialize = mutation({
  args: {
    companyName: v.string(),
    adminName: v.string(),
    currency: v.string(),
    defaultTaxRate: v.number(),
    fiscalYearStartMonth: v.number(),
    branchName: v.string(),
    branchCode: v.string(),
    storeName: v.string(),
    address: v.optional(v.string()),
    phone: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new ConvexError("Sign in first.");
    if (await ctx.db.query("companies").first()) {
      throw new ConvexError("The company is already set up.");
    }
    const user = await ctx.db.get(userId);

    await ctx.db.insert("companies", {
      name: args.companyName.trim(),
      address: args.address,
      phone: args.phone,
      currency: args.currency.trim().toUpperCase() || "USD",
      fiscalYearStartMonth: args.fiscalYearStartMonth,
      defaultTaxRate: args.defaultTaxRate,
      valuationMethod: "weighted_average",
      allowNegativeStock: false,
      requireApprovalAbove: 5000,
      setupComplete: true,
    });

    const branchId = await ctx.db.insert("branches", {
      name: args.branchName.trim(),
      code: args.branchCode.trim().toUpperCase(),
      isHeadOffice: true,
      active: true,
    });
    await ctx.db.insert("stores", {
      branchId,
      name: args.storeName.trim(),
      code: `${args.branchCode.trim().toUpperCase()}-MAIN`,
      kind: "main",
      active: true,
    });

    const memberId = await ctx.db.insert("members", {
      userId,
      name: args.adminName.trim(),
      email: (user?.email ?? "").toLowerCase(),
      role: "super_admin",
      branchIds: [branchId],
      active: true,
    });

    for (const a of DEFAULT_ACCOUNTS) {
      await ctx.db.insert("accounts", {
        code: a.code,
        name: a.name,
        type: a.type,
        subtype: a.subtype,
        systemKey: a.systemKey,
        isCashOrBank: !!a.isCashOrBank,
        active: true,
      });
    }

    if (args.defaultTaxRate > 0) {
      await ctx.db.insert("taxRates", { name: `Standard ${args.defaultTaxRate}%`, rate: args.defaultTaxRate, active: true });
    }
    await ctx.db.insert("taxRates", { name: "Exempt 0%", rate: 0, active: true });

    // Monthly fiscal periods for the current fiscal year
    const now = new Date();
    let year = now.getFullYear();
    if (now.getMonth() + 1 < args.fiscalYearStartMonth) year -= 1;
    for (let i = 0; i < 12; i++) {
      const start = new Date(year, args.fiscalYearStartMonth - 1 + i, 1);
      const end = new Date(year, args.fiscalYearStartMonth + i, 1).getTime() - 1;
      await ctx.db.insert("fiscalPeriods", {
        name: start.toLocaleString("en-US", { month: "short", year: "numeric" }),
        startDate: start.getTime(),
        endDate: end,
        status: "open",
      });
    }

    const member = await ctx.db.get(memberId);
    await audit(ctx, member, "company.initialized", "companies", "", { company: args.companyName });
    return memberId;
  },
});

/** Invited people sign up with the invited email, then call this to link their account. */
export const claimInvite = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new ConvexError("Sign in first.");
    const user = await ctx.db.get(userId);
    if (!user?.email) throw new ConvexError("Your account has no email.");
    const invite = await ctx.db
      .query("members")
      .withIndex("by_email", (q) => q.eq("email", user.email!.toLowerCase()))
      .first();
    if (!invite || invite.userId) throw new ConvexError("No pending invitation for this email.");
    await ctx.db.patch(invite._id, { userId });
    await audit(ctx, invite, "member.joined", "members", invite._id, user.email);
    return invite._id;
  },
});

/**
 * Optional: loads a small realistic catalogue so the team can try every workflow.
 * Super Admin only, and only while the catalogue is empty.
 */
export const loadSampleData = mutation({
  args: {},
  handler: async (ctx) => {
    const member = await requirePerm(ctx, "settings.manage");
    if (await ctx.db.query("products").first()) {
      throw new ConvexError("Sample data can only be loaded into an empty catalogue.");
    }
    const store = await ctx.db.query("stores").first();
    if (!store) throw new ConvexError("Create a store first.");
    const now = Date.now();

    const cat = async (name: string) => ctx.db.insert("categories", { name });
    const brand = async (name: string) => ctx.db.insert("brands", { name });
    const cats = {
      filters: await cat("Filters"),
      brakes: await cat("Brakes"),
      engine: await cat("Engine Parts"),
      electrical: await cat("Electrical"),
      suspension: await cat("Suspension"),
      oils: await cat("Oils & Lubricants"),
    };
    const brands = {
      toyota: await brand("Toyota Genuine"),
      denso: await brand("Denso"),
      bosch: await brand("Bosch"),
      kyb: await brand("KYB"),
      shell: await brand("Shell"),
      ngk: await brand("NGK"),
    };

    const supA = await ctx.db.insert("suppliers", {
      name: "Gulf Auto Parts Trading LLC",
      code: "SUP-001",
      contactName: "Ahmed",
      phone: "+971 4 000 0000",
      paymentTermsDays: 30,
      currency: "USD",
      leadTimeDays: 14,
      balance: 0,
      active: true,
    });
    const supB = await ctx.db.insert("suppliers", {
      name: "Nairobi Motor Spares Ltd",
      code: "SUP-002",
      contactName: "Wanjiru",
      phone: "+254 700 000 000",
      paymentTermsDays: 15,
      currency: "USD",
      leadTimeDays: 6,
      balance: 0,
      active: true,
    });

    await ctx.db.insert("customers", {
      name: "Garowe Auto Garage",
      code: "CUS-001",
      phone: "+252 90 000 0000",
      creditLimit: 3000,
      paymentTermsDays: 30,
      priceLevel: "wholesale",
      balance: 0,
      active: true,
    });
    await ctx.db.insert("customers", {
      name: "Walk-in Customer",
      code: "CUS-002",
      creditLimit: 0,
      paymentTermsDays: 0,
      priceLevel: "retail",
      balance: 0,
      active: true,
    });

    const items: Array<[string, string, string, any, any, string, string, number, number, number, number, any]> = [
      ["OF-90915", "Oil Filter", "90915-YZZE1", cats.filters, brands.toyota, "Toyota", "Land Cruiser / Hilux", 4.5, 9, 7.5, 120, supB],
      ["AF-17801", "Air Filter", "17801-0C010", cats.filters, brands.toyota, "Toyota", "Hilux 2005-2015", 7, 14, 11.5, 60, supB],
      ["BP-04465", "Front Brake Pads", "04465-0K290", cats.brakes, brands.toyota, "Toyota", "Hilux Vigo", 18, 35, 29, 40, supA],
      ["BD-43512", "Brake Disc Front", "43512-0K090", cats.brakes, brands.denso, "Toyota", "Hilux Vigo", 32, 58, 49, 16, supA],
      ["SP-BKR6E", "Spark Plug BKR6E", "BKR6E", cats.engine, brands.ngk, "Universal", "Petrol engines", 2.2, 5, 3.8, 200, supB],
      ["TB-13568", "Timing Belt", "13568-69175", cats.engine, brands.denso, "Toyota", "1KZ / 1KD", 25, 48, 40, 18, supA],
      ["AL-27060", "Alternator 12V 80A", "27060-0L030", cats.electrical, brands.bosch, "Toyota", "Hilux 2KD", 140, 245, 215, 6, supA],
      ["BT-N70", "Battery N70 12V", "N70", cats.electrical, brands.bosch, "Universal", "Trucks & SUVs", 85, 140, 125, 10, supB],
      ["SA-334", "Shock Absorber Rear", "KYB-344428", cats.suspension, brands.kyb, "Toyota", "Land Cruiser 79", 38, 70, 60, 24, supA],
      ["EO-15W40", "Engine Oil 15W-40 (5L)", "HELIX-HX5", cats.oils, brands.shell, "Universal", "Diesel engines", 16, 28, 24, 80, supB],
    ];

    const entryNumber = await nextNumber(ctx, "adjustment", "ADJ");
    let totalValue = 0;
    for (const [sku, name, pn, categoryId, brandId, make, model, cost, retail, wholesale, qty, supplierId] of items) {
      const productId = await ctx.db.insert("products", {
        sku,
        name,
        partNumber: pn,
        categoryId,
        brandId,
        vehicleMake: make,
        vehicleModel: model,
        unit: "pcs",
        purchaseCost: cost,
        retailPrice: retail,
        wholesalePrice: wholesale,
        preferredSupplierId: supplierId,
        status: "active",
        searchText: [sku, name, pn, make, model].join(" ").toLowerCase(),
      });
      await applyMovement(ctx, {
        productId,
        storeId: store._id,
        qty,
        unitCost: cost,
        type: "opening",
        sourceType: "opening",
        sourceId: entryNumber,
        reference: entryNumber,
        date: now,
        member,
        note: "Opening stock (sample data)",
      });
      totalValue += qty * cost;
      const demand = Math.max(1, Math.round(qty / 30));
      const lead = supplierId === supA ? 14 : 6;
      const safety = Math.ceil(demand * 3);
      await ctx.db.insert("reorderSettings", {
        productId,
        storeId: store._id,
        branchId: store.branchId,
        minStock: safety,
        reorderPoint: demand * lead + safety,
        maxStock: qty * 2,
        safetyStock: safety,
        avgDailyDemand: demand,
        autoDemand: true,
        leadTimeDays: lead,
        targetStock: Math.round(qty * 1.5),
        minOrderQty: 1,
        orderMultiple: 1,
        reviewDays: 7,
        preferredSupplierId: supplierId,
        autoReorderPoint: true,
      });
    }

    await postJournal(ctx, {
      date: now,
      memo: "Opening inventory (sample data)",
      sourceType: "adjustment",
      sourceId: entryNumber,
      branchId: store.branchId,
      member,
      lines: [
        { account: "inventory", debit: r2(totalValue) },
        { account: "opening_equity", credit: r2(totalValue) },
      ],
    });

    await audit(ctx, member, "sample_data.loaded", "products", "", `${items.length} products`);
    return items.length;
  },
});
