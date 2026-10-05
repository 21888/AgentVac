import { pathToFileURL } from "node:url";

interface RendererFrame {
  readonly url: string;
}
interface RendererContents {
  readonly mainFrame: RendererFrame;
}
interface RendererEvent {
  readonly sender: unknown;
  readonly senderFrame: RendererFrame | null;
}

/** Use this exact URL both for loadURL and for the IPC allowlist. */
export function rendererFileUrl(filePath: string): string {
  return pathToFileURL(filePath).href;
}

export function isTrustedRendererEvent(
  event: RendererEvent,
  contents: RendererContents,
  fileUrl: string,
  devUrl?: string,
): boolean {
  if (
    event.sender !== contents ||
    event.senderFrame === null ||
    event.senderFrame !== contents.mainFrame
  )
    return false;
  // Production accepts one exact serialized URL. Do not decode, fold case,
  // strip fragments, resolve alternate paths, or broaden to a file: origin.
  if (!devUrl) return event.senderFrame.url === fileUrl;
  try {
    return new URL(event.senderFrame.url).origin === new URL(devUrl).origin;
  } catch {
    return false;
  }
}
