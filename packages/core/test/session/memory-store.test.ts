import { MemorySessionStore } from "../../src/session/memory-store.js";
import { registerSessionStoreContract } from "./store-contract.js";

registerSessionStoreContract("MemorySessionStore", () => ({
  store: new MemorySessionStore(),
  cleanup: async () => {
    // The in-memory store owns no external resources.
  },
}));
