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
  const text = r.kind === "ok" ? r.text : "";
  const needles = [
    "Барабан-картридж HP CF257A",
    "Тонер-картридж Canon C-EVX60",
    "EVX60",
    "106R03396",
    "113R00779",
    "022N02894",
    "Комплект роликов подачи автоподатчика Xerox 022N02894"
  ];
  for (const n of needles) {
    const first = text.indexOf(n);
    const last = text.lastIndexOf(n);
    console.log("\n", JSON.stringify(n), "first", first, "last", last);
    if (last >= 0 && last !== first) {
      console.log("--- slice from last ---\n", text.slice(last, last + 1800));
    } else if (first >= 0) {
      console.log("--- slice from first (only) ---\n", text.slice(first, first + 900));
    }
  }
})();
