/** Two or three choices in a row (the prototype's .seg2): plum under the chosen one. */
import { Pressable, View, type ViewStyle } from "react-native";
import { Txt } from "../lac";
import { k } from "../theme";

export function Seg<V extends string>({
  value,
  options,
  onChange,
  style,
}: {
  value: V;
  options: { value: V; label: string }[];
  onChange: (v: V) => void;
  style?: ViewStyle;
}) {
  return (
    <View
      accessibilityRole="tablist"
      style={[
        {
          flexDirection: "row",
          borderWidth: 1,
          borderColor: k.line,
          borderRadius: 14,
          padding: 3,
          marginBottom: 16,
          backgroundColor: k.ink2,
        },
        style,
      ]}
    >
      {options.map((o) => {
        const on = o.value === value;
        return (
          <Pressable
            key={o.value}
            onPress={() => onChange(o.value)}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            style={{
              flex: 1,
              alignItems: "center",
              paddingVertical: 8,
              borderRadius: 11,
              backgroundColor: on ? k.plum2 : "transparent",
            }}
          >
            <Txt w="600" size={14} color={on ? k.text : k.sub} lines={1}>
              {o.label}
            </Txt>
          </Pressable>
        );
      })}
    </View>
  );
}
