import { Navigate, Route, Routes } from "react-router-dom";
import { useEffect } from "react";
import { claimSaved, readSaved, useConvexAuth, useOffline, useQuery } from "./lib/convex";
import { api } from "../convex/_generated/api";
import { AppProvider } from "./lib/app";
import Layout from "./components/Layout";
import { SignIn, CompanySetup, NoAccess } from "./pages/Auth";
import Dashboard from "./pages/Dashboard";
import { Products, ProductDetail } from "./pages/Products";
import { StockOnHand, Movements, Adjustments } from "./pages/Inventory";
import Transfers from "./pages/Transfers";
import Reorder from "./pages/Reorder";
import { Requests, Orders, OrderDetail, Receipts, Bills, SupplierPayments } from "./pages/Purchasing";
import { Suppliers, Customers } from "./pages/Parties";
import { SalesList, SalesEditor, SalesView, CreditNotes, CustomerPayments } from "./pages/Sales";
import Expenses from "./pages/Expenses";
import { Accounts, Journals, Ledger, Reconcile, Periods } from "./pages/Accounting";
import { FinancialReports, OperationalReports } from "./pages/Reports";
import { Approvals, Notifications, Branches, Users, AuditLog, Settings } from "./pages/Control";

function Splash({ offline }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-1 px-4 text-center text-sm text-ink-400">
      {offline ? (
        <>
          <div className="font-medium text-ink-700">You are offline</div>
          <div>No data is saved on this computer yet. Connect to the internet and sign in once to use Mareero offline.</div>
        </>
      ) : (
        "Loading Mareero…"
      )}
    </div>
  );
}

export default function App() {
  const { isLoading, isAuthenticated } = useConvexAuth();
  const offline = useOffline();
  const status = useQuery(api.setup.status);
  const liveMe = useQuery(api.setup.me, isAuthenticated ? {} : "skip");

  useEffect(() => {
    if (isAuthenticated && status?.email) claimSaved(status.email);
  }, [isAuthenticated, status?.email]);

  // Offline, the sign-in can't be confirmed with the server: open with the account saved on this device
  const savedMe = offline && isLoading ? readSaved(api.setup.me) : undefined;
  const me = liveMe ?? savedMe;

  if (!savedMe) {
    if (isLoading || status === undefined) return <Splash offline={offline} />;
    if (!isAuthenticated || !status.signedIn) return <SignIn hasCompany={status.hasCompany} />;
    if (!status.hasCompany) return <CompanySetup />;
    if (!status.hasMember) return <NoAccess email={status.email} pendingInvite={status.pendingInvite} />;
    if (!me) return <Splash offline={offline} />;
  }

  return (
    <AppProvider me={me}>
      <Layout>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/products" element={<Products />} />
          <Route path="/products/:id" element={<ProductDetail />} />
          <Route path="/inventory" element={<StockOnHand />} />
          <Route path="/inventory/movements" element={<Movements />} />
          <Route path="/inventory/adjustments" element={<Adjustments />} />
          <Route path="/transfers" element={<Transfers />} />
          <Route path="/reorder" element={<Reorder />} />
          <Route path="/purchasing/requests" element={<Requests />} />
          <Route path="/purchasing/orders" element={<Orders />} />
          <Route path="/purchasing/orders/:id" element={<OrderDetail />} />
          <Route path="/purchasing/receipts" element={<Receipts />} />
          <Route path="/purchasing/bills" element={<Bills />} />
          <Route path="/purchasing/payments" element={<SupplierPayments />} />
          <Route path="/suppliers" element={<Suppliers />} />
          <Route path="/sales/quotations" element={<SalesList kind="quotation" />} />
          <Route path="/sales/orders" element={<SalesList kind="order" />} />
          <Route path="/sales/invoices" element={<SalesList kind="invoice" />} />
          <Route path="/sales/:kind/new" element={<SalesEditor />} />
          <Route path="/sales/doc/:id" element={<SalesView />} />
          <Route path="/sales/doc/:id/edit" element={<SalesEditor />} />
          <Route path="/sales/credit-notes" element={<CreditNotes />} />
          <Route path="/sales/payments" element={<CustomerPayments />} />
          <Route path="/customers" element={<Customers />} />
          <Route path="/expenses" element={<Expenses />} />
          <Route path="/accounting/accounts" element={<Accounts />} />
          <Route path="/accounting/journals" element={<Journals />} />
          <Route path="/accounting/ledger" element={<Ledger />} />
          <Route path="/accounting/reconcile" element={<Reconcile />} />
          <Route path="/accounting/periods" element={<Periods />} />
          <Route path="/reports/financial" element={<FinancialReports />} />
          <Route path="/reports/operations" element={<OperationalReports />} />
          <Route path="/approvals" element={<Approvals />} />
          <Route path="/notifications" element={<Notifications />} />
          <Route path="/admin/branches" element={<Branches />} />
          <Route path="/admin/users" element={<Users />} />
          <Route path="/admin/audit" element={<AuditLog />} />
          <Route path="/admin/settings" element={<Settings />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Layout>
    </AppProvider>
  );
}
