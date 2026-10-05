export const requiredNativeChecks: readonly string[];
export function validateNativeEvidence(
  result: unknown,
  expected: Record<string, string | undefined>,
): string[];
