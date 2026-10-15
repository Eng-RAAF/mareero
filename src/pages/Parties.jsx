import { useEffect, useState } from "react";
import { useMutation, useQuery } from "../lib/convex";
import { api } from "../../convex/_generated/api";
import { useApp } from "../lib/app";
import { Badge, Card, Checkbox, DataTable, Field, Input, Loading, Modal, NumberInput, PageHeader, Select, Textarea, useRun } from "../components/ui";
import { date, money } from "../lib/format";
import { printDocument } from "../lib/print";

function PartyForm({ open, onClose, kind, party }) {
  const isCustomer = kind === "customer";
  const save = useMutation(isCustomer ? api.parties.saveCustomer : api.parties.saveSupplier);
  const [run, busy] = useRun();
  const empty = isCustomer
    ? { name: "", contactName: "", phone: "", email: "", address: "", creditLimit: 0, paymentTermsDays: 30, priceLevel: "retail", active: true }
    : { name: "", contactName: "", phone: "", email: "", address: "", paymentTermsDays: 30, creditLimit: 0, currency: "USD", leadTimeDays: 7, active: true, notes: "" };
  const [f, setF] = useState(empty);
  useEffect(() => {
    if (open) setF(party ? { ...empty, ...party } : empty);
  }, [open, party]); // eslint-disable-line
  const set = (k) => (e) => setF({ ...f, [k]: e?.target ? e.target.value : e });
  const opt = (s) => (s ? s : undefined);
  const submit = async () => {
    const common = { id: party?._id, name: f.name, contactName: opt(f.contactName), phone: opt(f.phone), email: opt(f.email), address: opt(f.address), paymentTermsDays: Number(f.paymentTermsDays) || 0, active: !!f.active };
    const payload = isCustomer
      ? { ...common, creditLimit: Number(f.creditLimit) || 0, priceLevel: f.priceLevel }
      : { ...common, creditLimit: Number(f.creditLimit) || undefined, currency: f.currency || "USD", leadTimeDays: Number(f.leadTimeDays) || 0, notes: opt(f.notes) };
    if ((await run(() => save(payload), "Saved")).ok) onClose();
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      wide
      title={party ? `Edit ${party.name}` : isCustomer ? "New customer" : "New supplier"}
      footer={
        <>
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={busy || !f.name.trim()} onClick={submit}>Save</button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <Field label="Name *" className="md:col-span-2"><Input value={f.name} onChange={set("name")} /></Field>
        <Field label="Contact person"><Input value={f.contactName ?? ""} onChange={set("contactName")} /></Field>
        <Field label="Phone"><Input value={f.phone ?? ""} onChange={set("phone")} /></Field>
        <Field label="Email"><Input type="email" value={f.email ?? ""} onChange={set("email")} /></Field>
        <Field label="Payment terms (days)"><NumberInput value={f.paymentTermsDays} onChange={set("paymentTermsDays")} /></Field>
        <Field label="Address" className="md:col-span-3"><Input value={f.address ?? ""} onChange={set("address")} /></Field>
        {isCustomer ? (
          <>
            <Field label="Credit limit" hint="0 = cash only; credit needs manager approval"><NumberInput value={f.creditLimit} onChange={set("creditLimit")} /></Field>
            <Field label="Price level"><Select value={f.priceLevel} onChange={set("priceLevel")} options={[{ value: "retail", label: "Retail" }, { value: "wholesale", label: "Wholesale" }]} /></Field>
          </>
        ) : (
          <>
            <Field label="Lead time (days)"><NumberInput value={f.leadTimeDays} onChange={set("leadTimeDays")} /></Field>
            <Field label="Currency"><Input value={f.currency} onChange={set("currency")} /></Field>
            <Field label="Credit limit they give us"><NumberInput value={f.creditLimit ?? 0} onChange={set("creditLimit")} /></Field>
            <Field label="Notes" className="md:col-span-3"><Textarea value={f.notes ?? ""} onChange={set("notes")} /></Field>
          </>
        )}
        <div className="md:col-span-3"><Checkbox checked={f.active} onChange={set("active")}>Active</Checkbox></div>
      </div>
    </Modal>
  );
}

function Statement({ kind, id, onClose }) {
  const app = useApp();
  const isCustomer = kind === "customer";
  const data = useQuery(isCustomer ? api.parties.customerStatement : api.parties.supplierStatement, id ? { id } : "skip");
  if (!id) return null;
  const party = data ? (isCustomer ? data.customer : data.supplier) : null;
  const print = () =>
    printDocument({
      company: app.company,
      title: "Statement",
      number: party.code,
      docDate: Date.now(),
      partyTitle: isCustomer ? "Customer" : "Supplier",
      party: [party.name, party.address, party.phone].filter(Boolean),
      meta: [["Balance", money(party.balance)], ["Terms", `${party.paymentTermsDays} days`]],
      columns: [
        { header: "Date", value: (r) => date(r.date) },
        { header: "Type", value: (r) => r.type },
        { header: "Number", value: (r) => r.number },
        { header: "Charges", value: (r) => (r.charge ? money(r.charge) : ""), align: "right" },
        { header: "Credits", value: (r) => (r.credit ? money(r.credit) : ""), align: "right" },
        { header: "Balance", value: (r) => money(r.balance), align: "right" },
      ],
      rows: data.lines,
      totals: [["Balance due", money(party.balance), true]],
    });
  return (
    <Modal open onClose={onClose} wide title={party ? `Statement — ${party.name}` : "Statement"} footer={party && <button className="btn-secondary" onClick={print}>Print statement</button>}>
      {!data ? (
        <Loading />
      ) : (
        <>
          <div className="mb-3 grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
            <div><span className="label">Code</span>{party.code}</div>
            <div><span className="label">Phone</span>{party.phone ?? "—"}</div>
            <div><span className="label">Balance</span><b>{money(party.balance)}</b></div>
            <div><span className="label">{isCustomer ? "Credit limit" : "Lead time"}</span>{isCustomer ? money(party.creditLimit) : `${party.leadTimeDays} days`}</div>
          </div>
          <DataTable
            search={false}
            rows={data.lines}
            exportName={`statement-${party.code}`}
            columns={[
              { key: "date", header: "Date", render: (r) => date(r.date) },
              { key: "type", header: "Type" },
              { key: "number", header: "Number" },
              { key: "ref", header: "Ref" },
              { key: "charge", header: "Charges", align: "right", render: (r) => (r.charge ? money(r.charge) : "") },
              { key: "credit", header: "Credits", align: "right", render: (r) => (r.credit ? money(r.credit) : "") },
              { key: "balance", header: "Balance", align: "right", render: (r) => money(r.balance) },
            ]}
            empty="No transactions yet."
          />
        </>
      )}
    </Modal>
  );
}

export function Suppliers() {
  const app = useApp();
  const rows = useQuery(api.parties.suppliers, { includeInactive: true });
  const [editing, setEditing] = useState(null);
  const [statement, setStatement] = useState(null);
  const canManage = app.can("suppliers.manage");
  return (
    <div>
      <PageHeader title="Suppliers" actions={canManage && <button className="btn-primary" onClick={() => setEditing({})}>+ New supplier</button>} />
      <Card bodyClass="p-0">
        <DataTable
          rows={rows}
          exportName="suppliers"
          totals
          onRowClick={(r) => setStatement(r._id)}
          columns={[
            { key: "code", header: "Code" },
            { key: "name", header: "Name", render: (r) => <span className="font-medium">{r.name}</span> },
            { key: "contactName", header: "Contact" },
            { key: "phone", header: "Phone" },
            { key: "paymentTermsDays", header: "Terms", align: "right", render: (r) => `${r.paymentTermsDays}d` },
            { key: "leadTimeDays", header: "Lead time", align: "right", render: (r) => `${r.leadTimeDays}d` },
            { key: "balance", header: "We owe", align: "right", total: true, totalRender: money, render: (r) => money(r.balance) },
            { key: "active", header: "", render: (r) => (!r.active ? <Badge>inactive</Badge> : null) },
            ...(canManage ? [{ key: "e", header: "", render: (r) => <button className="btn-ghost btn-sm" onClick={(e) => { e.stopPropagation(); setEditing(r); }}>Edit</button> }] : []),
          ]}
        />
      </Card>
      <PartyForm open={!!editing} kind="supplier" party={editing?._id ? editing : null} onClose={() => setEditing(null)} />
      <Statement kind="supplier" id={statement} onClose={() => setStatement(null)} />
    </div>
  );
}

export function Customers() {
  const app = useApp();
  const rows = useQuery(api.parties.customers, { includeInactive: true });
  const [editing, setEditing] = useState(null);
  const [statement, setStatement] = useState(null);
  const canManage = app.can("customers.manage");
  return (
    <div>
      <PageHeader title="Customers" actions={canManage && <button className="btn-primary" onClick={() => setEditing({})}>+ New customer</button>} />
      <Card bodyClass="p-0">
        <DataTable
          rows={rows}
          exportName="customers"
          totals
          onRowClick={(r) => setStatement(r._id)}
          columns={[
            { key: "code", header: "Code" },
            { key: "name", header: "Name", render: (r) => <span className="font-medium">{r.name}</span> },
            { key: "phone", header: "Phone" },
            { key: "priceLevel", header: "Price level", render: (r) => <Badge color="gray">{r.priceLevel}</Badge> },
            { key: "paymentTermsDays", header: "Terms", align: "right", render: (r) => `${r.paymentTermsDays}d` },
            { key: "creditLimit", header: "Credit limit", align: "right", render: (r) => money(r.creditLimit) },
            { key: "balance", header: "Balance", align: "right", total: true, totalRender: money, render: (r) => <span className={r.balance > r.creditLimit ? "font-semibold text-red-600" : ""}>{money(r.balance)}</span> },
            { key: "overdue", header: "Overdue", align: "right", total: true, totalRender: money, render: (r) => (r.overdue ? <span className="text-red-600">{money(r.overdue)}</span> : "") },
            { key: "active", header: "", render: (r) => (!r.active ? <Badge>inactive</Badge> : null) },
            ...(canManage ? [{ key: "e", header: "", render: (r) => <button className="btn-ghost btn-sm" onClick={(e) => { e.stopPropagation(); setEditing(r); }}>Edit</button> }] : []),
          ]}
        />
      </Card>
      <PartyForm open={!!editing} kind="customer" party={editing?._id ? editing : null} onClose={() => setEditing(null)} />
      <Statement kind="customer" id={statement} onClose={() => setStatement(null)} />
    </div>
  );
}
