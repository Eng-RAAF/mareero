import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { authTables } from "@convex-dev/auth/server";

/**
 * Mareero Auto Spare Parts — Convex data model.
 *
 * Conventions
 * - Money is stored as numbers rounded to 2 decimals (see lib/money.ts).
 * - Dates are stored as epoch milliseconds.
 * - Document lines are embedded arrays (Convex is document-oriented).
 * - Status fields are strings; allowed values are documented next to each table.
 * - Every stock change writes a stockMovements row; balances are a cache of movements.
 * - Every financial posting writes a balanced journalEntries + journalLines set.
 */

const saleLine = v.object({
  productId: v.id("products"),
  description: v.string(),
  qty: v.number(),
  unitPrice: v.number(),
  discount: v.number(), // amount per line, not percent
  unitCost: v.optional(v.number()), // filled when stock is issued
});

const purchaseLine = v.object({
  productId: v.id("products"),
  qty: v.number(),
  unitCost: v.number(),
  receivedQty: v.number(),
  billedQty: v.number(),
});

export default defineSchema({
  ...authTables,

  // ───────────────────────── Organization ─────────────────────────
  companies: defineTable({
    name: v.string(),
    address: v.optional(v.string()),
    phone: v.optional(v.string()),
    email: v.optional(v.string()),
    taxId: v.optional(v.string()),
    logoStorageId: v.optional(v.id("_storage")),
    currency: v.string(),
    fiscalYearStartMonth: v.number(), // 1-12
    defaultTaxRate: v.number(), // percent, e.g. 5
    valuationMethod: v.string(), // "weighted_average"
    allowNegativeStock: v.boolean(),
    requireApprovalAbove: v.number(), // PO / expense amount needing GM approval
    setupComplete: v.boolean(),
  }),

  branches: defineTable({
    name: v.string(),
    code: v.string(),
    address: v.optional(v.string()),
    phone: v.optional(v.string()),
    managerMemberId: v.optional(v.id("members")),
    isHeadOffice: v.boolean(),
    active: v.boolean(),
  }).index("by_code", ["code"]),

  stores: defineTable({
    branchId: v.id("branches"),
    name: v.string(),
    code: v.string(),
    kind: v.string(), // main | retail | warehouse
    managerMemberId: v.optional(v.id("members")),
    active: v.boolean(),
  })
    .index("by_branch", ["branchId"])
    .index("by_code", ["code"]),

  members: defineTable({
    userId: v.optional(v.id("users")), // linked after the person signs up
    name: v.string(),
    email: v.string(),
    role: v.string(), // see lib/permissions.ts
    branchIds: v.array(v.id("branches")), // branches this member may work in (roles with all_branches see everything)
    active: v.boolean(),
  })
    .index("by_user", ["userId"])
    .index("by_email", ["email"]),

  // ───────────────────────── Catalog ─────────────────────────
  categories: defineTable({
    name: v.string(),
    parentId: v.optional(v.id("categories")),
  }).index("by_name", ["name"]),

  brands: defineTable({ name: v.string() }).index("by_name", ["name"]),

  products: defineTable({
    sku: v.string(),
    name: v.string(),
    description: v.optional(v.string()),
    barcode: v.optional(v.string()),
    partNumber: v.optional(v.string()), // manufacturer part no. — NOT unique
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
    status: v.string(), // active | inactive
    searchText: v.string(),
  })
    .index("by_sku", ["sku"])
    .index("by_barcode", ["barcode"])
    .index("by_category", ["categoryId"])
    .searchIndex("search", { searchField: "searchText", filterFields: ["status"] }),

  // ───────────────────────── Inventory ─────────────────────────
  inventoryBalances: defineTable({
    productId: v.id("products"),
    storeId: v.id("stores"),
    branchId: v.id("branches"),
    onHand: v.number(),
    reserved: v.number(),
    incoming: v.number(),
    inTransitOut: v.number(),
    avgCost: v.number(),
    lastMovementAt: v.optional(v.number()),
  })
    .index("by_product_store", ["productId", "storeId"])
    .index("by_store", ["storeId"])
    .index("by_branch", ["branchId"])
    .index("by_product", ["productId"]),

  stockMovements: defineTable({
    productId: v.id("products"),
    storeId: v.id("stores"),
    branchId: v.id("branches"),
    // receipt | sale | sale_return | supplier_return | transfer_out | transfer_in
    // adjustment | count | damage | opening
    type: v.string(),
    quantity: v.number(), // signed: + in, - out
    unitCost: v.number(),
    totalCost: v.number(),
    balanceAfter: v.number(),
    sourceType: v.string(),
    sourceId: v.string(),
    reference: v.string(),
    note: v.optional(v.string()),
    date: v.number(),
    memberId: v.optional(v.id("members")),
  })
    .index("by_product", ["productId", "date"])
    .index("by_store", ["storeId", "date"])
    .index("by_source", ["sourceType", "sourceId"])
    .index("by_date", ["date"]),

  stockAdjustments: defineTable({
    number: v.string(),
    storeId: v.id("stores"),
    branchId: v.id("branches"),
    date: v.number(),
    kind: v.string(), // adjustment | count | damage | opening
    reason: v.string(),
    status: v.string(), // draft | pending_approval | posted | rejected
    lines: v.array(
      v.object({
        productId: v.id("products"),
        systemQty: v.number(),
        countedQty: v.optional(v.number()),
        qtyChange: v.number(),
        unitCost: v.number(),
      }),
    ),
    totalValue: v.number(),
    createdBy: v.id("members"),
    approvedBy: v.optional(v.id("members")),
    journalEntryId: v.optional(v.id("journalEntries")),
  })
    .index("by_status", ["status"])
    .index("by_branch", ["branchId"]),

  stockTransfers: defineTable({
    number: v.string(),
    fromStoreId: v.id("stores"),
    toStoreId: v.id("stores"),
    fromBranchId: v.id("branches"),
    toBranchId: v.id("branches"),
    // draft | pending_approval | approved | in_transit | partially_received | received | rejected | cancelled
    status: v.string(),
    lines: v.array(
      v.object({
        productId: v.id("products"),
        qty: v.number(),
        dispatchedQty: v.number(),
        receivedQty: v.number(),
        damagedQty: v.number(),
        unitCost: v.number(),
      }),
    ),
    date: v.number(),
    note: v.optional(v.string()),
    createdBy: v.id("members"),
    approvedBy: v.optional(v.id("members")),
    dispatchedAt: v.optional(v.number()),
    receivedAt: v.optional(v.number()),
    recommendationIds: v.optional(v.array(v.id("reorderRecommendations"))),
  })
    .index("by_status", ["status"])
    .index("by_from_branch", ["fromBranchId"])
    .index("by_to_branch", ["toBranchId"]),

  // ───────────────────────── Parties ─────────────────────────
  suppliers: defineTable({
    name: v.string(),
    code: v.string(),
    contactName: v.optional(v.string()),
    phone: v.optional(v.string()),
    email: v.optional(v.string()),
    address: v.optional(v.string()),
    paymentTermsDays: v.number(),
    creditLimit: v.optional(v.number()),
    currency: v.string(),
    leadTimeDays: v.number(),
    balance: v.number(), // what we owe them (AP)
    active: v.boolean(),
    notes: v.optional(v.string()),
  }).index("by_name", ["name"]),

  customers: defineTable({
    name: v.string(),
    code: v.string(),
    contactName: v.optional(v.string()),
    phone: v.optional(v.string()),
    email: v.optional(v.string()),
    address: v.optional(v.string()),
    creditLimit: v.number(),
    paymentTermsDays: v.number(),
    priceLevel: v.string(), // retail | wholesale
    balance: v.number(), // what they owe us (AR)
    active: v.boolean(),
  }).index("by_name", ["name"]),

  // ───────────────────────── Purchasing ─────────────────────────
  purchaseRequests: defineTable({
    number: v.string(),
    branchId: v.id("branches"),
    storeId: v.id("stores"),
    supplierId: v.optional(v.id("suppliers")),
    date: v.number(),
    source: v.string(), // manual | reorder
    // draft | pending_approval | approved | rejected | converted | cancelled
    status: v.string(),
    lines: v.array(
      v.object({
        productId: v.id("products"),
        qty: v.number(),
        estUnitCost: v.number(),
        recommendationId: v.optional(v.id("reorderRecommendations")),
      }),
    ),
    estTotal: v.number(),
    note: v.optional(v.string()),
    createdBy: v.id("members"),
    approvedBy: v.optional(v.id("members")),
    purchaseOrderId: v.optional(v.id("purchaseOrders")),
  })
    .index("by_status", ["status"])
    .index("by_branch", ["branchId"]),

  purchaseOrders: defineTable({
    number: v.string(),
    supplierId: v.id("suppliers"),
    branchId: v.id("branches"),
    storeId: v.id("stores"),
    date: v.number(),
    expectedDate: v.optional(v.number()),
    // draft | pending_approval | approved | partially_received | received | closed | cancelled
    status: v.string(),
    lines: v.array(purchaseLine),
    subtotal: v.number(),
    taxAmount: v.number(),
    total: v.number(),
    purchaseRequestId: v.optional(v.id("purchaseRequests")),
    note: v.optional(v.string()),
    createdBy: v.id("members"),
    approvedBy: v.optional(v.id("members")),
  })
    .index("by_status", ["status"])
    .index("by_supplier", ["supplierId"])
    .index("by_branch", ["branchId"])
    .index("by_request", ["purchaseRequestId"]),

  goodsReceipts: defineTable({
    number: v.string(),
    purchaseOrderId: v.id("purchaseOrders"),
    supplierId: v.id("suppliers"),
    storeId: v.id("stores"),
    branchId: v.id("branches"),
    date: v.number(),
    lines: v.array(
      v.object({ productId: v.id("products"), qty: v.number(), unitCost: v.number() }),
    ),
    total: v.number(),
    note: v.optional(v.string()),
    createdBy: v.id("members"),
    journalEntryId: v.optional(v.id("journalEntries")),
  })
    .index("by_po", ["purchaseOrderId"])
    .index("by_branch", ["branchId"]),

  supplierBills: defineTable({
    number: v.string(),
    kind: v.string(), // bill | debit_note (supplier return / credit)
    supplierRef: v.optional(v.string()),
    supplierId: v.id("suppliers"),
    branchId: v.id("branches"),
    storeId: v.optional(v.id("stores")),
    purchaseOrderId: v.optional(v.id("purchaseOrders")),
    date: v.number(),
    dueDate: v.number(),
    lines: v.array(
      v.object({
        description: v.string(),
        productId: v.optional(v.id("products")),
        accountId: v.optional(v.id("accounts")),
        qty: v.number(),
        unitCost: v.number(),
        amount: v.number(),
      }),
    ),
    subtotal: v.number(),
    taxAmount: v.number(),
    total: v.number(),
    amountPaid: v.number(),
    status: v.string(), // open | partial | paid | void
    note: v.optional(v.string()),
    createdBy: v.id("members"),
    journalEntryId: v.optional(v.id("journalEntries")),
  })
    .index("by_supplier", ["supplierId"])
    .index("by_status", ["status"])
    .index("by_po", ["purchaseOrderId"]),

  // ───────────────────────── Sales ─────────────────────────
  salesDocs: defineTable({
    number: v.string(),
    kind: v.string(), // quotation | order | invoice | credit_note
    customerId: v.id("customers"),
    branchId: v.id("branches"),
    storeId: v.id("stores"),
    date: v.number(),
    dueDate: v.optional(v.number()),
    validUntil: v.optional(v.number()),
    // quotation: draft | sent | accepted | converted | expired | cancelled
    // order: draft | confirmed | invoiced | cancelled
    // invoice: open | partial | paid | void
    // credit_note: open | applied | refunded | void
    status: v.string(),
    lines: v.array(saleLine),
    subtotal: v.number(),
    discountTotal: v.number(),
    taxRate: v.number(),
    taxAmount: v.number(),
    total: v.number(),
    amountPaid: v.number(),
    sourceDocId: v.optional(v.id("salesDocs")),
    convertedToId: v.optional(v.id("salesDocs")),
    returnsStock: v.optional(v.boolean()), // credit notes
    note: v.optional(v.string()),
    createdBy: v.id("members"),
    creditApprovedBy: v.optional(v.id("members")),
    journalEntryId: v.optional(v.id("journalEntries")),
  })
    .index("by_kind_status", ["kind", "status"])
    .index("by_customer", ["customerId", "kind"])
    .index("by_branch_kind", ["branchId", "kind"])
    .index("by_kind_date", ["kind", "date"]),

  payments: defineTable({
    number: v.string(),
    direction: v.string(), // received | paid | refund
    partyType: v.string(), // customer | supplier
    customerId: v.optional(v.id("customers")),
    supplierId: v.optional(v.id("suppliers")),
    branchId: v.id("branches"),
    date: v.number(),
    amount: v.number(),
    accountId: v.id("accounts"), // cash or bank
    method: v.string(), // cash | bank_transfer | cheque | mobile_money
    reference: v.optional(v.string()),
    allocations: v.array(v.object({ docId: v.string(), amount: v.number() })),
    unallocated: v.number(),
    note: v.optional(v.string()),
    createdBy: v.id("members"),
    journalEntryId: v.optional(v.id("journalEntries")),
  })
    .index("by_customer", ["customerId"])
    .index("by_supplier", ["supplierId"])
    .index("by_direction_date", ["direction", "date"]),

  // ───────────────────────── Accounting ─────────────────────────
  accounts: defineTable({
    code: v.string(),
    name: v.string(),
    // asset | liability | equity | revenue | cogs | expense | other_income | other_expense
    type: v.string(),
    subtype: v.optional(v.string()),
    systemKey: v.optional(v.string()),
    isCashOrBank: v.boolean(),
    parentId: v.optional(v.id("accounts")),
    description: v.optional(v.string()),
    active: v.boolean(),
  })
    .index("by_code", ["code"])
    .index("by_systemKey", ["systemKey"])
    .index("by_type", ["type"]),

  journalEntries: defineTable({
    number: v.string(),
    date: v.number(),
    memo: v.string(),
    sourceType: v.string(), // manual | invoice | credit_note | payment | bill | grn | expense | adjustment | transfer | reversal
    sourceId: v.optional(v.string()),
    branchId: v.optional(v.id("branches")),
    status: v.string(), // posted | reversed
    totalDebit: v.number(),
    reversalOfId: v.optional(v.id("journalEntries")),
    reversedById: v.optional(v.id("journalEntries")),
    createdBy: v.optional(v.id("members")),
  })
    .index("by_date", ["date"])
    .index("by_source", ["sourceType", "sourceId"]),

  journalLines: defineTable({
    entryId: v.id("journalEntries"),
    accountId: v.id("accounts"),
    branchId: v.optional(v.id("branches")),
    date: v.number(),
    debit: v.number(),
    credit: v.number(),
    memo: v.optional(v.string()),
    partyType: v.optional(v.string()),
    partyId: v.optional(v.string()),
  })
    .index("by_entry", ["entryId"])
    .index("by_account_date", ["accountId", "date"])
    .index("by_date", ["date"]),

  expenses: defineTable({
    number: v.string(),
    branchId: v.id("branches"),
    date: v.number(),
    expenseAccountId: v.id("accounts"),
    paymentAccountId: v.id("accounts"),
    payee: v.string(),
    supplierId: v.optional(v.id("suppliers")),
    amount: v.number(),
    taxAmount: v.number(),
    method: v.string(),
    reference: v.optional(v.string()),
    description: v.string(),
    status: v.string(), // pending_approval | posted | rejected | void
    receiptStorageId: v.optional(v.id("_storage")),
    recurring: v.optional(v.string()), // none | monthly | weekly
    createdBy: v.id("members"),
    approvedBy: v.optional(v.id("members")),
    journalEntryId: v.optional(v.id("journalEntries")),
  })
    .index("by_status", ["status"])
    .index("by_branch_date", ["branchId", "date"])
    .index("by_date", ["date"]),

  taxRates: defineTable({ name: v.string(), rate: v.number(), active: v.boolean() }),

  fiscalPeriods: defineTable({
    name: v.string(),
    startDate: v.number(),
    endDate: v.number(),
    status: v.string(), // open | closed
    closedBy: v.optional(v.id("members")),
    closedAt: v.optional(v.number()),
  }).index("by_start", ["startDate"]),

  bankReconciliations: defineTable({
    accountId: v.id("accounts"),
    statementDate: v.number(),
    statementBalance: v.number(),
    bookBalance: v.number(),
    clearedLineIds: v.array(v.id("journalLines")),
    difference: v.number(),
    status: v.string(), // draft | completed
    createdBy: v.id("members"),
  }).index("by_account", ["accountId"]),

  // ───────────────────────── Reorder ─────────────────────────
  reorderSettings: defineTable({
    productId: v.id("products"),
    storeId: v.id("stores"),
    branchId: v.id("branches"),
    minStock: v.number(),
    reorderPoint: v.number(),
    maxStock: v.number(),
    safetyStock: v.number(),
    avgDailyDemand: v.number(),
    autoDemand: v.boolean(), // recompute demand from last 90 days of sales
    leadTimeDays: v.number(),
    targetStock: v.number(),
    minOrderQty: v.number(),
    orderMultiple: v.number(),
    reviewDays: v.number(),
    preferredSupplierId: v.optional(v.id("suppliers")),
    autoReorderPoint: v.boolean(), // reorderPoint = demand × lead time + safety
  })
    .index("by_product_store", ["productId", "storeId"])
    .index("by_store", ["storeId"]),

  reorderRecommendations: defineTable({
    productId: v.id("products"),
    storeId: v.id("stores"),
    branchId: v.id("branches"),
    supplierId: v.optional(v.id("suppliers")),
    // recommended | pending_approval | approved | ordered | partially_received | completed | rejected | postponed
    status: v.string(),
    severity: v.string(), // below_reorder | critical
    action: v.string(), // purchase | transfer
    transferFromStoreId: v.optional(v.id("stores")),
    onHand: v.number(),
    reserved: v.number(),
    incoming: v.number(),
    projected: v.number(),
    reorderPoint: v.number(),
    targetStock: v.number(),
    suggestedQty: v.number(),
    finalQty: v.number(),
    estUnitCost: v.number(),
    estCost: v.number(),
    purchaseRequestId: v.optional(v.id("purchaseRequests")),
    transferId: v.optional(v.id("stockTransfers")),
    postponedUntil: v.optional(v.number()),
    overrides: v.array(
      v.object({
        memberId: v.id("members"),
        at: v.number(),
        originalQty: v.number(),
        newQty: v.number(),
        reason: v.string(),
      }),
    ),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_product_store", ["productId", "storeId"])
    .index("by_status", ["status"])
    .index("by_branch_status", ["branchId", "status"]),

  // ───────────────────────── System control ─────────────────────────
  auditLogs: defineTable({
    memberId: v.optional(v.id("members")),
    memberName: v.string(),
    action: v.string(),
    entityType: v.string(),
    entityId: v.string(),
    branchId: v.optional(v.id("branches")),
    details: v.string(),
    at: v.number(),
  })
    .index("by_at", ["at"])
    .index("by_entity", ["entityType", "entityId"]),

  notifications: defineTable({
    memberId: v.id("members"),
    title: v.string(),
    body: v.string(),
    link: v.optional(v.string()),
    read: v.boolean(),
    createdAt: v.number(),
  }).index("by_member", ["memberId", "read"]),

  documentSequences: defineTable({
    key: v.string(),
    next: v.number(),
  }).index("by_key", ["key"]),
});
