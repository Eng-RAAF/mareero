import { useState } from "react";
import { useAuthActions } from "@convex-dev/auth/react";
import { clearSaved, useMutation } from "../lib/convex";
import { api } from "../../convex/_generated/api";
import { Field, Input, NumberInput, Select, useRun } from "../components/ui";
import { errMsg } from "../lib/format";

function Shell({ children, wide }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-ink-900 via-ink-800 to-brand-900 p-4">
      <div className={`w-full ${wide ? "max-w-2xl" : "max-w-md"}`}>
        <div className="mb-6 flex items-center justify-center gap-3 text-white">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-brand-600 text-lg font-bold">M</div>
          <div>
            <div className="text-lg font-semibold leading-tight">Mareero Auto Spare Parts</div>
            <div className="text-xs text-ink-300">Management System</div>
          </div>
        </div>
        <div className="card p-6">{children}</div>
      </div>
    </div>
  );
}

export function SignIn({ hasCompany }) {
  const { signIn } = useAuthActions();
  const [flow, setFlow] = useState(hasCompany ? "signIn" : "signUp");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    const fd = new FormData(e.currentTarget);
    fd.set("email", String(fd.get("email")).trim().toLowerCase());
    fd.set("flow", flow);
    try {
      await signIn("password", fd);
    } catch (err) {
      const m = errMsg(err);
      setError(
        /InvalidSecret|InvalidAccountId|Invalid password/i.test(m)
          ? "Email or password is incorrect."
          : /already exists/i.test(m)
            ? "An account with this email already exists — sign in instead."
            : flow === "signUp" && /password/i.test(m)
              ? "Password must be at least 8 characters."
              : m,
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Shell>
      <h1 className="text-lg font-semibold text-ink-900">{flow === "signIn" ? "Sign in" : "Create your account"}</h1>
      <p className="mt-1 text-sm text-ink-500">
        {flow === "signIn"
          ? "Use the email your administrator invited."
          : hasCompany
            ? "Sign up with the email address you were invited with."
            : "The first account becomes the Super Admin and sets up the company."}
      </p>
      <form onSubmit={submit} className="mt-5 space-y-4">
        <Field label="Email">
          <Input name="email" type="email" required autoComplete="email" />
        </Field>
        <Field label="Password" hint={flow === "signUp" ? "At least 8 characters." : undefined}>
          <Input name="password" type="password" required minLength={8} autoComplete={flow === "signIn" ? "current-password" : "new-password"} />
        </Field>
        {error && <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
        <button className="btn-primary w-full" disabled={busy}>
          {busy ? "Please wait…" : flow === "signIn" ? "Sign in" : "Create account"}
        </button>
      </form>
      <div className="mt-4 text-center text-sm text-ink-500">
        {flow === "signIn" ? "New here? " : "Already have an account? "}
        <button className="link" onClick={() => setFlow(flow === "signIn" ? "signUp" : "signIn")}>
          {flow === "signIn" ? "Create an account" : "Sign in"}
        </button>
      </div>
    </Shell>
  );
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export function CompanySetup() {
  const initialize = useMutation(api.setup.initialize);
  const [run, busy] = useRun();
  const [f, setF] = useState({
    companyName: "Mareero Auto Spare Parts",
    adminName: "",
    currency: "USD",
    defaultTaxRate: 0,
    fiscalYearStartMonth: 1,
    branchName: "Head Office",
    branchCode: "HQ",
    storeName: "Head Office Main Store",
    address: "",
    phone: "",
  });
  const set = (k) => (e) => setF({ ...f, [k]: e?.target ? e.target.value : e });
  return (
    <Shell wide>
      <h1 className="text-lg font-semibold text-ink-900">Set up the company</h1>
      <p className="mt-1 text-sm text-ink-500">
        This runs once. It creates the head-office branch and its main store, a standard chart of accounts and the fiscal periods.
        You can add more branches, stores and users afterwards.
      </p>
      <form
        className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          run(() => initialize({ ...f, fiscalYearStartMonth: Number(f.fiscalYearStartMonth) }), "Company created");
        }}
      >
        <Field label="Company name" className="sm:col-span-2">
          <Input required value={f.companyName} onChange={set("companyName")} />
        </Field>
        <Field label="Your full name">
          <Input required value={f.adminName} onChange={set("adminName")} />
        </Field>
        <Field label="Phone">
          <Input value={f.phone} onChange={set("phone")} />
        </Field>
        <Field label="Address" className="sm:col-span-2">
          <Input value={f.address} onChange={set("address")} />
        </Field>
        <Field label="Currency code" hint="e.g. USD, SOS, KES">
          <Input required maxLength={3} value={f.currency} onChange={set("currency")} />
        </Field>
        <Field label="Default sales tax %">
          <NumberInput value={f.defaultTaxRate} onChange={set("defaultTaxRate")} min={0} />
        </Field>
        <Field label="Financial year starts in">
          <Select value={f.fiscalYearStartMonth} onChange={set("fiscalYearStartMonth")} options={MONTHS.map((m, i) => ({ value: i + 1, label: m }))} />
        </Field>
        <div />
        <Field label="Head office branch name">
          <Input required value={f.branchName} onChange={set("branchName")} />
        </Field>
        <Field label="Branch code">
          <Input required maxLength={6} value={f.branchCode} onChange={set("branchCode")} />
        </Field>
        <Field label="Main store name" className="sm:col-span-2">
          <Input required value={f.storeName} onChange={set("storeName")} />
        </Field>
        <div className="sm:col-span-2">
          <button className="btn-primary w-full" disabled={busy}>
            {busy ? "Setting up…" : "Create company"}
          </button>
        </div>
      </form>
    </Shell>
  );
}

export function NoAccess({ email, pendingInvite }) {
  const { signOut } = useAuthActions();
  const claim = useMutation(api.setup.claimInvite);
  const [run, busy] = useRun();
  return (
    <Shell>
      <h1 className="text-lg font-semibold text-ink-900">{pendingInvite ? "You've been invited" : "No access yet"}</h1>
      <p className="mt-2 text-sm text-ink-600">
        {pendingInvite
          ? `An administrator added ${email} to Mareero. Join to continue.`
          : `${email ?? "This account"} has not been added to the company. Ask your administrator to add this email under Users, then come back.`}
      </p>
      <div className="mt-5 flex gap-2">
        {pendingInvite && (
          <button className="btn-primary" disabled={busy} onClick={() => run(() => claim({}), "Welcome to Mareero")}>
            Join
          </button>
        )}
        <button
          className="btn-secondary"
          onClick={() => {
            clearSaved();
            signOut();
          }}
        >
          Sign out
        </button>
      </div>
    </Shell>
  );
}
