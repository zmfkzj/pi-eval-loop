// ctrl-confirm-3: prereg loader. Endpoints/unit outcomes are ctrl-confirm-2's (legacyValid, strictValid, designTable, adoption),
// unchanged and imported from there; the inferential procedure is stats.mjs.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const EXPERIMENT_DIR = dirname(fileURLToPath(import.meta.url));
export const loadPrereg = (path = join(EXPERIMENT_DIR, "prereg.json")) => JSON.parse(readFileSync(path, "utf8"));
export { adoption, designTable, legacyValid, strictValid, functionalOf } from "../ctrl-confirm-2/lib.mjs";
