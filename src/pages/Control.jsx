import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery } from "../lib/convex";
import { api } from "../../convex/_generated/api";
import { useApp } from "../lib/app";
import { Badge, Card, Checkbox, DataTable, Field, Input, Loading, Modal, NumberInput, PageHeader, Select, usePrompt, useRun } from "../components/ui";
import { date, dateTime, label, money } from "../lib/format";

// ───────────── Approvals ─────────────
export function Approvals() {
  const navigate = useNavigate();
  const rows = useQuery(api.reports.approvals);
  const m = {
    purchase_request: { approve: useMutation(api.purchasing.approveRequest), reject: useMutation(api.purchasing.rejectRequest), link: "/purchasing/requests" },
    purchase_order: { approve: useMutation(api.purchasing.approveOrder), reject: useMutation(api.purchasing.rejectOrder), link: (id) => `/purchasing/orders/${id}` },
    transfer: { approve: useMutation(api.transfers.approve), reject: useMutation(api.transfers.reject), link: "/transfers" },
    adjustment: { approve: useMutation(api.inventory.approveAdjustment), reject: useMutation(api.inventory.rejectAdjustment), link: "/inventory/adjustments" },
    expense: { approve: useMutation(api.expenses.approve), reject: useMutation(api.expenses.reject), link: "/expenses" },
  };
  const [run, busy] = useRun();
  const [ask, prompt] = usePrompt();
  return (
    <div>
      {prompt}
      <PageHeader title="Approvals" subtitle="Everything waiting for your decision, oldest first" />
      <Card bodyClass="p-0">
        <DataTable
          rows={rows}
          exportName="approvals"
          empty="Nothing waiting for approval. ✓"
          columns={[
            { key: "type", header: "Type", render: (r) => <Badge color="blue">{label(r.type)}</Badge> },
            { key: "number", header: "Number", render: (r) => <button className="link" onClick={() => { const l = m[r.type].link; navigate(typeof l === "function" ? l(r.id) : l); }}>{r.number}</button> },
            { key: "title", header: "Description" },
            { key: "branchName", header: "Branch" },
            { key: "date", header: "Date", render: (r) => date(r.date) },
            { key: "by", header: "Requested by" },
            { key: "amount", header: "Amount", align: "right", render: (r) => money(r.amount) },
            {
              key: "x",
              header: "",
              render: (r) => (
                <div className="flex justify-end gap-1">
                  <button className="btn-primary btn-sm" disabled={busy} onClick={() => run(() => m[r.type].approve({ id: r.id }), `${r.number} approved`)}>Approve</button>
                  <button className="btn-ghost btn-sm text-red-600" disabled={busy} onClick={async () => { const reason = await ask(`Reject ${r.number}`); if (reason) run(() => m[r.type].reject({ id: r.id, reason }), `${r.number} rejected`); }}>Reject</button>
                </div>
              ),
            },
          ]}
        />
      </Card>
    </div>
  );
}

// ───────────── Notifications ─────────────
export function Notifications() {
  const navigate = useNavigate();
  const rows = useQuery(api.org.notifications);
  const mark = useMutation(api.org.markNotificationsRead);
  return (
    <div>
      <PageHeader title="Notifications" actions={<button className="btn-secondary" onClick={() => mark({})}>Mark all read</button>} />
      <Card bodyClass="p-0">
        {!rows ? <Loading /> : rows.length === 0 ? <div className="p-10 text-center text-sm text-ink-400">No notifications.</div> : (
          <ul className="divide-y divide-ink-100">
            {rows.map((n) => (
              <li key={n._id} className={`flex cursor-pointer items-start justify-between gap-4 px-4 py-3 hover:bg-ink-50 ${n.read ? "" : "bg-brand-50/50"}`} onClick={() => { mark({ ids: [n._id] }); if (n.link) navigate(n.link); }}>
                <div>
                  <div className={`text-sm ${n.read ? "text-ink-700" : "font-semibold text-ink-900"}`}>{n.title}</div>
                  <div className="text-sm text-ink-500">{n.body}</div>
                </div>
                <div className="whitespace-nowrap text-xs text-ink-400">{dateTime(n.createdAt)}</div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

// ───────────── Branches & stores ─────────────
export function Branches() {
  const rows = useQuery(api.org.listBranches);
  const members = useQuery(api.org.memberOptions) ?? [];
  const saveBranch = useMutation(api.org.saveBranch);
  const saveStore = useMutation(api.org.saveStore);
  const [run, busy] = useRun();
  const [branch, setBranch] = useState(null);
  const [store, setStore] = useState(null);
  const memberOpts = members.map((m) => ({ value: m._id, label: m.name }));
  return (
    <div>
      <PageHeader title="Branches & Stores" subtitle="Each branch can hold any number of stores or warehouses" actions={<button className="btn-primary" onClick={() => setBranch({ name: "", code: "", address: "", phone: "", managerMemberId: "", isHeadOffice: false, active: true })}>+ New branch</button>} />
      {!rows ? <Loading /> : (
        <div className="space-y-4">
          {rows.map((b) => (
            <Card
              key={b._id}
              title={<span>{b.name} <span className="ml-1 text-xs font-normal text-ink-500">{b.code}</span> {b.isHeadOffice && <Badge color="violet">Head office</Badge>} {!b.active && <Badge>inactive</Badge>}</span>}
              actions={
                <>
                  <button className="btn-secondary btn-sm" onClick={() => setStore({ branchId: b._id, name: "", code: `${b.code}-`, kind: "warehouse", managerMemberId: "", active: true })}>+ Store</button>
                  <button className="btn-ghost btn-sm" onClick={() => setBranch({ ...b, managerMemberId: b.managerMemberId ?? "" })}>Edit</button>
                </>
              }
              bodyClass="p-0"
            >
              <div className="px-4 py-2 text-sm text-ink-500">{[b.address, b.phone, b.manager && `Manager: ${b.manager}`].filter(Boolean).join(" · ") || "—"}</div>
              <table className="table">
                <thead><tr><th>Store</th><th>Code</th><th>Type</th><th>Manager</th><th /></tr></thead>
                <tbody>
                  {b.stores.map((s) => (
                    <tr key={s._id}>
                      <td className="font-medium">{s.name} {!s.active && <Badge>inactive</Badge>}</td><td>{s.code}</td><td>{label(s.kind)}</td><td>{s.manager ?? "—"}</td>
                      <td className="text-right"><button className="btn-ghost btn-sm" onClick={() => setStore({ ...s, managerMemberId: s.managerMemberId ?? "" })}>Edit</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          ))}
        </div>
      )}
      <Modal
        open={!!branch}
        onClose={() => setBranch(null)}
        title={branch?._id ? `Edit ${branch.name}` : "New branch"}
        footer={<><button className="btn-secondary" onClick={() => setBranch(null)}>Cancel</button><button className="btn-primary" disabled={busy || !branch?.name || !branch?.code} onClick={async () => (await run(() => saveBranch({ id: branch._id, name: branch.name, code: branch.code, address: branch.address || undefined, phone: branch.phone || undefined, managerMemberId: branch.managerMemberId || undefined, isHeadOffice: !!branch.isHeadOffice, active: !!branch.active }), branch._id ? "Branch saved" : "Branch created with a main store")).ok && setBranch(null)}>Save</button></>}
      >
        {branch && (
          <div className="grid grid-cols-2 gap-4">
            <Field label="Name"><Input value={branch.name} onChange={(e) => setBranch({ ...branch, name: e.target.value })} /></Field>
            <Field label="Code"><Input value={branch.code} onChange={(e) => setBranch({ ...branch, code: e.target.value })} /></Field>
            <Field label="Address" className="col-span-2"><Input value={branch.address ?? ""} onChange={(e) => setBranch({ ...branch, address: e.target.value })} /></Field>
            <Field label="Phone"><Input value={branch.phone ?? ""} onChange={(e) => setBranch({ ...branch, phone: e.target.value })} /></Field>
            <Field label="Branch manager"><Select value={branch.managerMemberId} onChange={(e) => setBranch({ ...branch, managerMemberId: e.target.value })} placeholder="—" options={memberOpts} /></Field>
            <Checkbox checked={branch.isHeadOffice} onChange={(v) => setBranch({ ...branch, isHeadOffice: v })}>Head office</Checkbox>
            <Checkbox checked={branch.active} onChange={(v) => setBranch({ ...branch, active: v })}>Active</Checkbox>
          </div>
        )}
      </Modal>
      <Modal
        open={!!store}
        onClose={() => setStore(null)}
        title={store?._id ? `Edit ${store.name}` : "New store / warehouse"}
        footer={<><button className="btn-secondary" onClick={() => setStore(null)}>Cancel</button><button className="btn-primary" disabled={busy || !store?.name || !store?.code} onClick={async () => (await run(() => saveStore({ id: store._id, branchId: store.branchId, name: store.name, code: store.code, kind: store.kind, managerMemberId: store.managerMemberId || undefined, active: !!store.active }), "Store saved")).ok && setStore(null)}>Save</button></>}
      >
        {store && (
          <div className="grid grid-cols-2 gap-4">
            <Field label="Name"><Input value={store.name} onChange={(e) => setStore({ ...store, name: e.target.value })} /></Field>
            <Field label="Code"><Input value={store.code} onChange={(e) => setStore({ ...store, code: e.target.value })} /></Field>
            <Field label="Type"><Select value={store.kind} onChange={(e) => setStore({ ...store, kind: e.target.value })} options={[{ value: "main", label: "Main store" }, { value: "retail", label: "Retail stock store" }, { value: "warehouse", label: "Warehouse" }]} /></Field>
            <Field label="Store manager"><Select value={store.managerMemberId} onChange={(e) => setStore({ ...store, managerMemberId: e.target.value })} placeholder="—" options={memberOpts} /></Field>
            <Checkbox checked={store.active} onChange={(v) => setStore({ ...store, active: v })}>Active</Checkbox>
          </div>
        )}
      </Modal>
    </div>
  );
}

// ───────────── Users ─────────────
export function Users() {
  const app = useApp();
  const rows = useQuery(api.org.listMembers);
  const roles = useQuery(api.org.roles) ?? [];
  const branches = useQuery(api.org.listBranches) ?? [];
  const save = useMutation(api.org.saveMember);
  const [run, busy] = useRun();
  const [edit, setEdit] = useState(null);
  const role = roles.find((r) => r.key === edit?.role);
  return (
    <div>
      <PageHeader
        title="Users & Roles"
        subtitle="Add a person here, then ask them to create an account with the same email"
        actions={<button className="btn-primary" onClick={() => setEdit({ name: "", email: "", role: "sales_officer", branchIds: app.branchId ? [app.branchId] : [], active: true })}>+ Add user</button>}
      />
      <Card bodyClass="p-0">
        <DataTable
          rows={rows}
          exportName="users"
          onRowClick={(r) => setEdit(r)}
          columns={[
            { key: "name", header: "Name", render: (r) => <span className="font-medium">{r.name}</span> },
            { key: "email", header: "Email" },
            { key: "roleLabel", header: "Role" },
            { key: "branches", header: "Branches", value: (r) => (["super_admin", "general_manager", "accountant", "auditor"].includes(r.role) ? "All" : r.branchIds.map((id) => branches.find((b) => b._id === id)?.name).filter(Boolean).join(", ")) },
            { key: "joined", header: "", render: (r) => (r.joined ? <Badge color="green">Joined</Badge> : <Badge color="amber">Invited</Badge>) },
            { key: "active", header: "", render: (r) => (!r.active ? <Badge>inactive</Badge> : null) },
          ]}
        />
      </Card>
      <Modal
        open={!!edit}
        onClose={() => setEdit(null)}
        wide
        title={edit?._id ? `Edit ${edit.name}` : "Add user"}
        footer={<><button className="btn-secondary" onClick={() => setEdit(null)}>Cancel</button><button className="btn-primary" disabled={busy || !edit?.name || !edit?.email} onClick={async () => (await run(() => save({ id: edit._id, name: edit.name, email: edit.email, role: edit.role, branchIds: edit.branchIds, active: !!edit.active }), edit._id ? "User updated" : "User added — they can now sign up with this email")).ok && setEdit(null)}>Save</button></>}
      >
        {edit && (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Field label="Full name"><Input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
            <Field label="Email"><Input type="email" value={edit.email} disabled={!!edit.joined} onChange={(e) => setEdit({ ...edit, email: e.target.value })} /></Field>
            <Field label="Role"><Select value={edit.role} onChange={(e) => setEdit({ ...edit, role: e.target.value })} options={roles.map((r) => ({ value: r.key, label: r.label }))} /></Field>
            <div className="flex items-end pb-2"><Checkbox checked={edit.active} onChange={(v) => setEdit({ ...edit, active: v })}>Active</Checkbox></div>
            <div className="md:col-span-2">
              <div className="label">Branch access {role?.permissions.includes("all_branches") && <span className="normal-case text-ink-400">(this role sees every branch)</span>}</div>
              <div className="flex flex-wrap gap-4">
                {branches.map((b) => (
                  <Checkbox key={b._id} checked={edit.branchIds.includes(b._id)} onChange={(v) => setEdit({ ...edit, branchIds: v ? [...edit.branchIds, b._id] : edit.branchIds.filter((x) => x !== b._id) })}>{b.name}</Checkbox>
                ))}
              </div>
            </div>
            {role && (
              <div className="md:col-span-2">
                <div className="label">What this role can do</div>
                <div className="flex flex-wrap gap-1">{role.permissions.map((p) => <Badge key={p} color="gray">{p}</Badge>)}</div>
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}

// ───────────── Audit log ─────────────
export function AuditLog() {
  const rows = useQuery(api.org.auditLog, { limit: 500 });
  return (
    <div>
      <PageHeader title="Audit Log" subtitle="Who did what, and when" />
      <Card bodyClass="p-0">
        <DataTable
          rows={rows}
          exportName="audit-log"
          columns={[
            { key: "at", header: "When", render: (r) => dateTime(r.at), csv: (r) => new Date(r.at).toISOString() },
            { key: "memberName", header: "User" },
            { key: "action", header: "Action", render: (r) => <code className="text-xs">{r.action}</code> },
            { key: "entityType", header: "Record" },
            { key: "details", header: "Details", render: (r) => <span className="line-clamp-2 max-w-md break-all text-xs text-ink-600">{r.details}</span> },
          ]}
        />
      </Card>
    </div>
  );
}

// ───────────── Settings ─────────────
export function Settings() {
  const app = useApp();
  const update = useMutation(api.org.updateCompany);
  const uploadUrl = useMutation(api.org.generateUploadUrl);
  const setLogo = useMutation(api.org.setLogo);
  const logo = useQuery(api.org.logoUrl);
  const sample = useMutation(api.setup.loadSampleData);
  const [run, busy] = useRun();
  const [f, setF] = useState(null);
  useEffect(() => {
    const c = app.company;
    if (c) setF({ name: c.name, address: c.address ?? "", phone: c.phone ?? "", email: c.email ?? "", taxId: c.taxId ?? "", currency: c.currency, defaultTaxRate: c.defaultTaxRate, fiscalYearStartMonth: c.fiscalYearStartMonth, allowNegativeStock: c.allowNegativeStock, requireApprovalAbove: c.requireApprovalAbove });
  }, [app.company]);
  if (!f) return <Loading />;
  const set = (k) => (e) => setF({ ...f, [k]: e?.target ? e.target.value : e });
  return (
    <div className="max-w-4xl">
      <PageHeader title="Settings" />
      <Card title="Company">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <Field label="Company name" className="md:col-span-2"><Input value={f.name} onChange={set("name")} /></Field>
          <Field label="Tax ID"><Input value={f.taxId} onChange={set("taxId")} /></Field>
          <Field label="Address" className="md:col-span-3"><Input value={f.address} onChange={set("address")} /></Field>
          <Field label="Phone"><Input value={f.phone} onChange={set("phone")} /></Field>
          <Field label="Email"><Input value={f.email} onChange={set("email")} /></Field>
          <Field label="Currency"><Input value={f.currency} onChange={set("currency")} /></Field>
          <Field label="Default sales tax %"><NumberInput value={f.defaultTaxRate} onChange={set("defaultTaxRate")} /></Field>
          <Field label="Fiscal year start month (1–12)"><NumberInput value={f.fiscalYearStartMonth} onChange={set("fiscalYearStartMonth")} min={1} max={12} /></Field>
          <Field label="GM approval needed above" hint="Purchase orders, requests and expenses"><NumberInput value={f.requireApprovalAbove} onChange={set("requireApprovalAbove")} /></Field>
          <div className="md:col-span-3"><Checkbox checked={f.allowNegativeStock} onChange={set("allowNegativeStock")}>Allow negative stock (not recommended)</Checkbox></div>
          <div className="text-xs text-ink-500 md:col-span-3">Inventory valuation: weighted-average cost (applied consistently to receipts, transfers, sales and returns).</div>
        </div>
        <div className="mt-4 flex justify-end">
          <button className="btn-primary" disabled={busy} onClick={() => run(() => update({ ...f, address: f.address || undefined, phone: f.phone || undefined, email: f.email || undefined, taxId: f.taxId || undefined, defaultTaxRate: Number(f.defaultTaxRate) || 0, fiscalYearStartMonth: Number(f.fiscalYearStartMonth) || 1, requireApprovalAbove: Number(f.requireApprovalAbove) || 0 }), "Settings saved")}>Save settings</button>
        </div>
      </Card>
      <Card title="Logo" className="mt-5">
        <div className="flex items-center gap-4">
          {logo ? <img src={logo} alt="Company logo" className="h-16 w-16 rounded border object-contain" /> : <div className="flex h-16 w-16 items-center justify-center rounded border text-xs text-ink-400">No logo</div>}
          <input
            type="file"
            accept="image/*"
            className="text-sm"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              await run(async () => {
                const url = await uploadUrl({});
                const r = await fetch(url, { method: "POST", headers: { "Content-Type": file.type }, body: file });
                const { storageId } = await r.json();
                await setLogo({ storageId });
              }, "Logo updated");
            }}
          />
        </div>
      </Card>
      <Card title="Sample data" className="mt-5">
        <p className="text-sm text-ink-600">Loads 10 common spare parts with opening stock, two suppliers, two customers and reorder rules into the head-office main store, so the team can practise every workflow. Only works while the catalogue is empty.</p>
        <button className="btn-secondary mt-3" disabled={busy} onClick={() => run(() => sample({}), "Sample data loaded")}>Load sample data</button>
      </Card>
    </div>
  );
}
