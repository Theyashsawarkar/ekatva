/** Phone features exist on Android only (phone-features.android.tsx). */
import { Card, T } from "./kit";
import { c } from "./theme";

export function PhoneFeatures() {
  return (
    <Card>
      <T color={c.dim}>Calls, messages and locking are available on Android.</T>
    </Card>
  );
}
