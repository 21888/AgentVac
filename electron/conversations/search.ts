/** Locale-independent caseless NFC matching, with bounded raw continuation state. */
export const normalizeSearch = (text: string) =>
  text.normalize("NFC").toUpperCase().normalize("NFC");
const MAX_SUFFIX = 8192;
// Four trailing starters also retain the short Hangul L/V/T composition sequence.
function stableBoundary(text: string) {
  let i = text.length,
    starters = 0;
  while (i > 0) {
    const low = text.charCodeAt(i - 1);
    let start = i - 1;
    if (low >= 0xdc00 && low <= 0xdfff && start > 0) {
      const high = text.charCodeAt(start - 1);
      if (high >= 0xd800 && high <= 0xdbff) start--;
    }
    if (!/^\p{M}$/u.test(text.slice(start, i)) && ++starters === 4)
      return start;
    i = start;
  }
  return 0;
}
export class ConversationContentMatcher {
  private key = "";
  private suffix = "";
  readonly needle: string;
  matched = false;
  partial = false;
  constructor(keyword: string) {
    this.needle = normalizeSearch(keyword);
  }
  private inspect(text: string) {
    if (normalizeSearch(text).includes(this.needle)) this.matched = true;
  }
  finish() {
    this.inspect(this.suffix);
    this.suffix = "";
    this.key = "";
  }
  consume(key: string, text: string, continued: boolean) {
    if (this.key && key !== this.key) this.finish();
    this.key = key;
    const raw = this.suffix + text;
    if (!continued) {
      this.inspect(raw);
      this.suffix = "";
      return;
    }
    const boundary = stableBoundary(raw);
    this.inspect(raw.slice(0, boundary));
    let keep = Math.max(0, raw.length - MAX_SUFFIX);
    if (
      keep &&
      raw.charCodeAt(keep) >= 0xdc00 &&
      raw.charCodeAt(keep) <= 0xdfff
    )
      keep++;
    // A pathological unfinished normalization sequence is not called complete.
    if (boundary < keep) this.partial = true;
    this.suffix = raw.slice(keep);
  }
}
