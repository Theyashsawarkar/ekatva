/**
 * ekatva echo: the smallest phone app on ekatva. It talks to examples/echo
 * on the laptop through ekatva, and answers the laptop's "say" too.
 * Every label is plain text, so a test can find it (uiautomator).
 */
import { connectEkatva, type Status } from "@ekatva/connect";
import { useEffect, useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

const MANIFEST = {
  id: "echo",
  name: "Echo",
  version: "1",
  methods: [
    { name: "say", why: "Says back what the laptop sends" },
    { name: "files", why: "Says which files came with the call, and their sizes" },
  ],
  events: [{ name: "note", why: "A note from the laptop" }],
};

export default function App() {
  const ekatva = useMemo(() => connectEkatva(MANIFEST), []);
  const [status, setStatus] = useState<Status>(ekatva.status());
  const [why, setWhy] = useState<string | null>(ekatva.why());
  const [answer, setAnswer] = useState("");
  const [heard, setHeard] = useState("");

  useEffect(() => {
    ekatva
      .on("say", (input, from) => {
        setHeard(`${from.name} said: ${JSON.stringify(input)}`);
        return { said: input, by: "phone" };
      })
      .on("files", (_input, from, files) => {
        setHeard(
          `${from.app ?? from.name} sent: ${files.map((f) => `${f.name} (${f.size})`).join(", ")}`,
        );
        return { files: files.map((f) => ({ name: f.name, size: f.size })), by: "phone" };
      })
      .onEvent("note", (data, from) =>
        setHeard(`A note from ${from.name}: ${JSON.stringify(data)}`),
      );
    const off = ekatva.onStatus((s, w) => {
      setStatus(s);
      setWhy(w);
    });
    return () => {
      off();
      ekatva.close();
    };
  }, [ekatva]);

  const say = async () => {
    try {
      setAnswer(`Answer: ${JSON.stringify(await ekatva.call("say", "hello from the phone"))}`);
    } catch (e) {
      setAnswer(`Error: ${(e as Error).message}`);
    }
  };

  return (
    <View style={s.page}>
      <Text style={s.title}>ekatva echo</Text>
      <Text style={s.line}>Status: {status}</Text>
      {why ? <Text style={s.sub}>{why}</Text> : null}
      {status === "unlinked" ? (
        <Pressable style={s.btn} onPress={() => ekatva.link()} accessibilityRole="button">
          <Text style={s.btnText}>Link with ekatva</Text>
        </Pressable>
      ) : null}
      <Pressable style={s.btn} onPress={() => void say()} accessibilityRole="button">
        <Text style={s.btnText}>Say hello to the laptop</Text>
      </Pressable>
      {answer ? <Text style={s.line}>{answer}</Text> : null}
      {heard ? <Text style={s.line}>{heard}</Text> : null}
    </View>
  );
}

const s = StyleSheet.create({
  page: { flex: 1, backgroundColor: "#16121b", padding: 24, paddingTop: 80, gap: 14 },
  title: { color: "#efe7dc", fontSize: 28, fontWeight: "700" },
  line: { color: "#efe7dc", fontSize: 16 },
  sub: { color: "#b9ad9f", fontSize: 14 },
  btn: { backgroundColor: "#cdb38a", borderRadius: 14, paddingVertical: 14, alignItems: "center" },
  btnText: { color: "#16121b", fontSize: 16, fontWeight: "700" },
});
