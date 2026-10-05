/** Adapted from the reviewed development Windows wire parser; arrays added with
 * fixed depth/node/item/key caps. Duplicate decoded keys are always rejected. */
export function decodeStrictJson(text: string): unknown {
  let offset = 0,
    nodes = 0;
  const invalid = (): never => {
    throw new Error("invalid-process-argv-protocol");
  };
  if (typeof text !== "string" || text.length > 640 * 1024) return invalid();
  const whitespace = () => {
    while (/[\x20\t\r\n]/u.test(text[offset] ?? "\0")) offset++;
  };
  const string = (key = false): string => {
    const start = offset;
    if (text[offset++] !== '"') return invalid();
    while (offset < text.length) {
      if (key && offset - start > 386) return invalid();
      const c = text.charCodeAt(offset++);
      if (c === 34) {
        const value: unknown = JSON.parse(text.slice(start, offset));
        if (typeof value !== "string" || (key && value.length > 64))
          return invalid();
        return value;
      }
      if (c < 32) return invalid();
      if (c === 92) {
        const escaped = text[offset++];
        if (escaped === "u") {
          if (!/^[0-9a-fA-F]{4}$/u.test(text.slice(offset, offset + 4)))
            return invalid();
          offset += 4;
        } else if (escaped === undefined || !'"\\/bfnrt'.includes(escaped))
          return invalid();
      }
    }
    return invalid();
  };
  const value = (depth: number): unknown => {
    if (++nodes > 2048 || depth > 5) return invalid();
    whitespace();
    const first = text[offset];
    if (first === '"') return string();
    if (first === "{") {
      offset++;
      const object: Record<string, unknown> = Object.create(null);
      const keys = new Set<string>();
      whitespace();
      if (text[offset] === "}") {
        offset++;
        return object;
      }
      while (offset < text.length) {
        whitespace();
        const key = string(true);
        if (keys.size >= 32 || keys.has(key)) return invalid();
        keys.add(key);
        whitespace();
        if (text[offset++] !== ":") return invalid();
        object[key] = value(depth + 1);
        whitespace();
        const separator = text[offset++];
        if (separator === "}") return object;
        if (separator !== ",") return invalid();
      }
      return invalid();
    }
    if (first === "[") {
      offset++;
      const array: unknown[] = [];
      whitespace();
      if (text[offset] === "]") {
        offset++;
        return array;
      }
      while (offset < text.length) {
        if (array.length >= 512) return invalid();
        array.push(value(depth + 1));
        whitespace();
        const separator = text[offset++];
        if (separator === "]") return array;
        if (separator !== ",") return invalid();
      }
      return invalid();
    }
    for (const [token, result] of [
      ["true", true],
      ["false", false],
      ["null", null],
    ] as const) {
      if (text.startsWith(token, offset)) {
        offset += token.length;
        return result;
      }
    }
    const numberPattern =
      /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/uy;
    numberPattern.lastIndex = offset;
    const token = numberPattern.exec(text)?.[0];
    if (!token || token.length > 32) return invalid();
    offset += token.length;
    const number = Number(token);
    if (!Number.isFinite(number)) return invalid();
    return number;
  };
  const result = value(0);
  whitespace();
  if (offset !== text.length) return invalid();
  return result;
}
