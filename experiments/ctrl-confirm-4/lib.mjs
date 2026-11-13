// ctrl-confirm-4: prereg loader and re-exports. Unit outcomes/endpoints are ctrl-confirm-2's (legacyValid, strictValid, designTable,
// adoption) and the inferential procedure is ctrl-confirm-3 stats.mjs - both unchanged and imported, never copied.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const EXPERIMENT_DIR = dirname(fileURLToPath(import.meta.url));
export const loadPrereg = (path = join(EXPERIMENT_DIR, "prereg.json")) => JSON.parse(readFileSync(path, "utf8"));
export { adoption, designTable, legacyValid, strictValid, functionalOf } from "../ctrl-confirm-2/lib.mjs";
export { hierarchy, coPrimaryDecision } from "../ctrl-confirm-3/stats.mjs";
