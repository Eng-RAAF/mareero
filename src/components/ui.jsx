import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { downloadCsv, errMsg, label } from "../lib/format";
import { useOffline } from "../lib/convex";

// ───────────── Toasts & safe mutation runner ─────────────
const ToastCtx = createContext(null);

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const push = useCallback((kind, text) => {
    const id = Math.random().toString(36).slice(2);
    setToasts((t) => [...t, { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "error" ? 7000 : 3500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="no-print fixed bottom-4 right-4 z-[100] flex w-80 flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`rounded-md border px-4 py-3 text-sm shadow-lg ${
              t.kind === "error" ? "border-red-200 bg-red-50 text-red-800" : "border-brand-200 bg-white text-ink-800"
            }`}
          >
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export function useToast() {
  return useContext(ToastCtx);
}

/** Wraps a mutation call: shows success / error toasts and tracks busy state. */
export function useRun() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = useCallback(
    async (fn, success) => {
      setBusy(true);
      try {
        const res = await fn();
        if (success) toast("ok", success);
        return { ok: true, res };
      } catch (e) {
        toast("error", errMsg(e));
        return { ok: false };
      } finally {
        setBusy(false);
      }
    },
    [toast],
  );
  return [run, busy];
}

// ───────────── Layout primitives ─────────────
export function PageHeader({ title, subtitle, actions, children }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold text-ink-900">{title}</h1>
        {subtitle && <p className="mt-0.5 text-sm text-ink-500">{subtitle}</p>}
      </div>
      <div className="no-print flex flex-wrap items-center gap-2">{actions}</div>
      {children}
    </div>
  );
}

export function Card({ title, actions, children, className = "", bodyClass = "p-4" }) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-2 border-b border-ink-100 px-4 py-3">
          <h2 className="text-sm font-semibold text-ink-800">{title}</h2>
          <div className="flex items-center gap-2">{actions}</div>
        </header>
      )}
      <div className={bodyClass}>{children}</div>
    </section>
  );
}

export function Field({ label: text, hint, children, className = "" }) {
  return (
    <label className={`block ${className}`}>
      {text && <span className="label">{text}</span>}
      {children}
      {hint && <span className="mt-1 block text-xs text-ink-400">{hint}</span>}
    </label>
  );
}

export function Input(props) {
  return <input {...props} className={`input ${props.className ?? ""}`} />;
}

export function NumberInput({ value, onChange, ...rest }) {
  return (
    <input
      type="number"
      step="any"
      {...rest}
      value={value === undefined || value === null || Number.isNaN(value) ? "" : value}
      onChange={(e) => onChange(e.target.value === "" ? 0 : Number(e.target.value))}
      className={`input ${rest.className ?? ""}`}
    />
  );
}

export function Select({ options, placeholder, ...props }) {
  return (
    <select {...props} className={`input ${props.className ?? ""}`}>
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function Textarea(props) {
  return <textarea rows={3} {...props} className={`input ${props.className ?? ""}`} />;
}

export function Checkbox({ checked, onChange, children }) {
  return (
    <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-ink-700">
      <input
        type="checkbox"
        checked={!!checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 rounded border-ink-300 text-brand-600 focus:ring-brand-600"
      />
      {children}
    </label>
  );
}

const STATUS_COLORS = {
  green: "bg-brand-50 text-brand-700 ring-brand-600/20",
  amber: "bg-amber-50 text-amber-700 ring-amber-600/20",
  red: "bg-red-50 text-red-700 ring-red-600/20",
  blue: "bg-sky-50 text-sky-700 ring-sky-600/20",
  gray: "bg-ink-100 text-ink-600 ring-ink-500/20",
  violet: "bg-violet-50 text-violet-700 ring-violet-600/20",
};
const STATUS_MAP = {
  posted: "green", paid: "green", received: "green", completed: "green", approved: "green", active: "green", applied: "green",
  converted: "gray", invoiced: "gray", closed: "gray", refunded: "gray", normal: "gray",
  confirmed: "blue", sent: "blue", ordered: "blue", in_transit: "blue", open: "blue", accepted: "blue", recommended: "blue",
  partial: "amber", partially_received: "amber", pending_approval: "amber", draft: "gray", postponed: "amber", below_reorder: "amber",
  rejected: "red", void: "red", cancelled: "red", expired: "red", critical: "red", overdue: "red", inactive: "red",
  transfer: "violet", purchase: "blue",
};

export function Badge({ children, color }) {
  const key = color ?? STATUS_MAP[String(children)] ?? "gray";
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${STATUS_COLORS[key]}`}>
      {typeof children === "string" ? label(children) : children}
    </span>
  );
}

export function StatCard({ title, value, sub, tone = "default", onClick }) {
  const tones = { default: "text-ink-900", good: "text-brand-700", bad: "text-red-600", warn: "text-amber-600" };
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      className="card block w-full p-4 text-left transition enabled:hover:border-brand-300 enabled:hover:shadow"
    >
      <div className="text-xs font-medium uppercase tracking-wide text-ink-500">{title}</div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums ${tones[tone]}`}>{value}</div>
      {sub && <div className="mt-1 text-xs text-ink-500">{sub}</div>}
    </button>
  );
}

export function Empty({ children = "Nothing here yet." }) {
  return <div className="px-4 py-10 text-center text-sm text-ink-400">{children}</div>;
}

export function Loading() {
  const offline = useOffline();
  return (
    <div className="px-4 py-10 text-center text-sm text-ink-400">
      {offline ? "Not saved on this computer — open this page once while online to view it offline." : "Loading…"}
    </div>
  );
}

export function Tabs({ tabs, value, onChange }) {
  return (
    <div className="no-print mb-4 flex gap-1 overflow-x-auto border-b border-ink-200">
      {tabs.map((t) => (
        <button
          key={t.value}
          type="button"
          onClick={() => onChange(t.value)}
          className={`-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium ${
            value === t.value ? "border-brand-600 text-brand-700" : "border-transparent text-ink-500 hover:text-ink-800"
          }`}
        >
          {t.label}
          {t.count !== undefined && t.count > 0 && (
            <span className="ml-1.5 rounded-full bg-ink-100 px-1.5 text-xs text-ink-600">{t.count}</span>
          )}
        </button>
      ))}
    </div>
  );
}

export function Modal({ open, onClose, title, children, footer, wide = false }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => e.key === "Escape" && onClose?.();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="no-print fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink-900/40 p-4 pt-12">
      <div className={`card w-full ${wide ? "max-w-5xl" : "max-w-lg"}`}>
        <header className="flex items-center justify-between border-b border-ink-100 px-5 py-3">
          <h3 className="font-semibold text-ink-900">{title}</h3>
          <button type="button" onClick={onClose} className="btn-ghost btn-sm" aria-label="Close">
            ✕
          </button>
        </header>
        <div className="max-h-[70vh] overflow-y-auto px-5 py-4">{children}</div>
        {footer && <footer className="flex justify-end gap-2 border-t border-ink-100 px-5 py-3">{footer}</footer>}
      </div>
    </div>
  );
}

/** Ask for a reason, then run. */
export function usePrompt() {
  const [state, setState] = useState(null);
  const ask = useCallback((title, { placeholder = "Reason", required = true } = {}) => {
    return new Promise((resolve) => setState({ title, placeholder, required, resolve, value: "" }));
  }, []);
  const node = state && (
    <Modal
      open
      title={state.title}
      onClose={() => {
        state.resolve(null);
        setState(null);
      }}
      footer={
        <>
          <button
            className="btn-secondary"
            onClick={() => {
              state.resolve(null);
              setState(null);
            }}
          >
            Cancel
          </button>
          <button
            className="btn-primary"
            disabled={state.required && !state.value.trim()}
            onClick={() => {
              state.resolve(state.value.trim());
              setState(null);
            }}
          >
            Confirm
          </button>
        </>
      }
    >
      <Textarea autoFocus placeholder={state.placeholder} value={state.value} onChange={(e) => setState({ ...state, value: e.target.value })} />
    </Modal>
  );
  return [ask, node];
}

/**
 * Data table with optional search, column totals and CSV export.
 * columns: [{ key, header, render?(row), value?(row), align: "right", total?: true, csv?(row) }]
 */
export function DataTable({ columns, rows, search = true, exportName, onRowClick, empty, totals = false, toolbar, pageSize = 100 }) {
  const [q, setQ] = useState("");
  const [limit, setLimit] = useState(pageSize);
  const filtered = useMemo(() => {
    if (!rows) return null;
    if (!q.trim()) return rows;
    const s = q.toLowerCase();
    return rows.filter((r) =>
      columns.some((c) => {
        const v = typeof c.value === "function" ? c.value(r) : r[c.key];
        return v !== undefined && v !== null && String(v).toLowerCase().includes(s);
      }),
    );
  }, [rows, q, columns]);

  if (!filtered) return <Loading />;
  const shown = filtered.slice(0, limit);
  return (
    <div>
      {(search || exportName || toolbar) && (
        <div className="no-print flex flex-wrap items-center gap-2 border-b border-ink-100 p-3">
          {search && <Input className="max-w-xs" placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} />}
          <div className="flex flex-1 flex-wrap items-center gap-2">{toolbar}</div>
          {exportName && (
            <button className="btn-secondary btn-sm" onClick={() => downloadCsv(exportName, filtered, columns.filter((c) => c.header))}>
              Export CSV
            </button>
          )}
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="table">
          <thead>
            <tr>
              {columns.map((c, i) => (
                <th key={c.key ?? i} className={c.align === "right" ? "text-right" : ""}>
                  {c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((r, i) => (
              <tr key={r._id ?? i} onClick={onRowClick ? () => onRowClick(r) : undefined} className={onRowClick ? "cursor-pointer" : ""}>
                {columns.map((c, j) => (
                  <td key={c.key ?? j} className={c.align === "right" ? "num" : ""}>
                    {c.render ? c.render(r) : typeof c.value === "function" ? c.value(r) : r[c.key]}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
          {totals && shown.length > 0 && (
            <tfoot>
              <tr className="bg-ink-50 font-semibold">
                {columns.map((c, j) => (
                  <td key={c.key ?? j} className={`border-t border-ink-200 px-3 py-2 ${c.align === "right" ? "num" : ""}`}>
                    {j === 0 ? "Total" : c.total ? (c.totalRender ?? ((x) => x))(filtered.reduce((a, r) => a + Number((typeof c.value === "function" ? c.value(r) : r[c.key]) ?? 0), 0)) : ""}
                  </td>
                ))}
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      {filtered.length === 0 && <Empty>{empty}</Empty>}
      {filtered.length > limit && (
        <div className="p-3 text-center">
          <button className="btn-secondary btn-sm" onClick={() => setLimit(limit + pageSize)}>
            Show more ({filtered.length - limit} remaining)
          </button>
        </div>
      )}
    </div>
  );
}
