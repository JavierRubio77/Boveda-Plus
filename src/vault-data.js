// Remove only retired fields: preserve credentials, metadata and unknown fields.
export function migrateEntries(entries) {
  return entries.map(({ type, favorite, ...entry }) => entry);
}
