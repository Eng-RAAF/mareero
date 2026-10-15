import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "../lib/convex";
import { api } from "../../convex/_generated/api";
import { useApp } from "../lib/app";
import { Card, Loading, PageHeader, StatCard, Select, Empty } from "../components/ui";
import { DAY, money, monthStart, num, yearStart, endOfDay, startOfDay } from "../lib/format";

const RANGES = [
  { value: "month", label: "This month" },
  { value: "30", label: "Last 30 days" },
  { value: "7", label: "Last 7 days" },
  { value: "year", label: "This year" },
];

export default function Dashboard() {
  const app = useApp();
  const navigate = useNavigate();
  const [range, setRange] = useState("month");
  const { from, to } = useMemo(() => {
    const now = Date.now();
    const to = endOfDay(now);
    if (range === "month") return { from: monthStart(now), to };
    if (range === "year") return { from: yearStart(now), to };
    return { from: startOfDay(now - (Number(range) - 1) * DAY), to };
  }, [range]);
  const data = useQuery(api.reports.dashboard, { from, to, branchId: app.branchId });
  const products = useQuery(api.products.list, app.can("products.view") ? { search: undefined } : "skip");

  return (
    <div>
      <PageHeader
        title={`Welcome, ${app.member.name.split(" ")[0]}`}
        subtitle={`${app.branchId ? app.branchName(app.branchId) : "All branches"} · ${app.me.roleLabel}`}
        actions={<Select className="w-40" value={range} onChange={(e) => setRange(e.target.value)} options={RANGES} />}
      />
      {!data ? (
        <Loading />
      ) : (
        <div className="space-y-5">
          {products && products.length === 0 && app.can("products.manage") && (
            <div className="card flex flex-wrap items-center justify-between gap-3 border-brand-200 bg-brand-50 p-4">
              <div>
                <div className="font-semibold text-brand-800">Your catalogue is empty</div>
                <div className="text-sm text-brand-700">Add products, import a CSV, or load sample data from Settings to try every workflow.</div>
              </div>
              <div className="flex gap-2">
                <button className="btn-primary" onClick={() => navigate("/products")}>Add products</button>
                {app.can("settings.manage") && <button className="btn-secondary" onClick={() => navigate("/admin/settings")}>Settings</button>}
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <StatCard title="Sales" value={money(data.kpi.sales)} sub="net of returns & discounts" onClick={() => navigate("/sales/invoices")} />
            {!data.limited && (
              <>
                <StatCard title="Gross profit" value={money(data.kpi.grossProfit)} sub={`${data.kpi.grossMargin}% margin`} tone="good" />
                <StatCard title="Expenses" value={money(data.kpi.expenses)} onClick={app.can("expenses.create") ? () => navigate("/expenses") : undefined} />
                <StatCard title="Net profit" value={money(data.kpi.netProfit)} tone={data.kpi.netProfit >= 0 ? "good" : "bad"} />
              </>
            )}
            <StatCard title="Inventory value" value={money(data.kpi.inventoryValue)} onClick={() => navigate("/inventory")} />
            <StatCard
              title="Low stock"
              value={num(data.kpi.lowStock)}
              sub={`${data.kpi.critical} critical`}
              tone={data.kpi.critical ? "bad" : data.kpi.lowStock ? "warn" : "default"}
              onClick={app.can("reorder.view") ? () => navigate("/reorder") : undefined}
            />
          </div>

          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <StatCard title="Receivables" value={money(data.kpi.receivables)} sub={`${money(data.kpi.overdueReceivables)} overdue`} tone={data.kpi.overdueReceivables ? "warn" : "default"} onClick={() => navigate("/sales/invoices")} />
            {!data.limited && <StatCard title="Payables" value={money(data.kpi.payables)} sub={`${money(data.kpi.overduePayables)} overdue`} tone={data.kpi.overduePayables ? "warn" : "default"} onClick={app.can("purchasing.view") ? () => navigate("/purchasing/bills") : undefined} />}
            <StatCard title="Pending approvals" value={num(data.approvals)} tone={data.approvals ? "warn" : "default"} onClick={() => navigate("/approvals")} />
            {!data.limited && <StatCard title="Cash & bank" value={money(data.cash.reduce((a, c) => a + c.balance, 0))} sub={data.cash.map((c) => `${c.name}: ${money(c.balance)}`).join(" · ")} />}
          </div>

          <div className="grid grid-cols-1 gap-5 xl:grid-cols-3">
            <Card title="Daily sales" className="xl:col-span-2">
              <SalesBars trend={data.trend} />
            </Card>
            <Card title="Top products" bodyClass="p-0">
              {data.topProducts.length === 0 ? (
                <Empty>No sales in this period.</Empty>
              ) : (
                <table className="table">
                  <tbody>
                    {data.topProducts.map((p) => (
                      <tr key={p.name}>
                        <td>{p.name}</td>
                        <td className="num text-ink-500">{num(p.qty)}</td>
                        <td className="num font-medium">{money(p.revenue)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>
          </div>

          <Card title="Branch performance" bodyClass="p-0">
            <table className="table">
              <thead>
                <tr>
                  <th>Branch</th>
                  <th className="text-right">Sales</th>
                  {!data.limited && <th className="text-right">Gross profit</th>}
                  {!data.limited && <th className="text-right">Margin</th>}
                  <th className="text-right">Stock value</th>
                </tr>
              </thead>
              <tbody>
                {data.branchPerf.map((b) => (
                  <tr key={b.branch}>
                    <td className="font-medium">{b.branch}</td>
                    <td className="num">{money(b.sales)}</td>
                    {!data.limited && <td className="num">{money(b.grossProfit)}</td>}
                    {!data.limited && <td className="num">{b.sales ? `${Math.round((b.grossProfit / b.sales) * 1000) / 10}%` : "—"}</td>}
                    <td className="num">{money(b.stockValue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </div>
      )}
    </div>
  );
}

function SalesBars({ trend }) {
  const max = Math.max(1, ...trend.map((t) => t.sales));
  const total = trend.reduce((a, t) => a + t.sales, 0);
  if (!total) return <Empty>No invoiced sales in this period yet.</Empty>;
  const step = Math.ceil(trend.length / 12);
  return (
    <div>
      <div className="flex h-48 items-end gap-[2px]">
        {trend.map((t) => (
          <div key={t.date} className="group relative flex-1">
            <div className="w-full rounded-t bg-brand-500 transition group-hover:bg-brand-700" style={{ height: `${Math.max(2, (t.sales / max) * 184)}px` }} />
            <div className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 hidden -translate-x-1/2 whitespace-nowrap rounded bg-ink-900 px-2 py-1 text-xs text-white group-hover:block">
              {t.date}: {money(t.sales)}
            </div>
          </div>
        ))}
      </div>
      <div className="mt-1 flex gap-[2px] text-[10px] text-ink-400">
        {trend.map((t, i) => (
          <div key={t.date} className="flex-1 text-center">
            {i % step === 0 ? t.date : ""}
          </div>
        ))}
      </div>
    </div>
  );
}
