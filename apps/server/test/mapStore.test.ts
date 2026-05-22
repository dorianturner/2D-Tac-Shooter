import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { sampleMap } from "@tac/shared";
import { listMaps, readMap, writeMap } from "../src/mapStore.js";

describe("map store", () => {
  it("saves, lists, and reads validated maps", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tac-maps-"));
    await writeMap("prototype-one", sampleMap, dir);
    await expect(readMap("prototype-one", dir)).resolves.toMatchObject({ id: "prototype-one" });
    await expect(listMaps(dir)).resolves.toEqual([{ id: "prototype-one", name: "Signal Split", version: 1 }]);
    const raw = await readFile(join(dir, "prototype-one.json"), "utf8");
    expect(raw).toContain("\"rooms\"");
    const saved = JSON.parse(raw) as typeof sampleMap;
    expect(saved.walls[0]).toHaveProperty("preset");
    expect(saved.walls[0]).not.toHaveProperty("kind");
  });

  it("rejects invalid maps", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tac-maps-"));
    await expect(writeMap("bad-map", { id: "bad-map" }, dir)).rejects.toThrow();
  });
});
