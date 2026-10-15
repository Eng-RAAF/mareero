/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as accounting from "../accounting.js";
import type * as admin from "../admin.js";
import type * as auth from "../auth.js";
import type * as crons from "../crons.js";
import type * as expenses from "../expenses.js";
import type * as http from "../http.js";
import type * as inventory from "../inventory.js";
import type * as lib_access from "../lib/access.js";
import type * as lib_ledger from "../lib/ledger.js";
import type * as lib_money from "../lib/money.js";
import type * as lib_permissions from "../lib/permissions.js";
import type * as lib_stock from "../lib/stock.js";
import type * as lib_system from "../lib/system.js";
import type * as org from "../org.js";
import type * as parties from "../parties.js";
import type * as payments from "../payments.js";
import type * as products from "../products.js";
import type * as purchasing from "../purchasing.js";
import type * as reorder from "../reorder.js";
import type * as reports from "../reports.js";
import type * as sales from "../sales.js";
import type * as setup from "../setup.js";
import type * as transfers from "../transfers.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  accounting: typeof accounting;
  admin: typeof admin;
  auth: typeof auth;
  crons: typeof crons;
  expenses: typeof expenses;
  http: typeof http;
  inventory: typeof inventory;
  "lib/access": typeof lib_access;
  "lib/ledger": typeof lib_ledger;
  "lib/money": typeof lib_money;
  "lib/permissions": typeof lib_permissions;
  "lib/stock": typeof lib_stock;
  "lib/system": typeof lib_system;
  org: typeof org;
  parties: typeof parties;
  payments: typeof payments;
  products: typeof products;
  purchasing: typeof purchasing;
  reorder: typeof reorder;
  reports: typeof reports;
  sales: typeof sales;
  setup: typeof setup;
  transfers: typeof transfers;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
