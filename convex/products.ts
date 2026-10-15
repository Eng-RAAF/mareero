import { v, ConvexError } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { requirePerm, allowedBranches } from "./lib/access";
import { audit } from "./lib/system";

const productFields = {
  sku: v.string(),
  name: v.string(),
  description: v.optional(v.string()),
  barcode: v.optional(v.string()),
  partNumber: v.optional(v.string()),
  brandId: v.optional(v.id("brands")),
  categoryId: v.optional(v.id("categories")),
  vehicleMake: v.optional(v.string()),
  vehicleModel: v.optional(v.string()),
  yearFrom: v.optional(v.number()),
  yearTo: v.optional(v.number()),
  engine: v.optional(v.string()),
  unit: v.string(),
  purchaseCost: v.number(),
  retailPrice: v.number(),
  wholesalePrice: v.number(),
  preferredSupplierId: v.optional(v.id("suppliers")),
  status: v.string(),
};

function searchText(p: { sku: string; name: string; partNumber?: string; barcode?: string; vehicleMake?: string; vehicleModel?: string; engine?: string; description?: string }) {
  return [p.sku, p.name, p.partNumber, p.barcode, p.vehicleMake, p.vehicleModel, p.engine, p.description]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

/** Catalogue list with stock totals across the stores the user can see. */
export const list = query({
  args: {
    search: v.optional(v.string()),
    categoryId: v.optional(v.id("categories")),
    storeId: v.optional(v.id("stores")),
    includeInactive: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const member = await requirePerm(ctx, "products.view");
    let products;
    if (args.search && args.search.trim()) {
      products = await ctx.db
        .query("products")
        .withSearchIndex("search", (q) => q.search("searchText", args.search!.toLowerCase()))
        .take(200);
    } else if (args.categoryId) {
      products = await ctx.db
        .query("products")
        .withIndex("by_category", (q) => q.eq("categoryId", args.categoryId))
        .collect();
    } else {
      products = await ctx.db.query("products").collect();
    }
    if (!args.includeInactive) products = products.filter((p) => p.status === "active");
    if (args.categoryId) products = products.filter((p) => p.categoryId === args.categoryId);

    const allowed = allowedBranches(member);
    const balances = (await ctx.db.query("inventoryBalances").collect()).filter(
      (b) => (allowed === null || allowed.has(b.branchId)) && (!args.storeId || b.storeId === args.storeId),
    );
    const categories = await ctx.db.query("categories").collect();
    const brands = await ctx.db.query("brands").collect();
    const byProduct = new Map<string, { onHand: number; reserved: number; incoming: number; value: number }>();
    for (const b of balances) {
      const cur = byProduct.get(b.productId) ?? { onHand: 0, reserved: 0, incoming: 0, value: 0 };
      cur.onHand += b.onHand;
      cur.reserved += b.reserved;
      cur.incoming += b.incoming;
      cur.value += b.onHand * b.avgCost;
      byProduct.set(b.productId, cur);
    }
    return products
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((p) => {
        const s = byProduct.get(p._id) ?? { onHand: 0, reserved: 0, incoming: 0, value: 0 };
        return {
          ...p,
          category: categories.find((c) => c._id === p.categoryId)?.name ?? "",
          brand: brands.find((b) => b._id === p.brandId)?.name ?? "",
          onHand: s.onHand,
          reserved: s.reserved,
          available: s.onHand - s.reserved,
          incoming: s.incoming,
          stockValue: Math.round(s.value * 100) / 100,
        };
      });
  },
});

/** Small list for line-item pickers. */
export const options = query({
  args: { storeId: v.optional(v.id("stores")) },
  handler: async (ctx, { storeId }) => {
    await requirePerm(ctx, "products.view");
    const products = (await ctx.db.query("products").collect()).filter((p) => p.status === "active");
    const balances = storeId
      ? await ctx.db.query("inventoryBalances").withIndex("by_store", (q) => q.eq("storeId", storeId)).collect()
      : [];
    return products
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((p) => {
        const b = balances.find((x) => x.productId === p._id);
        return {
          _id: p._id,
          sku: p.sku,
          name: p.name,
          partNumber: p.partNumber ?? "",
          barcode: p.barcode ?? "",
          unit: p.unit,
          purchaseCost: p.purchaseCost,
          retailPrice: p.retailPrice,
          wholesalePrice: p.wholesalePrice,
          preferredSupplierId: p.preferredSupplierId,
          onHand: b?.onHand ?? 0,
          available: (b?.onHand ?? 0) - (b?.reserved ?? 0),
          avgCost: b?.avgCost ?? p.purchaseCost,
        };
      });
  },
});

export const get = query({
  args: { id: v.id("products") },
  handler: async (ctx, { id }) => {
    const member = await requirePerm(ctx, "products.view");
    const product = await ctx.db.get(id);
    if (!product) return null;
    const allowed = allowedBranches(member);
    const stores = await ctx.db.query("stores").collect();
    const branches = await ctx.db.query("branches").collect();
    const balances = (
      await ctx.db.query("inventoryBalances").withIndex("by_product", (q) => q.eq("productId", id)).collect()
    ).filter((b) => allowed === null || allowed.has(b.branchId));
    const movements = (
      await ctx.db.query("stockMovements").withIndex("by_product", (q) => q.eq("productId", id)).order("desc").take(200)
    ).filter((m) => allowed === null || allowed.has(m.branchId));
    const settings = await ctx.db.query("reorderSettings").collect();
    return {
      product,
      balances: balances.map((b) => {
        const store = stores.find((s) => s._id === b.storeId);
        return {
          ...b,
          storeName: store?.name ?? "",
          branchName: branches.find((br) => br._id === b.branchId)?.name ?? "",
          reorder: settings.find((s) => s.productId === id && s.storeId === b.storeId) ?? null,
        };
      }),
      movements: movements.map((m) => ({ ...m, storeName: stores.find((s) => s._id === m.storeId)?.name ?? "" })),
    };
  },
});

export const findByCode = query({
  args: { code: v.string() },
  handler: async (ctx, { code }) => {
    await requirePerm(ctx, "products.view");
    const c = code.trim();
    return (
      (await ctx.db.query("products").withIndex("by_barcode", (q) => q.eq("barcode", c)).first()) ??
      (await ctx.db.query("products").withIndex("by_sku", (q) => q.eq("sku", c.toUpperCase())).first())
    );
  },
});

export const save = mutation({
  args: { id: v.optional(v.id("products")), ...productFields },
  handler: async (ctx, { id, ...data }) => {
    const member = await requirePerm(ctx, "products.manage");
    data.sku = data.sku.trim().toUpperCase();
    if (!data.sku || !data.name.trim()) throw new ConvexError("SKU and name are required.");
    const dup = await ctx.db.query("products").withIndex("by_sku", (q) => q.eq("sku", data.sku)).first();
    if (dup && dup._id !== id) throw new ConvexError(`SKU ${data.sku} already exists.`);
    if (data.barcode) {
      const bc = await ctx.db.query("products").withIndex("by_barcode", (q) => q.eq("barcode", data.barcode)).first();
      if (bc && bc._id !== id) throw new ConvexError(`Barcode ${data.barcode} is already on ${bc.sku}.`);
    }
    const doc = { ...data, searchText: searchText(data) };
    if (id) {
      await ctx.db.patch(id, doc);
      await audit(ctx, member, "product.updated", "products", id, { sku: data.sku });
      return id;
    }
    const newId = await ctx.db.insert("products", doc);
    await audit(ctx, member, "product.created", "products", newId, { sku: data.sku });
    return newId;
  },
});

/** Bulk import from CSV rows (already parsed on the client). Upserts by SKU. */
export const importRows = mutation({
  args: {
    rows: v.array(
      v.object({
        sku: v.string(),
        name: v.string(),
        partNumber: v.optional(v.string()),
        barcode: v.optional(v.string()),
        brand: v.optional(v.string()),
        category: v.optional(v.string()),
        vehicleMake: v.optional(v.string()),
        vehicleModel: v.optional(v.string()),
        unit: v.optional(v.string()),
        purchaseCost: v.optional(v.number()),
        retailPrice: v.optional(v.number()),
        wholesalePrice: v.optional(v.number()),
      }),
    ),
  },
  handler: async (ctx, { rows }) => {
    const member = await requirePerm(ctx, "products.manage");
    if (rows.length > 500) throw new ConvexError("Import at most 500 rows at a time.");
    let created = 0;
    let updated = 0;
    const catCache = new Map<string, Id<"categories">>();
    const brandCache = new Map<string, Id<"brands">>();
    for (const r of rows) {
      const sku = r.sku.trim().toUpperCase();
      if (!sku || !r.name.trim()) continue;
      let categoryId: Id<"categories"> | undefined;
      if (r.category?.trim()) {
        const name = r.category.trim();
        categoryId = catCache.get(name);
        if (!categoryId) {
          categoryId =
            (await ctx.db.query("categories").withIndex("by_name", (q) => q.eq("name", name)).first())?._id ??
            (await ctx.db.insert("categories", { name }));
          catCache.set(name, categoryId);
        }
      }
      let brandId: Id<"brands"> | undefined;
      if (r.brand?.trim()) {
        const name = r.brand.trim();
        brandId = brandCache.get(name);
        if (!brandId) {
          brandId =
            (await ctx.db.query("brands").withIndex("by_name", (q) => q.eq("name", name)).first())?._id ??
            (await ctx.db.insert("brands", { name }));
          brandCache.set(name, brandId);
        }
      }
      const data = {
        sku,
        name: r.name.trim(),
        partNumber: r.partNumber || undefined,
        barcode: r.barcode || undefined,
        brandId,
        categoryId,
        vehicleMake: r.vehicleMake || undefined,
        vehicleModel: r.vehicleModel || undefined,
        unit: r.unit || "pcs",
        purchaseCost: r.purchaseCost ?? 0,
        retailPrice: r.retailPrice ?? 0,
        wholesalePrice: r.wholesalePrice ?? r.retailPrice ?? 0,
        status: "active",
      };
      const existing = await ctx.db.query("products").withIndex("by_sku", (q) => q.eq("sku", sku)).first();
      if (existing) {
        await ctx.db.patch(existing._id, { ...data, searchText: searchText(data) });
        updated++;
      } else {
        await ctx.db.insert("products", { ...data, searchText: searchText(data) });
        created++;
      }
    }
    await audit(ctx, member, "product.import", "products", "", { created, updated });
    return { created, updated };
  },
});

// ───────────── Categories & brands ─────────────
export const categories = query({
  args: {},
  handler: async (ctx) => {
    await requirePerm(ctx, "products.view");
    return (await ctx.db.query("categories").collect()).sort((a, b) => a.name.localeCompare(b.name));
  },
});

export const brands = query({
  args: {},
  handler: async (ctx) => {
    await requirePerm(ctx, "products.view");
    return (await ctx.db.query("brands").collect()).sort((a, b) => a.name.localeCompare(b.name));
  },
});

export const saveCategory = mutation({
  args: { id: v.optional(v.id("categories")), name: v.string(), parentId: v.optional(v.id("categories")) },
  handler: async (ctx, { id, name, parentId }) => {
    const member = await requirePerm(ctx, "products.manage");
    if (id) {
      await ctx.db.patch(id, { name: name.trim(), parentId });
      return id;
    }
    const newId = await ctx.db.insert("categories", { name: name.trim(), parentId });
    await audit(ctx, member, "category.created", "categories", newId, name);
    return newId;
  },
});

export const saveBrand = mutation({
  args: { id: v.optional(v.id("brands")), name: v.string() },
  handler: async (ctx, { id, name }) => {
    const member = await requirePerm(ctx, "products.manage");
    if (id) {
      await ctx.db.patch(id, { name: name.trim() });
      return id;
    }
    const newId = await ctx.db.insert("brands", { name: name.trim() });
    await audit(ctx, member, "brand.created", "brands", newId, name);
    return newId;
  },
});
