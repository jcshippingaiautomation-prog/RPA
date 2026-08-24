// Public API for programmatic consumers (e.g. the rpa-web server).
export { runImport, previewRows, loadConfig, PROJECT_ROOT } from "./runner.js";
export type {
  RunOptions,
  RunResult,
  RowInfo,
  RowStatus,
} from "./runner.js";
export type { AppConfig } from "./types.js";
export { loadFieldRegistry, fieldRegistryPath, resolveSelector, fillableFields } from "./field-registry.js";
export type { FieldDef } from "./field-registry.js";
export { loadDctkRules, ruleFor, dependenciesFor } from "./dctk-rules.js";
export type { DctkRules, DctkFieldRule, DctkDependency } from "./dctk-rules.js";
