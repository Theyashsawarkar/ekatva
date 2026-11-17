/**
 * Settings' "This phone": one row to the Permissions screen, saying how many
 * of ekatva's permissions Android has granted (the screen lists them all).
 */
import { router } from "expo-router";
import { H2, Item, List, Panel, Txt } from "./lac";
import { available, usePermissions } from "./permissions";
import { k } from "./theme";

export function PhoneFeatures() {
  const { perms } = usePermissions();
  if (!available() || !perms) {
    return (
      <>
        <H2>This phone</H2>
        <Panel style={{ padding: 16 }}>
          <Txt size={14} color={k.sub}>
            Calls, messages and locking need the full ekatva app on Android.
          </Txt>
        </Panel>
      </>
    );
  }
  const allowed = perms.filter((p) => p.on).length;
  const needed = perms.filter((p) => p.essential && !p.on).length;
  return (
    <>
      <H2>This phone</H2>
      <List>
        <Item
          glyph="key"
          glyphColor={needed ? k.amber : k.sage}
          title="Permissions"
          sub={
            needed
              ? `${allowed} of ${perms.length} allowed, ${needed} needed`
              : `${allowed} of ${perms.length} allowed`
          }
          chev
          onPress={() => router.push("/permissions")}
        />
      </List>
    </>
  );
}
