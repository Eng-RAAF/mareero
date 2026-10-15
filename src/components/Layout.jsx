import { useState } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { useAuthActions } from "@convex-dev/auth/react";
import { clearSaved, forgetSignIn, useOffline, useQuery } from "../lib/convex";
import { api } from "../../convex/_generated/api";
import { useApp } from "../lib/app";

const NAV = [
  { label: "Dashboard", to: "/", icon: "▦" },
  {
    section: "Inventory",
    items: [
      { label: "Products & Categories", to: "/products", perm: "products.view" },
      { label: "Stock on Hand", to: "/inventory", perm: "inventory.view" },
      { label: "Stock Movements", to: "/inventory/movements", perm: "inventory.view" },
      { label: "Counts & Adjustments", to: "/inventory/adjustments", perm: "inventory.view" },
      { label: "Stock Transfers", to: "/transfers", perm: "inventory.view" },
      { label: "Reorder Management", to: "/reorder", perm: "reorder.view" },
    ],
  },
  {
    section: "Purchasing",
    items: [
      { label: "Purchase Requests", to: "/purchasing/requests", perm: "purchasing.view" },
      { label: "Purchase Orders", to: "/purchasing/orders", perm: "purchasing.view" },
      { label: "Goods Received", to: "/purchasing/receipts", perm: "purchasing.view" },
      { label: "Supplier Bills", to: "/purchasing/bills", perm: "purchasing.view" },
      { label: "Supplier Payments", to: "/purchasing/payments", perm: "purchasing.view" },
      { label: "Suppliers", to: "/suppliers", perm: "purchasing.view" },
    ],
  },
  {
    section: "Sales",
    items: [
      { label: "Quotations", to: "/sales/quotations", perm: "sales.view" },
      { label: "Sales Orders", to: "/sales/orders", perm: "sales.view" },
      { label: "Invoices", to: "/sales/invoices", perm: "sales.view" },
      { label: "Credit Notes & Returns", to: "/sales/credit-notes", perm: "sales.view" },
      { label: "Customer Payments", to: "/sales/payments", perm: "sales.view" },
      { label: "Customers", to: "/customers", perm: "sales.view" },
    ],
  },
  {
    section: "Accounting",
    items: [
      { label: "Expenses", to: "/expenses", perm: "expenses.create" },
      { label: "Chart of Accounts", to: "/accounting/accounts", perm: "accounting.view" },
      { label: "Journal Entries", to: "/accounting/journals", perm: "accounting.view" },
      { label: "General Ledger", to: "/accounting/ledger", perm: "accounting.view" },
      { label: "Bank Reconciliation", to: "/accounting/reconcile", perm: "accounting.reconcile" },
      { label: "Financial Periods", to: "/accounting/periods", perm: "accounting.view" },
    ],
  },
  {
    section: "Reports",
    items: [
      { label: "Financial Reports", to: "/reports/financial", perm: "reports.financial" },
      { label: "Operational Reports", to: "/reports/operations", perm: "reports.view" },
    ],
  },
  {
    section: "Control",
    items: [
      { label: "Approvals", to: "/approvals", badge: "approvals" },
      { label: "Notifications", to: "/notifications", badge: "notifications" },
      { label: "Branches & Stores", to: "/admin/branches", perm: "branches.manage" },
      { label: "Users & Roles", to: "/admin/users", perm: "users.manage" },
      { label: "Audit Log", to: "/admin/audit", perm: "audit.view" },
      { label: "Settings", to: "/admin/settings", perm: "settings.manage" },
    ],
  },
];

function NavItem({ item, badge, onNavigate }) {
  return (
    <NavLink
      to={item.to}
      end={item.to === "/" || item.to === "/inventory"}
      onClick={onNavigate}
      className={({ isActive }) =>
        `flex items-center justify-between rounded-md px-3 py-1.5 text-sm ${
          isActive ? "bg-brand-600 font-medium text-white" : "text-ink-300 hover:bg-white/5 hover:text-white"
        }`
      }
    >
      <span>{item.label}</span>
      {badge > 0 && <span className="rounded-full bg-amber-500 px-1.5 text-xs font-semibold text-white">{badge}</span>}
    </NavLink>
  );
}

export default function Layout({ children }) {
  const app = useApp();
  const { signOut } = useAuthActions();
  const navigate = useNavigate();
  const offline = useOffline();
  const [open, setOpen] = useState(false);
  const [lookup, setLookup] = useState("");
  const approvals = useQuery(api.reports.approvals);
  const badges = { approvals: approvals?.length ?? 0, notifications: app.me.unreadNotifications };

  const sidebar = (
    <nav className="flex h-full flex-col">
      <div className="flex items-center gap-2.5 px-4 py-4">
        <div className="flex h-8 w-8 items-center justify-center rounded-md bg-brand-600 font-bold text-white">M</div>
        <div className="leading-tight">
          <div className="text-sm font-semibold text-white">{app.company?.name ?? "Mareero"}</div>
          <div className="text-[11px] text-ink-400">Management System</div>
        </div>
      </div>
      <div className="flex-1 space-y-4 overflow-y-auto px-2 pb-6">
        {NAV.map((n, i) =>
          n.to ? (
            <NavItem key={i} item={n} onNavigate={() => setOpen(false)} />
          ) : (
            (() => {
              const items = n.items.filter((it) => !it.perm || app.can(it.perm));
              if (!items.length) return null;
              return (
                <div key={i}>
                  <div className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-wider text-ink-500">{n.section}</div>
                  <div className="space-y-0.5">
                    {items.map((it) => (
                      <NavItem key={it.to} item={it} badge={it.badge ? badges[it.badge] : 0} onNavigate={() => setOpen(false)} />
                    ))}
                  </div>
                </div>
              );
            })()
          ),
        )}
      </div>
    </nav>
  );

  return (
    <div className="flex min-h-screen">
      <aside className="no-print fixed inset-y-0 left-0 z-30 hidden w-60 bg-ink-900 lg:block">{sidebar}</aside>
      {open && (
        <div className="no-print fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-ink-900/50" onClick={() => setOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-64 bg-ink-900">{sidebar}</aside>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col lg:pl-60">
        <header className="no-print sticky top-0 z-20 flex flex-wrap items-center gap-2 border-b border-ink-200 bg-white px-4 py-2.5">
          <button className="btn-ghost lg:hidden" onClick={() => setOpen(true)} aria-label="Menu">
            ☰
          </button>
          <form
            className="min-w-[160px] flex-1"
            onSubmit={(e) => {
              e.preventDefault();
              if (lookup.trim()) navigate(`/products?q=${encodeURIComponent(lookup.trim())}`);
            }}
          >
            <input
              className="input max-w-md"
              placeholder="Search parts by name, SKU, part no., barcode or vehicle…"
              value={lookup}
              onChange={(e) => setLookup(e.target.value)}
            />
          </form>
          <select className="input w-auto" value={app.branchId ?? ""} onChange={(e) => app.setBranchId(e.target.value)} title="Branch">
            {app.can("all_branches") || app.branches.length > 1 ? <option value="">All branches</option> : null}
            {app.branches.map((b) => (
              <option key={b._id} value={b._id}>
                {b.name}
              </option>
            ))}
          </select>
          <select className="input w-auto" value={app.storeId ?? ""} onChange={(e) => app.setStoreId(e.target.value)} title="Store">
            <option value="">All stores</option>
            {app.visibleStores.map((s) => (
              <option key={s._id} value={s._id}>
                {s.name}
              </option>
            ))}
          </select>
          <button className="btn-ghost relative" onClick={() => navigate("/notifications")} title="Notifications">
            🔔
            {app.me.unreadNotifications > 0 && (
              <span className="absolute -right-0.5 -top-0.5 rounded-full bg-red-600 px-1 text-[10px] font-semibold text-white">
                {app.me.unreadNotifications}
              </span>
            )}
          </button>
          <div className="flex items-center gap-2 border-l border-ink-200 pl-3">
            <div className="hidden text-right leading-tight sm:block">
              <div className="text-sm font-medium text-ink-800">{app.member.name}</div>
              <div className="text-xs text-ink-500">{app.me.roleLabel}</div>
            </div>
            <button
              className="btn-secondary btn-sm"
              onClick={() => {
                clearSaved(); // don't leave company data on a shared computer
                if (offline) {
                  forgetSignIn();
                  window.location.reload();
                } else signOut();
              }}
            >
              Sign out
            </button>
          </div>
        </header>
        {offline && (
          <div className="no-print border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800">
            <span className="font-semibold">Offline.</span> Showing data saved on this computer from your last visit. Changes
            can't be saved until the internet connection is back.
          </div>
        )}
        <main className="flex-1 p-4 sm:p-6">{children}</main>
      </div>
    </div>
  );
}
