import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "../lib/convex";
import { api } from "../../convex/_generated/api";
import { useApp } from "../lib/app";
import { Badge, Card, Checkbox, DataTable, Field, Input, Loading, Modal, NumberInput, PageHeader, Select, Textarea, usePrompt, useRun } from "../components/ui";
import { date, dateTime, endOfDay, fromInput, label, money, monthStart, toInput, yearStart } from "../lib/format";

const TYPES = [
  { value: "asset", label: "Asset" },
  { value: "liability", label: "Liability" },
  { value: "equity", label: "Equity" },
  { value: "revenue", label: "Revenue" },
  { value: "cogs", label: "Cost of Goods Sold" },
  { value: "expense", label: "Operating Expense" },
  { value: "other_income", label: "Other Income" },
  { value: "other_expense", label: "Other Expense" },
];

export function Accounts() {
  const app = useApp();
  const rows = useQuery(api.accounting.accounts, { withBalances: true });
  const save = useMutation(api.accounting.saveAccount);
  const [run, busy] = useRun();
  const [edit, setEdit] = useState(null);
  const canEdit = app.can("accounting.journal");
  return (
    <div>
      <PageHeader title="Chart of Accounts" actions={canEdit && <button className="btn-primary" onClick={() => setEdit({ code: "", name: "", type: "expense", subtype: "", isCashOrBank: false, description: "", active: true })}>+ New account</button>} />
      <Card bodyClass="p-0">
        <DataTable
          rows={rows}
          exportName="chart-of-accounts"
          onRowClick={canEdit ? (r) => setEdit(r) : undefined}
          columns={[
            { key: "code", header: "Code", render: (r) => <span className="font-medium">{r.code}</span> },
            { key: "name", header: "Account" },
            { key: "typeLabel", header: "Type" },
            { key: "systemKey", header: "", render: (r) => (r.systemKey ? <Badge color="gray">system</Badge> : null) },
            { key: "isCashOrBank", header: "", render: (r) => (r.isCashOrBank ? <Badge color="blue">cash/bank</Badge> : null) },
            { key: "balance", header: "Balance", align: "right", render: (r) => money(r.balance) },
            { key: "active", header: "", render: (r) => (!r.active ? <Badge>inactive</Badge> : null) },
          ]}
        />
      </Card>
      <Modal
        open={!!edit}
        onClose={() => setEdit(null)}
        title={edit?._id ? `Edit ${edit.code}` : "New account"}
        footer={
          <>
            <button className="btn-secondary" onClick={() => setEdit(null)}>Cancel</button>
            <button
              className="btn-primary"
              disabled={busy || !edit?.code || !edit?.name}
              onClick={async () => (await run(() => save({ id: edit._id, code: edit.code, name: edit.name, type: edit.type, subtype: edit.subtype || undefined, isCashOrBank: !!edit.isCashOrBank, description: edit.description || undefined, active: !!edit.active }), "Account saved")).ok && setEdit(null)}
            >
              Save
            </button>
          </>
        }
      >
        {edit && (
          <div className="grid grid-cols-2 gap-4">
            <Field label="Code"><Input value={edit.code} onChange={(e) => setEdit({ ...edit, code: e.target.value })} /></Field>
            <Field label="Type"><Select value={edit.type} disabled={!!edit.systemKey} onChange={(e) => setEdit({ ...edit, type: e.target.value })} options={TYPES} /></Field>
            <Field label="Name" className="col-span-2"><Input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
            <Field label="Subtype" hint="e.g. current, fixed, long_term"><Input value={edit.subtype ?? ""} onChange={(e) => setEdit({ ...edit, subtype: e.target.value })} /></Field>
            <div className="flex flex-col justify-end gap-2 pb-1">
              <Checkbox checked={edit.isCashOrBank} onChange={(v) => setEdit({ ...edit, isCashOrBank: v })}>Cash or bank account</Checkbox>
              <Checkbox checked={edit.active} onChange={(v) => setEdit({ ...edit, active: v })}>Active</Checkbox>
            </div>
            <Field label="Description" className="col-span-2"><Textarea value={edit.description ?? ""} onChange={(e) => setEdit({ ...edit, description: e.target.value })} /></Field>
          </div>
        )}
      </Modal>
    </div>
  );
}

function JournalForm({ open, onClose }) {
  const app = useApp();
  const accounts = useQuery(api.accounting.accounts, {}) ?? [];
  const create = useMutation(api.accounting.createJournal);
  const [run, busy] = useRun();
  const [memo, setMemo] = useState("");
  const [day, setDay] = useState(toInput());
  const [branchId, setBranchId] = useState("");
  const [lines, setLines] = useState([]);
  useEffect(() => {
    if (open) {
      setMemo("");
      setLines([{ accountId: "", debit: 0, credit: 0, memo: "" }, { accountId: "", debit: 0, credit: 0, memo: "" }]);
      setBranchId(app.branchId ?? "");
    }
  }, [open]); // eslint-disable-line
  const dr = lines.reduce((a, l) => a + (Number(l.debit) || 0), 0);
  const cr = lines.reduce((a, l) => a + (Number(l.credit) || 0), 0);
  const balanced = Math.abs(dr - cr) < 0.005 && dr > 0;
  const usable = accounts.filter((a) => a.active && !["ar", "ap", "inventory"].includes(a.systemKey ?? ""));
  const upd = (i, patch) => setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  return (
    <Modal
      open={open}
      onClose={onClose}
      wide
      title="Manual journal entry"
      footer={
        <>
          <span className={`mr-auto text-sm ${balanced ? "text-brand-700" : "text-red-600"}`}>Debits {money(dr)} · Credits {money(cr)} {balanced ? "✓ balanced" : "— not balanced"}</span>
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button
            className="btn-primary"
            disabled={busy || !balanced || !memo.trim()}
            onClick={async () => (await run(() => create({ date: fromInput(day), memo, branchId: branchId || undefined, lines: lines.filter((l) => l.accountId).map((l) => ({ accountId: l.accountId, debit: Number(l.debit) || 0, credit: Number(l.credit) || 0, memo: l.memo || undefined })) }), "Journal posted")).ok && onClose()}
          >
            Post
          </button>
        </>
      }
    >
      <div className="mb-4 grid grid-cols-1 gap-4 md:grid-cols-3">
        <Field label="Date"><Input type="date" value={day} onChange={(e) => setDay(e.target.value)} /></Field>
        <Field label="Branch"><Select value={branchId} onChange={(e) => setBranchId(e.target.value)} placeholder="Company-wide" options={app.branches.map((b) => ({ value: b._id, label: b.name }))} /></Field>
        <Field label="Memo *"><Input value={memo} onChange={(e) => setMemo(e.target.value)} /></Field>
      </div>
      <table className="table">
        <thead><tr><th>Account</th><th>Line memo</th><th className="w-32 text-right">Debit</th><th className="w-32 text-right">Credit</th><th className="w-8" /></tr></thead>
        <tbody>
          {lines.map((l, i) => (
            <tr key={i}>
              <td><select className="input input-sm" value={l.accountId} onChange={(e) => upd(i, { accountId: e.target.value })}><option value="">Choose…</option>{usable.map((a) => <option key={a._id} value={a._id}>{a.code} {a.name}</option>)}</select></td>
              <td><input className="input input-sm" value={l.memo} onChange={(e) => upd(i, { memo: e.target.value })} /></td>
              <td><input type="number" className="input input-sm text-right" value={l.debit || ""} onChange={(e) => upd(i, { debit: e.target.value, credit: 0 })} /></td>
              <td><input type="number" className="input input-sm text-right" value={l.credit || ""} onChange={(e) => upd(i, { credit: e.target.value, debit: 0 })} /></td>
              <td><button className="btn-ghost btn-sm text-red-600" onClick={() => setLines(lines.filter((_, j) => j !== i))}>✕</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <button className="btn-secondary btn-sm mt-2" onClick={() => setLines([...lines, { accountId: "", debit: 0, credit: 0, memo: "" }])}>+ Add line</button>
      <p className="mt-3 text-xs text-ink-500">Receivables, payables and inventory are control accounts — change them through invoices, bills, payments and stock adjustments so the sub-ledgers always reconcile.</p>
    </Modal>
  );
}

export function Journals() {
  const app = useApp();
  const [from, setFrom] = useState(toInput(monthStart()));
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState(null);
  const rows = useQuery(api.accounting.journals, { from: fromInput(from) - 12 * 3600 * 1000 });
  const reverse = useMutation(api.accounting.reverseEntry);
  const [run] = useRun();
  const [ask, prompt] = usePrompt();
  return (
    <div>
      {prompt}
      <PageHeader title="Journal Entries" subtitle="Every posting in the general ledger — posted entries are never edited, only reversed" actions={app.can("accounting.journal") && <button className="btn-primary" onClick={() => setCreating(true)}>+ Manual journal</button>} />
      <Card bodyClass="p-0">
        <DataTable
          rows={rows}
          exportName="journal-entries"
          onRowClick={(r) => setOpen(open === r._id ? null : r._id)}
          toolbar={<Field><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>}
          columns={[
            { key: "number", header: "Number", render: (r) => <span className="font-medium">{r.number}</span> },
            { key: "date", header: "Date", render: (r) => date(r.date) },
            { key: "sourceType", header: "Source", render: (r) => label(r.sourceType) },
            {
              key: "memo",
              header: "Memo",
              render: (r) => (
                <div>
                  {r.memo}
                  {open === r._id && (
                    <table className="mt-2 w-full text-xs">
                      <tbody>
                        {r.lines.map((l) => (
                          <tr key={l._id}>
                            <td className="py-0.5 pr-3">{l.accountCode} {l.accountName}</td>
                            <td className="py-0.5 text-right tabular-nums">{l.debit ? money(l.debit) : ""}</td>
                            <td className="py-0.5 text-right tabular-nums">{l.credit ? money(l.credit) : ""}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              ),
            },
            { key: "totalDebit", header: "Amount", align: "right", render: (r) => money(r.totalDebit) },
            { key: "createdByName", header: "By" },
            { key: "status", header: "Status", render: (r) => <Badge>{r.status}</Badge> },
            {
              key: "x",
              header: "",
              render: (r) =>
                r.sourceType === "manual" && r.status === "posted" && app.can("accounting.journal") ? (
                  <button className="btn-ghost btn-sm text-red-600" onClick={async (e) => { e.stopPropagation(); const reason = await ask(`Reverse ${r.number}`); if (reason) run(() => reverse({ id: r._id, reason }), "Entry reversed"); }}>Reverse</button>
                ) : null,
            },
          ]}
        />
      </Card>
      <JournalForm open={creating} onClose={() => setCreating(false)} />
    </div>
  );
}

export function Ledger() {
  const app = useApp();
  const accounts = useQuery(api.accounting.accounts, {}) ?? [];
  const [accountId, setAccountId] = useState("");
  const [from, setFrom] = useState(toInput(yearStart()));
  const [to, setTo] = useState(toInput());
  useEffect(() => {
    if (!accountId && accounts[0]) setAccountId(accounts[0]._id);
  }, [accounts, accountId]);
  const data = useQuery(api.accounting.ledger, accountId ? { accountId, from: fromInput(from) - 12 * 3600 * 1000, to: endOfDay(fromInput(to)), branchId: app.branchId } : "skip");
  return (
    <div>
      <PageHeader title="General Ledger" />
      <Card bodyClass="p-0">
        <div className="flex flex-wrap gap-3 border-b border-ink-100 p-3">
          <Select className="w-72" value={accountId} onChange={(e) => setAccountId(e.target.value)} options={accounts.map((a) => ({ value: a._id, label: `${a.code} ${a.name}` }))} />
          <Input type="date" className="w-40" value={from} onChange={(e) => setFrom(e.target.value)} />
          <Input type="date" className="w-40" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        {!data ? (
          <Loading />
        ) : (
          <>
            <div className="flex justify-between px-4 py-2 text-sm"><span>Opening balance</span><b>{money(data.opening)}</b></div>
            <DataTable
              rows={data.rows}
              exportName={`ledger-${data.account.code}`}
              columns={[
                { key: "date", header: "Date", render: (r) => date(r.date) },
                { key: "entryNumber", header: "Entry" },
                { key: "sourceType", header: "Source", render: (r) => label(r.sourceType) },
                { key: "memo", header: "Memo" },
                { key: "debit", header: "Debit", align: "right", render: (r) => (r.debit ? money(r.debit) : "") },
                { key: "credit", header: "Credit", align: "right", render: (r) => (r.credit ? money(r.credit) : "") },
                { key: "balance", header: "Balance", align: "right", render: (r) => money(r.balance) },
              ]}
              empty="No postings in this period."
            />
            <div className="flex justify-between border-t border-ink-200 px-4 py-2 text-sm"><span>Closing balance</span><b>{money(data.closing)}</b></div>
          </>
        )}
      </Card>
    </div>
  );
}

export function Reconcile() {
  const cash = useQuery(api.accounting.cashAccounts) ?? [];
  const [accountId, setAccountId] = useState("");
  const [stmtDate, setStmtDate] = useState(toInput());
  const [stmtBal, setStmtBal] = useState(0);
  const [cleared, setCleared] = useState(new Set());
  const complete = useMutation(api.accounting.completeReconciliation);
  const [run, busy] = useRun();
  useEffect(() => {
    if (!accountId && cash[0]) setAccountId(cash[0]._id);
  }, [cash, accountId]);
  const data = useQuery(api.accounting.reconciliationData, accountId ? { accountId, statementDate: endOfDay(fromInput(stmtDate)) } : "skip");
  useEffect(() => setCleared(new Set()), [accountId]);
  const clearedNow = useMemo(() => (data ? data.open.filter((l) => cleared.has(l._id)).reduce((a, l) => a + l.debit - l.credit, 0) : 0), [data, cleared]);
  const clearedBalance = (data?.clearedBalance ?? 0) + clearedNow;
  const diff = Math.round((Number(stmtBal) - clearedBalance) * 100) / 100;
  return (
    <div>
      <PageHeader title="Bank Reconciliation" subtitle="Tick the transactions that appear on the bank statement" />
      <Card>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
          <Field label="Account"><Select value={accountId} onChange={(e) => setAccountId(e.target.value)} options={cash.map((a) => ({ value: a._id, label: a.name }))} /></Field>
          <Field label="Statement date"><Input type="date" value={stmtDate} onChange={(e) => setStmtDate(e.target.value)} /></Field>
          <Field label="Statement ending balance"><NumberInput value={stmtBal} onChange={setStmtBal} /></Field>
          <div className="text-sm">
            <div className="flex justify-between"><span>Book balance</span><span>{money(data?.bookBalance)}</span></div>
            <div className="flex justify-between"><span>Cleared balance</span><span>{money(clearedBalance)}</span></div>
            <div className={`flex justify-between font-semibold ${diff === 0 ? "text-brand-700" : "text-red-600"}`}><span>Difference</span><span>{money(diff)}</span></div>
          </div>
        </div>
      </Card>
      <Card className="mt-5" bodyClass="p-0" title="Uncleared transactions" actions={<button className="btn-primary btn-sm" disabled={busy || diff !== 0} onClick={async () => (await run(() => complete({ accountId, statementDate: endOfDay(fromInput(stmtDate)), statementBalance: Number(stmtBal), clearedLineIds: [...cleared] }), "Reconciliation completed")).ok && setCleared(new Set())}>Finish reconciliation</button>}>
        {!data ? (
          <Loading />
        ) : (
          <DataTable
            search={false}
            rows={data.open}
            columns={[
              { key: "c", header: "", render: (r) => <input type="checkbox" className="h-4 w-4" checked={cleared.has(r._id)} onChange={() => { const s = new Set(cleared); s.has(r._id) ? s.delete(r._id) : s.add(r._id); setCleared(s); }} /> },
              { key: "date", header: "Date", render: (r) => date(r.date) },
              { key: "entryNumber", header: "Entry" },
              { key: "memo", header: "Memo" },
              { key: "debit", header: "Deposit", align: "right", render: (r) => (r.debit ? money(r.debit) : "") },
              { key: "credit", header: "Payment", align: "right", render: (r) => (r.credit ? money(r.credit) : "") },
            ]}
            empty="Everything up to this date is reconciled."
          />
        )}
      </Card>
      {data?.history?.length > 0 && (
        <Card className="mt-5" title="Previous reconciliations" bodyClass="p-0">
          <DataTable search={false} rows={data.history} columns={[{ key: "statementDate", header: "Statement date", render: (r) => date(r.statementDate) }, { key: "statementBalance", header: "Statement balance", align: "right", render: (r) => money(r.statementBalance) }, { key: "n", header: "Items cleared", align: "right", value: (r) => r.clearedLineIds.length }, { key: "_creationTime", header: "Done", render: (r) => dateTime(r._creationTime) }]} />
        </Card>
      )}
    </div>
  );
}

export function Periods() {
  const app = useApp();
  const rows = useQuery(api.accounting.periods);
  const setStatus = useMutation(api.accounting.setPeriodStatus);
  const addYear = useMutation(api.accounting.addFiscalYear);
  const [run] = useRun();
  const can = app.can("accounting.periods");
  const nextYear = rows?.length ? new Date(rows[rows.length - 1].endDate + 1).getFullYear() : new Date().getFullYear();
  return (
    <div>
      <PageHeader title="Financial Periods" subtitle="Closed periods block any posting dated inside them" actions={can && <button className="btn-secondary" onClick={() => run(() => addYear({ startYear: nextYear }), "Periods added")}>+ Add fiscal year {nextYear}</button>} />
      <Card bodyClass="p-0">
        <DataTable
          search={false}
          rows={rows}
          columns={[
            { key: "name", header: "Period", render: (r) => <span className="font-medium">{r.name}</span> },
            { key: "startDate", header: "From", render: (r) => date(r.startDate) },
            { key: "endDate", header: "To", render: (r) => date(r.endDate) },
            { key: "status", header: "Status", render: (r) => <Badge color={r.status === "closed" ? "gray" : "green"}>{r.status}</Badge> },
            { key: "closedAt", header: "Closed", render: (r) => (r.closedAt ? dateTime(r.closedAt) : "") },
            { key: "x", header: "", render: (r) => (can ? <button className="btn-secondary btn-sm" onClick={() => run(() => setStatus({ id: r._id, status: r.status === "closed" ? "open" : "closed" }), r.status === "closed" ? "Period reopened" : "Period closed")}>{r.status === "closed" ? "Reopen" : "Close"}</button> : null) },
          ]}
        />
      </Card>
    </div>
  );
}
