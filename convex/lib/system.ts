import type { MutationCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { roleHas, type Permission } from "./permissions";

/** Next document number, e.g. INV-000042. Atomic inside the mutation transaction. */
export async function nextNumber(ctx: MutationCtx, key: string, prefix: string): Promise<string> {
  const seq = await ctx.db
    .query("documentSequences")
    .withIndex("by_key", (q) => q.eq("key", key))
    .unique();
  let n = 1;
  if (seq) {
    n = seq.next;
    await ctx.db.patch(seq._id, { next: n + 1 });
  } else {
    await ctx.db.insert("documentSequences", { key, next: 2 });
  }
  return `${prefix}-${String(n).padStart(6, "0")}`;
}

export async function audit(
  ctx: MutationCtx,
  member: Doc<"members"> | null,
  action: string,
  entityType: string,
  entityId: string,
  details: string | Record<string, unknown> = "",
  branchId?: Id<"branches">,
) {
  await ctx.db.insert("auditLogs", {
    memberId: member?._id,
    memberName: member?.name ?? "System",
    action,
    entityType,
    entityId,
    branchId,
    details: typeof details === "string" ? details : JSON.stringify(details),
    at: Date.now(),
  });
}

/** Notify every active member holding `permission` who can see `branchId`. */
export async function notifyPermission(
  ctx: MutationCtx,
  permission: Permission,
  title: string,
  body: string,
  link?: string,
  branchId?: Id<"branches">,
  exceptMemberId?: Id<"members">,
) {
  const members = await ctx.db.query("members").collect();
  for (const m of members) {
    if (!m.active || m._id === exceptMemberId) continue;
    if (!roleHas(m.role, permission)) continue;
    if (branchId && !roleHas(m.role, "all_branches") && !m.branchIds.includes(branchId)) continue;
    await ctx.db.insert("notifications", {
      memberId: m._id,
      title,
      body,
      link,
      read: false,
      createdAt: Date.now(),
    });
  }
}
