import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import "./styles.css";

const host = document.getElementById("root");
if (!host) throw new Error("Missing #root element.");

// The router lives here rather than in `App` so tests can mount `App` inside a
// `MemoryRouter` without fighting a second router.
createRoot(host).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
