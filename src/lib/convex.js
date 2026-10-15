// Drop-in replacement for "convex/react" that keeps the app usable without internet:
// - useQuery saves every result on this device and returns the saved copy while offline
// - useMutation refuses to run while offline, so nothing is silently lost or left half-saved
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { useMutation as convexUseMutation, useQuery as convexUseQuery } from "convex/react";
import { getFunctionName } from "convex/server";
import { convexToJson, jsonToConvex } from "convex/values";

export * from "convex/react";

export const OFFLINE_MESSAGE =
  "You are offline. This change was not saved — try again when the internet connection is back.";

// ───────────── Connection status ─────────────
// Offline = the browser reports no network, or the Convex socket has been down for a few seconds
// (short drops are normal and Convex reconnects on its own).
const GRACE_MS = 4000;
let offline = typeof navigator !== "undefined" && navigator.onLine === false;
const listeners = new Set();

function setOffline(value) {
  if (value === offline) return;
  offline = value;
  listeners.forEach((l) => l());
}

export function isOffline() {
  return offline;
}

/** Call once with the ConvexReactClient to start tracking the connection. */
export function watchConnection(client) {
  let timer = null;
  let socketUp = false;
  const evaluate = () => {
    if (!navigator.onLine) {
      clearTimeout(timer);
      timer = null;
      setOffline(true);
    } else if (socketUp) {
      clearTimeout(timer);
      timer = null;
      setOffline(false);
    } else if (!timer) {
      timer = setTimeout(() => {
        timer = null;
        if (!socketUp) setOffline(true);
      }, GRACE_MS);
    }
  };
  client.subscribeToConnectionState((s) => {
    socketUp = s.isWebSocketConnected;
    evaluate();
  });
  window.addEventListener("online", evaluate);
  window.addEventListener("offline", evaluate);
  socketUp = client.connectionState().isWebSocketConnected;
  evaluate();
}

export function useOffline() {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => offline,
  );
}

// ───────────── Saved query results ─────────────
const PREFIX = "mareero.q:";
const OWNER_KEY = "mareero.cacheOwner";
const MAX_ENTRY_CHARS = 1_500_000;
const memory = new Map(); // key → { text, value } so offline renders get stable references

function cacheKey(ref, args) {
  return PREFIX + getFunctionName(ref) + ":" + JSON.stringify(convexToJson(args ?? {}));
}

function cacheEntries() {
  const keys = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith(PREFIX)) keys.push(k);
    }
  } catch {
    /* storage unavailable */
  }
  return keys;
}

function save(key, value) {
  let text;
  try {
    text = JSON.stringify({ t: Date.now(), v: convexToJson(value) });
  } catch {
    return;
  }
  if (text.length > MAX_ENTRY_CHARS || memory.get(key)?.text === text) return;
  memory.set(key, { text, value });
  try {
    localStorage.setItem(key, text);
  } catch {
    // Storage full: drop the oldest half of the saved results and try once more
    const dated = cacheEntries()
      .map((k) => {
        try {
          return [k, JSON.parse(localStorage.getItem(k)).t];
        } catch {
          return [k, 0];
        }
      })
      .sort((a, b) => a[1] - b[1]);
    dated.slice(0, Math.ceil(dated.length / 2)).forEach(([k]) => localStorage.removeItem(k));
    try {
      localStorage.setItem(key, text);
    } catch {
      /* give up on this entry */
    }
  }
}

function load(key) {
  try {
    const text = localStorage.getItem(key);
    if (!text) return undefined;
    const hit = memory.get(key);
    if (hit?.text === text) return hit.value;
    const value = jsonToConvex(JSON.parse(text).v);
    memory.set(key, { text, value });
    return value;
  } catch {
    return undefined;
  }
}

/** Saved result of a query from an earlier online visit, or undefined. */
export function readSaved(ref, args = {}) {
  return load(cacheKey(ref, args));
}

/** Remove everything saved on this device (call on sign-out). */
export function clearSaved() {
  memory.clear();
  try {
    cacheEntries().forEach((k) => localStorage.removeItem(k));
    localStorage.removeItem(OWNER_KEY);
  } catch {
    /* storage unavailable */
  }
}

/** Offline sign-out: the server can't be told, so forget the sign-in tokens kept on this device. */
export function forgetSignIn() {
  try {
    Object.keys(localStorage)
      .filter((k) => k.startsWith("__convexAuth"))
      .forEach((k) => localStorage.removeItem(k));
  } catch {
    /* storage unavailable */
  }
}

/** Saved data belongs to one account; wipe it when a different account signs in. */
export function claimSaved(owner) {
  if (!owner) return;
  try {
    const current = localStorage.getItem(OWNER_KEY);
    if (current && current !== owner) clearSaved();
    localStorage.setItem(OWNER_KEY, owner);
  } catch {
    /* storage unavailable */
  }
}

export function useQuery(ref, ...rest) {
  const args = rest[0];
  const live = convexUseQuery(ref, ...rest);
  const isOff = useOffline();
  const key = args === "skip" ? null : cacheKey(ref, args);
  useEffect(() => {
    if (key && live !== undefined) save(key, live);
  }, [key, live]);
  if (live !== undefined || !key || !isOff) return live;
  return load(key);
}

export function useMutation(ref) {
  const mutate = convexUseMutation(ref);
  return useMemo(() => {
    const guarded = (...a) => (offline ? Promise.reject(new Error(OFFLINE_MESSAGE)) : mutate(...a));
    guarded.withOptimisticUpdate = (u) => {
      const inner = mutate.withOptimisticUpdate(u);
      return (...a) => (offline ? Promise.reject(new Error(OFFLINE_MESSAGE)) : inner(...a));
    };
    return guarded;
  }, [mutate]);
}
