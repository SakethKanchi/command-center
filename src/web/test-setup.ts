import { afterEach } from "vitest";

// Loaded by vitest for every suite in the repo, so the DOM half is imported
// only when a DOM exists: the server suites run under node and must not pull
// react-dom in.
import "@testing-library/jest-dom/vitest";

if (typeof document !== "undefined") {
  // Dynamic on purpose: a static import would load react-dom into the node
  // environment the server suites use, where there is no document to unmount
  // from. `globals: false` also means Testing Library never sees a global
  // `afterEach` to hook itself onto, so cleanup has to be registered here or
  // every render accumulates into the same document.
  const { cleanup } = await import("@testing-library/react");
  afterEach(cleanup);
}
