/** Escaping for text that ends up inside generated markup; reporters pass every string they did not write themselves through these. */

const ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

/** Escape `text` for HTML element content and quoted attribute values. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ENTITIES[c] ?? c)
}

// Characters XML 1.0 cannot represent at all, even escaped: C0 controls other than tab, LF and CR, the U+FFFE and U+FFFF non-characters, and lone surrogates.
// eslint-disable-next-line no-control-regex
const XML_INVALID = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g

/** Escape `text` for XML text and attribute values, dropping the characters XML 1.0 forbids. */
export function escapeXml(text: string): string {
  return text.replace(XML_INVALID, '').replace(/[&<>"']/g, (c) => (c === "'" ? '&apos;' : (ENTITIES[c] ?? c)))
}

/** Escape `text` for the data part of a GitHub Actions workflow command (`::error ...::<data>`), so a message cannot end the command or start another one. */
export function escapeWorkflowData(text: string): string {
  return text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')
}

/** Escape `text` for a property value of a GitHub Actions workflow command (`file=`, `title=`, ...). */
export function escapeWorkflowProperty(text: string): string {
  return escapeWorkflowData(text).replace(/:/g, '%3A').replace(/,/g, '%2C')
}
