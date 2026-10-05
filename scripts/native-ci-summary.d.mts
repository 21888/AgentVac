export const requiredNativeChecks: readonly string[];
export function validateNativeEvidence(
  result: unknown,
  expected: Record<string, string | undefined>,
): string[];

export const requiredProviderChecks: readonly string[];
export function validateProviderEvidence(
  result: unknown,
  expected: Record<string, string | undefined>,
): string[];

export function validateConversationEvidence(
  result: unknown,
  expected: Record<string, string | undefined>,
): string[];
export function validateAclEvidence(
  result: unknown,
  expected: Record<string, string | undefined>,
): string[];

export function validateDurabilityEvidence(
  result: unknown,
  expected: Record<string, string | undefined>,
): string[];
