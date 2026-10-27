/** Turning on what the laptop may use of this phone, one Android permission at a time. */
import { useEffect, useState } from "react";
import { AppState, PermissionsAndroid, Platform, Switch, View } from "react-native";
import { phone } from "../../modules/ekatva-phone";
import { Card, T } from "./kit";
import { c } from "./theme";

const P = PermissionsAndroid.PERMISSIONS;

async function ask(perms: string[]): Promise<boolean> {
  const r = await PermissionsAndroid.requestMultiple(perms as never[]);
  return Object.values(r).every((v) => v === PermissionsAndroid.RESULTS.GRANTED);
}

/** Android 13+ asks before an app may show notifications; older ones always let it. */
const canNotify = () =>
  Number(Platform.Version) < 33
    ? Promise.resolve(true)
    : PermissionsAndroid.check(P.POST_NOTIFICATIONS);

export function PhoneFeatures() {
  const [, bump] = useState(0);
  const [notify, setNotify] = useState(true);
  // Most of these are granted on Android's own settings pages, not here: read them again
  // when the app comes back to the front, and every few seconds while this is on screen.
  useEffect(() => {
    const again = () => {
      bump((n) => n + 1);
      void canNotify().then(setNotify);
    };
    again();
    const sub = AppState.addEventListener("change", (s) => s === "active" && again());
    const timer = setInterval(again, 2000);
    return () => {
      sub.remove();
      clearInterval(timer);
    };
  }, []);
  if (!phone) {
    return (
      <Card>
        <T color={c.dim}>
          This build has no phone features (calls, messages, lock). Install the full ekatva app.
        </T>
      </Card>
    );
  }
  const native = phone;
  const st = native.status();
  const refresh = () => setTimeout(() => bump((n) => n + 1), 600);
  const rows: {
    title: string;
    detail: string;
    on: boolean;
    enable: () => Promise<unknown>;
  }[] = [
    {
      title: "Calls",
      detail: "place calls from the laptop, see incoming ones, answer and end them",
      on: st.calls,
      enable: () =>
        ask([
          P.CALL_PHONE,
          P.READ_PHONE_STATE,
          P.ANSWER_PHONE_CALLS,
          P.READ_CALL_LOG,
          P.READ_CONTACTS,
        ]).then(() => native.watchCalls()),
    },
    {
      title: "Messages",
      detail: "read and send SMS from the laptop, see new ones there",
      on: st.sms,
      enable: () =>
        ask([P.READ_SMS, P.SEND_SMS, P.RECEIVE_SMS, P.READ_CONTACTS]).then(() => native.watchSms()),
    },
    {
      title: "Notifications",
      detail: "this phone's notifications, on the laptop",
      on: st.notifications,
      enable: async () => native.openNotificationAccess(),
    },
    {
      title: "Lock from the laptop",
      detail: "the laptop can lock this phone (nothing else of device admin)",
      on: st.admin,
      enable: async () => native.requestAdmin(),
    },
    {
      title: "All files",
      detail: "the laptop can reach all of this phone's storage, not just ekatva's folder",
      on: st.allFiles,
      enable: async () => native.requestAllFiles(),
    },
    {
      title: "Stay linked in the background",
      detail: "an ongoing notification keeps the link up when the app is closed",
      on: notify,
      enable: () => ask([P.POST_NOTIFICATIONS]),
    },
  ];
  return (
    <Card>
      <T weight="700">Phone features</T>
      <T size={12} color={c.subtle}>
        Android asks you for each. What the laptop may actually use is still up to the switches
        above.
      </T>
      {rows.map((r) => (
        <View
          key={r.title}
          style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 4 }}
        >
          <View style={{ flex: 1 }}>
            <T weight="600">{r.title}</T>
            <T size={12} color={c.subtle}>
              {r.detail}
            </T>
          </View>
          <Switch
            value={r.on}
            disabled={r.on}
            onValueChange={() => {
              void Promise.resolve(r.enable()).finally(refresh);
            }}
            trackColor={{ true: c.teal, false: c.muted }}
            thumbColor={c.text}
          />
        </View>
      ))}
    </Card>
  );
}
