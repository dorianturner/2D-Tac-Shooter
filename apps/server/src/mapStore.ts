import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseMap, type MapDefinition } from "@tac/shared";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export const defaultMapsDir = join(repoRoot, "maps");
const mapIdPattern = /^[a-z0-9][a-z0-9-]*$/;

export interface MapSummary {
  id: string;
  name: string;
  version: number;
}

export function validateMapId(id: string): string {
  if (!mapIdPattern.test(id)) {
    throw new Error("Map id must use lowercase letters, numbers, and dashes");
  }
  return id;
}

export async function listMaps(mapsDir = defaultMapsDir): Promise<MapSummary[]> {
  await mkdir(mapsDir, { recursive: true });
  const files = await readdir(mapsDir);
  const maps: MapSummary[] = [];
  for (const file of files.filter((name) => name.endsWith(".json")).sort()) {
    const id = file.slice(0, -5);
    try {
      const map = await readMap(id, mapsDir);
      maps.push({ id: map.id, name: map.name, version: map.version });
    } catch {
      // Bad draft files should not break the editor map list.
    }
  }
  return maps;
}

export async function readMap(id: string, mapsDir = defaultMapsDir): Promise<MapDefinition> {
  const safeId = validateMapId(id);
  const raw = await readFile(join(mapsDir, `${safeId}.json`), "utf8");
  return parseMap(JSON.parse(raw));
}

export async function writeMap(id: string, value: unknown, mapsDir = defaultMapsDir): Promise<MapDefinition> {
  const safeId = validateMapId(id);
  const map = parseMap(value);
  if (map.id !== safeId) {
    throw new Error("Map id must match the request path");
  }
  await mkdir(mapsDir, { recursive: true });
  await writeFile(join(mapsDir, `${safeId}.json`), `${JSON.stringify(map, null, 2)}\n`, "utf8");
  return map;
}
