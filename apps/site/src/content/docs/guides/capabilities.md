---
title: "Add a feature"
description: "Every feature is a capability, one contract shared by both sides."
---

ekatva is built to grow. A feature is a **capability**: a name, a router in the
shared contract, a handler on the device that does it, and a screen on the
device that asks for it.

## 1. Name the capability

`packages/protocol/src/capabilities.ts`:

```ts
"media.queue": { side: "laptop", risk: "low", title: "The music queue", detail: "add, reorder, remove" },
```

It's **off** on every existing pairing until someone grants it.

## 2. Describe the API

In `packages/protocol/src/laptop.ts` (or `phone.ts`), add procedures with the
shared builder. `meta.cap` is required: the builder refuses callers without it,
and records every mutation in the action log.

```ts
queue: api.router({
  add: p
    .meta({ cap: "media.queue" })
    .input(z.object({ url: z.string().url() }))
    .mutation(async ({ ctx, input }) => done(ctx, await ctx.services.media.add(input.url))),
}),
```

## 3. Implement it, undo included

The service returns a `Done`: the value, a summary for the log, and, if it can
be reversed, how:

```ts
async add(url: string): Promise<Done<Item>> {
  const item = await mpd.add(url);
  return { value: item, summary: `Queued ${item.title}`, undo: { kind: "media.remove", data: { id: item.id } } };
}
```

and teach the device's undo dispatcher the new `kind`.

## 4. Test it

The protocol's end-to-end tests run a real tRPC client over a real encrypted
channel; add a case there, and one in the daemon's tests.
