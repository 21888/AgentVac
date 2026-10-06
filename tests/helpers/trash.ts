import type { AgentVacEngine } from "../../electron/engine.js";
/** Generated-fixture convenience; all consent is supplied explicitly by the test. */
export async function trashFixture(
  engine: AgentVacEngine,
  batchId: string,
  confirmed: boolean,
  confirmedClosed: boolean,
  move: (directory: string) => Promise<void>,
) {
  const confirmation = await engine.prepareTrash(batchId);
  return engine.trash(
    batchId,
    confirmed,
    confirmedClosed,
    confirmation.token,
    move,
  );
}
