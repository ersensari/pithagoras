/**
 * What is never read aloud: the portal's own [Audio mode] marker when the model echoes it,
 * and bare web addresses (a markdown link's address is already gone by the time this runs).
 */
export function stripUnspoken(text: string): string {
  return text.replace(/\[\s*audio mode\s*\]:?/gi, "").replace(/\b(?:https?:\/\/|www\.)[^\s<>)\]]*[^\s<>)\].,;:!?'\"]/gi, "");
}
