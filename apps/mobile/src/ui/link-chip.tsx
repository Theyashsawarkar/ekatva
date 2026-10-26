import { Chip } from "./kit";
import { useLink } from "./state";

/** Near, away, connecting or offline, at a glance. */
export function LinkChip() {
  const link = useLink();
  if (link.status === "online")
    return <Chip label={link.via === "lan" ? "● near" : "● away"} tone="ok" />;
  if (link.status === "connecting") return <Chip label="connecting" tone="accent" />;
  if (link.status === "offline") return <Chip label="offline" tone="warn" />;
  return <Chip label="not paired" />;
}
