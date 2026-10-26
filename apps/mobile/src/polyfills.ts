/** What the shared code expects from the JS runtime, before anything else loads. */
import "react-native-url-polyfill/auto";
import { getRandomValues } from "expo-crypto";

const g = globalThis as { crypto?: { getRandomValues?: unknown } };
if (!g.crypto) g.crypto = {};
if (!g.crypto.getRandomValues) g.crypto.getRandomValues = getRandomValues;
