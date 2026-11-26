/** Renames a Claude session: the name Claude itself shows, everywhere. */
import { useState } from "react";
import { StyleSheet, TextInput, View } from "react-native";
import { Btn, Sheet, Txt } from "../lac";
import { font, k } from "../theme";

export function RenameSheet({
  name,
  onSave,
  onClose,
}: {
  name: string;
  onSave: (name: string) => Promise<boolean>;
  onClose: () => void;
}) {
  const [text, setText] = useState(name);
  const [busy, setBusy] = useState(false);
  const clean = text.replace(/\s+/g, " ").trim();
  const save = async () => {
    if (!clean || busy) return;
    setBusy(true);
    const ok = clean === name || (await onSave(clean));
    setBusy(false);
    if (ok) onClose();
  };
  return (
    <View style={[StyleSheet.absoluteFill, { zIndex: 40 }]}>
      <Sheet title="Rename" onClose={onClose}>
        <Txt size={14} color={k.sub} style={{ marginBottom: 12 }}>
          The session gets this name on the laptop too.
        </Txt>
        <TextInput
          value={text}
          onChangeText={setText}
          autoFocus
          selectTextOnFocus
          maxLength={60}
          onSubmitEditing={() => void save()}
          accessibilityLabel="The session's name"
          style={{
            color: k.text,
            fontFamily: font.body,
            fontSize: 16,
            backgroundColor: k.ink,
            borderWidth: 1,
            borderColor: k.line2,
            borderRadius: 16,
            paddingHorizontal: 16,
            paddingVertical: 13,
            marginBottom: 14,
          }}
        />
        <Btn
          label="Rename"
          kind="solid"
          busy={busy}
          disabled={!clean}
          onPress={() => void save()}
        />
      </Sheet>
    </View>
  );
}
