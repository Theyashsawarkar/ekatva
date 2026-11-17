// Pairs the emulator with the demo laptop: an offer (written to uri.txt), then accepts the phone.

import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../../../../", import.meta.url));
const req = createRequire(`${repo}apps/daemon/package.json`);
const { createTRPCClient, createWSClient, wsLink } = req("@trpc/client");
const WebSocket = req("ws");
const { PRESETS } = await import(`${repo}packages/protocol/dist/index.js`);
const ws = createWSClient({
  url: `ws+unix://${process.env.XDG_RUNTIME_DIR}/ekatva.sock:/`,
  WebSocket,
});
const api = createTRPCClient({ links: [wsLink({ client: ws })] });
const o = await api.admin.pair.start.mutate({ away: false });
writeFileSync(process.argv[2], o.uri);
console.log("offer ready");
const timer = setTimeout(() => {
  console.log("no phone");
  process.exit(1);
}, 150_000);
const sub = api.admin.pair.pending.subscribe(undefined, {
  onData: async (list) => {
    if (!list?.[0]) return;
    const p = list[0];
    sub.unsubscribe();
    console.log(`${p.name} asks to pair: ${p.sas.join(" ")}`);
    await api.admin.pair.confirm.mutate({
      id: p.id,
      accept: true,
      grants: [...PRESETS["everything-but-root"]],
    });
    console.log("accepted");
    clearTimeout(timer);
    ws.close();
    process.exit(0);
  },
});
