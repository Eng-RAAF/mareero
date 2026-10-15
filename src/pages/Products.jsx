import { useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery } from "../lib/convex";
import { api } from "../../convex/_generated/api";
import { useApp } from "../lib/app";
import { Badge, Card, DataTable, Field, Input, Loading, Modal, NumberInput, PageHeader, Select, Tabs, Textarea, useRun } from "../components/ui";
import { date, dateTime, label, money, num, parseCsv } from "../lib/format";

const EMPTY = {
  sku: "", name: "", description: "", barcode: "", partNumber: "", brandId: "", categoryId: "",
  vehicleMake: "", vehicleModel: "", yearFrom: "", yearTo: "", engine: "", unit: "pcs",
  purchaseCost: 0, retailPrice: 0, wholesalePrice: 0, preferredSupplierId: "", status: "active",
};

export function ProductForm({ open, onClose, product }) {
  const save = useMutation(api.products.save);
  const categories = useQuery(api.products.categories) ?? [];
  const brands = useQuery(api.products.brands) ?? [];
  const suppliers = useQuery(api.parties.suppliers, {}) ?? [];
  const [run, busy] = useRun();
  const [f, setF] = useState(EMPTY);
  useEffect(() => {
    if (open) setF(product ? { ...EMPTY, ...product, yearFrom: product.yearFrom ?? "", yearTo: product.yearTo ?? "" } : EMPTY);
  }, [open, product]);
  const set = (k) => (e) => setF({ ...f, [k]: e?.target ? e.target.value : e });

  const submit = async () => {
    const opt = (s) => (s ? s : undefined);
    const res = await run(
      () =>
        save({
          id: product?._id,
          sku: f.sku,
          name: f.name,
          description: opt(f.description),
          barcode: opt(f.barcode),
          partNumber: opt(f.partNumber),
          brandId: opt(f.brandId),
          categoryId: opt(f.categoryId),
          vehicleMake: opt(f.vehicleMake),
          vehicleModel: opt(f.vehicleModel),
          yearFrom: f.yearFrom === "" ? undefined : Number(f.yearFrom),
          yearTo: f.yearTo === "" ? undefined : Number(f.yearTo),
          engine: opt(f.engine),
          unit: f.unit || "pcs",
          purchaseCost: Number(f.purchaseCost) || 0,
          retailPrice: Number(f.retailPrice) || 0,
          wholesalePrice: Number(f.wholesalePrice) || 0,
          preferredSupplierId: opt(f.preferredSupplierId),
          status: f.status,
        }),
      product ? "Product updated" : "Product created",
    );
    if (res.ok) onClose();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      wide
      title={product ? `Edit ${product.sku}` : "New product"}
      footer={
        <>
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={busy || !f.sku || !f.name} onClick={submit}>Save</button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
        <Field label="SKU *"><Input value={f.sku} onChange={set("sku")} /></Field>
        <Field label="Name *" className="md:col-span-2"><Input value={f.name} onChange={set("name")} /></Field>
        <Field label="Status"><Select value={f.status} onChange={set("status")} options={[{ value: "active", label: "Active" }, { value: "inactive", label: "Inactive" }]} /></Field>
        <Field label="Manufacturer part no." hint="Not assumed unique across brands"><Input value={f.partNumber} onChange={set("partNumber")} /></Field>
        <Field label="Barcode"><Input value={f.barcode} onChange={set("barcode")} /></Field>
        <Field label="Brand"><Select value={f.brandId} onChange={set("brandId")} placeholder="—" options={brands.map((b) => ({ value: b._id, label: b.name }))} /></Field>
        <Field label="Category"><Select value={f.categoryId} onChange={set("categoryId")} placeholder="—" options={categories.map((c) => ({ value: c._id, label: c.name }))} /></Field>
        <Field label="Vehicle make"><Input value={f.vehicleMake} onChange={set("vehicleMake")} placeholder="Toyota" /></Field>
        <Field label="Vehicle model"><Input value={f.vehicleModel} onChange={set("vehicleModel")} placeholder="Hilux" /></Field>
        <Field label="Year from"><Input type="number" value={f.yearFrom} onChange={set("yearFrom")} /></Field>
        <Field label="Year to"><Input type="number" value={f.yearTo} onChange={set("yearTo")} /></Field>
        <Field label="Engine / compatibility"><Input value={f.engine} onChange={set("engine")} placeholder="2KD-FTV" /></Field>
        <Field label="Unit"><Input value={f.unit} onChange={set("unit")} /></Field>
        <Field label="Preferred supplier" className="md:col-span-2"><Select value={f.preferredSupplierId} onChange={set("preferredSupplierId")} placeholder="—" options={suppliers.map((s) => ({ value: s._id, label: s.name }))} /></Field>
        <Field label="Purchase cost"><NumberInput value={f.purchaseCost} onChange={set("purchaseCost")} /></Field>
        <Field label="Retail price"><NumberInput value={f.retailPrice} onChange={set("retailPrice")} /></Field>
        <Field label="Wholesale price"><NumberInput value={f.wholesalePrice} onChange={set("wholesalePrice")} /></Field>
        <Field label="Description" className="md:col-span-4"><Textarea value={f.description} onChange={set("description")} /></Field>
      </div>
    </Modal>
  );
}

function ImportModal({ open, onClose }) {
  const importRows = useMutation(api.products.importRows);
  const [rows, setRows] = useState([]);
  const [run, busy] = useRun();
  const onFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    setRows(parseCsv(text));
  };
  const n = (v) => (v === undefined || v === "" ? undefined : Number(v));
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Import products from CSV"
      footer={
        <>
          <button className="btn-secondary" onClick={onClose}>Close</button>
          <button
            className="btn-primary"
            disabled={busy || rows.length === 0}
            onClick={async () => {
              for (let i = 0; i < rows.length; i += 400) {
                const chunk = rows.slice(i, i + 400).map((r) => ({
                  sku: r.sku ?? r.SKU ?? "",
                  name: r.name ?? r.Name ?? "",
                  partNumber: r.partNumber || undefined,
                  barcode: r.barcode || undefined,
                  brand: r.brand || undefined,
                  category: r.category || undefined,
                  vehicleMake: r.vehicleMake || undefined,
                  vehicleModel: r.vehicleModel || undefined,
                  unit: r.unit || undefined,
                  purchaseCost: n(r.purchaseCost),
                  retailPrice: n(r.retailPrice),
                  wholesalePrice: n(r.wholesalePrice),
                }));
                const res = await run(() => importRows({ rows: chunk }), `Imported rows ${i + 1}–${i + chunk.length}`);
                if (!res.ok) return;
              }
              setRows([]);
              onClose();
            }}
          >
            Import {rows.length || ""} rows
          </button>
        </>
      }
    >
      <p className="text-sm text-ink-600">
        Columns: <code className="text-xs">sku, name, partNumber, barcode, brand, category, vehicleMake, vehicleModel, unit, purchaseCost, retailPrice, wholesalePrice</code>.
        Existing SKUs are updated. Opening stock is entered separately under Counts &amp; Adjustments → Opening stock.
      </p>
      <input type="file" accept=".csv,text/csv" className="mt-4 text-sm" onChange={onFile} />
      {rows.length > 0 && <div className="mt-3 text-sm text-ink-700">{rows.length} rows ready. First: {rows[0].sku} — {rows[0].name}</div>}
    </Modal>
  );
}

function NameList({ title, rows, onSave }) {
  const [name, setName] = useState("");
  const [run, busy] = useRun();
  return (
    <Card title={title} bodyClass="p-0">
      <form
        className="flex gap-2 border-b border-ink-100 p-3"
        onSubmit={async (e) => {
          e.preventDefault();
          const r = await run(() => onSave({ name }), `${title.slice(0, -1)} added`);
          if (r.ok) setName("");
        }}
      >
        <Input placeholder={`New ${title.toLowerCase().slice(0, -1)}`} value={name} onChange={(e) => setName(e.target.value)} />
        <button className="btn-primary" disabled={busy || !name.trim()}>Add</button>
      </form>
      <ul className="max-h-96 divide-y divide-ink-100 overflow-y-auto">
        {(rows ?? []).map((r) => (
          <li key={r._id} className="px-4 py-2 text-sm">{r.name}</li>
        ))}
      </ul>
    </Card>
  );
}

export function Products() {
  const app = useApp();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [tab, setTab] = useState("products");
  const [search, setSearch] = useState(params.get("q") ?? "");
  const [categoryId, setCategoryId] = useState("");
  const [editing, setEditing] = useState(null);
  const [importing, setImporting] = useState(false);
  useEffect(() => setSearch(params.get("q") ?? ""), [params]);
  const products = useQuery(api.products.list, {
    search: search || undefined,
    categoryId: categoryId || undefined,
    storeId: app.storeId,
    includeInactive: true,
  });
  const categories = useQuery(api.products.categories);
  const brands = useQuery(api.products.brands);
  const saveCategory = useMutation(api.products.saveCategory);
  const saveBrand = useMutation(api.products.saveBrand);
  const canManage = app.can("products.manage");

  return (
    <div>
      <PageHeader
        title="Products & Categories"
        subtitle="Shared catalogue for every branch and store"
        actions={
          canManage && (
            <>
              <button className="btn-secondary" onClick={() => setImporting(true)}>Import CSV</button>
              <button className="btn-primary" onClick={() => setEditing({})}>+ New product</button>
            </>
          )
        }
      />
      <Tabs value={tab} onChange={setTab} tabs={[{ value: "products", label: "Products", count: products?.length }, { value: "categories", label: "Categories & brands" }]} />
      {tab === "products" ? (
        <Card bodyClass="p-0">
          <div className="flex flex-wrap gap-2 border-b border-ink-100 p-3">
            <Input
              className="max-w-sm"
              placeholder="Search name, SKU, part no., barcode, vehicle…"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setParams(e.target.value ? { q: e.target.value } : {});
              }}
            />
            <Select className="w-48" value={categoryId} onChange={(e) => setCategoryId(e.target.value)} placeholder="All categories" options={(categories ?? []).map((c) => ({ value: c._id, label: c.name }))} />
          </div>
          <DataTable
            search={false}
            rows={products}
            exportName="products"
            onRowClick={(r) => navigate(`/products/${r._id}`)}
            columns={[
              { key: "sku", header: "SKU", render: (r) => <span className="font-medium text-ink-900">{r.sku}</span> },
              { key: "name", header: "Name" },
              { key: "partNumber", header: "Part no." },
              { key: "brand", header: "Brand" },
              { key: "category", header: "Category" },
              { key: "fitment", header: "Fits", value: (r) => [r.vehicleMake, r.vehicleModel].filter(Boolean).join(" ") },
              { key: "onHand", header: app.storeId ? "On hand (store)" : "On hand", align: "right", render: (r) => num(r.onHand) },
              { key: "available", header: "Available", align: "right", render: (r) => num(r.available) },
              { key: "retailPrice", header: "Retail", align: "right", render: (r) => money(r.retailPrice) },
              { key: "wholesalePrice", header: "Wholesale", align: "right", render: (r) => money(r.wholesalePrice) },
              { key: "status", header: "Status", render: (r) => <Badge>{r.status}</Badge> },
              ...(canManage
                ? [{ key: "edit", header: "", render: (r) => <button className="btn-ghost btn-sm" onClick={(e) => { e.stopPropagation(); setEditing(r); }}>Edit</button> }]
                : []),
            ]}
          />
        </Card>
      ) : (
        <div className="grid gap-5 md:grid-cols-2">
          <NameList title="Categories" rows={categories} onSave={canManage ? saveCategory : async () => { throw new Error("No permission"); }} />
          <NameList title="Brands" rows={brands} onSave={canManage ? saveBrand : async () => { throw new Error("No permission"); }} />
        </div>
      )}
      <ProductForm open={!!editing} product={editing?._id ? editing : null} onClose={() => setEditing(null)} />
      <ImportModal open={importing} onClose={() => setImporting(false)} />
    </div>
  );
}

export function ProductDetail() {
  const { id } = useParams();
  const app = useApp();
  const data = useQuery(api.products.get, { id });
  const prices = useQuery(api.reports.priceHistory, app.can("purchasing.view") ? { productId: id } : "skip");
  const [editing, setEditing] = useState(false);
  if (data === undefined) return <Loading />;
  if (data === null) return <div>Product not found.</div>;
  const p = data.product;
  return (
    <div>
      <PageHeader
        title={`${p.sku} — ${p.name}`}
        subtitle={[p.partNumber && `Part no. ${p.partNumber}`, p.vehicleMake && `${p.vehicleMake} ${p.vehicleModel ?? ""}`, p.yearFrom && `${p.yearFrom}–${p.yearTo ?? ""}`, p.engine].filter(Boolean).join(" · ")}
        actions={
          <>
            <Link to="/products" className="btn-secondary">Back</Link>
            {app.can("products.manage") && <button className="btn-primary" onClick={() => setEditing(true)}>Edit</button>}
          </>
        }
      />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <div className="card p-4"><div className="label">Purchase cost</div><div className="text-lg font-semibold">{money(p.purchaseCost)}</div></div>
        <div className="card p-4"><div className="label">Retail price</div><div className="text-lg font-semibold">{money(p.retailPrice)}</div></div>
        <div className="card p-4"><div className="label">Wholesale price</div><div className="text-lg font-semibold">{money(p.wholesalePrice)}</div></div>
        <div className="card p-4"><div className="label">Total on hand</div><div className="text-lg font-semibold">{num(data.balances.reduce((a, b) => a + b.onHand, 0))} {p.unit}</div></div>
      </div>
      <Card title="Stock by store" className="mt-5" bodyClass="p-0">
        <DataTable
          search={false}
          rows={data.balances}
          columns={[
            { key: "branchName", header: "Branch" },
            { key: "storeName", header: "Store" },
            { key: "onHand", header: "On hand", align: "right", render: (r) => num(r.onHand) },
            { key: "reserved", header: "Reserved", align: "right", render: (r) => num(r.reserved) },
            { key: "incoming", header: "Incoming", align: "right", render: (r) => num(r.incoming) },
            { key: "inTransitOut", header: "In transit out", align: "right", render: (r) => num(r.inTransitOut) },
            { key: "avgCost", header: "Avg cost", align: "right", render: (r) => money(r.avgCost) },
            { key: "rp", header: "Reorder point", align: "right", value: (r) => r.reorder?.reorderPoint ?? "—" },
          ]}
          empty="No stock recorded in any store yet."
        />
      </Card>
      <div className="mt-5 grid gap-5 xl:grid-cols-3">
        <Card title="Movement history" className="xl:col-span-2" bodyClass="p-0">
          <DataTable
            rows={data.movements}
            exportName={`${p.sku}-movements`}
            columns={[
              { key: "date", header: "Date", render: (r) => dateTime(r.date), csv: (r) => new Date(r.date).toISOString() },
              { key: "storeName", header: "Store" },
              { key: "type", header: "Type", render: (r) => label(r.type) },
              { key: "reference", header: "Reference" },
              { key: "quantity", header: "Qty", align: "right", render: (r) => <span className={r.quantity < 0 ? "text-red-600" : "text-brand-700"}>{r.quantity > 0 ? "+" : ""}{num(r.quantity)}</span> },
              { key: "unitCost", header: "Unit cost", align: "right", render: (r) => money(r.unitCost) },
              { key: "balanceAfter", header: "Balance", align: "right", render: (r) => num(r.balanceAfter) },
            ]}
          />
        </Card>
        <Card title="Purchase price history" bodyClass="p-0">
          <DataTable
            search={false}
            rows={prices ?? []}
            columns={[
              { key: "date", header: "Date", render: (r) => date(r.date) },
              { key: "supplier", header: "Supplier" },
              { key: "qty", header: "Qty", align: "right" },
              { key: "unitCost", header: "Unit cost", align: "right", render: (r) => money(r.unitCost) },
            ]}
            empty="No receipts yet."
          />
        </Card>
      </div>
      <ProductForm open={editing} product={p} onClose={() => setEditing(false)} />
    </div>
  );
}
