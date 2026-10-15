import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery } from "../lib/convex";
import { api } from "../../convex/_generated/api";
import { useApp } from "../lib/app";
import { Badge, Card, Checkbox, DataTable, Field, Input, Modal, PageHeader, Select, Tabs, usePrompt, useRun } from "../components/ui";
import { LineEditor, cleanLines } from "../components/LineEditor";
import { date, dateTime, fromInput, label, money, num, toInput } from "../lib/format";

export function StockOnHand() {
  const app = useApp();
  const [onlyLow, setOnlyLow] = useState(false);
  const rows = useQuery(api.inventory.stockOnHand, { branchId: app.branchId, storeId: app.storeId, onlyLow });
  return (
    <div>
      <PageHeader title="Stock on Hand" subtitle={app.storeId ? app.storeName(app.storeId) : app.branchId ? app.branchName(app.branchId) : "All stores"} />
      <Card bodyClass="p-0">
        <DataTable
          rows={rows}
          exportName="stock-on-hand"
          totals
          toolbar={<Checkbox checked={onlyLow} onChange={setOnlyLow}>Only items at or below reorder point</Checkbox>}
          columns={[
            { key: "sku", header: "SKU", render: (r) => <Link className="link" to={`/products/${r.productId}`}>{r.sku}</Link>, value: (r) => r.sku },
            { key: "name", header: "Name" },
            { key: "storeName", header: "Store" },
            { key: "onHand", header: "On hand", align: "right", total: true, totalRender: num, render: (r) => num(r.onHand) },
            { key: "reserved", header: "Reserved", align: "right", render: (r) => num(r.reserved) },
            { key: "available", header: "Available", align: "right", render: (r) => <span className={r.available <= 0 ? "font-semibold text-red-600" : ""}>{num(r.available)}</span> },
            { key: "incoming", header: "Incoming", align: "right", render: (r) => num(r.incoming) },
            { key: "reorderPoint", header: "Reorder pt", align: "right", render: (r) => (r.reorderPoint ?? "—") },
            { key: "avgCost", header: "Avg cost", align: "right", render: (r) => money(r.avgCost) },
            { key: "value", header: "Value", align: "right", total: true, totalRender: money, render: (r) => money(r.value) },
            { key: "low", header: "", render: (r) => (r.low ? <Badge color="amber">Low</Badge> : null), value: (r) => (r.low ? "low" : "") },
          ]}
          empty="No stock yet. Receive a purchase order or enter opening stock."
        />
      </Card>
    </div>
  );
}

const MOVE_TYPES = ["receipt", "sale", "sale_return", "supplier_return", "transfer_out", "transfer_in", "adjustment", "count", "damage", "opening"];

export function Movements() {
  const app = useApp();
  const [type, setType] = useState("");
  const rows = useQuery(api.inventory.movements, { storeId: app.storeId, type: type || undefined });
  return (
    <div>
      <PageHeader title="Stock Movements" subtitle="Every quantity change, traceable to its source document" />
      <Card bodyClass="p-0">
        <DataTable
          rows={rows}
          exportName="stock-movements"
          toolbar={<Select className="w-44" value={type} onChange={(e) => setType(e.target.value)} placeholder="All types" options={MOVE_TYPES.map((t) => ({ value: t, label: label(t) }))} />}
          columns={[
            { key: "date", header: "Date", render: (r) => dateTime(r.date), csv: (r) => new Date(r.date).toISOString() },
            { key: "sku", header: "SKU" },
            { key: "productName", header: "Product" },
            { key: "storeName", header: "Store" },
            { key: "type", header: "Type", render: (r) => label(r.type) },
            { key: "reference", header: "Reference" },
            { key: "quantity", header: "Qty", align: "right", render: (r) => <span className={r.quantity < 0 ? "text-red-600" : "text-brand-700"}>{r.quantity > 0 ? "+" : ""}{num(r.quantity)}</span> },
            { key: "unitCost", header: "Unit cost", align: "right", render: (r) => money(r.unitCost) },
            { key: "totalCost", header: "Value", align: "right", render: (r) => money(r.totalCost) },
            { key: "balanceAfter", header: "Balance", align: "right", render: (r) => num(r.balanceAfter) },
            { key: "by", header: "By" },
          ]}
        />
      </Card>
    </div>
  );
}

const KINDS = [
  { value: "adjustment", label: "Adjustment (+/−)" },
  { value: "count", label: "Physical count" },
  { value: "damage", label: "Damaged / defective" },
  { value: "opening", label: "Opening stock" },
];

function AdjustmentForm({ open, onClose }) {
  const app = useApp();
  const create = useMutation(api.inventory.createAdjustment);
  const [run, busy] = useRun();
  const [kind, setKind] = useState("adjustment");
  const [storeId, setStoreId] = useState(app.defaultStoreId);
  const [reason, setReason] = useState("");
  const [day, setDay] = useState(toInput());
  const [lines, setLines] = useState([{ productId: "" }]);
  const options = useQuery(api.products.options, storeId ? { storeId } : "skip");
  const sheet = useQuery(api.inventory.countSheet, open && kind === "count" && storeId ? { storeId } : "skip");
  const [counts, setCounts] = useState({});

  useEffect(() => {
    if (open) {
      setLines([{ productId: "" }]);
      setCounts({});
      setReason("");
      setStoreId(app.defaultStoreId);
    }
  }, [open, app.defaultStoreId]);

  const submit = async () => {
    let payload;
    if (kind === "count") {
      payload = Object.entries(counts)
        .filter(([, v]) => v !== "" && v !== undefined)
        .map(([productId, v]) => ({ productId, countedQty: Number(v) }));
    } else {
      payload = cleanLines(lines, kind === "opening" || kind === "adjustment" ? ["qtyChange", "unitCost"] : ["qtyChange"]).map((l) => ({
        productId: l.productId,
        qtyChange: l.qtyChange,
        unitCost: l.unitCost || undefined,
      }));
    }
    const res = await run(
      () => create({ storeId, kind, reason, date: fromInput(day), lines: payload }),
      "Submitted for approval",
    );
    if (res.ok) onClose();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      wide
      title="New stock adjustment"
      footer={
        <>
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={busy || !reason.trim() || !storeId} onClick={submit}>Submit for approval</button>
        </>
      }
    >
      <div className="mb-4 grid grid-cols-1 gap-4 md:grid-cols-4">
        <Field label="Type"><Select value={kind} onChange={(e) => setKind(e.target.value)} options={KINDS} /></Field>
        <Field label="Store"><Select value={storeId} onChange={(e) => setStoreId(e.target.value)} options={app.stores.map((s) => ({ value: s._id, label: s.name }))} /></Field>
        <Field label="Date"><Input type="date" value={day} onChange={(e) => setDay(e.target.value)} /></Field>
        <Field label="Reason *"><Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder={kind === "count" ? "Quarterly count" : "Reason"} /></Field>
      </div>
      {kind === "count" ? (
        <div className="max-h-[50vh] overflow-y-auto rounded-md border border-ink-200">
          <table className="table">
            <thead>
              <tr><th>SKU</th><th>Name</th><th className="text-right">System qty</th><th className="w-32 text-right">Counted</th><th className="text-right">Difference</th></tr>
            </thead>
            <tbody>
              {(sheet ?? []).map((r) => {
                const c = counts[r.productId];
                const diff = c === undefined || c === "" ? null : Number(c) - r.systemQty;
                return (
                  <tr key={r.productId}>
                    <td>{r.sku}</td>
                    <td>{r.name}</td>
                    <td className="num">{num(r.systemQty)}</td>
                    <td><input type="number" className="input input-sm text-right" value={c ?? ""} onChange={(e) => setCounts({ ...counts, [r.productId]: e.target.value })} /></td>
                    <td className={`num ${diff ? (diff < 0 ? "text-red-600" : "text-brand-700") : ""}`}>{diff === null ? "" : diff > 0 ? `+${diff}` : diff}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="p-3 text-xs text-ink-500">Only rows with a counted quantity are submitted. Differences are recalculated against live stock when approved.</p>
        </div>
      ) : (
        <>
          <LineEditor
            lines={lines}
            setLines={setLines}
            options={options}
            fields={
              kind === "damage"
                ? [{ key: "qtyChange", label: "Qty damaged" }]
                : [{ key: "qtyChange", label: kind === "opening" ? "Qty" : "Qty +/−" }, { key: "unitCost", label: "Unit cost" }]
            }
            onPick={(p) => ({ qtyChange: kind === "opening" ? 1 : 0, unitCost: p.avgCost })}
          />
          <p className="mt-2 text-xs text-ink-500">
            {kind === "opening"
              ? "Opening stock posts to Inventory against Opening Balance Equity."
              : kind === "damage"
                ? "Damaged stock is written off to Inventory Adjustments & Shrinkage at average cost."
                : "Positive quantities add stock at the unit cost given; negative quantities remove stock at average cost."}
          </p>
        </>
      )}
    </Modal>
  );
}

export function Adjustments() {
  const app = useApp();
  const [status, setStatus] = useState("");
  const [creating, setCreating] = useState(false);
  const [viewing, setViewing] = useState(null);
  const rows = useQuery(api.inventory.listAdjustments, { status: status || undefined });
  const approve = useMutation(api.inventory.approveAdjustment);
  const reject = useMutation(api.inventory.rejectAdjustment);
  const [run, busy] = useRun();
  const [ask, prompt] = usePrompt();
  return (
    <div>
      {prompt}
      <PageHeader
        title="Counts & Adjustments"
        subtitle="Physical counts, damage write-offs, corrections and opening stock — all need approval"
        actions={app.can("inventory.adjust") && <button className="btn-primary" onClick={() => setCreating(true)}>+ New adjustment</button>}
      />
      <Tabs
        value={status}
        onChange={setStatus}
        tabs={[{ value: "", label: "All" }, { value: "pending_approval", label: "Pending approval" }, { value: "posted", label: "Posted" }, { value: "rejected", label: "Rejected" }]}
      />
      <Card bodyClass="p-0">
        <DataTable
          rows={rows}
          exportName="adjustments"
          onRowClick={setViewing}
          columns={[
            { key: "number", header: "Number", render: (r) => <span className="font-medium">{r.number}</span> },
            { key: "date", header: "Date", render: (r) => date(r.date) },
            { key: "kind", header: "Type", render: (r) => label(r.kind) },
            { key: "storeName", header: "Store" },
            { key: "reason", header: "Reason" },
            { key: "lines", header: "Lines", align: "right", value: (r) => r.lines.length },
            { key: "totalValue", header: "Value", align: "right", render: (r) => money(r.totalValue) },
            { key: "createdByName", header: "By" },
            { key: "status", header: "Status", render: (r) => <Badge>{r.status}</Badge> },
          ]}
        />
      </Card>
      <AdjustmentForm open={creating} onClose={() => setCreating(false)} />
      <Modal
        open={!!viewing}
        onClose={() => setViewing(null)}
        wide
        title={viewing ? `${viewing.number} · ${label(viewing.kind)}` : ""}
        footer={
          viewing?.status === "pending_approval" &&
          app.can("inventory.approve") && (
            <>
              <button className="btn-secondary" disabled={busy} onClick={async () => {
                const reason = await ask("Reject adjustment");
                if (reason && (await run(() => reject({ id: viewing._id, reason }), "Rejected")).ok) setViewing(null);
              }}>Reject</button>
              <button className="btn-primary" disabled={busy} onClick={async () => {
                if ((await run(() => approve({ id: viewing._id }), "Adjustment posted")).ok) setViewing(null);
              }}>Approve & post</button>
            </>
          )
        }
      >
        {viewing && (
          <>
            <p className="mb-3 text-sm text-ink-600">{viewing.storeName} · {date(viewing.date)} · {viewing.reason} · by {viewing.createdByName}{viewing.approvedByName && ` · approved by ${viewing.approvedByName}`}</p>
            <table className="table">
              <thead><tr><th>SKU</th><th>Name</th><th className="text-right">System</th><th className="text-right">Counted</th><th className="text-right">Change</th><th className="text-right">Unit cost</th></tr></thead>
              <tbody>
                {viewing.lines.map((l, i) => (
                  <tr key={i}><td>{l.sku}</td><td>{l.name}</td><td className="num">{num(l.systemQty)}</td><td className="num">{l.countedQty ?? "—"}</td><td className="num">{l.qtyChange > 0 ? "+" : ""}{num(l.qtyChange)}</td><td className="num">{money(l.unitCost)}</td></tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </Modal>
    </div>
  );
}
