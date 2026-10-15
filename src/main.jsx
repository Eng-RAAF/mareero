import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { ConvexReactClient } from "convex/react";
import { ConvexAuthProvider } from "@convex-dev/auth/react";
import App from "./App";
import { ToastProvider } from "./components/ui";
import { watchConnection } from "./lib/convex";
import "./index.css";

const url = import.meta.env.VITE_CONVEX_URL;
const root = ReactDOM.createRoot(document.getElementById("root"));

if (!url) {
  root.render(
    <div style={{ fontFamily: "system-ui", padding: 40 }}>
      <h2>Convex URL missing</h2>
      <p>
        Run <code>npx convex dev</code> once — it writes <code>VITE_CONVEX_URL</code> to <code>.env.local</code>.
      </p>
    </div>,
  );
} else {
  const convex = new ConvexReactClient(url);
  watchConnection(convex);
  root.render(
    <React.StrictMode>
      <ConvexAuthProvider client={convex}>
        <BrowserRouter>
          <ToastProvider>
            <App />
          </ToastProvider>
        </BrowserRouter>
      </ConvexAuthProvider>
    </React.StrictMode>,
  );
}

// Installable app + offline start: the service worker keeps the app files on this computer
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      /* not available (e.g. plain http on a network address) — app still works online */
    });
  });
}
