import { ConvexError } from "convex/values";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { r2, r4 } from "./money";

export async function findBalance(
  ctx: QueryCtx | MutationCtx,
  productId: Id<"products">,
  storeId: Id<"stores">,
): Promise<Doc<"inventoryBalances"> | null> {
  return await ctx.db
    .query("inventoryBalances")
    .withIndex("by_product_store", (q) => q.eq("productId", productId).eq("storeId", storeId))
    .unique();
}

export async function ensureBalance(
  ctx: MutationCtx,
  productId: Id<"products">,
  storeId: Id<"stores">,
): Promise<Doc<"inventoryBalances">> {
  const existing = await findBalance(ctx, productId, storeId);
  if (existing) return existing;
  const store = await ctx.db.get(storeId);
  if (!store) throw new ConvexError("Store not found.");
  const product = await ctx.db.get(productId);
  if (!product) throw new ConvexError("Product not found.");
  const id = await ctx.db.insert("inventoryBalances", {
    productId,
    storeId,
    branchId: store.branchId,
    onHand: 0,
    reserved: 0,
    incoming: 0,
    inTransitOut: 0,
    avgCost: product.purchaseCost,
  });
  return (await ctx.db.get(id))!;
}

/**
 * The only way stock quantities change. Writes a movement row and updates the
 * cached balance using weighted-average cost.
 *   qty > 0: inbound at `unitCost` (required)
 *   qty < 0: outbound at current average cost (or `unitCost` if given, e.g. supplier returns)
 * Returns the unit cost actually applied.
 */
export async function applyMovement(
  ctx: MutationCtx,
  args: {
    productId: Id<"products">;
    storeId: Id<"stores">;
    qty: number;
    unitCost?: number;
    type: string;
    sourceType: string;
    sourceId: string;
    reference: string;
    date: number;
    member?: Doc<"members"> | null;
    note?: string;
    allowNegative?: boolean;
  },
): Promise<{ unitCost: number; totalCost: number }> {
  if (args.qty === 0) return { unitCost: 0, totalCost: 0 };
  const bal = await ensureBalance(ctx, args.productId, args.storeId);
  let unitCost: number;
  let newAvg = bal.avgCost;
  const newOnHand = bal.onHand + args.qty;

  if (args.qty > 0) {
    unitCost = r4(args.unitCost ?? bal.avgCost);
    if (newOnHand > 0) {
      const existingValue = Math.max(bal.onHand, 0) * bal.avgCost;
      newAvg = r4((existingValue + args.qty * unitCost) / (Math.max(bal.onHand, 0) + args.qty));
    } else {
      newAvg = unitCost;
    }
  } else {
    unitCost = r4(args.unitCost ?? bal.avgCost);
    if (newOnHand < 0 && !args.allowNegative) {
      const company = await ctx.db.query("companies").first();
      if (!company?.allowNegativeStock) {
        const product = await ctx.db.get(args.productId);
        const store = await ctx.db.get(args.storeId);
        throw new ConvexError(
          `Not enough stock for ${product?.sku ?? "item"} in ${store?.name ?? "store"}: on hand ${bal.onHand}, needed ${-args.qty}.`,
        );
      }
    }
  }

  await ctx.db.patch(bal._id, {
    onHand: newOnHand,
    avgCost: newAvg,
    lastMovementAt: args.date,
  });

  const totalCost = r2(args.qty * unitCost);
  await ctx.db.insert("stockMovements", {
    productId: args.productId,
    storeId: args.storeId,
    branchId: bal.branchId,
    type: args.type,
    quantity: args.qty,
    unitCost,
    totalCost,
    balanceAfter: newOnHand,
    sourceType: args.sourceType,
    sourceId: args.sourceId,
    reference: args.reference,
    note: args.note,
    date: args.date,
    memberId: args.member?._id,
  });
  return { unitCost, totalCost };
}

/** Adjust reserved / incoming / inTransitOut counters (never below zero). */
export async function bumpCounter(
  ctx: MutationCtx,
  productId: Id<"products">,
  storeId: Id<"stores">,
  field: "reserved" | "incoming" | "inTransitOut",
  delta: number,
) {
  if (delta === 0) return;
  const bal = await ensureBalance(ctx, productId, storeId);
  await ctx.db.patch(bal._id, { [field]: Math.max(0, r4(bal[field] + delta)) });
}
