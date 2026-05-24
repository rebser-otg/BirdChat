export const MAX_NAME_LENGTH = 16
export const MAX_TEXT_LENGTH = 100

/**
 * Pack a {name, text} message into a compact JSON string for ggwave encoding.
 * Silently truncates name to MAX_NAME_LENGTH and text to MAX_TEXT_LENGTH.
 * @param {{ name: string, text: string }} msg
 * @returns {string} JSON string, always ≤ 140 bytes UTF-8
 */
export function pack({ name, text }) {
  const n = String(name).slice(0, MAX_NAME_LENGTH)
  const t = String(text).slice(0, MAX_TEXT_LENGTH)
  return JSON.stringify({ n, t })
}

/**
 * Unpack a JSON string decoded from ggwave back into {name, text}.
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
