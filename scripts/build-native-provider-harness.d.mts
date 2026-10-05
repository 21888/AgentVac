export function buildNativeProviderHarness(projectRoot?: string): Promise<{
  format: string;
  source: string;
  output: string;
  bundleSha256: string;
  workerSha256: string;
  sourceDigest: string;
  files: Array<{ path: string; sha256: string }>;
}>;
