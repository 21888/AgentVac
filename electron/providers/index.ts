import type { ProviderId } from "../../shared/types.js";
import type { ProviderAdapter } from "./types.js";
import { codexAdapter } from "./codex.js";
import { claudeCodeAdapter } from "./claude-code.js";
import { clineAdapter } from "./cline.js";
import { cursorAdapter } from "./cursor.js";
export const adapters: readonly ProviderAdapter[] = [codexAdapter, claudeCodeAdapter, clineAdapter, cursorAdapter];
export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === "string" && adapters.some(adapter => adapter.id === value);
}
export function getAdapter(value: unknown): ProviderAdapter {
  const adapter = adapters.find(adapter => adapter.id === value);
  if (!adapter) throw new Error("提供方标识无效。");
  return adapter;
}
