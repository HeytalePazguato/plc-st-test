/**
 * Identifier case folding shared by interpreter collaborators that receive the case mode as a plain boolean (typically `Session.caseSensitive`). IEC 61131-3 identifiers are case-insensitive by default; some dialects (e.g. B&R) are case-sensitive.
 */

/** Map an identifier to its lookup key under the given case mode. */
export function caseKey(name: string, caseSensitive: boolean): string {
  return caseSensitive ? name : name.toLowerCase()
}
