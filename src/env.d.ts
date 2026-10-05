/// <reference types="vite/client" />
import type { AgentVacAPI } from "../shared/types";

declare global {
  interface Window {
    agentvac: AgentVacAPI;
  }
}
export {};
