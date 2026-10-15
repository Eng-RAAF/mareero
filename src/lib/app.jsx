import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { setCurrency } from "./format";

const AppContext = createContext(null);

function read(key) {
  try {
    return localStorage.getItem(key) || "";
  } catch {
    return "";
  }
}
function write(key, value) {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    /* storage unavailable */
  }
}

/** Holds the signed-in member, permissions and the global branch / store filter. */
export function AppProvider({ me, children }) {
  const [branchId, setBranchIdRaw] = useState(() => read("mareero.branch"));
  const [storeId, setStoreIdRaw] = useState(() => read("mareero.store"));

  useEffect(() => setCurrency(me.company?.currency), [me.company?.currency]);

  // Drop selections the member can no longer see
  useEffect(() => {
    if (branchId && !me.branches.some((b) => b._id === branchId)) setBranchIdRaw("");
    if (storeId && !me.stores.some((s) => s._id === storeId)) setStoreIdRaw("");
  }, [me.branches, me.stores, branchId, storeId]);

  const setBranchId = useCallback((id) => {
    setBranchIdRaw(id);
    write("mareero.branch", id);
    setStoreIdRaw("");
    write("mareero.store", "");
  }, []);
  const setStoreId = useCallback((id) => {
    setStoreIdRaw(id);
    write("mareero.store", id);
  }, []);

  const value = useMemo(() => {
    const perms = new Set(me.permissions);
    const visibleStores = me.stores.filter((s) => !branchId || s.branchId === branchId);
    return {
      me,
      member: me.member,
      company: me.company,
      branches: me.branches,
      stores: me.stores,
      visibleStores,
      branchId: branchId || undefined,
      storeId: storeId || undefined,
      setBranchId,
      setStoreId,
      can: (p) => perms.has(p),
      branchName: (id) => me.branches.find((b) => b._id === id)?.name ?? "",
      storeName: (id) => me.stores.find((s) => s._id === id)?.name ?? "",
      // Default store for new documents: selected store, else first store of selected branch, else first store
      defaultStoreId: storeId || visibleStores[0]?._id || me.stores[0]?._id || "",
    };
  }, [me, branchId, storeId, setBranchId, setStoreId]);

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp outside AppProvider");
  return ctx;
}
