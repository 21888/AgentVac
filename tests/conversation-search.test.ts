import test from "node:test";
import assert from "node:assert/strict";
import { ConversationContentMatcher } from "../electron/conversations/search.js";
for (const keyword of ["é", "éclair"])
  test("NFC continuation finds " + keyword, () => {
    const m = new ConversationContentMatcher(keyword);
    m.consume("same", "prefix e", true);
    m.consume("same", "\u0301clair", false);
    assert.equal(m.matched, true);
    assert.equal(m.partial, false);
  });
test("unfinished grapheme is not prematurely matched before composing accent arrives", () => {
  const m = new ConversationContentMatcher("e");
  m.consume("same", "e", true);
  assert.equal(m.matched, false);
  m.consume("same", "\u0301", false);
  assert.equal(m.matched, false);
});
test("independent parts never manufacture normalized cross-part keyword", () => {
  const m = new ConversationContentMatcher("é");
  m.consume("one", "e", true);
  m.consume("two", "\u0301", false);
  assert.equal(m.matched, false);
});
test("single-codepoint and Hangul composition remain searchable across short pages", () => {
  const m = new ConversationContentMatcher("각");
  m.consume("same", "\u1100", true);
  m.consume("same", "\u1161", true);
  m.consume("same", "\u11a8", false);
  assert.equal(m.matched, true);
});
test("pathological unbounded combining run reports partial rather than unlimited memory", () => {
  const m = new ConversationContentMatcher("absent");
  m.consume("same", "e" + "\u0301".repeat(20000), true);
  assert.equal(m.partial, true);
  m.finish();
  assert.equal(m.matched, false);
});
test("large normal text keeps keyword at streamed boundary and is not marked partial", () => {
  const m = new ConversationContentMatcher("target-word");
  m.consume("same", "x".repeat(50000) + "TARGET-", true);
  m.consume("same", "WORD" + "y".repeat(50000), false);
  assert.equal(m.matched, true);
  assert.equal(m.partial, false);
});
