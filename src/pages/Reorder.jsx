import { useEffect, useState } from "react";
import { useMutation, useQuery } from "../lib/convex";
import { api } from "../../convex/_generated/api";
import { useApp } from "../lib/app";
import { Badge, Card, Checkbox, DataTable, Field, Input, Modal, NumberInput, PageHeader, Select, StatCard, Tabs, usePrompt, useRun } from "../components/ui";
import { TransferForm } from "./Transfers";
import { dateTime, money, num } from "../lib/format";

function OverrideModal({ rec, onClose }) {
  const override = useMutation(api.reorder.overrideQty);
  const [qty, setQty] = useState(0);
  const [reason, setReason] = useState("");
  const [run, busy] = useRun();
  useEffect(() => {
    if (rec) {
      setQty(rec.finalQty);
      setReason("");
    }
  }, [rec]);
  if (!rec) return null;
  return (
    <Modal
      open
      onClose={onClose}
      title={`Change quantity — ${rec.sku}`}
      footer={
        <>
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={busy || !reason.trim()} onClick={async () => (await run(() => override({ id: rec._id, qty, reason }), "Quantity updated")).ok && onClose()}>Save</button>
        </>
      }
    >
      <p className="mb-3 text-sm text-ink-600">System suggestion: <b>{num(rec.suggestedQty)}</b>. Every change is logged with your name, the time and the reason.</p>
      <div className="grid gap-4">
        <Field label="Quantity"><NumberInput value={qty} onChange={setQty} min={0} /></Field>
        <Field label="Reason *"><Input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      </div>
      {rec.overrides.length > 0 && (
        <div className="mt-4">
          <div className="label">History</div>
          <ul className="space-y-1 text-xs text-ink-600">
            {rec.overrides.map((o, i) => (
              <li key={i}>{dateTime(o.at)}: {num(o.originalQty)} → {num(o.newQty)} — {o.reason}</li>
            ))}
          </ul>
        </div>
      )}
    </Modal>
  );
}

function SettingsTab() {
  const app = useApp();
  const [storeId, setStoreId] = useState(app.defaultStoreId);
  const rows = useQuery(api.reorder.settings, storeId ? { storeId } : "skip");
  const suppliers = useQuery(api.parties.suppliers, {}) ?? [];
  const save = useMutation(api.reorder.saveSetting);
  const applyDefaults = useMutation(api.reorder.applyDefaults);
  const [run, busy] = useRun();
  const [edit, setEdit] = useState(null);
  const [defaults, setDefaults] = useState(false);
  const [d, setD] = useState({ leadTimeDays: 7, safetyDays: 5, coverDays: 30 });
  const canManage = app.can("reorder.manage");

  const openEdit = (r) =>
    setEdit({
      productId: r.productId,
      sku: r.sku,
      name: r.name,
      minStock: r.setting?.minStock ?? 0,
      reorderPoint: r.setting?.reorderPoint ?? 0,
      maxStock: r.setting?.maxStock ?? 0,
      safetyStock: r.setting?.safetyStock ?? 0,
      avgDailyDemand: r.setting?.avgDailyDemand ?? 0,
      autoDemand: r.setting?.autoDemand ?? true,
      autoReorderPoint: r.setting?.autoReorderPoint ?? true,
      leadTimeDays: r.setting?.leadTimeDays ?? 7,
      targetStock: r.setting?.targetStock ?? 0,
      minOrderQty: r.setting?.minOrderQty ?? 1,
      orderMultiple: r.setting?.orderMultiple ?? 1,
      reviewDays: r.setting?.reviewDays ?? 7,
      preferredSupplierId: r.setting?.preferredSupplierId ?? r.preferredSupplierId ?? "",
    });
  const set = (k) => (v) => setEdit({ ...edit, [k]: v?.target ? v.target.value : v });
  const computedRP = edit ? Math.ceil(Number(edit.avgDailyDemand) * Number(edit.leadTimeDays) + Number(edit.safetyStock)) : 0;

  return (
    <Card bodyClass="p-0">
      <DataTable
        rows={rows}
        exportName="reorder-settings"
        onRowClick={canManage ? openEdit : undefined}
        toolbar={
          <>
            <Select className="w-56" value={storeId} onChange={(e) => setStoreId(e.target.value)} options={app.stores.map((s) => ({ value: s._id, label: s.name }))} />
            {canManage && <button className="btn-secondary btn-sm" onClick={() => setDefaults(true)}>Apply defaults to unset items</button>}
          </>
        }
        columns={[
          { key: "sku", header: "SKU" },
          { key: "name", header: "Name" },
          { key: "onHand", header: "On hand", align: "right", render: (r) => num(r.onHand) },
          { key: "d", header: "Daily demand", align: "right", value: (r) => r.setting?.avgDailyDemand ?? "—" },
          { key: "lt", header: "Lead time", align: "right", value: (r) => (r.setting ? `${r.setting.leadTimeDays}d` : "—") },
          { key: "ss", header: "Safety", align: "right", value: (r) => r.setting?.safetyStock ?? "—" },
          { key: "rp", header: "Reorder pt", align: "right", value: (r) => r.setting?.reorderPoint ?? "—" },
          { key: "ts", header: "Target", align: "right", value: (r) => r.setting?.targetStock ?? "—" },
          { key: "moq", header: "MOQ / multiple", align: "right", value: (r) => (r.setting ? `${r.setting.minOrderQty} / ${r.setting.orderMultiple}` : "—") },
          { key: "set", header: "", render: (r) => (r.setting ? <Badge color="green">Set</Badge> : <Badge color="gray">Not set</Badge>) },
        ]}
      />
      <Modal
        open={!!edit}
        onClose={() => setEdit(null)}
        wide
        title={edit ? `Reorder rules — ${edit.sku} ${edit.name}` : ""}
        footer={
          <>
            <button className="btn-secondary" onClick={() => setEdit(null)}>Cancel</button>
            <button
              className="btn-primary"
              disabled={busy}
              onClick={async () => {
                const { sku, name, ...rest } = edit;
                const nums = ["minStock", "reorderPoint", "maxStock", "safetyStock", "avgDailyDemand", "leadTimeDays", "targetStock", "minOrderQty", "orderMultiple", "reviewDays"];
                const payload = { ...rest, storeId, preferredSupplierId: rest.preferredSupplierId || undefined };
                for (const k of nums) payload[k] = Number(payload[k]) || 0;
                if ((await run(() => save(payload), "Reorder rules saved")).ok) setEdit(null);
              }}
            >
              Save
            </button>
          </>
        }
      >
        {edit && (
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            <Field label="Avg daily demand"><NumberInput value={edit.avgDailyDemand} onChange={set("avgDailyDemand")} disabled={edit.autoDemand} /></Field>
            <Field label="Supplier lead time (days)"><NumberInput value={edit.leadTimeDays} onChange={set("leadTimeDays")} /></Field>
            <Field label="Safety stock"><NumberInput value={edit.safetyStock} onChange={set("safetyStock")} /></Field>
            <Field label="Reorder point" hint={edit.autoReorderPoint ? `= ${edit.avgDailyDemand} × ${edit.leadTimeDays} + ${edit.safetyStock} = ${computedRP}` : undefined}>
              <NumberInput value={edit.autoReorderPoint ? computedRP : edit.reorderPoint} onChange={set("reorderPoint")} disabled={edit.autoReorderPoint} />
            </Field>
            <Field label="Minimum stock (critical)"><NumberInput value={edit.minStock} onChange={set("minStock")} /></Field>
            <Field label="Target stock"><NumberInput value={edit.targetStock} onChange={set("targetStock")} /></Field>
            <Field label="Maximum stock" hint="0 = no maximum"><NumberInput value={edit.maxStock} onChange={set("maxStock")} /></Field>
            <Field label="Review every (days)"><NumberInput value={edit.reviewDays} onChange={set("reviewDays")} /></Field>
            <Field label="Min order qty"><NumberInput value={edit.minOrderQty} onChange={set("minOrderQty")} /></Field>
            <Field label="Order multiple"><NumberInput value={edit.orderMultiple} onChange={set("orderMultiple")} /></Field>
            <Field label="Preferred supplier" className="col-span-2"><Select value={edit.preferredSupplierId} onChange={set("preferredSupplierId")} placeholder="—" options={suppliers.map((s) => ({ value: s._id, label: s.name }))} /></Field>
            <div className="col-span-2 flex flex-col gap-2 md:col-span-4">
              <Checkbox checked={edit.autoDemand} onChange={set("autoDemand")}>Calculate demand automatically from the last 90 days of sales</Checkbox>
              <Checkbox checked={edit.autoReorderPoint} onChange={set("autoReorderPoint")}>Reorder point = demand × lead time + safety stock</Checkbox>
            </div>
          </div>
        )}
      </Modal>
      <Modal
        open={defaults}
        onClose={() => setDefaults(false)}
        title="Apply default reorder rules"
        footer={
          <>
            <button className="btn-secondary" onClick={() => setDefaults(false)}>Cancel</button>
            <button className="btn-primary" disabled={busy} onClick={async () => (await run(() => applyDefaults({ storeId, ...d }), "Defaults applied")).ok && setDefaults(false)}>Apply</button>
          </>
        }
      >
        <p className="mb-3 text-sm text-ink-600">Creates rules for every product in this store that has none, using sales history where available. Existing rules are left alone.</p>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Lead time (days)"><NumberInput value={d.leadTimeDays} onChange={(v) => setD({ ...d, leadTimeDays: v })} /></Field>
          <Field label="Safety (days)"><NumberInput value={d.safetyDays} onChange={(v) => setD({ ...d, safetyDays: v })} /></Field>
          <Field label="Cover (days)"><NumberInput value={d.coverDays} onChange={(v) => setD({ ...d, coverDays: v })} /></Field>
        </div>
      </Modal>
    </Card>
  );
}

export default function Reorder() {
  const app = useApp();
  const [view, setView] = useState("open");
  const [supplierId, setSupplierId] = useState("");
  const [selected, setSelected] = useState(new Set());
  const [overriding, setOverriding] = useState(null);
  const [transferInit, setTransferInit] = useState(null);
  const data = useQuery(api.reorder.dashboard, view === "settings" ? "skip" : { view, branchId: app.branchId, storeId: app.storeId, supplierId: supplierId || undefined });
  const suppliers = useQuery(api.parties.suppliers, {}) ?? [];
  const recalc = useMutation(api.reorder.recalculate);
  const createRequests = useMutation(api.reorder.createRequests);
  const postpone = useMutation(api.reorder.postpone);
  const reject = useMutation(api.reorder.reject);
  const setAction = useMutation(api.reorder.setAction);
  const [run, busy] = useRun();
  const [ask, prompt] = usePrompt();
  const canManage = app.can("reorder.manage");

  const toggle = (id) => {
    const s = new Set(selected);
    s.has(id) ? s.delete(id) : s.add(id);
    setSelected(s);
  };
  const purchaseRows = (data?.rows ?? []).filter((r) => r.status === "recommended" && r.action === "purchase");

  return (
    <div>
      {prompt}
      <PageHeader
        title="Reorder Management"
        subtitle="Reorder point = daily demand × lead time + safety stock · Projected = on hand − reserved + incoming"
        actions={canManage && <button className="btn-secondary" disabled={busy} onClick={() => run(() => recalc({ storeId: app.storeId }), "Recommendations recalculated")}>Recalculate now</button>}
      />
      {data && view !== "settings" && (
        <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-5">
          <StatCard title="Below reorder point" value={num(data.summary.belowReorder)} tone={data.summary.belowReorder ? "warn" : "default"} />
          <StatCard title="Critical shortages" value={num(data.summary.critical)} tone={data.summary.critical ? "bad" : "default"} />
          <StatCard title="Est. purchase cost" value={money(data.summary.estCost)} />
          <StatCard title="Pending approval" value={num(data.summary.pendingApproval)} />
          <StatCard title="On order" value={num(data.summary.ordered)} />
        </div>
      )}
      <Tabs
        value={view}
        onChange={(v) => {
          setView(v);
          setSelected(new Set());
        }}
        tabs={[
          { value: "open", label: "Recommendations" },
          { value: "pipeline", label: "In progress" },
          { value: "history", label: "History" },
          { value: "settings", label: "Reorder settings" },
        ]}
      />
      {view === "settings" ? (
        <SettingsTab />
      ) : (
        <Card bodyClass="p-0">
          <DataTable
            rows={data?.rows}
            exportName={`reorder-${view}`}
            toolbar={
              <>
                <Select className="w-56" value={supplierId} onChange={(e) => setSupplierId(e.target.value)} placeholder="All suppliers" options={suppliers.map((s) => ({ value: s._id, label: s.name }))} />
                {view === "open" && app.can("purchasing.request") && (
                  <>
                    <button className="btn-secondary btn-sm" onClick={() => setSelected(new Set(purchaseRows.map((r) => r._id)))}>Select all purchases</button>
                    <button
                      className="btn-primary btn-sm"
                      disabled={busy || selected.size === 0}
                      onClick={async () => {
                        if ((await run(() => createRequests({ ids: [...selected] }), "Purchase requests created, grouped by supplier")).ok) setSelected(new Set());
                      }}
                    >
                      Create purchase requests ({selected.size})
                    </button>
                  </>
                )}
              </>
            }
            empty={view === "open" ? "All stock is above its reorder point. 👍" : "Nothing here."}
            columns={[
              ...(view === "open"
                ? [{ key: "sel", header: "", render: (r) => r.action === "purchase" && r.status === "recommended" ? <input type="checkbox" checked={selected.has(r._id)} onChange={() => toggle(r._id)} className="h-4 w-4" /> : null }]
                : []),
              { key: "severity", header: "Priority", render: (r) => <Badge>{r.severity}</Badge> },
              { key: "sku", header: "SKU" },
              { key: "name", header: "Name" },
              { key: "storeName", header: "Store" },
              { key: "onHand", header: "On hand", align: "right", render: (r) => num(r.onHand) },
              { key: "reserved", header: "Reserved", align: "right", render: (r) => num(r.reserved) },
              { key: "incoming", header: "Incoming", align: "right", render: (r) => num(r.incoming) },
              { key: "projected", header: "Projected", align: "right", render: (r) => <span className={r.projected <= 0 ? "font-semibold text-red-600" : ""}>{num(r.projected)}</span> },
              { key: "reorderPoint", header: "Reorder pt", align: "right" },
              { key: "targetStock", header: "Target", align: "right" },
              { key: "finalQty", header: "Order qty", align: "right", render: (r) => <span>{num(r.finalQty)}{r.overrides.length > 0 && <span title="Manually changed" className="ml-1 text-amber-600">✎</span>}</span> },
              { key: "estCost", header: "Est. cost", align: "right", render: (r) => money(r.estCost) },
              { key: "action", header: "Action", render: (r) => <span><Badge>{r.action}</Badge>{r.action === "transfer" && <div className="mt-0.5 text-xs text-ink-500">from {r.fromStoreName}</div>}</span> },
              { key: "supplierName", header: "Supplier" },
              { key: "status", header: "Status", render: (r) => <span><Badge>{r.status}</Badge>{(r.prNumber || r.transferNumber) && <div className="mt-0.5 text-xs text-ink-500">{r.prNumber || r.transferNumber}</div>}</span> },
              ...(view === "open" && canManage
                ? [
                    {
                      key: "act",
                      header: "",
                      render: (r) => (
                        <div className="flex flex-wrap justify-end gap-1">
                          {r.action === "transfer" && app.can("transfers.create") && (
                            <button className="btn-primary btn-sm" onClick={() => setTransferInit({ fromStoreId: r.transferFromStoreId, toStoreId: r.storeId, lines: [{ productId: r.productId, qty: r.finalQty }], note: "From reorder recommendation", recommendationIds: [r._id] })}>Transfer</button>
                          )}
                          {r.transferFromStoreId && (
                            <button className="btn-ghost btn-sm" onClick={() => run(() => setAction({ id: r._id, action: r.action === "transfer" ? "purchase" : "transfer" }))}>
                              {r.action === "transfer" ? "Buy instead" : "Transfer instead"}
                            </button>
                          )}
                          <button className="btn-ghost btn-sm" onClick={() => setOverriding(r)}>Qty</button>
                          <button className="btn-ghost btn-sm" onClick={async () => { const reason = await ask("Postpone 7 days", { placeholder: "Reason (optional)", required: false }); if (reason !== null) run(() => postpone({ id: r._id, days: 7, reason }), "Postponed 7 days"); }}>Later</button>
                          <button className="btn-ghost btn-sm text-red-600" onClick={async () => { const reason = await ask("Reject recommendation"); if (reason) run(() => reject({ id: r._id, reason }), "Rejected"); }}>Reject</button>
                        </div>
                      ),
                    },
                  ]
                : []),
            ]}
          />
        </Card>
      )}
      <OverrideModal rec={overriding} onClose={() => setOverriding(null)} />
      <TransferForm open={!!transferInit} initial={transferInit} onClose={() => setTransferInit(null)} />
    </div>
  );
}
