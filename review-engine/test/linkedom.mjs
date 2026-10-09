/**
 * linkedom(가짜 DOM)을 찾아서 준다.
 *
 * 이 폴더에 node_modules 를 새로 만들지 않고 저장소 안에 이미 있는 것을 쓴다 —
 * labeling/test-heuristic.mjs 와 같은 방침. 없으면 null 을 주고,
 * 호출부가 "건너뜀"으로 처리한다(테스트 실패로 치지 않는다).
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const CANDIDATES = [
  "../node_modules/linkedom/esm/index.js",
  "../../archive/clearclause-fulldemo/extension/node_modules/linkedom/esm/index.js",
  "../../node_modules/linkedom/esm/index.js",
];

export async function loadLinkedom() {
  for (const rel of CANDIDATES) {
    const p = path.join(HERE, rel);
    if (existsSync(p)) return await import(pathToFileURL(p).href);
  }
  return null;
}
