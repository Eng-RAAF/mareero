import { useState } from "react";
import { useQuery } from "../lib/convex";
import { api } from "../../convex/_generated/api";
import { useApp } from "../lib/app";
import { Badge, Card, DataTable, Input, Loading, PageHeader, Select, Tabs } from "../components/ui";
import { date, endOfDay, fromInput, money, monthStart, num, toInput, yearStart } from "../lib/format";

function useRange(initialFrom = yearStart()) {
  const [from, setFrom] = useState(toInput(initialFrom));
  const [to, setTo] = useState(toInput());
  const controls = (
    <div className="flex flex-wrap items-center gap-2">
      <Input type="date" className="w-40" value={from} onChange={(e) => setFrom(e.target.value)} />
      <span className="text-ink-400">to</span>
      <Input type="date" className="w-40" value={to} onChange={(e) => setTo(e.target.value)} />
      <button className="btn-ghost btn-sm" onClick={() => { setFrom(toInput(monthStart())); setTo(toInput()); }}>This month</button>
      <button className="btn-ghost btn-sm" onClick={() => { setFrom(toInput(yearStart())); setTo(toInput()); }}>This year</button>
    </div>
  );
  return { from: fromInput(from) - 12 * 3600 * 1000, to: endOfDay(fromInput(to)), controls, toLabel: to, fromLabel: from };
}

function Section({ title, rows, total, totalLabel }) {
  return (
    <>
      <tr className="bg-ink-50"><td colSpan={2} className="font-semibold text-ink-700">{title}</td></tr>
      {rows.map((r) => (
        <tr key={r._id ?? r.name}><td className="pl-8">{r.code ? `${r.code} · ` : ""}{r.name ?? r.label}</td><td className="num">{money(r.amount)}</td></tr>
      ))}
      {totalLabel && <tr><td className="pl-4 font-medium">{totalLabel}</td><td className="num border-t border-ink-300 font-medium">{money(total)}</td></tr>}
    </>
  );
}

function Statement({ title, subtitle, children }) {
  return (
    <Card bodyClass="p-0">
      <div className="border-b border-ink-100 px-4 py-3 text-center">
        <div className="font-semibold">{title}</div>
        <div className="text-xs text-ink-500">{subtitle}</div>
      </div>
      <table className="table">
        <tbody>{children}</tbody>
      </table>
    </Card>
  );
}

function ProfitLoss({ branchId }) {
  const app = useApp();
  const r = useRange();
  const d = useQuery(api.accounting.profitAndLoss, { from: r.from, to: r.to, branchId });
  return (
    <div>
      <div className="no-print mb-3 flex flex-wrap justify-between gap-2">{r.controls}<button className="btn-secondary btn-sm" onClick={() => window.print()}>Print</button></div>
      {!d ? <Loading /> : (
        <Statement title={`${app.company.name} — Profit and Loss`} subtitle={`${date(r.from + 12 * 3600 * 1000)} – ${date(r.to)}${branchId ? ` · ${app.branchName(branchId)}` : ""}`}>
          <Section title="Revenue" rows={d.revenue} total={d.totalRevenue} totalLabel="Total revenue" />
          <Section title="Cost of goods sold" rows={d.cogs} total={d.totalCogs} totalLabel="Total cost of goods sold" />
          <tr className="bg-brand-50"><td className="font-semibold">Gross profit ({d.grossMargin}%)</td><td className="num font-semibold">{money(d.grossProfit)}</td></tr>
          <Section title="Operating expenses" rows={d.expenses} total={d.totalExpenses} totalLabel="Total operating expenses" />
          <tr><td className="font-semibold">Operating profit</td><td className="num font-semibold">{money(d.operatingProfit)}</td></tr>
          {(d.otherIncome.length > 0 || d.otherExpenses.length > 0) && (
            <>
              <Section title="Other income" rows={d.otherIncome} total={d.totalOtherIncome} totalLabel="Total other income" />
              <Section title="Other expenses" rows={d.otherExpenses} total={d.totalOtherExpenses} totalLabel="Total other expenses" />
            </>
          )}
          <tr className="bg-ink-100 text-base"><td className="font-bold">Net profit</td><td className={`num font-bold ${d.netProfit < 0 ? "text-red-600" : ""}`}>{money(d.netProfit)}</td></tr>
        </Statement>
      )}
    </div>
  );
}

function BalanceSheet({ branchId }) {
  const app = useApp();
  const [asOf, setAsOf] = useState(toInput());
  const d = useQuery(api.accounting.balanceSheet, { asOf: endOfDay(fromInput(asOf)), branchId });
  return (
    <div>
      <div className="no-print mb-3 flex justify-between gap-2"><div className="flex items-center gap-2">As of <Input type="date" className="w-40" value={asOf} onChange={(e) => setAsOf(e.target.value)} /></div><button className="btn-secondary btn-sm" onClick={() => window.print()}>Print</button></div>
      {!d ? <Loading /> : (
        <Statement title={`${app.company.name} — Balance Sheet`} subtitle={`As of ${date(fromInput(asOf))}${branchId ? ` · ${app.branchName(branchId)}` : ""}`}>
          <Section title="Assets" rows={d.assets} total={d.totalAssets} totalLabel="Total assets" />
          <Section title="Liabilities" rows={d.liabilities} total={d.totalLiabilities} totalLabel="Total liabilities" />
          <Section title="Equity" rows={d.equity} total={d.totalEquity} totalLabel="Total equity" />
          <tr className="bg-ink-100"><td className="font-bold">Total liabilities & equity</td><td className="num font-bold">{money(d.totalLiabilitiesAndEquity)}</td></tr>
          <tr><td colSpan={2} className={`text-center text-xs ${d.balanced ? "text-brand-700" : "text-red-600"}`}>{d.balanced ? "✓ Assets = Liabilities + Equity" : "⚠ Out of balance — check branch-filtered or opening entries"}</td></tr>
        </Statement>
      )}
    </div>
  );
}

function CashFlow({ branchId }) {
  const app = useApp();
  const r = useRange(monthStart());
  const d = useQuery(api.accounting.cashFlow, { from: r.from, to: r.to, branchId });
  const t = (xs) => xs.reduce((a, x) => a + x.amount, 0);
  return (
    <div>
      <div className="no-print mb-3 flex flex-wrap justify-between gap-2">{r.controls}<button className="btn-secondary btn-sm" onClick={() => window.print()}>Print</button></div>
      {!d ? <Loading /> : (
        <Statement title={`${app.company.name} — Cash Flow (direct)`} subtitle={`${date(r.from + 12 * 3600 * 1000)} – ${date(r.to)}`}>
          <tr><td className="font-medium">Opening cash & bank</td><td className="num">{money(d.openingCash)}</td></tr>
          <Section title="Operating activities" rows={d.operating} total={t(d.operating)} totalLabel="Net cash from operations" />
          <Section title="Investing activities" rows={d.investing} total={t(d.investing)} totalLabel="Net cash from investing" />
          <Section title="Financing activities" rows={d.financing} total={t(d.financing)} totalLabel="Net cash from financing" />
          <tr><td className="font-medium">Net change in cash</td><td className="num font-medium">{money(d.netChange)}</td></tr>
          <tr className="bg-ink-100"><td className="font-bold">Closing cash & bank</td><td className="num font-bold">{money(d.closingCash)}</td></tr>
        </Statement>
      )}
    </div>
  );
}

function TrialBalance({ branchId }) {
  const [asOf, setAsOf] = useState(toInput());
  const d = useQuery(api.accounting.trialBalance, { asOf: endOfDay(fromInput(asOf)), branchId });
  return (
    <Card bodyClass="p-0">
      <DataTable
        rows={d?.rows}
        exportName="trial-balance"
        toolbar={<div className="flex items-center gap-2 text-sm">As of <Input type="date" className="w-40" value={asOf} onChange={(e) => setAsOf(e.target.value)} />{d && <Badge color={Math.abs(d.totalDebit - d.totalCredit) < 0.01 ? "green" : "red"}>{Math.abs(d.totalDebit - d.totalCredit) < 0.01 ? "Balanced" : "Not balanced"}</Badge>}</div>}
        totals
        columns={[
          { key: "code", header: "Code" },
          { key: "name", header: "Account" },
          { key: "debit", header: "Debit", align: "right", total: true, totalRender: money, render: (r) => (r.debit ? money(r.debit) : "") },
          { key: "credit", header: "Credit", align: "right", total: true, totalRender: money, render: (r) => (r.credit ? money(r.credit) : "") },
        ]}
      />
    </Card>
  );
}

function Aging({ kind }) {
  const rows = useQuery(kind === "ar" ? api.accounting.receivablesAging : api.accounting.payablesAging, {});
  return (
    <Card bodyClass="p-0">
      <DataTable
        rows={rows}
        exportName={kind === "ar" ? "receivables-aging" : "payables-aging"}
        totals
        columns={[
          { key: "name", header: kind === "ar" ? "Customer" : "Supplier" },
          { key: "current", header: "Current", align: "right", total: true, totalRender: money, render: (r) => money(r.current) },
          { key: "d1_30", header: "1–30", align: "right", total: true, totalRender: money, render: (r) => money(r.d1_30) },
          { key: "d31_60", header: "31–60", align: "right", total: true, totalRender: money, render: (r) => money(r.d31_60) },
          { key: "d61_90", header: "61–90", align: "right", total: true, totalRender: money, render: (r) => money(r.d61_90) },
          { key: "d90_plus", header: "90+", align: "right", total: true, totalRender: money, render: (r) => <span className={r.d90_plus ? "font-semibold text-red-600" : ""}>{money(r.d90_plus)}</span> },
          { key: "total", header: "Total", align: "right", total: true, totalRender: money, render: (r) => <b>{money(r.total)}</b> },
        ]}
        empty="Nothing outstanding."
      />
    </Card>
  );
}

function BranchProfit() {
  const r = useRange();
  const rows = useQuery(api.accounting.branchProfitability, { from: r.from, to: r.to });
  return (
    <div>
      <div className="mb-3">{r.controls}</div>
      <Card bodyClass="p-0">
        <DataTable
          search={false}
          rows={rows}
          exportName="branch-profitability"
          totals
          columns={[
            { key: "branch", header: "Branch" },
            { key: "revenue", header: "Revenue", align: "right", total: true, totalRender: money, render: (x) => money(x.revenue) },
            { key: "cogs", header: "COGS", align: "right", total: true, totalRender: money, render: (x) => money(x.cogs) },
            { key: "grossProfit", header: "Gross profit", align: "right", total: true, totalRender: money, render: (x) => money(x.grossProfit) },
            { key: "grossMargin", header: "Margin", align: "right", render: (x) => `${x.grossMargin}%` },
            { key: "expenses", header: "Expenses", align: "right", total: true, totalRender: money, render: (x) => money(x.expenses) },
            { key: "netProfit", header: "Net profit", align: "right", total: true, totalRender: money, render: (x) => <b>{money(x.netProfit)}</b> },
          ]}
        />
      </Card>
    </div>
  );
}

export function FinancialReports() {
  const app = useApp();
  const [tab, setTab] = useState("pl");
  return (
    <div>
      <PageHeader title="Financial Reports" subtitle={app.branchId ? `Filtered to ${app.branchName(app.branchId)}` : "Consolidated — all branches"} />
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { value: "pl", label: "Profit & Loss" },
          { value: "bs", label: "Balance Sheet" },
          { value: "cf", label: "Cash Flow" },
          { value: "tb", label: "Trial Balance" },
          { value: "branch", label: "Branch Profitability" },
          { value: "ar", label: "Receivables Aging" },
          { value: "ap", label: "Payables Aging" },
        ]}
      />
      {tab === "pl" && <ProfitLoss branchId={app.branchId} />}
      {tab === "bs" && <BalanceSheet branchId={app.branchId} />}
      {tab === "cf" && <CashFlow branchId={app.branchId} />}
      {tab === "tb" && <TrialBalance branchId={app.branchId} />}
      {tab === "branch" && <BranchProfit />}
      {tab === "ar" && <Aging kind="ar" />}
      {tab === "ap" && <Aging kind="ap" />}
    </div>
  );
}

// ═════════════ Operational ═════════════
function SalesReport({ branchId }) {
  const r = useRange(monthStart());
  const [groupBy, setGroupBy] = useState("product");
  const rows = useQuery(api.reports.sales, { from: r.from, to: r.to, groupBy, branchId });
  return (
    <div>
      <div className="mb-3 flex flex-wrap gap-2">
        {r.controls}
        <Select className="w-44" value={groupBy} onChange={(e) => setGroupBy(e.target.value)} options={[["day", "By day"], ["month", "By month"], ["product", "By product"], ["category", "By category"], ["customer", "By customer"], ["branch", "By branch"]].map(([value, label]) => ({ value, label }))} />
      </div>
      <Card bodyClass="p-0">
        <DataTable
          rows={rows}
          exportName={`sales-by-${groupBy}`}
          totals
          columns={[
            { key: "key", header: groupBy.charAt(0).toUpperCase() + groupBy.slice(1) },
            { key: "qty", header: "Qty", align: "right", total: true, totalRender: num, render: (x) => num(x.qty) },
            { key: "revenue", header: "Gross sales", align: "right", total: true, totalRender: money, render: (x) => money(x.revenue) },
            { key: "returns", header: "Returns", align: "right", total: true, totalRender: money, render: (x) => (x.returns ? money(x.returns) : "") },
            { key: "netSales", header: "Net sales", align: "right", total: true, totalRender: money, render: (x) => money(x.netSales) },
            { key: "cost", header: "Cost", align: "right", total: true, totalRender: money, render: (x) => money(x.cost) },
            { key: "grossProfit", header: "Gross margin", align: "right", total: true, totalRender: money, render: (x) => money(x.grossProfit) },
            { key: "margin", header: "%", align: "right", render: (x) => `${x.margin}%` },
          ]}
        />
      </Card>
    </div>
  );
}

function Valuation({ branchId, storeId }) {
  const d = useQuery(api.reports.inventoryValuation, { branchId, storeId });
  return (
    <div>
      {d && d.ledgerValue !== null && (
        <div className={`mb-3 rounded-md px-4 py-2 text-sm ${Math.abs(d.ledgerValue - d.total) < 0.05 ? "bg-brand-50 text-brand-800" : "bg-amber-50 text-amber-800"}`}>
          Stock records {money(d.total)} · Inventory account in the ledger {money(d.ledgerValue)} {Math.abs(d.ledgerValue - d.total) < 0.05 ? "✓ reconciled" : `· difference ${money(d.total - d.ledgerValue)}`}
        </div>
      )}
      <Card bodyClass="p-0">
        <DataTable
          rows={d?.rows}
          exportName="inventory-valuation"
          totals
          columns={[
            { key: "sku", header: "SKU" },
            { key: "name", header: "Name" },
            { key: "store", header: "Store" },
            { key: "onHand", header: "On hand", align: "right", total: true, totalRender: num, render: (x) => num(x.onHand) },
            { key: "avgCost", header: "Avg cost", align: "right", render: (x) => money(x.avgCost) },
            { key: "value", header: "Cost value", align: "right", total: true, totalRender: money, render: (x) => money(x.value) },
            { key: "retailValue", header: "Retail value", align: "right", total: true, totalRender: money, render: (x) => money(x.retailValue) },
          ]}
        />
      </Card>
    </div>
  );
}

function Velocity({ branchId }) {
  const [days, setDays] = useState(90);
  const [cls, setCls] = useState("");
  const rows = useQuery(api.reports.stockVelocity, { days, branchId });
  const shown = rows?.filter((r) => !cls || r.class === cls);
  return (
    <Card bodyClass="p-0">
      <DataTable
        rows={shown}
        exportName="stock-velocity"
        toolbar={
          <>
            <Select className="w-40" value={days} onChange={(e) => setDays(Number(e.target.value))} options={[30, 60, 90, 180, 365].map((d) => ({ value: d, label: `Last ${d} days` }))} />
            <Select className="w-40" value={cls} onChange={(e) => setCls(e.target.value)} placeholder="All items" options={["fast", "normal", "slow", "dead"].map((c) => ({ value: c, label: `${c.charAt(0).toUpperCase() + c.slice(1)} moving` }))} />
          </>
        }
        columns={[
          { key: "sku", header: "SKU" },
          { key: "name", header: "Name" },
          { key: "sold", header: "Sold", align: "right", render: (x) => num(x.sold) },
          { key: "dailyDemand", header: "Per day", align: "right" },
          { key: "onHand", header: "On hand", align: "right", render: (x) => num(x.onHand) },
          { key: "daysCover", header: "Days of cover", align: "right", render: (x) => (x.daysCover ?? "∞") },
          { key: "lastMovementDays", header: "Days since last move", align: "right", render: (x) => (x.lastMovementDays ?? "—") },
          { key: "value", header: "Stock value", align: "right", render: (x) => money(x.value) },
          { key: "class", header: "Class", render: (x) => <Badge color={{ fast: "green", normal: "gray", slow: "amber", dead: "red" }[x.class]}>{x.class}</Badge> },
        ]}
      />
    </Card>
  );
}

function PurchasingReport() {
  const r = useRange();
  const d = useQuery(api.reports.purchasing, { from: r.from, to: r.to });
  return (
    <div className="space-y-5">
      {r.controls}
      <Card title="By supplier" bodyClass="p-0">
        <DataTable
          rows={d?.bySupplier}
          exportName="purchases-by-supplier"
          totals
          columns={[
            { key: "supplier", header: "Supplier" },
            { key: "orders", header: "POs", align: "right" },
            { key: "ordered", header: "Ordered", align: "right", total: true, totalRender: money, render: (x) => money(x.ordered) },
            { key: "received", header: "Received", align: "right", total: true, totalRender: money, render: (x) => money(x.received) },
            { key: "onTimePct", header: "On-time delivery", align: "right", render: (x) => (x.onTimePct === null ? "—" : `${x.onTimePct}%`) },
            { key: "balance", header: "Balance owed", align: "right", total: true, totalRender: money, render: (x) => money(x.balance) },
          ]}
        />
      </Card>
      <Card title="Outstanding purchase orders" bodyClass="p-0">
        <DataTable
          rows={d?.outstanding}
          exportName="outstanding-pos"
          columns={[
            { key: "number", header: "PO" },
            { key: "supplier", header: "Supplier" },
            { key: "date", header: "Ordered", render: (x) => date(x.date) },
            { key: "expectedDate", header: "Expected", render: (x) => <span className={x.late ? "font-medium text-red-600" : ""}>{date(x.expectedDate)}</span> },
            { key: "total", header: "PO total", align: "right", render: (x) => money(x.total) },
            { key: "outstandingValue", header: "Not yet received", align: "right", render: (x) => money(x.outstandingValue) },
          ]}
          empty="No open purchase orders."
        />
      </Card>
    </div>
  );
}

export function OperationalReports() {
  const app = useApp();
  const [tab, setTab] = useState("sales");
  return (
    <div>
      <PageHeader title="Operational Reports" subtitle={app.branchId ? app.branchName(app.branchId) : "All branches"} />
      <Tabs value={tab} onChange={setTab} tabs={[{ value: "sales", label: "Sales" }, { value: "valuation", label: "Inventory valuation" }, { value: "velocity", label: "Fast / slow / dead stock" }, { value: "purchasing", label: "Purchasing" }]} />
      {tab === "sales" && <SalesReport branchId={app.branchId} />}
      {tab === "valuation" && <Valuation branchId={app.branchId} storeId={app.storeId} />}
      {tab === "velocity" && <Velocity branchId={app.branchId} />}
      {tab === "purchasing" && <PurchasingReport />}
    </div>
  );
}
