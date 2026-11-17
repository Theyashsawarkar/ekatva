/** Light and dark, on either device. */
import { z } from "zod";

export const AppearanceMode = z.enum(["light", "dark"]);
export type AppearanceMode = z.infer<typeof AppearanceMode>;

export const Appearance = z.object({
  mode: AppearanceMode,
  /** False when this device can't be switched from ekatva (and why, in `why`). */
  settable: z.boolean(),
  why: z.string().nullable(),
});
export type Appearance = z.infer<typeof Appearance>;
