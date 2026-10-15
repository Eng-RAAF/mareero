import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery } from "../lib/convex";
import { api } from "../../convex/_generated/api";
import { useApp } from "../lib/app";
import { Badge, Card, Checkbox, DataTable, Field, Input, Loading, Modal, NumberInput, PageHeader, Select, Tabs, Textarea, usePrompt, useRun } from "../components/ui";
import { LineEditor, cleanLines } from "../components/LineEditor";
import { PaymentForm, PaymentsTable } from "./Purchasing";
import { DAY, date, fromInput, money, num, toInput } from "../lib/format";
import { printDocument } from "../lib/print";

const TITLES = { quotation: "Quotations", order: "Sales Orders", invoice: "Invoices", credit_note: "Credit Notes" };
const SINGULAR = { quotation: "Quotation", order: "Sales Order", invoice: "Invoice", credit_note: "Credit Note" };
const STATUSES = {
  quotation: ["draft", "sent", "accepted", "converted", "expired", "cancelled"],
  order: ["draft", "confirmed", "invoiced", "cancelled"],
  invoice: ["draft", "open", "partial", "paid", "void"],
};

export function SalesList({ kind }) {
  const app = useApp();
  const navigate = useNavigate();
  const [status, setStatus] = useState("");
  useEffect(() => setStatus(""), [kind]);
  const rows = useQuery(api.sales.list, { kind, status: status || undefined });
  const shown = useMemo(() => (rows ? rows.filter((r) => !app.branchId || r.branchId === app.branchId) : rows), [rows, app.branchId]);
  return (
    <div>
      <PageHeader
        title={TITLES[kind]}
        subtitle={kind === "invoice" ? "Accounts receivable" : kind === "order" ? "Confirmed orders reserve stock" : "Price quotes for customers"}
        actions={app.can("sales.create") && <button className="btn-primary" onClick={() => navigate(`/sales/${kind}/new`)}>+ New {SINGULAR[kind].toLowerCase()}</button>}
      />
      <Tabs value={status} onChange={setStatus} tabs={[{ value: "", label: "All" }, ...STATUSES[kind].map((s) => ({ value: s, label: s.charAt(0).toUpperCase() + s.slice(1) }))]} />
      <Card bodyClass="p-0">
        <DataTable
          rows={shown}
          exportName={TITLES[kind].toLowerCase().replace(/ /g, "-")}
          totals
          onRowClick={(r) => navigate(`/sales/doc/${r._id}`)}
          columns={[
            { key: "number", header: "Number", render: (r) => <span className="font-medium">{r.number}</span> },
            { key: "date", header: "Date", render: (r) => date(r.date) },
            { key: "customerName", header: "Customer" },
            { key: "storeName", header: "Store" },
            ...(kind === "invoice" ? [{ key: "dueDate", header: "Due", render: (r) => <span className={r.overdue ? "font-medium text-red-600" : ""}>{date(r.dueDate)}</span> }] : []),
            { key: "total", header: "Total", align: "right", total: true, totalRender: money, render: (r) => money(r.total) },
            ...(kind === "invoice" ? [{ key: "balanceDue", header: "Balance due", align: "right", total: true, totalRender: money, render: (r) => money(r.balanceDue) }] : []),
            { key: "createdByName", header: "By" },
            { key: "status", header: "Status", render: (r) => <Badge>{r.overdue ? "overdue" : r.status}</Badge> },
          ]}
        />
      </Card>
    </div>
  );
}

export function SalesEditor() {
  const params = useParams();
  const app = useApp();
  const navigate = useNavigate();
  const existing = useQuery(api.sales.get, params.id ? { id: params.id } : "skip");
  const kind = params.kind ?? existing?.kind;
  const customers = useQuery(api.parties.customers, {}) ?? [];
  const cash = useQuery(api.accounting.cashAccounts) ?? [];
  const save = useMutation(api.sales.save);
  const [run, busy] = useRun();
  const [customerId, setCustomerId] = useState("");
  const [storeId, setStoreId] = useState(app.defaultStoreId);
  const [day, setDay] = useState(toInput());
  const [validUntil, setValidUntil] = useState(toInput(Date.now() + 14 * DAY));
  const [taxRate, setTaxRate] = useState(app.company?.defaultTaxRate ?? 0);
  const [note, setNote] = useState("");
  const [lines, setLines] = useState([{ productId: "" }]);
  const [payNow, setPayNow] = useState(false);
  const [payAccount, setPayAccount] = useState("");
  const [payMethod, setPayMethod] = useState("cash");
  const options = useQuery(api.products.options, storeId ? { storeId } : "skip");
  const customer = customers.find((c) => c._id === customerId);

  useEffect(() => {
    if (!existing) return;
    setCustomerId(existing.customerId);
    setStoreId(existing.storeId);
    setDay(toInput(existing.date));
    if (existing.validUntil) setValidUntil(toInput(existing.validUntil));
    setTaxRate(existing.taxRate);
    setNote(existing.note ?? "");
    setLines(existing.lines.map((l) => ({ productId: l.productId, description: l.description, qty: l.qty, unitPrice: l.unitPrice, discount: l.discount })));
  }, [existing?._id]); // eslint-disable-line
  useEffect(() => {
    if (!payAccount && cash[0]) setPayAccount(cash[0]._id);
  }, [cash, payAccount]);

  if (params.id && existing === undefined) return <Loading />;
  if (!kind || !SINGULAR[kind]) return <div>Unknown document type.</div>;

  const priceOf = (p) => (customer?.priceLevel === "wholesale" ? p.wholesalePrice : p.retailPrice);
  const subtotal = lines.reduce((a, l) => a + (Number(l.qty) || 0) * (Number(l.unitPrice) || 0), 0);
  const discount = lines.reduce((a, l) => a + (Number(l.discount) || 0), 0);
  const tax = ((subtotal - discount) * (Number(taxRate) || 0)) / 100;
  const total = subtotal - discount + tax;
  const overLimit = customer && kind !== "quotation" && customer.balance + (payNow ? 0 : total) > customer.creditLimit;

  const submit = (action) => async () => {
    const res = await run(
      () =>
        save({
          id: existing?._id,
          kind,
          customerId,
          storeId,
          date: fromInput(day),
          validUntil: kind === "quotation" ? fromInput(validUntil) : undefined,
          taxRate: Number(taxRate) || 0,
          note: note || undefined,
          lines: cleanLines(lines, ["description", "qty", "unitPrice", "discount"]),
          action,
          payNow: kind === "invoice" && action === "post" && payNow && payAccount ? { accountId: payAccount, method: payMethod, amount: Math.round(total * 100) / 100 } : undefined,
        }),
      action === "post" ? "Invoice posted" : action === "confirm" ? "Order confirmed — stock reserved" : action === "send" ? "Quotation marked as sent" : "Draft saved",
    );
    if (res.ok) navigate(`/sales/doc/${res.res}`);
  };

  return (
    <div>
      <PageHeader title={existing ? `Edit ${existing.number}` : `New ${SINGULAR[kind].toLowerCase()}`} actions={<button className="btn-secondary" onClick={() => navigate(-1)}>Cancel</button>} />
      <Card>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
          <Field label="Customer *" className="md:col-span-2">
            <Select value={customerId} onChange={(e) => setCustomerId(e.target.value)} placeholder="Choose customer…" options={customers.map((c) => ({ value: c._id, label: `${c.name} (${c.priceLevel})` }))} />
          </Field>
          <Field label="Store"><Select value={storeId} onChange={(e) => setStoreId(e.target.value)} options={app.stores.map((s) => ({ value: s._id, label: s.name }))} /></Field>
          <Field label="Date"><Input type="date" value={day} onChange={(e) => setDay(e.target.value)} /></Field>
          {kind === "quotation" && <Field label="Valid until"><Input type="date" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} /></Field>}
        </div>
        {customer && (
          <div className={`mt-3 rounded-md px-3 py-2 text-sm ${overLimit ? "bg-amber-50 text-amber-800" : "bg-ink-50 text-ink-600"}`}>
            Balance {money(customer.balance)} · Credit limit {money(customer.creditLimit)} · Terms {customer.paymentTermsDays} days
            {customer.overdue > 0 && <span className="ml-2 font-medium text-red-600">· {money(customer.overdue)} overdue</span>}
            {overLimit && <span className="ml-2 font-medium">· This exceeds the credit limit — a manager must post it, or take payment now.</span>}
          </div>
        )}
        <div className="mt-4">
          <LineEditor
            lines={lines}
            setLines={setLines}
            options={options}
            showDescription
            fields={[{ key: "qty", label: "Qty", width: "6rem" }, { key: "unitPrice", label: "Unit price" }, ...(app.can("sales.discount") ? [{ key: "discount", label: "Discount" }] : [])]}
            onPick={(p) => ({ qty: 1, unitPrice: priceOf(p), discount: 0 })}
            amount={(l) => (Number(l.qty) || 0) * (Number(l.unitPrice) || 0) - (Number(l.discount) || 0)}
          />
        </div>
        <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-3">
          <Field label="Notes (printed)" className="md:col-span-2"><Textarea value={note} onChange={(e) => setNote(e.target.value)} /></Field>
          <div className="space-y-2 text-sm">
            <div className="flex justify-between"><span>Subtotal</span><span>{money(subtotal)}</span></div>
            <div className="flex justify-between"><span>Discount</span><span>−{money(discount)}</span></div>
            <div className="flex items-center justify-between gap-2"><span>Tax %</span><NumberInput className="w-24 text-right" value={taxRate} onChange={setTaxRate} /></div>
            <div className="flex justify-between"><span>Tax</span><span>{money(tax)}</span></div>
            <div className="flex justify-between border-t pt-2 text-base font-semibold"><span>Total</span><span>{money(total)}</span></div>
          </div>
        </div>
        {kind === "invoice" && app.can("customer_payments.manage") && (
          <div className="mt-4 flex flex-wrap items-center gap-3 rounded-md border border-ink-200 p-3">
            <Checkbox checked={payNow} onChange={setPayNow}>Customer pays in full now</Checkbox>
            {payNow && (
              <>
                <Select className="w-56" value={payAccount} onChange={(e) => setPayAccount(e.target.value)} options={cash.map((a) => ({ value: a._id, label: a.name }))} />
                <Select className="w-44" value={payMethod} onChange={(e) => setPayMethod(e.target.value)} options={[{ value: "cash", label: "Cash" }, { value: "mobile_money", label: "Mobile money" }, { value: "bank_transfer", label: "Bank transfer" }, { value: "cheque", label: "Cheque" }]} />
              </>
            )}
          </div>
        )}
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button className="btn-secondary" disabled={busy || !customerId} onClick={submit("draft")}>Save draft</button>
          {kind === "quotation" && <button className="btn-primary" disabled={busy || !customerId} onClick={submit("send")}>Save & mark sent</button>}
          {kind === "order" && <button className="btn-primary" disabled={busy || !customerId} onClick={submit("confirm")}>Confirm order</button>}
          {kind === "invoice" && <button className="btn-primary" disabled={busy || !customerId} onClick={submit("post")}>Post invoice</button>}
        </div>
      </Card>
    </div>
  );
}

export function SalesView() {
  const { id } = useParams();
  const app = useApp();
  const navigate = useNavigate();
  const doc = useQuery(api.sales.get, { id });
  const convert = useMutation(api.sales.convert);
  const setStatus = useMutation(api.sales.setStatus);
  const postDraft = useMutation(api.sales.postDraftInvoice);
  const voidInvoice = useMutation(api.sales.voidInvoice);
  const [run, busy] = useRun();
  const [ask, prompt] = usePrompt();
  const [paying, setPaying] = useState(false);
  if (doc === undefined) return <Loading />;
  if (doc === null) return <div>Not found.</div>;
  const can = app.can("sales.create");

  const print = () =>
    printDocument({
      company: app.company,
      title: SINGULAR[doc.kind],
      number: doc.number,
      docDate: doc.date,
      partyTitle: "Bill to",
      party: [doc.customerName, doc.customer?.address, doc.customer?.phone].filter(Boolean),
      meta: [
        ...(doc.kind === "invoice" ? [["Due date", date(doc.dueDate)]] : []),
        ...(doc.kind === "quotation" ? [["Valid until", date(doc.validUntil)]] : []),
        ["Store", doc.storeName],
      ],
      columns: [
        { header: "Part", value: (l) => l.sku },
        { header: "Description", value: (l) => l.description },
        { header: "Qty", value: (l) => num(l.qty), align: "right" },
        { header: "Unit price", value: (l) => money(l.unitPrice), align: "right" },
        { header: "Discount", value: (l) => (l.discount ? money(l.discount) : ""), align: "right" },
        { header: "Amount", value: (l) => money(l.qty * l.unitPrice - l.discount), align: "right" },
      ],
      rows: doc.lines,
      totals: [
        ["Subtotal", money(doc.subtotal)],
        ...(doc.discountTotal ? [["Discount", `−${money(doc.discountTotal)}`]] : []),
        [`Tax (${doc.taxRate}%)`, money(doc.taxAmount)],
        ["Total", money(doc.total), true],
        ...(doc.kind === "invoice" && doc.amountPaid ? [["Paid", money(doc.amountPaid)], ["Balance due", money(doc.balanceDue), true]] : []),
      ],
      notes: doc.note,
    });

  const go = async (fn, msg) => {
    const r = await run(fn, msg);
    if (r.ok && typeof r.res === "string") navigate(`/sales/doc/${r.res}`);
  };

  return (
    <div>
      {prompt}
      <PageHeader
        title={`${SINGULAR[doc.kind]} ${doc.number}`}
        subtitle={`${doc.customerName} · ${doc.storeName} · ${date(doc.date)} · by ${doc.createdByName}`}
        actions={
          <>
            <button className="btn-secondary" onClick={() => navigate(-1)}>Back</button>
            <button className="btn-secondary" onClick={print}>Print / PDF</button>
            {can && ["draft", "sent"].includes(doc.status) && doc.kind !== "credit_note" && <Link className="btn-secondary" to={`/sales/doc/${doc._id}/edit`}>Edit</Link>}
            {can && doc.kind === "quotation" && !doc.convertedToId && ["draft", "sent", "accepted"].includes(doc.status) && (
              <>
                {doc.status !== "accepted" && <button className="btn-secondary" disabled={busy} onClick={() => run(() => setStatus({ id: doc._id, status: "accepted" }), "Marked accepted")}>Mark accepted</button>}
                <button className="btn-secondary" disabled={busy} onClick={() => go(() => convert({ id: doc._id, to: "order" }), "Sales order created")}>Convert to order</button>
                <button className="btn-primary" disabled={busy} onClick={() => go(() => convert({ id: doc._id, to: "invoice" }), "Invoice posted")}>Convert to invoice</button>
              </>
            )}
            {can && doc.kind === "order" && doc.status === "draft" && <button className="btn-primary" disabled={busy} onClick={() => run(() => setStatus({ id: doc._id, status: "confirmed" }), "Order confirmed — stock reserved")}>Confirm order</button>}
            {can && doc.kind === "order" && doc.status === "confirmed" && <button className="btn-primary" disabled={busy} onClick={() => go(() => convert({ id: doc._id, to: "invoice" }), "Invoice posted")}>Create invoice</button>}
            {can && doc.kind === "order" && ["draft", "confirmed"].includes(doc.status) && <button className="btn-ghost text-red-600" disabled={busy} onClick={() => run(() => setStatus({ id: doc._id, status: "cancelled" }), "Order cancelled")}>Cancel order</button>}
            {can && doc.kind === "invoice" && doc.status === "draft" && <button className="btn-primary" disabled={busy} onClick={() => run(() => postDraft({ id: doc._id }), "Invoice posted")}>Post invoice</button>}
            {doc.kind === "invoice" && ["open", "partial"].includes(doc.status) && app.can("customer_payments.manage") && <button className="btn-primary" onClick={() => setPaying(true)}>Record payment</button>}
            {doc.kind === "invoice" && doc.status !== "void" && doc.amountPaid === 0 && app.can("credit.override") && (
              <button className="btn-ghost text-red-600" disabled={busy} onClick={async () => { const r = await ask(`Void ${doc.number}`); if (r) run(() => voidInvoice({ id: doc._id, reason: r }), "Invoice voided"); }}>Void</button>
            )}
          </>
        }
      />
      <div className="mb-4 flex flex-wrap items-center gap-3 text-sm">
        <Badge>{doc.overdue ? "overdue" : doc.status}</Badge>
        {doc.sourceNumber && <span className="text-ink-500">From {doc.sourceNumber}</span>}
        {doc.convertedNumber && <Link className="link" to={`/sales/doc/${doc.convertedToId}`}>→ {doc.convertedNumber}</Link>}
        {doc.creditApprovedBy && <Badge color="amber">Credit override approved</Badge>}
        {doc.kind === "invoice" && <span className="text-ink-500">Due {date(doc.dueDate)}</span>}
      </div>
      <Card bodyClass="p-0">
        <table className="table">
          <thead><tr><th>Part</th><th>Description</th><th className="text-right">Qty</th><th className="text-right">Unit price</th><th className="text-right">Discount</th><th className="text-right">Amount</th>{app.can("accounting.view") && doc.kind === "invoice" && <th className="text-right">Cost</th>}</tr></thead>
          <tbody>
            {doc.lines.map((l, i) => (
              <tr key={i}>
                <td className="font-medium">{l.sku}</td><td>{l.description}</td><td className="num">{num(l.qty)}</td><td className="num">{money(l.unitPrice)}</td><td className="num">{l.discount ? money(l.discount) : ""}</td><td className="num">{money(l.qty * l.unitPrice - l.discount)}</td>
                {app.can("accounting.view") && doc.kind === "invoice" && <td className="num text-ink-500">{l.unitCost !== undefined ? money(l.unitCost * l.qty) : ""}</td>}
              </tr>
            ))}
          </tbody>
        </table>
        <div className="ml-auto w-full max-w-xs space-y-1 p-4 text-sm">
          <div className="flex justify-between"><span>Subtotal</span><span>{money(doc.subtotal)}</span></div>
          {doc.discountTotal > 0 && <div className="flex justify-between"><span>Discount</span><span>−{money(doc.discountTotal)}</span></div>}
          <div className="flex justify-between"><span>Tax ({doc.taxRate}%)</span><span>{money(doc.taxAmount)}</span></div>
          <div className="flex justify-between border-t pt-2 text-base font-semibold"><span>Total</span><span>{money(doc.total)}</span></div>
          {(doc.kind === "invoice" || doc.kind === "credit_note") && (
            <>
              <div className="flex justify-between text-ink-600"><span>{doc.kind === "invoice" ? "Paid / credited" : "Applied / refunded"}</span><span>{money(doc.amountPaid)}</span></div>
              <div className="flex justify-between font-semibold"><span>Balance</span><span>{money(doc.balanceDue)}</span></div>
            </>
          )}
        </div>
      </Card>
      {doc.note && <Card title="Notes" className="mt-5"><p className="whitespace-pre-line text-sm">{doc.note}</p></Card>}
      <PaymentForm open={paying} onClose={() => setPaying(false)} partyType="customer" partyId={doc.customerId} />
    </div>
  );
}

// ═════════════ Credit notes & returns ═════════════
function CreditNoteForm({ open, onClose }) {
  const app = useApp();
  const create = useMutation(api.sales.createCreditNote);
  const customers = useQuery(api.parties.customers, {}) ?? [];
  const [run, busy] = useRun();
  const [customerId, setCustomerId] = useState("");
  const [invoiceId, setInvoiceId] = useState("");
  const [storeId, setStoreId] = useState(app.defaultStoreId);
  const [returnsStock, setReturnsStock] = useState(true);
  const [reason, setReason] = useState("");
  const [taxRate, setTaxRate] = useState(app.company?.defaultTaxRate ?? 0);
  const [lines, setLines] = useState([{ productId: "" }]);
  const invoices = useQuery(api.sales.list, customerId ? { kind: "invoice", customerId } : "skip");
  const invoice = useQuery(api.sales.get, invoiceId ? { id: invoiceId } : "skip");
  const options = useQuery(api.products.options, storeId ? { storeId } : "skip");
  useEffect(() => {
    if (open) {
      setCustomerId("");
      setInvoiceId("");
      setReason("");
      setLines([{ productId: "" }]);
    }
  }, [open]);
  useEffect(() => {
    if (invoice) {
      setStoreId(invoice.storeId);
      setTaxRate(invoice.taxRate);
      setLines(invoice.lines.map((l) => ({ productId: l.productId, description: l.description, qty: l.qty, unitPrice: l.unitPrice, discount: l.discount })));
    }
  }, [invoice?._id]); // eslint-disable-line
  return (
    <Modal
      open={open}
      onClose={onClose}
      wide
      title="New credit note / sales return"
      footer={
        <>
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button
            className="btn-primary"
            disabled={busy || !customerId || !reason.trim()}
            onClick={async () => (await run(() => create({ invoiceId: invoiceId || undefined, customerId, storeId, date: Date.now(), returnsStock, reason, taxRate: Number(taxRate) || 0, lines: cleanLines(lines, ["description", "qty", "unitPrice", "discount"]) }), "Credit note posted")).ok && onClose()}
          >
            Post credit note
          </button>
        </>
      }
    >
      <div className="mb-4 grid grid-cols-1 gap-4 md:grid-cols-4">
        <Field label="Customer"><Select value={customerId} onChange={(e) => { setCustomerId(e.target.value); setInvoiceId(""); }} placeholder="Choose…" options={customers.map((c) => ({ value: c._id, label: c.name }))} /></Field>
        <Field label="Against invoice"><Select value={invoiceId} onChange={(e) => setInvoiceId(e.target.value)} placeholder="(none)" options={(invoices ?? []).filter((i) => i.status !== "void" && i.status !== "draft").map((i) => ({ value: i._id, label: `${i.number} · ${money(i.total)}` }))} /></Field>
        <Field label="Return to store"><Select value={storeId} onChange={(e) => setStoreId(e.target.value)} options={app.stores.map((s) => ({ value: s._id, label: s.name }))} /></Field>
        <Field label="Tax %"><NumberInput value={taxRate} onChange={setTaxRate} /></Field>
        <Field label="Reason *" className="md:col-span-3"><Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Wrong part, defective, price adjustment…" /></Field>
        <div className="flex items-end pb-2"><Checkbox checked={returnsStock} onChange={setReturnsStock}>Goods returned to stock</Checkbox></div>
      </div>
      <LineEditor
        lines={lines}
        setLines={setLines}
        options={options}
        showDescription
        fields={[{ key: "qty", label: "Qty" }, { key: "unitPrice", label: "Unit price" }, { key: "discount", label: "Discount" }]}
        onPick={(p) => ({ qty: 1, unitPrice: p.retailPrice, discount: 0 })}
        amount={(l) => (Number(l.qty) || 0) * (Number(l.unitPrice) || 0) - (Number(l.discount) || 0)}
      />
    </Modal>
  );
}

function ApplyCreditModal({ cn, onClose }) {
  const app = useApp();
  const apply = useMutation(api.sales.applyCredit);
  const refund = useMutation(api.payments.refundCustomer);
  const invoices = useQuery(api.sales.list, cn ? { kind: "invoice", customerId: cn.customerId } : "skip");
  const cash = useQuery(api.accounting.cashAccounts) ?? [];
  const [run, busy] = useRun();
  const [invoiceId, setInvoiceId] = useState("");
  const [amount, setAmount] = useState(0);
  const [accountId, setAccountId] = useState("");
  useEffect(() => {
    if (cn) {
      setAmount(cn.balanceDue);
      setInvoiceId("");
    }
  }, [cn]);
  if (!cn) return null;
  const open = (invoices ?? []).filter((i) => i.status === "open" || i.status === "partial");
  return (
    <Modal open onClose={onClose} title={`Use credit ${cn.number} (${money(cn.balanceDue)} available)`}>
      <div className="space-y-5">
        <div>
          <div className="label">Apply to an open invoice</div>
          <div className="flex gap-2">
            <Select value={invoiceId} onChange={(e) => setInvoiceId(e.target.value)} placeholder="Choose invoice…" options={open.map((i) => ({ value: i._id, label: `${i.number} · due ${money(i.balanceDue)}` }))} />
            <NumberInput className="w-32" value={amount} onChange={setAmount} />
            <button className="btn-primary" disabled={busy || !invoiceId} onClick={async () => (await run(() => apply({ creditNoteId: cn._id, invoiceId, amount: Number(amount) }), "Credit applied")).ok && onClose()}>Apply</button>
          </div>
        </div>
        {app.can("credit.override") && (
          <div>
            <div className="label">Or refund cash to the customer</div>
            <div className="flex gap-2">
              <Select value={accountId} onChange={(e) => setAccountId(e.target.value)} placeholder="Pay from…" options={cash.map((a) => ({ value: a._id, label: a.name }))} />
              <NumberInput className="w-32" value={amount} onChange={setAmount} />
              <button className="btn-secondary" disabled={busy || !accountId} onClick={async () => (await run(() => refund({ creditNoteId: cn._id, date: Date.now(), amount: Number(amount), accountId, method: "cash" }), "Refund recorded")).ok && onClose()}>Refund</button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

export function CreditNotes() {
  const app = useApp();
  const navigate = useNavigate();
  const rows = useQuery(api.sales.list, { kind: "credit_note" });
  const [creating, setCreating] = useState(false);
  const [using, setUsing] = useState(null);
  return (
    <div>
      <PageHeader
        title="Credit Notes & Returns"
        subtitle="Returned goods go back to stock at their original cost"
        actions={app.can("sales.create") && (app.can("credit.override") || app.can("sales.discount")) && <button className="btn-primary" onClick={() => setCreating(true)}>+ New credit note</button>}
      />
      <Card bodyClass="p-0">
        <DataTable
          rows={rows}
          exportName="credit-notes"
          onRowClick={(r) => navigate(`/sales/doc/${r._id}`)}
          columns={[
            { key: "number", header: "Number", render: (r) => <span className="font-medium">{r.number}</span> },
            { key: "date", header: "Date", render: (r) => date(r.date) },
            { key: "customerName", header: "Customer" },
            { key: "note", header: "Reason" },
            { key: "returnsStock", header: "Stock", render: (r) => (r.returnsStock ? "Returned" : "—") },
            { key: "total", header: "Total", align: "right", render: (r) => money(r.total) },
            { key: "balanceDue", header: "Unused", align: "right", render: (r) => money(r.balanceDue) },
            { key: "status", header: "Status", render: (r) => <Badge>{r.status}</Badge> },
            { key: "x", header: "", render: (r) => (r.status === "open" && r.balanceDue > 0 && app.can("customer_payments.manage") ? <button className="btn-secondary btn-sm" onClick={(e) => { e.stopPropagation(); setUsing(r); }}>Apply / refund</button> : null) },
          ]}
        />
      </Card>
      <CreditNoteForm open={creating} onClose={() => setCreating(false)} />
      <ApplyCreditModal cn={using} onClose={() => setUsing(null)} />
    </div>
  );
}

export function CustomerPayments() {
  const app = useApp();
  const [paying, setPaying] = useState(false);
  return (
    <div>
      <PageHeader title="Customer Payments" subtitle="Receipts allocated to invoices" actions={app.can("customer_payments.manage") && <button className="btn-primary" onClick={() => setPaying(true)}>+ Receive payment</button>} />
      <PaymentsTable partyType="customer" />
      <PaymentForm open={paying} onClose={() => setPaying(false)} partyType="customer" />
    </div>
  );
}
