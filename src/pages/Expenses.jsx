import { useEffect, useState } from "react";
import { useMutation, useQuery } from "../lib/convex";
import { api } from "../../convex/_generated/api";
import { useApp } from "../lib/app";
import { Badge, Card, DataTable, Field, Input, Modal, NumberInput, PageHeader, Select, Tabs, usePrompt, useRun } from "../components/ui";
import { date, fromInput, money, toInput } from "../lib/format";

function ExpenseForm({ open, onClose }) {
  const app = useApp();
  const create = useMutation(api.expenses.create);
  const upload = useMutation(api.org.generateUploadUrl);
  const accounts = useQuery(api.accounting.expenseAccounts) ?? [];
  const cash = useQuery(api.accounting.cashAccounts) ?? [];
  const [run, busy] = useRun();
  const [file, setFile] = useState(null);
  const blank = () => ({ branchId: app.branchId ?? app.branches[0]?._id ?? "", date: toInput(), expenseAccountId: "", paymentAccountId: cash[0]?._id ?? "", payee: "", amount: 0, taxAmount: 0, method: "cash", reference: "", description: "", recurring: "none" });
  const [f, setF] = useState(blank);
  useEffect(() => {
    if (open) {
      setF(blank());
      setFile(null);
    }
  }, [open]); // eslint-disable-line
  const set = (k) => (e) => setF({ ...f, [k]: e?.target ? e.target.value : e });
  const submit = async () => {
    const res = await run(async () => {
      let receiptStorageId;
      if (file) {
        const url = await upload({});
        const r = await fetch(url, { method: "POST", headers: { "Content-Type": file.type }, body: file });
        if (!r.ok) throw new Error("Receipt upload failed");
        receiptStorageId = (await r.json()).storageId;
      }
      return create({
        branchId: f.branchId,
        date: fromInput(f.date),
        expenseAccountId: f.expenseAccountId,
        paymentAccountId: f.paymentAccountId || cash[0]?._id,
        payee: f.payee,
        amount: Number(f.amount),
        taxAmount: Number(f.taxAmount) || 0,
        method: f.method,
        reference: f.reference || undefined,
        description: f.description,
        receiptStorageId,
        recurring: f.recurring,
      });
    }, "Expense saved");
    if (res.ok) onClose();
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      wide
      title="Record expense"
      footer={
        <>
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={busy || !f.expenseAccountId || !f.payee || !(Number(f.amount) > 0) || !f.description} onClick={submit}>Save</button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <Field label="Branch"><Select value={f.branchId} onChange={set("branchId")} options={app.branches.map((b) => ({ value: b._id, label: b.name }))} /></Field>
        <Field label="Date"><Input type="date" value={f.date} onChange={set("date")} /></Field>
        <Field label="Category (account)"><Select value={f.expenseAccountId} onChange={set("expenseAccountId")} placeholder="Choose…" options={accounts.map((a) => ({ value: a._id, label: `${a.code} ${a.name}` }))} /></Field>
        <Field label="Payee"><Input value={f.payee} onChange={set("payee")} /></Field>
        <Field label="Amount (before tax)"><NumberInput value={f.amount} onChange={set("amount")} /></Field>
        <Field label="Recoverable tax"><NumberInput value={f.taxAmount} onChange={set("taxAmount")} /></Field>
        <Field label="Paid from"><Select value={f.paymentAccountId} onChange={set("paymentAccountId")} options={cash.map((a) => ({ value: a._id, label: `${a.code} ${a.name}` }))} /></Field>
        <Field label="Method"><Select value={f.method} onChange={set("method")} options={[{ value: "cash", label: "Cash" }, { value: "bank_transfer", label: "Bank transfer" }, { value: "mobile_money", label: "Mobile money" }, { value: "cheque", label: "Cheque" }]} /></Field>
        <Field label="Reference"><Input value={f.reference} onChange={set("reference")} /></Field>
        <Field label="Description" className="md:col-span-2"><Input value={f.description} onChange={set("description")} /></Field>
        <Field label="Recurring"><Select value={f.recurring} onChange={set("recurring")} options={[{ value: "none", label: "No" }, { value: "monthly", label: "Monthly" }, { value: "weekly", label: "Weekly" }]} /></Field>
        <Field label="Receipt (photo or PDF)" className="md:col-span-3"><input type="file" accept="image/*,application/pdf" className="text-sm" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></Field>
      </div>
      <p className="mt-3 text-xs text-ink-500">Expenses above the company approval limit — or entered by someone who cannot approve — wait in Approvals before posting.</p>
    </Modal>
  );
}

export default function Expenses() {
  const app = useApp();
  const [status, setStatus] = useState("");
  const [creating, setCreating] = useState(false);
  const rows = useQuery(api.expenses.list, { status: status || undefined, branchId: app.branchId });
  const approve = useMutation(api.expenses.approve);
  const reject = useMutation(api.expenses.reject);
  const voidExpense = useMutation(api.expenses.voidExpense);
  const repeat = useMutation(api.expenses.repeat);
  const [run] = useRun();
  const [ask, prompt] = usePrompt();
  const canApprove = app.can("expenses.approve");
  return (
    <div>
      {prompt}
      <PageHeader title="Expenses" subtitle="Operating costs by branch" actions={app.can("expenses.create") && <button className="btn-primary" onClick={() => setCreating(true)}>+ Record expense</button>} />
      <Tabs value={status} onChange={setStatus} tabs={[{ value: "", label: "All" }, { value: "pending_approval", label: "Pending approval" }, { value: "posted", label: "Posted" }, { value: "rejected", label: "Rejected" }, { value: "void", label: "Void" }]} />
      <Card bodyClass="p-0">
        <DataTable
          rows={rows}
          exportName="expenses"
          totals
          columns={[
            { key: "number", header: "Number", render: (r) => <span className="font-medium">{r.number}</span> },
            { key: "date", header: "Date", render: (r) => date(r.date) },
            { key: "branchName", header: "Branch" },
            { key: "category", header: "Category" },
            { key: "payee", header: "Payee" },
            { key: "description", header: "Description" },
            { key: "paidFrom", header: "Paid from" },
            { key: "total", header: "Total", align: "right", total: true, totalRender: money, render: (r) => money(r.total) },
            { key: "receiptUrl", header: "Receipt", render: (r) => (r.receiptUrl ? <a className="link" href={r.receiptUrl} target="_blank" rel="noreferrer">View</a> : "") },
            { key: "status", header: "Status", render: (r) => <span><Badge>{r.status}</Badge>{r.recurring && r.recurring !== "none" && <Badge color="violet">{r.recurring}</Badge>}</span> },
            {
              key: "x",
              header: "",
              render: (r) => (
                <div className="flex justify-end gap-1">
                  {r.status === "pending_approval" && canApprove && (
                    <>
                      <button className="btn-primary btn-sm" onClick={() => run(() => approve({ id: r._id }), "Expense posted")}>Approve</button>
                      <button className="btn-ghost btn-sm text-red-600" onClick={async () => { const reason = await ask("Reject expense"); if (reason) run(() => reject({ id: r._id, reason }), "Rejected"); }}>Reject</button>
                    </>
                  )}
                  {r.status === "posted" && r.recurring && r.recurring !== "none" && app.can("expenses.create") && (
                    <button className="btn-ghost btn-sm" onClick={() => run(() => repeat({ id: r._id, date: Date.now() }), "Copied for today")}>Repeat</button>
                  )}
                  {r.status === "posted" && canApprove && (
                    <button className="btn-ghost btn-sm text-red-600" onClick={async () => { const reason = await ask(`Void ${r.number}`); if (reason) run(() => voidExpense({ id: r._id, reason }), "Expense voided"); }}>Void</button>
                  )}
                </div>
              ),
            },
          ]}
        />
      </Card>
      <ExpenseForm open={creating} onClose={() => setCreating(false)} />
    </div>
  );
}
