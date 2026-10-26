import { defineConfig } from "vitest/config";

// Some tests drive a real tmux and real sockets: give them room under load.
export default defineConfig({ test: { testTimeout: 20_000 } });
