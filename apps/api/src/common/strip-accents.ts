/** Text without diacritics, for accent-insensitive matching: "Suspensión" -> "Suspension". */
export function stripAccents(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}
