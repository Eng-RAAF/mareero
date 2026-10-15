import { useMemo, useRef, useState, useEffect } from "react";
import { money, num } from "../lib/format";

/** Searchable product picker. options: products.options query rows. */
export function ProductPicker({ options, value, onChange, placeholder = "Search part…", autoFocus }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const selected = options?.find((o) => o._id === value);

  useEffect(() => {
    const close = (e) => ref.current && !ref.current.contains(e.target) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  const matches = useMemo(() => {
    if (!options) return [];
    const s = q.trim().toLowerCase();
    const list = s
      ? options.filter((o) => `${o.sku} ${o.name} ${o.partNumber} ${o.barcode}`.toLowerCase().includes(s))
      : options;
    return list.slice(0, 40);
  }, [options, q]);

  return (
    <div ref={ref} className="relative">
      <input
        autoFocus={autoFocus}
        className="input input-sm"
        placeholder={placeholder}
        value={open ? q : selected ? `${selected.sku} — ${selected.name}` : ""}
        onFocus={() => {
          setOpen(true);
          setQ("");
        }}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            // Barcode scanners type the code then Enter: pick exact barcode/SKU match first
            const exact = options?.find((o) => o.barcode === q.trim() || o.sku.toLowerCase() === q.trim().toLowerCase());
            const pick = exact ?? matches[0];
            if (pick) {
              onChange(pick);
              setOpen(false);
            }
          }
        }}
      />
      {open && (
        <div className="absolute z-40 mt-1 max-h-72 w-[28rem] max-w-[90vw] overflow-y-auto rounded-md border border-ink-200 bg-white shadow-lg">
          {matches.length === 0 && <div className="px-3 py-2 text-sm text-ink-400">No matching parts</div>}
          {matches.map((o) => (
            <button
              type="button"
              key={o._id}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                onChange(o);
                setOpen(false);
              }}
              className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-brand-50"
            >
              <span>
                <span className="font-medium text-ink-800">{o.sku}</span> <span className="text-ink-600">{o.name}</span>
                {o.partNumber && <span className="ml-1 text-xs text-ink-400">({o.partNumber})</span>}
              </span>
              <span className="whitespace-nowrap text-xs text-ink-500">Avail {num(o.available)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Editable document lines.
 * fields: [{ key, label, width?, readOnly? }] numeric fields shown after the product column.
 * onPick(product) → initial values for a line when a product is chosen.
 * amount(line) → optional line total.
 */
export function LineEditor({ lines, setLines, options, fields, onPick, amount, showDescription = false, showAvailable = true }) {
  const update = (i, patch) => setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const remove = (i) => setLines(lines.filter((_, j) => j !== i));
  const add = () => setLines([...lines, { productId: "", description: "" }]);
  const total = amount ? lines.reduce((a, l) => a + (l.productId ? amount(l) : 0), 0) : null;

  return (
    <div className="overflow-x-auto rounded-md border border-ink-200">
      <table className="table">
        <thead>
          <tr>
            <th className="w-8">#</th>
            <th className="min-w-[16rem]">Part</th>
            {showDescription && <th className="min-w-[12rem]">Description</th>}
            {fields.map((f) => (
              <th key={f.key} className="text-right" style={{ width: f.width ?? "7rem" }}>
                {f.label}
              </th>
            ))}
            {amount && <th className="w-28 text-right">Amount</th>}
            <th className="w-8" />
          </tr>
        </thead>
        <tbody>
          {lines.map((l, i) => {
            const p = options?.find((o) => o._id === l.productId);
            return (
              <tr key={i}>
                <td className="pt-3 text-ink-400">{i + 1}</td>
                <td>
                  <ProductPicker
                    options={options}
                    value={l.productId}
                    onChange={(prod) => update(i, { productId: prod._id, description: prod.name, ...(onPick ? onPick(prod) : {}) })}
                  />
                  {showAvailable && p && (
                    <div className="mt-1 text-xs text-ink-400">
                      On hand {num(p.onHand)} · Available {num(p.available)} · Avg cost {money(p.avgCost)}
                    </div>
                  )}
                </td>
                {showDescription && (
                  <td>
                    <input className="input input-sm" value={l.description ?? ""} onChange={(e) => update(i, { description: e.target.value })} />
                  </td>
                )}
                {fields.map((f) => (
                  <td key={f.key}>
                    <input
                      type="number"
                      step="any"
                      readOnly={f.readOnly}
                      className="input input-sm text-right"
                      value={l[f.key] ?? ""}
                      onChange={(e) => update(i, { [f.key]: e.target.value === "" ? "" : Number(e.target.value) })}
                    />
                  </td>
                ))}
                {amount && <td className="num pt-3">{l.productId ? money(amount(l)) : ""}</td>}
                <td className="pt-2">
                  <button type="button" className="btn-ghost btn-sm text-red-600" onClick={() => remove(i)} aria-label="Remove line">
                    ✕
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={2 + (showDescription ? 1 : 0) + fields.length} className="px-3 py-2">
              <button type="button" className="btn-secondary btn-sm" onClick={add}>
                + Add line
              </button>
            </td>
            {amount && <td className="num px-3 py-2 font-semibold">{money(total)}</td>}
            <td />
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

/** Strip empty lines and coerce numbers before sending to the server. */
export function cleanLines(lines, keys) {
  return lines
    .filter((l) => l.productId)
    .map((l) => {
      const out = { productId: l.productId };
      for (const k of keys) {
        if (k === "description") out.description = l.description ?? "";
        else out[k] = Number(l[k] ?? 0) || 0;
      }
      return out;
    });
}
