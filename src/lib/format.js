export const DAY = 24 * 60 * 60 * 1000;

let currency = "USD";
export function setCurrency(c) {
  currency = c || "USD";
}

export function money(n, opts = {}) {
  const v = Number(n ?? 0);
  try {
    return new Intl.NumberFormat("en-US", {
      style: opts.plain ? "decimal" : "currency",
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(v);
  } catch {
    return v.toFixed(2);
  }
}

export function num(n, digits = 0) {
  return Number(n ?? 0).toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}

export function date(ts) {
  if (!ts) return "—";
  return new Date(ts).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

export function dateTime(ts) {
  if (!ts) return "—";
  return new Date(ts).toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** yyyy-mm-dd for <input type="date"> */
export function toInput(ts) {
  const d = new Date(ts ?? Date.now());
  const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off * 60000).toISOString().slice(0, 10);
}

/** local noon of the chosen day, so the date never shifts across time zones */
export function fromInput(s) {
  if (!s) return Date.now();
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d, 12, 0, 0).getTime();
}

export function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function endOfDay(ts) {
  const d = new Date(ts);
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}

export function monthStart(ts = Date.now()) {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
}

export function yearStart(ts = Date.now()) {
  return new Date(new Date(ts).getFullYear(), 0, 1).getTime();
}

export function errMsg(e) {
  if (!e) return "";
  if (typeof e.data === "string") return e.data;
  if (e.data?.message) return e.data.message;
  const m = String(e.message ?? e);
  // Strip Convex request-id noise
  const match = m.match(/Uncaught (?:ConvexError|Error): (.*?)(\n|$)/);
  return match ? match[1] : m;
}

export function label(s) {
  return String(s ?? "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function downloadCsv(filename, rows, columns) {
  const esc = (v) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = columns.map((c) => esc(c.header)).join(",");
  const body = rows.map((r) => columns.map((c) => esc(c.csv ? c.csv(r) : typeof c.value === "function" ? c.value(r) : r[c.key])).join(","));
  const blob = new Blob([[header, ...body].join("\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename.endsWith(".csv") ? filename : `${filename}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

/** Minimal CSV parser (handles quotes). Returns array of objects keyed by header. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") {
      row.push(cur);
      cur = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cur);
      rows.push(row);
      row = [];
      cur = "";
    } else cur += ch;
  }
  if (cur || row.length) {
    row.push(cur);
    rows.push(row);
  }
  const [header, ...data] = rows.filter((r) => r.some((c) => c.trim() !== ""));
  if (!header) return [];
  const keys = header.map((h) => h.trim());
  return data.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? "").trim()])));
}
