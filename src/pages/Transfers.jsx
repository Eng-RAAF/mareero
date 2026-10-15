import { useEffect, useState } from "react";
import { useMutation, useQuery } from "../lib/convex";
import { api } from "../../convex/_generated/api";
import { useApp } from "../lib/app";
import { Badge, Card, Checkbox, DataTable, Field, Input, Modal, PageHeader, Select, Tabs, Textarea, usePrompt, useRun } from "../components/ui";
import { LineEditor, cleanLines } from "../components/LineEditor";
import { date, dateTime, fromInput, money, num, toInput } from "../lib/format";

export function TransferForm({ open, onClose, initial }) {
  const app = useApp();
  const create = useMutation(api.transfers.create);
  const [run, busy] = useRun();
  const [fromStoreId, setFrom] = useState("");
  const [toStoreId, setTo] = useState("");
  const [day, setDay] = useState(toInput());
  const [note, setNote] = useState("");
  const [lines, setLines] = useState([{ productId: "" }]);
  const options = useQuery(api.products.options, fromStoreId ? { storeId: fromStoreId } : "skip");
  useEffect(() => {
    if (!open) return;
    setFrom(initial?.fromStoreId ?? "");
    setTo(initial?.toStoreId ?? app.defaultStoreId);
    setLines(initial?.lines ?? [{ productId: "" }]);
    setNote(initial?.note ?? "");
  }, [open, initial, app.defaultStoreId]);
  // Every store in the company may be a source/destination; the server checks access to at least one side.
  const allStores = useQuery(api.org.allStores) ?? [];
  return (
    <Modal
      open={open}
      onClose={onClose}
      wide
      title="New stock transfer"
      footer={
        <>
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button
            className="btn-primary"
            disabled={busy || !fromStoreId || !toStoreId}
            onClick={async () => {
              const res = await run(
                () => create({ fromStoreId, toStoreId, date: fromInput(day), note: note || undefined, lines: cleanLines(lines, ["qty"]), recommendationIds: initial?.recommendationIds }),
                "Transfer submitted for approval",
              );
              if (res.ok) onClose();
            }}
          >
            Submit for approval
          </button>
        </>
      }
    >
      <div className="mb-4 grid grid-cols-1 gap-4 md:grid-cols-3">
        <Field label="From store"><Select value={fromStoreId} onChange={(e) => setFrom(e.target.value)} placeholder="Choose…" options={allStores.map((s) => ({ value: s._id, label: `${s.name} (${s.branchName})` }))} /></Field>
        <Field label="To store"><Select value={toStoreId} onChange={(e) => setTo(e.target.value)} placeholder="Choose…" options={allStores.filter((s) => s._id !== fromStoreId).map((s) => ({ value: s._id, label: `${s.name} (${s.branchName})` }))} /></Field>
        <Field label="Date"><Input type="date" value={day} onChange={(e) => setDay(e.target.value)} /></Field>
      </div>
      {fromStoreId ? (
        <LineEditor lines={lines} setLines={setLines} options={options} fields={[{ key: "qty", label: "Qty" }]} onPick={() => ({ qty: 1 })} />
      ) : (
        <p className="text-sm text-ink-500">Choose the source store to pick items and see what is available there.</p>
      )}
      <Field label="Note" className="mt-4"><Textarea value={note} onChange={(e) => setNote(e.target.value)} /></Field>
    </Modal>
  );
}

function TransferDetail({ t, onClose }) {
  const app = useApp();
  const approve = useMutation(api.transfers.approve);
  const reject = useMutation(api.transfers.reject);
  const dispatch = useMutation(api.transfers.dispatch);
  const receive = useMutation(api.transfers.receive);
  const cancel = useMutation(api.transfers.cancel);
  const [run, busy] = useRun();
  const [ask, prompt] = usePrompt();
  const [qty, setQty] = useState({});
  const [dmg, setDmg] = useState({});
  const [final, setFinal] = useState(true);
  useEffect(() => {
    if (!t) return;
    const q = {};
    for (const l of t.lines) q[l.productId] = t.status === "approved" ? l.qty : Math.max(0, l.dispatchedQty - l.receivedQty - l.damagedQty);
    setQty(q);
    setDmg({});
  }, [t]);
  if (!t) return null;
  const done = (r) => r.ok && onClose();
  const canFrom = app.can("all_branches") || app.member.branchIds.includes(t.fromBranchId);
  const canTo = app.can("all_branches") || app.member.branchIds.includes(t.toBranchId);

  let footer = null;
  if (t.status === "pending_approval" && app.can("transfers.approve") && canFrom) {
    footer = (
      <>
        <button className="btn-secondary" disabled={busy} onClick={async () => { const r = await ask("Reject transfer"); if (r) done(await run(() => reject({ id: t._id, reason: r }), "Rejected")); }}>Reject</button>
        <button className="btn-primary" disabled={busy} onClick={async () => done(await run(() => approve({ id: t._id }), "Approved — stock reserved"))}>Approve</button>
      </>
    );
  } else if (t.status === "approved" && app.can("transfers.dispatch") && canFrom) {
    footer = (
      <>
        <button className="btn-secondary" disabled={busy} onClick={async () => done(await run(() => cancel({ id: t._id }), "Cancelled"))}>Cancel transfer</button>
        <button className="btn-primary" disabled={busy} onClick={async () => done(await run(() => dispatch({ id: t._id, lines: t.lines.map((l) => ({ productId: l.productId, qty: Number(qty[l.productId] ?? 0) })) }), "Dispatched — stock in transit"))}>Confirm dispatch</button>
      </>
    );
  } else if ((t.status === "in_transit" || t.status === "partially_received") && app.can("transfers.receive") && canTo) {
    footer = (
      <>
        <Checkbox checked={final} onChange={setFinal}>Final receipt (write off any shortage)</Checkbox>
        <button className="btn-primary" disabled={busy} onClick={async () => done(await run(() => receive({ id: t._id, final, lines: t.lines.map((l) => ({ productId: l.productId, receivedQty: Number(qty[l.productId] ?? 0), damagedQty: Number(dmg[l.productId] ?? 0) })) }), "Receipt recorded"))}>Confirm receipt</button>
      </>
    );
  } else if (t.status === "pending_approval" && app.can("transfers.create")) {
    footer = <button className="btn-secondary" disabled={busy} onClick={async () => done(await run(() => cancel({ id: t._id }), "Cancelled"))}>Cancel transfer</button>;
  }

  const editing = t.status === "approved" ? "dispatch" : t.status === "in_transit" || t.status === "partially_received" ? "receive" : null;
  return (
    <Modal open onClose={onClose} wide title={`${t.number} · ${t.fromStoreName} → ${t.toStoreName}`} footer={footer}>
      {prompt}
      <div className="mb-3 flex flex-wrap gap-4 text-sm text-ink-600">
        <span>Status: <Badge>{t.status}</Badge></span>
        <span>Requested {date(t.date)} by {t.createdByName}</span>
        {t.dispatchedAt && <span>Dispatched {dateTime(t.dispatchedAt)}</span>}
        {t.receivedAt && <span>Received {dateTime(t.receivedAt)}</span>}
      </div>
      <table className="table">
        <thead>
          <tr>
            <th>SKU</th><th>Name</th><th className="text-right">Requested</th><th className="text-right">Dispatched</th><th className="text-right">Received</th><th className="text-right">Damaged/short</th><th className="text-right">Unit cost</th>
            {editing === "dispatch" && <th className="w-28 text-right">Dispatch now</th>}
            {editing === "receive" && <><th className="w-28 text-right">Receive now</th><th className="w-28 text-right">Damaged</th></>}
          </tr>
        </thead>
        <tbody>
          {t.lines.map((l) => (
            <tr key={l.productId}>
              <td>{l.sku}</td><td>{l.name}</td><td className="num">{num(l.qty)}</td><td className="num">{num(l.dispatchedQty)}</td><td className="num">{num(l.receivedQty)}</td>
              <td className={`num ${l.damagedQty ? "text-red-600" : ""}`}>{num(l.damagedQty)}</td><td className="num">{money(l.unitCost)}</td>
              {editing && <td><input type="number" className="input input-sm text-right" value={qty[l.productId] ?? ""} onChange={(e) => setQty({ ...qty, [l.productId]: e.target.value })} /></td>}
              {editing === "receive" && <td><input type="number" className="input input-sm text-right" value={dmg[l.productId] ?? ""} onChange={(e) => setDmg({ ...dmg, [l.productId]: e.target.value })} /></td>}
            </tr>
          ))}
        </tbody>
      </table>
      {t.note && <p className="mt-3 whitespace-pre-line text-sm text-ink-600">{t.note}</p>}
    </Modal>
  );
}

export default function Transfers() {
  const app = useApp();
  const [status, setStatus] = useState("");
  const [creating, setCreating] = useState(false);
  const [viewingId, setViewingId] = useState(null);
  const rows = useQuery(api.transfers.list, { status: status || undefined });
  const viewing = rows?.find((r) => r._id === viewingId) ?? null;
  return (
    <div>
      <PageHeader
        title="Stock Transfers"
        subtitle="Request → approval → dispatch → in transit → receipt"
        actions={app.can("transfers.create") && <button className="btn-primary" onClick={() => setCreating(true)}>+ New transfer</button>}
      />
      <Tabs
        value={status}
        onChange={setStatus}
        tabs={[
          { value: "", label: "All" },
          { value: "pending_approval", label: "Pending approval" },
          { value: "approved", label: "To dispatch" },
          { value: "in_transit", label: "In transit" },
          { value: "partially_received", label: "Partially received" },
          { value: "received", label: "Received" },
        ]}
      />
      <Card bodyClass="p-0">
        <DataTable
          rows={rows}
          exportName="transfers"
          onRowClick={(r) => setViewingId(r._id)}
          columns={[
            { key: "number", header: "Number", render: (r) => <span className="font-medium">{r.number}</span> },
            { key: "date", header: "Date", render: (r) => date(r.date) },
            { key: "fromStoreName", header: "From" },
            { key: "toStoreName", header: "To" },
            { key: "lines", header: "Items", align: "right", value: (r) => r.lines.length },
            { key: "totalValue", header: "Value", align: "right", render: (r) => money(r.totalValue) },
            { key: "createdByName", header: "Requested by" },
            { key: "status", header: "Status", render: (r) => <Badge>{r.status}</Badge> },
          ]}
        />
      </Card>
      <TransferForm open={creating} onClose={() => setCreating(false)} />
      <TransferDetail t={viewing} onClose={() => setViewingId(null)} />
    </div>
  );
}
