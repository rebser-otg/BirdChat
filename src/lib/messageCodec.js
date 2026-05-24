export const MAX_NAME_LENGTH = 16
export const MAX_TEXT_LENGTH = 100
// birdCodec wire format supports up to 142 bytes of payload.
// Keep headroom to 142 so multi-byte UTF-8 input (emoji, CJK) stays within codec capacity.
const MAX_PAYLOAD_BYTES = 142

/**
 * Pack a {name, text} message into a compact JSON string for acoustic encoding.
 * Truncates name to MAX_NAME_LENGTH chars, text to MAX_TEXT_LENGTH chars,
 * then further truncates text if the UTF-8 byte length exceeds MAX_PAYLOAD_BYTES.
 * @param {{ name: string, text: string }} msg
 * @returns {string} JSON string, always ≤ 142 bytes UTF-8
 */
export function pack({ name, text }) {
  const n = String(name).slice(0, MAX_NAME_LENGTH)
  let t = String(text).slice(0, MAX_TEXT_LENGTH)
  let packed = JSON.stringify({ n, t })
  // Safety: enforce byte limit for multi-byte UTF-8 (emoji, CJK, etc.)
  const encoder = new TextEncoder()
  while (encoder.encode(packed).length > MAX_PAYLOAD_BYTES && [...t].length > 0) {
    t = [...t].slice(0, -1).join('')
    packed = JSON.stringify({ n, t })
  }
  return packed
}

/**
 * Unpack a JSON string decoded from birdCodec back into {name, text}.
 * Returns null if the string is malformed or missing required fields.
 * @param {string} str
 * @returns {{ name: string, text: string } | null}
 */
export function unpack(str) {
  try {
    const parsed = JSON.parse(str)
    if (typeof parsed.n !== 'string' || typeof parsed.t !== 'string') return null
    return { name: parsed.n, text: parsed.t }
  } catch {
    return null
  }
}
