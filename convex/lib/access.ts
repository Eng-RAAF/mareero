import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError } from "convex/values";
import type { QueryCtx, MutationCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { roleHas, type Permission } from "./permissions";

type Ctx = QueryCtx | MutationCtx;

export async function getMember(ctx: Ctx): Promise<Doc<"members"> | null> {
  const userId = await getAuthUserId(ctx);
  if (!userId) return null;
  const member = await ctx.db
    .query("members")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .unique();
  if (!member || !member.active) return null;
  return member;
}

export async function requireMember(ctx: Ctx): Promise<Doc<"members">> {
  const member = await getMember(ctx);
  if (!member) throw new ConvexError("You are not signed in or your account has no access.");
  return member;
}

export async function requirePerm(ctx: Ctx, permission: Permission): Promise<Doc<"members">> {
  const member = await requireMember(ctx);
  if (!roleHas(member.role, permission)) {
    throw new ConvexError(`Permission denied: ${permission}`);
  }
  return member;
}

export function has(member: Doc<"members">, permission: Permission): boolean {
  return roleHas(member.role, permission);
}

export function canAccessBranch(member: Doc<"members">, branchId: Id<"branches">): boolean {
  return roleHas(member.role, "all_branches") || member.branchIds.includes(branchId);
}

export function assertBranch(member: Doc<"members">, branchId: Id<"branches">) {
  if (!canAccessBranch(member, branchId)) {
    throw new ConvexError("You do not have access to this branch.");
  }
}

/** null = every branch. */
export function allowedBranches(member: Doc<"members">): Set<string> | null {
  if (roleHas(member.role, "all_branches")) return null;
  return new Set(member.branchIds as string[]);
}

export function filterByBranch<T extends { branchId: Id<"branches"> }>(
  member: Doc<"members">,
  rows: T[],
  branchId?: Id<"branches"> | null,
): T[] {
  const allowed = allowedBranches(member);
  return rows.filter(
    (r) => (allowed === null || allowed.has(r.branchId)) && (!branchId || r.branchId === branchId),
  );
}

export async function getCompany(ctx: Ctx): Promise<Doc<"companies">> {
  const company = await ctx.db.query("companies").first();
  if (!company) throw new ConvexError("Company is not set up yet.");
  return company;
}

export async function storeBranch(ctx: Ctx, storeId: Id<"stores">): Promise<Doc<"stores">> {
  const store = await ctx.db.get(storeId);
  if (!store) throw new ConvexError("Store not found.");
  return store;
}

/** High-value documents need a GM / Super Admin approval. */
export async function assertCanApproveAmount(
  ctx: Ctx,
  member: Doc<"members">,
  amount: number,
) {
  const company = await getCompany(ctx);
  if (amount > company.requireApprovalAbove && !roleHas(member.role, "approvals.high_value")) {
    throw new ConvexError(
      `Amounts above ${company.requireApprovalAbove} need General Manager approval.`,
    );
  }
}
