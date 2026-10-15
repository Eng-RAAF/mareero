# Mareero Auto Spare Parts — Management System

Multi-branch, multi-store inventory, purchasing, sales invoicing, reorder management and double-entry accounting.
**No POS** — sales run through quotations → sales orders → invoices → payments.

- **Frontend:** React 18 + Vite + Tailwind CSS + React Router
- **Backend & database:** Convex (queries, mutations, scheduled reorder job, file storage) with Convex Auth (email + password)
- **Your deployment:** `woozy-rhinoceros-980` (`https://woozy-rhinoceros-980.convex.cloud`)
- **HTTP Actions:** `https://woozy-rhinoceros-980.convex.site`

---

## 1. First-time setup (Windows, PowerShell)

Requires Node.js 18+ (you have 24).

```powershell
cd path\to\mareero
npm install
npx convex dev            # log in if asked, choose the project for woozy-rhinoceros-980
```

The frontend is configured to use `https://woozy-rhinoceros-980.convex.cloud` via `.env.local`.
`npx convex dev` selects the backend deployment and pushes the current schema and functions; check that this is the
intended deployment before accepting any schema changes. Its HTTP Actions domain is
`https://woozy-rhinoceros-980.convex.site`.
Leave the Convex process running in that terminal.

In a **second** terminal, set up sign-in keys once:

```powershell
npx @convex-dev/auth
```

Answer the prompts (site URL `http://localhost:5173`). This sets `SITE_URL`, `JWT_PRIVATE_KEY` and `JWKS` on the deployment.

Then start the web app:

```powershell
npm run dev:frontend
```

Open http://localhost:5173 → **Create account** → the first account becomes **Super Admin** and runs the company setup
(head-office branch, main store, chart of accounts, 12 fiscal periods).

Optional: **Settings → Load sample data** adds 10 spare parts with opening stock, suppliers, customers and reorder rules so
the team can practise every workflow.

## 2. Existing data in Convex

Do not clear existing tables just to connect the app. If a schema push reports incompatible existing documents, review the
affected data and choose an appropriate migration before proceeding. Clearing tables or running `npm run wipe` permanently
deletes deployment data and should only be done when that is explicitly intended.

## 3. Production

```powershell
npx convex deploy          # pushes to your production deployment and builds the frontend
```

Host the `dist/` folder on any static host (Netlify, Vercel, Cloudflare Pages) with `VITE_CONVEX_URL` set to the production
URL, and run `npx @convex-dev/auth --prod` once.

## 4. Working without internet

There are two options. They can be used together.

### A. Install the app on each computer (offline viewing)

Open the hosted app (https address, or `http://localhost`) in Chrome or Edge and click **Install** in the address bar
(or menu → *Install Mareero*). It then opens from the desktop / Start menu like a normal program.

- When the internet is off, the app still opens, shows an **Offline** banner and displays the data saved on that computer
  from the last time each page was opened online.
- Changes (invoices, payments, stock moves…) **cannot be saved offline** — they are refused with a clear message, so stock
  and the ledger never get out of step. Save them once the connection is back.
- The user must have signed in once while online. **Sign out** removes the saved data from that computer.
- Installing needs `https` or `localhost` (a browser rule); it does not install from a plain `http://192.168…` address.

### B. Shop server (full use on the shop network without internet)

Runs the database, functions and the web app on **one computer in the shop** with Docker. Every PC on the same network uses
it in the browser, and everything — sales, purchasing, stock, accounting — keeps working when the internet is down.

Needs Docker Desktop on that computer (internet is needed once, to download it and the server images).

```powershell
npm run shop:setup                      # first time; prints the address for the other PCs, e.g. http://192.168.1.20:8080
npm run shop:setup -- --host 192.168.1.20   # if the detected address is wrong
npm run shop:start / npm run shop:stop
npm run shop:update                     # after changing code: pushes functions and rebuilds the web app
npm run shop:backup                     # saves everything to backups\shop-<date>.zip
```

- Give the server computer a **fixed IP** in the router, and allow inbound TCP **8080, 3210, 3211** in Windows Firewall.
- The admin dashboard is at http://localhost:6791 on the server (admin key is in `.env.shop` — keep that file private).
- The shop server has **its own data**, separate from the Convex cloud. To start it with your cloud data:
  `npx convex export --path backups\cloud.zip` then `npm run shop:import -- backups\cloud.zip`
  (this replaces the shop server's data; it asks before changing anything). Branches in other locations can only reach
  the shop server over the internet (VPN), so pick one system as the live one — don't record in both.
- Back up regularly: the data lives only on that computer (Docker volume `data`).

---

## How it works

### Organisation & security
- Company → branches → stores/warehouses (any number). One shared product catalogue; stock is tracked per store.
- Nine roles (`convex/lib/permissions.ts`): Super Admin, General Manager, Accountant, Branch Manager, Store/Warehouse Manager,
  Sales Officer, Purchasing Officer, Inventory Controller, Auditor (read-only).
- **Every query and mutation checks permission and branch access on the server** — changing a URL or calling a function
  directly does not bypass it. Branch roles only see their assigned branches.
- Users: an admin adds the person (name, email, role, branches) under **Users & Roles**; the person then signs up with that
  email and clicks **Join**.
- Every sensitive action writes to the **Audit Log**; approvers get **Notifications**.

### Inventory
- Weighted-average costing. Every quantity change is a `stockMovements` row (product, store, qty, cost, type, source
  document); `inventoryBalances` are a cache of those movements.
- Balances track **on hand, reserved** (confirmed sales orders, approved transfers), **incoming** (approved POs, transfers in
  transit) and **in transit out**.
- Negative stock is blocked unless enabled in Settings.
- Counts, damage write-offs, corrections and opening stock all go through approval. Counts are re-checked against live stock
  when approved.

### Reorder management
- Per product × store rules: min, reorder point, max, safety stock, daily demand (manual or automatic from 90 days of
  sales), lead time, target, MOQ, order multiple, preferred supplier.
- **Reorder point = daily demand × lead time + safety stock. Projected = on hand − reserved + incoming.
  Suggested = max(0, target − projected)** rounded up to MOQ and multiples.
- Prefers an **internal transfer** when another store has surplus; otherwise a purchase.
- Runs **hourly** (Convex cron) and on demand. A product/store already in the pipeline is never recommended twice, and a
  recommendation can only produce one request → one PO.
- Manual quantity overrides record who, when, original, new and why.

### Purchasing
Purchase request → approval → purchase order → goods receipt (with freight/landed cost) → supplier bill (3-way matched to the
PO; price differences to *Purchase Price Variance*) → supplier payment. Partial receipts, short-closing, supplier returns
(debit notes) and duplicate supplier-invoice detection are built in. High-value approvals (Settings) need a General Manager.

### Sales
Quotation → sales order (reserves stock) → invoice (issues stock, posts revenue + COGS) → payment (allocated to invoices,
oldest first) → statement. Credit limits and overdue checks block credit sales unless a manager posts them or payment is
taken immediately. Credit notes return goods at original cost and can be applied to invoices or refunded.

### Accounting
- Default chart of accounts with system accounts for AR, AP, inventory, GRNI, transit, tax, COGS, variance, etc.
- Every document posts a **balanced** journal (rejected otherwise). Posted entries are never edited — corrections are
  reversals. AR, AP and Inventory are control accounts (no manual journals).
- Monthly fiscal periods; closing a period blocks any posting dated in it.
- Reports: Profit & Loss, Balance Sheet, Cash Flow (direct), Trial Balance, General Ledger, AR/AP aging, branch
  profitability, inventory valuation (cross-checked against the ledger), sales by day/month/product/category/customer/branch,
  fast/slow/dead stock, purchasing and supplier delivery performance. CSV export everywhere; printable invoices, quotations,
  POs and statements.

## Project layout

```
convex/
  schema.ts          data model (all tables + indexes)
  auth.ts, http.ts   Convex Auth (password)
  lib/               access control, permissions, ledger posting, stock engine, numbering, audit
  setup.ts           first-run company setup, invites, sample data
  org.ts             company settings, branches, stores, users, notifications, audit log
  products.ts        catalogue, categories, brands, CSV import
  inventory.ts       stock on hand, movements, counts & adjustments
  transfers.ts       transfer workflow
  reorder.ts         replenishment engine + settings   (crons.ts runs it hourly)
  purchasing.ts      requests, POs, receipts, bills, supplier returns
  sales.ts           quotations, orders, invoices, credit notes
  payments.ts        customer receipts, supplier payments, refunds
  expenses.ts        expenses with approval and receipts
  accounting.ts      chart of accounts, journals, ledger, statements, aging, periods, bank reconciliation
  reports.ts         dashboard, approvals queue, operational reports
  admin.ts           wipeAllData (internal)
src/
  pages/             one file per module
  components/        layout, tables, forms, line-item editor
```
