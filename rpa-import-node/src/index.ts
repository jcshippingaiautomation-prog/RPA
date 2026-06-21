// Public API for programmatic consumers (e.g. the rpa-web server).
export { runImport, previewRows, loadConfig, PROJECT_ROOT } from "./runner.js";
export type {
  RunOptions,
  RunResult,
  RowInfo,
  RowStatus,
} from "./runner.js";
export type { AppConfig } from "./types.js";
