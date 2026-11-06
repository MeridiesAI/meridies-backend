/**
 * How many text-message segments a message costs.
 *
 * A text in the GSM-7 alphabet fits 160 characters in one segment, 153 in each
 * after that. One character outside it (an accented "á", a Chinese character,
 * a curly quote, the dash in the English divider) switches the whole message to
 * UCS-2: 70 characters in one segment, 67 in each after that. A Spanish or
 * Vietnamese text is therefore often UCS-2, and a Chinese, Arabic or Hindi one
 * always is. The composer shows the count and refuses a translated text past
 * `MAX_TRANSLATED_SEGMENTS`, so a family is never sent a dozen segments.
 *
 * The same file lives in the demo, the app and the backend. Pure.
 */

const GSM_BASIC =
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
/** Each of these costs two characters (an escape plus the character). */
const GSM_EXTENDED = "^{}\\[~]|€\f";

export type SmsCost = {
  encoding: "GSM-7" | "UCS-2";
  /** Characters counted the way the carrier counts them. */
  units: number;
  segments: number;
};

export function smsSegments(text: string): SmsCost {
  let units = 0;
  let gsm = true;
  for (const ch of text) {
    if (GSM_BASIC.includes(ch)) units += 1;
    else if (GSM_EXTENDED.includes(ch)) units += 2;
    else {
      gsm = false;
      break;
    }
  }
  if (gsm) {
    return { encoding: "GSM-7", units, segments: units === 0 ? 0 : units <= 160 ? 1 : Math.ceil(units / 153) };
  }
  // UCS-2 counts UTF-16 code units, so an emoji is two.
  const ucs = text.length;
  return { encoding: "UCS-2", units: ucs, segments: ucs === 0 ? 0 : ucs <= 70 ? 1 : Math.ceil(ucs / 67) };
}

/** The longest an untranslated text can be, in characters (the composer's existing cap). */
export const TEXT_CHAR_LIMIT = 320;

/** The most segments a translated or bilingual text may take. */
export const MAX_TRANSLATED_SEGMENTS = 6;

/** Whether a text is over its cap: characters for English, segments once translated. */
export function smsOverLimit(text: string, translated: boolean): boolean {
  if (!translated) return text.length > TEXT_CHAR_LIMIT;
  return smsSegments(text).segments > MAX_TRANSLATED_SEGMENTS;
}
