import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery } from "../lib/convex";
import { api } from "../../convex/_generated/api";
import { useApp } from "../lib/app";
import { Badge, Card, DataTable, Field, Input, Loading, Modal, NumberInput, PageHeader, Select, Tabs, Textarea, usePrompt, useRun } from "../components/ui";
import { LineEditor, cleanLines } from "../components/LineEditor";
import { DAY, date, fromInput, money, num, toInput } from "../lib/format";
import { printDocument } from "../lib/print";

// ═════════════ Purchase requests ═════════════
function RequestForm({ open, onClose }) {
  const app = useApp();
  const save = useMutation(api.purchasing.saveRequest);
  const suppliers = useQuery(api.parties.suppliers, {}) ?? [];
  const [run, busy] = useRun();
  const [storeId, setStoreId] = useState(app.defaultStoreId);
  const [supplierId, setSupplierId] = useState("");
  const [note, setNote] = useState("");
  const [lines, setLines] = useState([{ productId: "" }]);
  const options = useQuery(api.products.options, storeId ? { storeId } : "skip");
  useEffect(() => {
    if (open) {
      setLines([{ productId: "" }]);
      setNote("");
      setStoreId(app.defaultStoreId);
    }
  }, [open, app.defaultStoreId]);
  const submit = (submitNow) => async () => {
    const res = await run(
      () => save({ storeId, supplierId: supplierId || undefined, date: Date.now(), note: note || undefined, lines: cleanLines(lines, ["qty", "estUnitCost"]), submit: submitNow }),
      submitNow ? "Submitted for approval" : "Draft saved",
    );
    if (res.ok) onClose();
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      wide
      title="New purchase request"
      footer={
        <>
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-secondary" disabled={busy} onClick={submit(false)}>Save draft</button>
          <button className="btn-primary" disabled={busy} onClick={submit(true)}>Submit for approval</button>
        </>
      }
    >
      <div className="mb-4 grid grid-cols-1 gap-4 md:grid-cols-2">
        <Field label="Deliver to store"><Select value={storeId} onChange={(e) => setStoreId(e.target.value)} options={app.stores.map((s) => ({ value: s._id, label: s.name }))} /></Field>
        <Field label="Suggested supplier"><Select value={supplierId} onChange={(e) => setSupplierId(e.target.value)} placeholder="—" options={suppliers.map((s) => ({ value: s._id, label: s.name }))} /></Field>
      </div>
      <LineEditor lines={lines} setLines={setLines} options={options} fields={[{ key: "qty", label: "Qty" }, { key: "estUnitCost", label: "Est. unit cost" }]} onPick={(p) => ({ qty: 1, estUnitCost: p.purchaseCost })} amount={(l) => (Number(l.qty) || 0) * (Number(l.estUnitCost) || 0)} />
      <Field label="Note" className="mt-4"><Textarea value={note} onChange={(e) => setNote(e.target.value)} /></Field>
    </Modal>
  );
}

export function Requests() {
  const app = useApp();
  const navigate = useNavigate();
  const [status, setStatus] = useState("");
  const [creating, setCreating] = useState(false);
  const [viewing, setViewing] = useState(null);
  const [convertSupplier, setConvertSupplier] = useState("");
  const rows = useQuery(api.purchasing.listRequests, { status: status || undefined });
  const suppliers = useQuery(api.parties.suppliers, {}) ?? [];
  const approve = useMutation(api.purchasing.approveRequest);
  const reject = useMutation(api.purchasing.rejectRequest);
  const convert = useMutation(api.purchasing.convertRequest);
  const [run, busy] = useRun();
  const [ask, prompt] = usePrompt();
  const v = rows?.find((r) => r._id === viewing?._id) ?? null;
  useEffect(() => setConvertSupplier(v?.supplierId ?? ""), [v?._id]); // eslint-disable-line

  return (
    <div>
      {prompt}
      <PageHeader
        title="Purchase Requests"
        subtitle="Request → approval → purchase order"
        actions={app.can("purchasing.request") && <button className="btn-primary" onClick={() => setCreating(true)}>+ New request</button>}
      />
      <Tabs value={status} onChange={setStatus} tabs={[{ value: "", label: "All" }, { value: "draft", label: "Draft" }, { value: "pending_approval", label: "Pending approval" }, { value: "approved", label: "Approved" }, { value: "converted", label: "Converted" }, { value: "rejected", label: "Rejected" }]} />
      <Card bodyClass="p-0">
        <DataTable
          rows={rows}
          exportName="purchase-requests"
          onRowClick={setViewing}
          columns={[
            { key: "number", header: "Number", render: (r) => <span className="font-medium">{r.number}</span> },
            { key: "date", header: "Date", render: (r) => date(r.date) },
            { key: "source", header: "Source", render: (r) => <Badge color={r.source === "reorder" ? "violet" : "gray"}>{r.source}</Badge> },
            { key: "storeName", header: "Store" },
            { key: "supplierName", header: "Supplier" },
            { key: "lines", header: "Lines", align: "right", value: (r) => r.lines.length },
            { key: "estTotal", header: "Est. total", align: "right", render: (r) => money(r.estTotal) },
            { key: "createdByName", header: "Requested by" },
            { key: "status", header: "Status", render: (r) => <Badge>{r.status}</Badge> },
          ]}
        />
      </Card>
      <RequestForm open={creating} onClose={() => setCreating(false)} />
      <Modal
        open={!!v}
        onClose={() => setViewing(null)}
        wide
        title={v ? `${v.number} · ${v.storeName}` : ""}
        footer={
          v && (
            <>
              {v.status === "pending_approval" && app.can("purchasing.approve") && (
                <>
                  <button className="btn-secondary" disabled={busy} onClick={async () => { const r = await ask("Reject request"); if (r && (await run(() => reject({ id: v._id, reason: r }), "Rejected")).ok) setViewing(null); }}>Reject</button>
                  <button className="btn-primary" disabled={busy} onClick={() => run(() => approve({ id: v._id }), "Approved")}>Approve</button>
                </>
              )}
              {v.status === "approved" && app.can("purchasing.order") && (
                <>
                  <Select className="w-56" value={convertSupplier} onChange={(e) => setConvertSupplier(e.target.value)} placeholder="Choose supplier" options={suppliers.map((s) => ({ value: s._id, label: s.name }))} />
                  <button
                    className="btn-primary"
                    disabled={busy || !convertSupplier}
                    onClick={async () => {
                      const res = await run(() => convert({ id: v._id, supplierId: convertSupplier }), "Purchase order created");
                      if (res.ok) navigate(`/purchasing/orders/${res.res}`);
                    }}
                  >
                    Create purchase order
                  </button>
                </>
              )}
            </>
          )
        }
      >
        {v && (
          <>
            <div className="mb-3 flex flex-wrap gap-4 text-sm text-ink-600">
              <Badge>{v.status}</Badge>
              <span>{date(v.date)} · by {v.createdByName}</span>
              {v.supplierName && <span>Supplier: {v.supplierName}</span>}
            </div>
            <table className="table">
              <thead><tr><th>SKU</th><th>Name</th><th className="text-right">Qty</th><th className="text-right">Est. unit cost</th><th className="text-right">Amount</th></tr></thead>
              <tbody>
                {v.lines.map((l, i) => (
                  <tr key={i}><td>{l.sku}</td><td>{l.name}</td><td className="num">{num(l.qty)}</td><td className="num">{money(l.estUnitCost)}</td><td className="num">{money(l.qty * l.estUnitCost)}</td></tr>
                ))}
              </tbody>
              <tfoot><tr><td colSpan={4} className="px-3 py-2 text-right font-semibold">Estimated total</td><td className="num px-3 py-2 font-semibold">{money(v.estTotal)}</td></tr></tfoot>
            </table>
            {v.note && <p className="mt-3 whitespace-pre-line text-sm text-ink-600">{v.note}</p>}
          </>
        )}
      </Modal>
    </div>
  );
}

// ═════════════ Purchase orders ═════════════
function OrderForm({ open, onClose }) {
  const app = useApp();
  const navigate = useNavigate();
  const save = useMutation(api.purchasing.saveOrder);
  const suppliers = useQuery(api.parties.suppliers, {}) ?? [];
  const [run, busy] = useRun();
  const [storeId, setStoreId] = useState(app.defaultStoreId);
  const [supplierId, setSupplierId] = useState("");
  const [day, setDay] = useState(toInput());
  const [expected, setExpected] = useState("");
  const [taxAmount, setTax] = useState(0);
  const [note, setNote] = useState("");
  const [lines, setLines] = useState([{ productId: "" }]);
  const options = useQuery(api.products.options, storeId ? { storeId } : "skip");
  useEffect(() => {
    if (open) {
      setLines([{ productId: "" }]);
      setNote("");
      setTax(0);
      setStoreId(app.defaultStoreId);
    }
  }, [open, app.defaultStoreId]);
  useEffect(() => {
    const s = suppliers.find((x) => x._id === supplierId);
    if (s) setExpected(toInput(Date.now() + s.leadTimeDays * DAY));
  }, [supplierId]); // eslint-disable-line
  const subtotal = lines.reduce((a, l) => a + (Number(l.qty) || 0) * (Number(l.unitCost) || 0), 0);
  const submit = (submitNow) => async () => {
    const res = await run(
      () => save({ supplierId, storeId, date: fromInput(day), expectedDate: expected ? fromInput(expected) : undefined, taxAmount: Number(taxAmount) || 0, note: note || undefined, lines: cleanLines(lines, ["qty", "unitCost"]), submit: submitNow }),
      submitNow ? "Submitted for approval" : "Draft saved",
    );
    if (res.ok) {
      onClose();
      navigate(`/purchasing/orders/${res.res}`);
    }
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      wide
      title="New purchase order"
      footer={
        <>
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-secondary" disabled={busy || !supplierId} onClick={submit(false)}>Save draft</button>
          <button className="btn-primary" disabled={busy || !supplierId} onClick={submit(true)}>Submit for approval</button>
        </>
      }
    >
      <div className="mb-4 grid grid-cols-1 gap-4 md:grid-cols-4">
        <Field label="Supplier *"><Select value={supplierId} onChange={(e) => setSupplierId(e.target.value)} placeholder="Choose…" options={suppliers.map((s) => ({ value: s._id, label: s.name }))} /></Field>
        <Field label="Deliver to store"><Select value={storeId} onChange={(e) => setStoreId(e.target.value)} options={app.stores.map((s) => ({ value: s._id, label: s.name }))} /></Field>
        <Field label="Order date"><Input type="date" value={day} onChange={(e) => setDay(e.target.value)} /></Field>
        <Field label="Expected delivery"><Input type="date" value={expected} onChange={(e) => setExpected(e.target.value)} /></Field>
      </div>
      <LineEditor lines={lines} setLines={setLines} options={options} fields={[{ key: "qty", label: "Qty" }, { key: "unitCost", label: "Unit cost" }]} onPick={(p) => ({ qty: 1, unitCost: p.purchaseCost })} amount={(l) => (Number(l.qty) || 0) * (Number(l.unitCost) || 0)} />
      <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-3">
        <Field label="Note" className="md:col-span-2"><Textarea value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        <div className="space-y-2">
          <Field label="Tax amount"><NumberInput value={taxAmount} onChange={setTax} /></Field>
          <div className="flex justify-between text-sm"><span>Subtotal</span><span>{money(subtotal)}</span></div>
          <div className="flex justify-between border-t pt-2 font-semibold"><span>Total</span><span>{money(subtotal + (Number(taxAmount) || 0))}</span></div>
        </div>
      </div>
    </Modal>
  );
}

export function Orders() {
  const app = useApp();
  const navigate = useNavigate();
  const [status, setStatus] = useState("");
  const [creating, setCreating] = useState(false);
  const rows = useQuery(api.purchasing.listOrders, { status: status || undefined });
  return (
    <div>
      <PageHeader
        title="Purchase Orders"
        subtitle="Purchase order → goods receipt → supplier bill → payment"
        actions={app.can("purchasing.order") && <button className="btn-primary" onClick={() => setCreating(true)}>+ New purchase order</button>}
      />
      <Tabs value={status} onChange={setStatus} tabs={[{ value: "", label: "All" }, { value: "draft", label: "Draft" }, { value: "pending_approval", label: "Pending approval" }, { value: "approved", label: "Open" }, { value: "partially_received", label: "Partially received" }, { value: "received", label: "Received" }, { value: "closed", label: "Closed" }, { value: "cancelled", label: "Cancelled" }]} />
      <Card bodyClass="p-0">
        <DataTable
          rows={rows}
          exportName="purchase-orders"
          onRowClick={(r) => navigate(`/purchasing/orders/${r._id}`)}
          columns={[
            { key: "number", header: "Number", render: (r) => <span className="font-medium">{r.number}</span> },
            { key: "date", header: "Date", render: (r) => date(r.date) },
            { key: "supplierName", header: "Supplier" },
            { key: "storeName", header: "Store" },
            { key: "expectedDate", header: "Expected", render: (r) => date(r.expectedDate) },
            { key: "total", header: "Total", align: "right", render: (r) => money(r.total) },
            { key: "receivedPct", header: "Received", align: "right", render: (r) => `${r.receivedPct}%` },
            { key: "status", header: "Status", render: (r) => <Badge>{r.status}</Badge> },
          ]}
        />
      </Card>
      <OrderForm open={creating} onClose={() => setCreating(false)} />
    </div>
  );
}

function ReceiveModal({ po, open, onClose }) {
  const receive = useMutation(api.purchasing.receiveGoods);
  const [run, busy] = useRun();
  const [qty, setQty] = useState({});
  const [freight, setFreight] = useState(0);
  const [day, setDay] = useState(toInput());
  const [note, setNote] = useState("");
  useEffect(() => {
    if (open) {
      const q = {};
      for (const l of po.lines) q[l.productId] = Math.max(0, l.qty - l.receivedQty);
      setQty(q);
      setFreight(0);
      setNote("");
    }
  }, [open, po]);
  return (
    <Modal
      open={open}
      onClose={onClose}
      wide
      title={`Receive goods — ${po.number}`}
      footer={
        <>
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button
            className="btn-primary"
            disabled={busy}
            onClick={async () => {
              const lines = po.lines.map((l) => ({ productId: l.productId, qty: Number(qty[l.productId]) || 0 })).filter((l) => l.qty > 0);
              if ((await run(() => receive({ purchaseOrderId: po._id, date: fromInput(day), freight: Number(freight) || 0, note: note || undefined, lines }), "Goods received — stock updated")).ok) onClose();
            }}
          >
            Post goods receipt
          </button>
        </>
      }
    >
      <div className="mb-4 grid grid-cols-1 gap-4 md:grid-cols-3">
        <Field label="Received on"><Input type="date" value={day} onChange={(e) => setDay(e.target.value)} /></Field>
        <Field label="Freight / landed cost" hint="Spread across items by value"><NumberInput value={freight} onChange={setFreight} /></Field>
        <Field label="Note / delivery ref"><Input value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      </div>
      <table className="table">
        <thead><tr><th>SKU</th><th>Name</th><th className="text-right">Ordered</th><th className="text-right">Received</th><th className="text-right">Outstanding</th><th className="w-32 text-right">Receive now</th></tr></thead>
        <tbody>
          {po.lines.map((l) => (
            <tr key={l.productId}>
              <td>{l.sku}</td><td>{l.name}</td><td className="num">{num(l.qty)}</td><td className="num">{num(l.receivedQty)}</td><td className="num">{num(l.qty - l.receivedQty)}</td>
              <td><input type="number" className="input input-sm text-right" value={qty[l.productId] ?? ""} onChange={(e) => setQty({ ...qty, [l.productId]: e.target.value })} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </Modal>
  );
}

function BillFromPO({ po, open, onClose }) {
  const create = useMutation(api.purchasing.createBill);
  const [run, busy] = useRun();
  const [ref, setRef] = useState("");
  const [day, setDay] = useState(toInput());
  const [tax, setTax] = useState(0);
  const [lines, setLines] = useState([]);
  useEffect(() => {
    if (open) {
      setLines(po.lines.map((l) => ({ productId: l.productId, description: `${l.sku} ${l.name}`, qty: Math.max(0, l.receivedQty - l.billedQty), unitCost: l.unitCost })));
      setRef("");
      setTax(0);
    }
  }, [open, po]);
  const subtotal = lines.reduce((a, l) => a + (Number(l.qty) || 0) * (Number(l.unitCost) || 0), 0);
  return (
    <Modal
      open={open}
      onClose={onClose}
      wide
      title={`Enter supplier bill — ${po.number}`}
      footer={
        <>
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button
            className="btn-primary"
            disabled={busy}
            onClick={async () => {
              const payload = lines.filter((l) => Number(l.qty) > 0).map((l) => ({ description: l.description, productId: l.productId, qty: Number(l.qty), unitCost: Number(l.unitCost) }));
              if ((await run(() => create({ supplierId: po.supplierId, branchId: po.branchId, purchaseOrderId: po._id, supplierRef: ref || undefined, date: fromInput(day), taxAmount: Number(tax) || 0, lines: payload }), "Bill posted")).ok) onClose();
            }}
          >
            Post bill
          </button>
        </>
      }
    >
      <div className="mb-4 grid grid-cols-1 gap-4 md:grid-cols-3">
        <Field label="Supplier invoice no."><Input value={ref} onChange={(e) => setRef(e.target.value)} /></Field>
        <Field label="Bill date"><Input type="date" value={day} onChange={(e) => setDay(e.target.value)} /></Field>
        <Field label="Tax amount"><NumberInput value={tax} onChange={setTax} /></Field>
      </div>
      <table className="table">
        <thead><tr><th>Item</th><th className="w-28 text-right">Qty</th><th className="w-32 text-right">Unit cost (as billed)</th><th className="text-right">Amount</th></tr></thead>
        <tbody>
          {lines.map((l, i) => (
            <tr key={i}>
              <td>{l.description}</td>
              <td><input type="number" className="input input-sm text-right" value={l.qty} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))} /></td>
              <td><input type="number" className="input input-sm text-right" value={l.unitCost} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, unitCost: e.target.value } : x)))} /></td>
              <td className="num">{money((Number(l.qty) || 0) * (Number(l.unitCost) || 0))}</td>
            </tr>
          ))}
        </tbody>
        <tfoot><tr><td colSpan={3} className="px-3 py-2 text-right font-semibold">Total incl. tax</td><td className="num px-3 py-2 font-semibold">{money(subtotal + (Number(tax) || 0))}</td></tr></tfoot>
      </table>
      <p className="mt-2 text-xs text-ink-500">Differences between billed cost and PO cost post to Purchase Price Variance.</p>
    </Modal>
  );
}

export function OrderDetail() {
  const { id } = useParams();
  const app = useApp();
  const po = useQuery(api.purchasing.getOrder, { id });
  const save = useMutation(api.purchasing.saveOrder);
  const approve = useMutation(api.purchasing.approveOrder);
  const rejectOrder = useMutation(api.purchasing.rejectOrder);
  const close = useMutation(api.purchasing.closeOrder);
  const [run, busy] = useRun();
  const [ask, prompt] = usePrompt();
  const [receiving, setReceiving] = useState(false);
  const [billing, setBilling] = useState(false);
  if (po === undefined) return <Loading />;
  if (po === null) return <div>Not found.</div>;
  const open = po.status === "approved" || po.status === "partially_received";
  const canBill = po.lines.some((l) => l.receivedQty > l.billedQty) && app.can("bills.manage");

  const print = () =>
    printDocument({
      company: app.company,
      title: "Purchase Order",
      number: po.number,
      docDate: po.date,
      partyTitle: "Supplier",
      party: [po.supplierName, po.supplier?.address, po.supplier?.phone].filter(Boolean),
      meta: [["Deliver to", po.storeName], ["Expected", date(po.expectedDate)], ["Terms", `${po.supplier?.paymentTermsDays ?? 0} days`]],
      columns: [
        { header: "SKU", value: (l) => l.sku },
        { header: "Description", value: (l) => l.name },
        { header: "Qty", value: (l) => num(l.qty), align: "right" },
        { header: "Unit cost", value: (l) => money(l.unitCost), align: "right" },
        { header: "Amount", value: (l) => money(l.qty * l.unitCost), align: "right" },
      ],
      rows: po.lines,
      totals: [["Subtotal", money(po.subtotal)], ["Tax", money(po.taxAmount)], ["Total", money(po.total), true]],
      notes: po.note,
    });

  return (
    <div>
      {prompt}
      <PageHeader
        title={`${po.number} · ${po.supplierName}`}
        subtitle={`${po.storeName} · ordered ${date(po.date)} · expected ${date(po.expectedDate)} · by ${po.createdByName}${po.approvedByName ? ` · approved by ${po.approvedByName}` : ""}`}
        actions={
          <>
            <Link to="/purchasing/orders" className="btn-secondary">Back</Link>
            <button className="btn-secondary" onClick={print}>Print</button>
            {po.status === "draft" && app.can("purchasing.order") && (
              <button className="btn-primary" disabled={busy} onClick={() => run(() => save({ id: po._id, supplierId: po.supplierId, storeId: po.storeId, date: po.date, expectedDate: po.expectedDate, taxAmount: po.taxAmount, note: po.note, lines: po.lines.map((l) => ({ productId: l.productId, qty: l.qty, unitCost: l.unitCost })), submit: true }), "Submitted for approval")}>Submit for approval</button>
            )}
            {po.status === "pending_approval" && app.can("purchasing.approve") && (
              <>
                <button className="btn-secondary" disabled={busy} onClick={async () => { const r = await ask("Return to draft"); if (r) run(() => rejectOrder({ id: po._id, reason: r }), "Returned to draft"); }}>Return</button>
                <button className="btn-primary" disabled={busy} onClick={() => run(() => approve({ id: po._id }), "Purchase order approved")}>Approve</button>
              </>
            )}
            {open && app.can("purchasing.receive") && <button className="btn-primary" onClick={() => setReceiving(true)}>Receive goods</button>}
            {canBill && <button className="btn-secondary" onClick={() => setBilling(true)}>Enter bill</button>}
            {["draft", "pending_approval", "approved", "partially_received"].includes(po.status) && app.can("purchasing.order") && (
              <button className="btn-ghost text-red-600" disabled={busy} onClick={async () => { const r = await ask(po.status === "partially_received" ? "Short-close this order" : "Cancel this order"); if (r) run(() => close({ id: po._id, reason: r }), "Order closed"); }}>
                {po.status === "partially_received" ? "Short-close" : "Cancel"}
              </button>
            )}
          </>
        }
      />
      <div className="mb-4"><Badge>{po.status}</Badge></div>
      <Card bodyClass="p-0">
        <table className="table">
          <thead><tr><th>SKU</th><th>Name</th><th className="text-right">Ordered</th><th className="text-right">Received</th><th className="text-right">Billed</th><th className="text-right">Unit cost</th><th className="text-right">Amount</th></tr></thead>
          <tbody>
            {po.lines.map((l) => (
              <tr key={l.productId}><td>{l.sku}</td><td>{l.name}</td><td className="num">{num(l.qty)}</td><td className="num">{num(l.receivedQty)}</td><td className="num">{num(l.billedQty)}</td><td className="num">{money(l.unitCost)}</td><td className="num">{money(l.qty * l.unitCost)}</td></tr>
            ))}
          </tbody>
          <tfoot>
            <tr><td colSpan={6} className="px-3 py-1 text-right">Subtotal</td><td className="num px-3 py-1">{money(po.subtotal)}</td></tr>
            <tr><td colSpan={6} className="px-3 py-1 text-right">Tax</td><td className="num px-3 py-1">{money(po.taxAmount)}</td></tr>
            <tr><td colSpan={6} className="px-3 py-2 text-right font-semibold">Total</td><td className="num px-3 py-2 font-semibold">{money(po.total)}</td></tr>
          </tfoot>
        </table>
      </Card>
      <div className="mt-5 grid gap-5 md:grid-cols-2">
        <Card title="Goods receipts" bodyClass="p-0">
          <DataTable search={false} rows={po.receipts} columns={[{ key: "number", header: "GRN" }, { key: "date", header: "Date", render: (r) => date(r.date) }, { key: "total", header: "Value", align: "right", render: (r) => money(r.total) }]} empty="Nothing received yet." />
        </Card>
        <Card title="Supplier bills" bodyClass="p-0">
          <DataTable search={false} rows={po.bills} columns={[{ key: "number", header: "Bill" }, { key: "supplierRef", header: "Supplier ref" }, { key: "date", header: "Date", render: (r) => date(r.date) }, { key: "total", header: "Total", align: "right", render: (r) => money(r.total) }, { key: "status", header: "Status", render: (r) => <Badge>{r.status}</Badge> }]} empty="No bills yet." />
        </Card>
      </div>
      {po.note && <Card title="Notes" className="mt-5"><p className="whitespace-pre-line text-sm">{po.note}</p></Card>}
      <ReceiveModal po={po} open={receiving} onClose={() => setReceiving(false)} />
      <BillFromPO po={po} open={billing} onClose={() => setBilling(false)} />
    </div>
  );
}

// ═════════════ Goods receipts ═════════════
export function Receipts() {
  const rows = useQuery(api.purchasing.listReceipts);
  const navigate = useNavigate();
  return (
    <div>
      <PageHeader title="Goods Received" subtitle="Receive goods from a purchase order to update stock" />
      <Card bodyClass="p-0">
        <DataTable
          rows={rows}
          exportName="goods-receipts"
          onRowClick={(r) => navigate(`/purchasing/orders/${r.purchaseOrderId}`)}
          columns={[
            { key: "number", header: "GRN", render: (r) => <span className="font-medium">{r.number}</span> },
            { key: "date", header: "Date", render: (r) => date(r.date) },
            { key: "poNumber", header: "PO" },
            { key: "supplierName", header: "Supplier" },
            { key: "storeName", header: "Store" },
            { key: "items", header: "Items", value: (r) => r.lines.map((l) => `${l.sku}×${l.qty}`).join(", ") },
            { key: "total", header: "Value", align: "right", render: (r) => money(r.total) },
            { key: "createdByName", header: "Received by" },
          ]}
        />
      </Card>
    </div>
  );
}

// ═════════════ Supplier bills ═════════════
function ExpenseBillForm({ open, onClose }) {
  const app = useApp();
  const create = useMutation(api.purchasing.createBill);
  const suppliers = useQuery(api.parties.suppliers, {}) ?? [];
  const accounts = useQuery(api.accounting.accounts, {}) ?? [];
  const [run, busy] = useRun();
  const [f, setF] = useState({ supplierId: "", branchId: "", supplierRef: "", date: toInput(), taxAmount: 0 });
  const [lines, setLines] = useState([{ description: "", accountId: "", amount: 0 }]);
  useEffect(() => {
    if (open) {
      setF({ supplierId: "", branchId: app.branchId ?? app.branches[0]?._id ?? "", supplierRef: "", date: toInput(), taxAmount: 0 });
      setLines([{ description: "", accountId: "", amount: 0 }]);
    }
  }, [open]); // eslint-disable-line
  const usable = accounts.filter((a) => a.active && !["ar", "ap", "inventory"].includes(a.systemKey ?? ""));
  const total = lines.reduce((a, l) => a + (Number(l.amount) || 0), 0) + (Number(f.taxAmount) || 0);
  return (
    <Modal
      open={open}
      onClose={onClose}
      wide
      title="New supplier bill (services / non-stock)"
      footer={
        <>
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button
            className="btn-primary"
            disabled={busy || !f.supplierId || !f.branchId}
            onClick={async () => {
              const payload = lines.filter((l) => l.accountId && Number(l.amount)).map((l) => ({ description: l.description || "Bill line", accountId: l.accountId, qty: 1, unitCost: Number(l.amount) }));
              if ((await run(() => create({ supplierId: f.supplierId, branchId: f.branchId, supplierRef: f.supplierRef || undefined, date: fromInput(f.date), taxAmount: Number(f.taxAmount) || 0, lines: payload }), "Bill posted")).ok) onClose();
            }}
          >
            Post bill
          </button>
        </>
      }
    >
      <div className="mb-4 grid grid-cols-1 gap-4 md:grid-cols-4">
        <Field label="Supplier"><Select value={f.supplierId} onChange={(e) => setF({ ...f, supplierId: e.target.value })} placeholder="Choose…" options={suppliers.map((s) => ({ value: s._id, label: s.name }))} /></Field>
        <Field label="Branch"><Select value={f.branchId} onChange={(e) => setF({ ...f, branchId: e.target.value })} options={app.branches.map((b) => ({ value: b._id, label: b.name }))} /></Field>
        <Field label="Supplier invoice no."><Input value={f.supplierRef} onChange={(e) => setF({ ...f, supplierRef: e.target.value })} /></Field>
        <Field label="Date"><Input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field>
      </div>
      <table className="table">
        <thead><tr><th>Description</th><th className="w-72">Account</th><th className="w-36 text-right">Amount</th><th className="w-8" /></tr></thead>
        <tbody>
          {lines.map((l, i) => (
            <tr key={i}>
              <td><input className="input input-sm" value={l.description} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))} /></td>
              <td><select className="input input-sm" value={l.accountId} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, accountId: e.target.value } : x)))}><option value="">Choose…</option>{usable.map((a) => <option key={a._id} value={a._id}>{a.code} {a.name}</option>)}</select></td>
              <td><input type="number" className="input input-sm text-right" value={l.amount} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} /></td>
              <td><button className="btn-ghost btn-sm text-red-600" onClick={() => setLines(lines.filter((_, j) => j !== i))}>✕</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-3 flex items-end justify-between gap-4">
        <button className="btn-secondary btn-sm" onClick={() => setLines([...lines, { description: "", accountId: "", amount: 0 }])}>+ Add line</button>
        <div className="flex items-end gap-4">
          <Field label="Tax"><NumberInput className="w-32" value={f.taxAmount} onChange={(v) => setF({ ...f, taxAmount: v })} /></Field>
          <div className="pb-2 font-semibold">Total {money(total)}</div>
        </div>
      </div>
      <p className="mt-3 text-xs text-ink-500">For stock purchases, enter the bill from the purchase order so it matches the goods received.</p>
    </Modal>
  );
}

function SupplierReturnForm({ open, onClose }) {
  const app = useApp();
  const create = useMutation(api.purchasing.supplierReturn);
  const suppliers = useQuery(api.parties.suppliers, {}) ?? [];
  const [run, busy] = useRun();
  const [supplierId, setSupplierId] = useState("");
  const [storeId, setStoreId] = useState(app.defaultStoreId);
  const [reason, setReason] = useState("");
  const [lines, setLines] = useState([{ productId: "" }]);
  const options = useQuery(api.products.options, storeId ? { storeId } : "skip");
  useEffect(() => {
    if (open) {
      setLines([{ productId: "" }]);
      setReason("");
    }
  }, [open]);
  return (
    <Modal
      open={open}
      onClose={onClose}
      wide
      title="Return goods to supplier (debit note)"
      footer={
        <>
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={busy || !supplierId || !reason.trim()} onClick={async () => (await run(() => create({ supplierId, storeId, date: Date.now(), reason, lines: cleanLines(lines, ["qty", "creditUnitPrice"]) }), "Supplier return posted")).ok && onClose()}>Post return</button>
        </>
      }
    >
      <div className="mb-4 grid grid-cols-1 gap-4 md:grid-cols-3">
        <Field label="Supplier"><Select value={supplierId} onChange={(e) => setSupplierId(e.target.value)} placeholder="Choose…" options={suppliers.map((s) => ({ value: s._id, label: s.name }))} /></Field>
        <Field label="From store"><Select value={storeId} onChange={(e) => setStoreId(e.target.value)} options={app.stores.map((s) => ({ value: s._id, label: s.name }))} /></Field>
        <Field label="Reason *"><Input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      </div>
      <LineEditor lines={lines} setLines={setLines} options={options} fields={[{ key: "qty", label: "Qty" }, { key: "creditUnitPrice", label: "Credit / unit" }]} onPick={(p) => ({ qty: 1, creditUnitPrice: p.avgCost })} amount={(l) => (Number(l.qty) || 0) * (Number(l.creditUnitPrice) || 0)} />
      <p className="mt-2 text-xs text-ink-500">Stock leaves at average cost; the supplier's balance is reduced by the credit value.</p>
    </Modal>
  );
}

export function Bills() {
  const app = useApp();
  const [status, setStatus] = useState("");
  const [creating, setCreating] = useState(false);
  const [returning, setReturning] = useState(false);
  const rows = useQuery(api.purchasing.listBills, { status: status || undefined });
  const voidBill = useMutation(api.purchasing.voidBill);
  const [run] = useRun();
  const [ask, prompt] = usePrompt();
  return (
    <div>
      {prompt}
      <PageHeader
        title="Supplier Bills"
        subtitle="Accounts payable"
        actions={
          <>
            {app.can("purchasing.receive") && <button className="btn-secondary" onClick={() => setReturning(true)}>Supplier return</button>}
            {app.can("bills.manage") && <button className="btn-primary" onClick={() => setCreating(true)}>+ Non-stock bill</button>}
          </>
        }
      />
      <Tabs value={status} onChange={setStatus} tabs={[{ value: "", label: "All" }, { value: "open", label: "Open" }, { value: "partial", label: "Partly paid" }, { value: "paid", label: "Paid" }, { value: "void", label: "Void" }]} />
      <Card bodyClass="p-0">
        <DataTable
          rows={rows}
          exportName="supplier-bills"
          totals
          columns={[
            { key: "number", header: "Number", render: (r) => <span className="font-medium">{r.number}</span> },
            { key: "kind", header: "Type", render: (r) => (r.kind === "debit_note" ? <Badge color="violet">Debit note</Badge> : "Bill") },
            { key: "supplierRef", header: "Supplier ref" },
            { key: "supplierName", header: "Supplier" },
            { key: "poNumber", header: "PO" },
            { key: "date", header: "Date", render: (r) => date(r.date) },
            { key: "dueDate", header: "Due", render: (r) => <span className={r.overdue ? "font-medium text-red-600" : ""}>{date(r.dueDate)}</span> },
            { key: "total", header: "Total", align: "right", total: true, totalRender: money, render: (r) => money(r.total) },
            { key: "balanceDue", header: "Balance due", align: "right", total: true, totalRender: money, render: (r) => money(r.balanceDue) },
            { key: "status", header: "Status", render: (r) => <Badge>{r.overdue ? "overdue" : r.status}</Badge> },
            {
              key: "x",
              header: "",
              render: (r) =>
                r.kind === "bill" && r.status === "open" && r.amountPaid === 0 && app.can("bills.manage") ? (
                  <button className="btn-ghost btn-sm text-red-600" onClick={async () => { const reason = await ask(`Void ${r.number}`); if (reason) run(() => voidBill({ id: r._id, reason }), "Bill voided"); }}>Void</button>
                ) : null,
            },
          ]}
        />
      </Card>
      <ExpenseBillForm open={creating} onClose={() => setCreating(false)} />
      <SupplierReturnForm open={returning} onClose={() => setReturning(false)} />
    </div>
  );
}

// ═════════════ Supplier payments ═════════════
export function PaymentForm({ open, onClose, partyType, partyId: initialParty }) {
  const app = useApp();
  const isCustomer = partyType === "customer";
  const parties = useQuery(isCustomer ? api.parties.customers : api.parties.suppliers, {}) ?? [];
  const cash = useQuery(api.accounting.cashAccounts) ?? [];
  const [partyId, setPartyId] = useState("");
  const openDocs = useQuery(isCustomer ? api.sales.list : api.purchasing.listBills, partyId ? (isCustomer ? { kind: "invoice", customerId: partyId } : { supplierId: partyId }) : "skip");
  const pay = useMutation(isCustomer ? api.payments.receiveFromCustomer : api.payments.paySupplier);
  const [run, busy] = useRun();
  const [f, setF] = useState({ amount: 0, accountId: "", method: "cash", reference: "", date: toInput(), branchId: "" });
  const [alloc, setAlloc] = useState({});
  useEffect(() => {
    if (open) {
      setPartyId(initialParty ?? "");
      setF({ amount: 0, accountId: cash[0]?._id ?? "", method: "cash", reference: "", date: toInput(), branchId: app.branchId ?? app.branches[0]?._id ?? "" });
      setAlloc({});
    }
  }, [open]); // eslint-disable-line
  const docs = useMemo(() => (openDocs ?? []).filter((d) => (d.status === "open" || d.status === "partial") && (isCustomer || d.kind === "bill")).sort((a, b) => (a.dueDate ?? a.date) - (b.dueDate ?? b.date)), [openDocs, isCustomer]);
  const autoAllocate = (amount) => {
    let left = amount;
    const a = {};
    for (const d of docs) {
      if (left <= 0) break;
      const take = Math.min(left, d.balanceDue);
      a[d._id] = Math.round(take * 100) / 100;
      left -= take;
    }
    setAlloc(a);
  };
  const allocated = Object.values(alloc).reduce((a, v) => a + (Number(v) || 0), 0);
  return (
    <Modal
      open={open}
      onClose={onClose}
      wide
      title={isCustomer ? "Receive customer payment" : "Pay supplier"}
      footer={
        <>
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button
            className="btn-primary"
            disabled={busy || !partyId || !f.accountId || !(Number(f.amount) > 0)}
            onClick={async () => {
              const allocations = Object.entries(alloc).filter(([, v]) => Number(v) > 0).map(([docId, v]) => ({ docId, amount: Number(v) }));
              const base = { branchId: f.branchId, date: fromInput(f.date), amount: Number(f.amount), accountId: f.accountId, method: f.method, reference: f.reference || undefined, allocations };
              const res = await run(() => pay(isCustomer ? { ...base, customerId: partyId } : { ...base, supplierId: partyId }), isCustomer ? "Payment received" : "Payment recorded");
              if (res.ok) onClose();
            }}
          >
            Save payment
          </button>
        </>
      }
    >
      <div className="mb-4 grid grid-cols-1 gap-4 md:grid-cols-3">
        <Field label={isCustomer ? "Customer" : "Supplier"}><Select value={partyId} onChange={(e) => { setPartyId(e.target.value); setAlloc({}); }} placeholder="Choose…" options={parties.map((p) => ({ value: p._id, label: `${p.name} (bal. ${money(p.balance)})` }))} /></Field>
        <Field label="Amount"><NumberInput value={f.amount} onChange={(v) => { setF({ ...f, amount: v }); autoAllocate(v); }} /></Field>
        <Field label="Date"><Input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field>
        <Field label={isCustomer ? "Deposit to" : "Pay from"}><Select value={f.accountId} onChange={(e) => setF({ ...f, accountId: e.target.value })} options={cash.map((a) => ({ value: a._id, label: `${a.code} ${a.name}` }))} /></Field>
        <Field label="Method"><Select value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })} options={[{ value: "cash", label: "Cash" }, { value: "bank_transfer", label: "Bank transfer" }, { value: "mobile_money", label: "Mobile money" }, { value: "cheque", label: "Cheque" }]} /></Field>
        <Field label="Reference"><Input value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} /></Field>
        <Field label="Branch"><Select value={f.branchId} onChange={(e) => setF({ ...f, branchId: e.target.value })} options={app.branches.map((b) => ({ value: b._id, label: b.name }))} /></Field>
      </div>
      {partyId && (
        <>
          <div className="label">Apply to open {isCustomer ? "invoices" : "bills"} (oldest first)</div>
          <table className="table">
            <thead><tr><th>Number</th><th>Date</th><th>Due</th><th className="text-right">Total</th><th className="text-right">Balance</th><th className="w-36 text-right">Apply</th></tr></thead>
            <tbody>
              {docs.map((d) => (
                <tr key={d._id}>
                  <td>{d.number}{d.supplierRef ? ` (${d.supplierRef})` : ""}</td><td>{date(d.date)}</td><td>{date(d.dueDate)}</td><td className="num">{money(d.total)}</td><td className="num">{money(d.balanceDue)}</td>
                  <td><input type="number" className="input input-sm text-right" value={alloc[d._id] ?? ""} onChange={(e) => setAlloc({ ...alloc, [d._id]: e.target.value })} /></td>
                </tr>
              ))}
              {docs.length === 0 && <tr><td colSpan={6} className="text-center text-ink-400">No open documents — the payment will sit as unallocated credit.</td></tr>}
            </tbody>
          </table>
          <div className="mt-2 text-right text-sm">Allocated {money(allocated)} · Unallocated {money((Number(f.amount) || 0) - allocated)}</div>
        </>
      )}
    </Modal>
  );
}

export function PaymentsTable({ partyType }) {
  const app = useApp();
  const rows = useQuery(api.payments.list, { partyType });
  const voidPayment = useMutation(api.payments.voidPayment);
  const [run] = useRun();
  const [ask, prompt] = usePrompt();
  return (
    <Card bodyClass="p-0">
      {prompt}
      <DataTable
        rows={rows}
        exportName={`${partyType}-payments`}
        totals
        columns={[
          { key: "number", header: "Number", render: (r) => <span className="font-medium">{r.number}</span> },
          { key: "date", header: "Date", render: (r) => date(r.date) },
          { key: "partyName", header: partyType === "customer" ? "Customer" : "Supplier" },
          { key: "direction", header: "Type", render: (r) => <Badge color={r.direction === "refund" ? "amber" : "gray"}>{r.direction}</Badge> },
          { key: "method", header: "Method" },
          { key: "accountName", header: "Account" },
          { key: "reference", header: "Reference" },
          { key: "amount", header: "Amount", align: "right", total: true, totalRender: money, render: (r) => money(r.amount) },
          { key: "unallocated", header: "Unallocated", align: "right", render: (r) => (r.unallocated ? money(r.unallocated) : "") },
          { key: "note", header: "Note", render: (r) => (r.note?.startsWith("VOID") ? <Badge color="red">void</Badge> : r.note) },
          {
            key: "x",
            header: "",
            render: (r) =>
              app.can("accounting.journal") && r.direction !== "refund" && !r.note?.startsWith("VOID") ? (
                <button className="btn-ghost btn-sm text-red-600" onClick={async () => { const reason = await ask(`Void ${r.number}`); if (reason) run(() => voidPayment({ id: r._id, reason }), "Payment voided"); }}>Void</button>
              ) : null,
          },
        ]}
      />
    </Card>
  );
}

export function SupplierPayments() {
  const app = useApp();
  const [paying, setPaying] = useState(false);
  return (
    <div>
      <PageHeader title="Supplier Payments" actions={app.can("supplier_payments.manage") && <button className="btn-primary" onClick={() => setPaying(true)}>+ Pay supplier</button>} />
      <PaymentsTable partyType="supplier" />
      <PaymentForm open={paying} onClose={() => setPaying(false)} partyType="supplier" />
    </div>
  );
}
