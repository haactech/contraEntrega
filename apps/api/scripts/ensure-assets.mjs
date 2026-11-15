// Garantiza que exista ../web/dist (wrangler falla si el directorio de assets no existe).
// Si la SPA aún no está construida, crea un index.html placeholder (dist está en .gitignore).
import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dist = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "web", "dist");
mkdirSync(dist, { recursive: true });
const index = join(dist, "index.html");
if (!existsSync(index)) {
  writeFileSync(
    index,
    '<!doctype html><html lang="es"><meta charset="utf-8"><title>Trato</title><p>Trato API en ejecución. La SPA aún no está construida (apps/web).</p></html>\n',
  );
}
