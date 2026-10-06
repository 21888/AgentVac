import type { AgentVacEngine } from "./engine.js";
/** Called only behind main's sender/origin and exclusive-operation guard. */
export async function handlePrepareTrash(engine: AgentVacEngine, id: unknown) {
  if (typeof id !== "string") {
    engine.discardTrashConfirmation();
    throw new Error("无效请求。");
  }
  return engine.prepareTrash(id);
}
export async function handleCancelTrash(
  engine: AgentVacEngine,
  token: unknown,
) {
  if (typeof token !== "string") throw new Error("无效请求。");
  engine.cancelTrashConfirmation(token);
}
export async function handleTrash(
  engine: AgentVacEngine,
  id: unknown,
  confirmed: unknown,
  confirmedClosed: unknown,
  confirmationToken: unknown,
  trashItem: (directory: string) => Promise<void>,
) {
  if (
    typeof id !== "string" ||
    typeof confirmed !== "boolean" ||
    typeof confirmedClosed !== "boolean" ||
    typeof confirmationToken !== "string"
  ) {
    // A malformed attempt must not leave any pending challenge reusable.
    engine.discardTrashConfirmation();
    throw new Error("无效请求。");
  }
  return engine.trash(
    id,
    confirmed,
    confirmedClosed,
    confirmationToken,
    trashItem,
  );
}
