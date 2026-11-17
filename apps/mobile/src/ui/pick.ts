/**
 * The system file picker, loaded only when first needed (not at launch).
 * Outside components: the React Compiler can't compile an `import()` in one.
 */
export async function pickDocuments(multiple: boolean) {
  const DocumentPicker = await import("expo-document-picker");
  return DocumentPicker.getDocumentAsync({ multiple, copyToCacheDirectory: true });
}
