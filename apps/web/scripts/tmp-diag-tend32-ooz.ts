import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractFromBuffer, getExtractionConfigFromEnv } from "../../../packages/extraction/src/index.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

void (async () => {
  const p = path.resolve(
    __dirname,
    "../../../samples/regression-goods/Тенд32/Описание_объекта_закупки_на_поставку_картриджей_2026_итог.docx"
  );
  const buf = await readFile(p);
  const r = await extractFromBuffer({
    buffer: buf,
    filename: path.basename(p),
    mime: "",
    config: getExtractionConfigFromEnv()
  });
  const text = r.kind === "ok" ? r.text : JSON.stringify(r);
  const needles = ["CF257A", "C-EVX60", "106R03396", "JC93-00834A", "022N02894", "113R00779"];
  for (const n of needles) {
    const i = text.indexOf(n);
    console.log("\n===", n, "idx", i, "===");
    if (i >= 0) console.log(text.slice(Math.max(0, i - 280), i + 520).replace(/\n+/g, " | "));
  }
  const markers = ["Раздел 2", "Раздел II", "характеристик", "Характеристик", "Требования", "CF257A"];
  for (const m of markers) {
    const i = text.indexOf(m);
    console.log("marker", m, "idx", i);
  }
  const i257 = text.indexOf("CF257A");
  if (i257 >= 0) console.log("\n--- from CF257A +4000 ---\n", text.slice(i257, i257 + 4500));

  for (const needle of ["Барабан-картридж HP CF257A", "Тонер-картридж Canon C-EVX60", "022N02894", "Раздел 1.2"]) {
    const i = text.indexOf(needle);
    console.log(needle, "idx", i);
  }
  const i257b = text.lastIndexOf("CF257A");
  console.log("\n--- last CF257A context ---\n", text.slice(Math.max(0, i257b - 200), i257b + 2200));
})();
