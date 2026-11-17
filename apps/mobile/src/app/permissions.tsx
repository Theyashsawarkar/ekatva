/**
 * Permissions: everything ekatva may use on this phone, in one place. How
 * many are allowed, what each one is for, and "Allow the rest": Android's
 * own dialogs all at once, then each of its settings pages in turn (you
 * come back here and the next one opens). Taking one back is always in
 * Android's settings.
 */
import * as Clipboard from "expo-clipboard";
import { useEffect, useRef, useState } from "react";
import { AppState, View } from "react-native";
import { Icon } from "../ui/icon";
import { Btn, Glyph, H2, Item, List, Navbar, Page, Panel, Pill, Txt, toast } from "../ui/lac";
import {
  available,
  grant,
  grantDialogs,
  type Perm,
  USB_COMMAND,
  usePermissions,
} from "../ui/permissions";
import { k } from "../ui/theme";

export default function Permissions() {
  const { perms, refresh } = usePermissions(true);
  const [walking, setWalking] = useState(false);
  const [next, setNext] = useState<string | null>(null);
  const tried = useRef(new Set<string>());
  const latest = useRef(perms);
  latest.current = perms;

  // The walk: one settings page at a time, the next when you come back.
  const advance = () => {
    const now = latest.current ?? [];
    const p = now.find((x) => !x.on && x.how === "settings" && !tried.current.has(x.id));
    if (!p) {
      setWalking(false);
      setNext(null);
      const left = now.filter((x) => !x.on && x.how !== "usb").length;
      toast(left ? `${left} still not allowed` : "All allowed");
      return;
    }
    tried.current.add(p.id);
    setNext(p.title);
    void grant(p);
  };
  useEffect(() => {
    if (!walking) return;
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "active") setTimeout(advance, 700); // let the status catch up first
    });
    return () => sub.remove();
  });

  if (!available() || !perms) {
    return (
      <Page bottom={48}>
        <Navbar back="Settings" />
        <Txt display w="700" size={30} style={{ letterSpacing: -0.6, marginTop: 4 }}>
          Permissions
        </Txt>
        <Txt size={14} color={k.sub} style={{ marginTop: 8 }}>
          This build has no phone features (calls, messages, lock). Install the full ekatva app.
        </Txt>
      </Page>
    );
  }

  const ordered = [...perms.filter((p) => p.essential), ...perms.filter((p) => !p.essential)];
  const allowed = perms.filter((p) => p.on).length;
  const missing = perms.filter((p) => !p.on && p.how !== "usb");
  const usb = perms.find((p) => p.how === "usb" && !p.on);

  const allowRest = async () => {
    tried.current = new Set();
    await grantDialogs(perms);
    refresh();
    setWalking(true);
    setTimeout(advance, 500);
  };

  return (
    <Page bottom={48}>
      <Navbar back="Settings" />
      <Txt display w="700" size={30} style={{ letterSpacing: -0.6, marginTop: 4 }}>
        Permissions
      </Txt>
      <Txt size={14} color={k.sub} style={{ marginTop: 4, lineHeight: 20 }}>
        What ekatva may use on this phone. Android asks you for each, and its settings take any of
        them back.
      </Txt>

      <Panel style={{ padding: 18, marginTop: 18, gap: 14 }}>
        <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
          <Txt display w="700" size={34} style={{ letterSpacing: -0.68 }}>
            {String(allowed)}
          </Txt>
          <Txt mono size={15} color={k.mute}>
            / {perms.length}
          </Txt>
          <Txt size={15} color={k.sub} style={{ marginLeft: 4 }}>
            allowed
          </Txt>
        </View>
        {/* one segment per permission: the needed ones first */}
        <View style={{ flexDirection: "row", gap: 4 }}>
          {ordered.map((p) => (
            <View
              key={p.id}
              style={{
                flex: 1,
                height: 6,
                borderRadius: 3,
                backgroundColor: p.on ? k.sage : p.essential ? `${k.amber}55` : k.line2,
              }}
            />
          ))}
        </View>
        {walking && next ? (
          <Txt size={14} color={k.brass2} style={{ lineHeight: 20 }}>
            Now: {next}. Allow it on Android's page, then come back here for the next.
          </Txt>
        ) : missing.length ? (
          <Btn
            label={`Allow the rest (${missing.length})`}
            kind="solid"
            onPress={() => void allowRest()}
          />
        ) : (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Icon name="check" size={18} color={k.sage} />
            <Txt size={14.5} color={k.sage}>
              {usb ? "Everything that can be allowed here is" : "Everything is allowed"}
            </Txt>
          </View>
        )}
      </Panel>

      <H2>Needed</H2>
      <List>{perms.filter((p) => p.essential).map((p) => row(p, refresh))}</List>

      <H2>Extras</H2>
      <List>{perms.filter((p) => !p.essential).map((p) => row(p, refresh))}</List>

      {usb ? (
        <Panel style={{ padding: 16, marginTop: 14, gap: 10 }}>
          <Txt w="600" size={15}>
            Light and dark: once, over USB
          </Txt>
          <Txt size={13.5} color={k.sub} style={{ lineHeight: 19 }}>
            Android keeps this one from apps. With the phone on USB (debugging on), run this on the
            laptop. It stays after that.
          </Txt>
          <View
            style={{
              backgroundColor: k.term,
              borderRadius: 12,
              borderWidth: 1,
              borderColor: k.line,
              padding: 12,
            }}
          >
            <Txt mono size={12} color={k.text} style={{ lineHeight: 18 }}>
              {USB_COMMAND}
            </Txt>
          </View>
          <Btn
            label="Copy the command"
            kind="plain"
            onPress={() =>
              void Clipboard.setStringAsync(USB_COMMAND).then(() =>
                toast("Copied: run it on the laptop"),
              )
            }
          />
        </Panel>
      ) : null}
    </Page>
  );
}

function row(p: Perm, refresh: () => void) {
  const allow = () => void grant(p).finally(() => setTimeout(refresh, 600));
  return (
    <Item
      key={p.id}
      glyph={<Glyph name={p.icon} color={p.on ? k.sage : p.essential ? k.amber : k.sub} />}
      title={p.title}
      sub={p.why}
      subLines={2}
      label={`${p.title}, ${p.on ? "allowed" : "not allowed"}`}
      onPress={p.on || p.how === "usb" ? undefined : allow}
      right={
        p.on ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
            <Icon name="check" size={16} color={k.sage} />
            <Txt size={13} color={k.sage}>
              Allowed
            </Txt>
          </View>
        ) : p.how === "usb" ? (
          <Txt size={13} color={k.mute}>
            Over USB
          </Txt>
        ) : (
          <Pill label="Allow" onPress={allow} />
        )
      }
    />
  );
}
