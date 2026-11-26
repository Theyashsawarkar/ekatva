/**
 * For a Vayu phone app to talk to its laptop half through ekatva:
 *
 *   import { connectEkatva } from "@ekatva/connect";
 *   const ekatva = connectEkatva({ id: "nada", name: "nāda", version: "1",
 *     methods: [{ name: "queue", why: "What the phone is playing" }] });
 *   ekatva.onStatus((s) => …);                 // "unlinked": show "Link with ekatva"
 *   ekatva.link();                             // that button: ekatva asks you, once
 *   await ekatva.call("play", { song: 3 });    // nāda on the laptop
 *   ekatva.on("queue", () => queue);           // the laptop asks this app
 *
 *   await ekatva.call("open", {}, { to: "laptop:darshan", files: [uri] });  // another app
 *
 * Nothing is asked until you call link(); the answer is kept for good,
 * pinned to how the app is signed. Without ekatva (or on iOS) the status
 * is "not-installed" and calls reject in words: keep the app working alone.
 */
import { requireOptionalNativeModule } from "expo";
import { createLink, type EkatvaLink, type Manifest, type Native } from "./link";

export type { CallOptions, EkatvaLink, From, LinkFile, Manifest, Method, Status } from "./link";
export { reasonOf } from "./link";

const native = requireOptionalNativeModule<Native>("EkatvaConnect");

/** Connects to ekatva now; the link keeps itself up while the app runs. */
export function connectEkatva(manifest: Manifest): EkatvaLink {
  return createLink(native, manifest);
}
