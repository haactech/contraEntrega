// Copia apps/api/.dev.vars.example -> apps/api/.dev.vars si no existe (nunca sobrescribe).
import { copyFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const api = join(dirname(fileURLToPath(import.meta.url)), "..", "apps", "api");
const target = join(api, ".dev.vars");
if (existsSync(target)) {
  console.log(".dev.vars ya existe: no se modifica.");
} else {
  copyFileSync(join(api, ".dev.vars.example"), target);
  console.log("Creado apps/api/.dev.vars desde .dev.vars.example (PIN demo: 1234).");
}
