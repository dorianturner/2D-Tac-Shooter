import { describe, expect, it } from "vitest";
import { createWall, deleteWallsById, hasLineOfSight, insertDoorGap, normalizeWallKind, parseMap, replaceWallSection, sampleMap, slugifyMapName, wallKindDefaults } from "./index.js";

describe("shared tactical primitives", () => {
  it("validates the sample map", () => {
    expect(parseMap(sampleMap).id).toBe("prototype-one");
    expect(parseMap(sampleMap).rooms?.[0]?.name).toBe("Blue Setup");
  });

  it("accepts editor wall metadata while keeping older maps valid", () => {
    expect(parseMap({ ...sampleMap, gridSize: 32, walls: [{ ...sampleMap.walls[0]!, kind: "mesh", label: "mesh" }] }).walls[0]?.kind).toBe("mesh");
    const { gridSize: _gridSize, ...legacyMap } = sampleMap;
    expect(parseMap({ ...legacyMap, walls: legacyMap.walls.map(({ kind: _kind, ...wall }) => wall) }).id).toBe("prototype-one");
  });

  it("normalizes legacy destructible wall kinds into a property", () => {
    const normalized = normalizeWallKind({ ...sampleMap.walls[0]!, kind: "destructible" as "solid", label: "destructible", destructible: false });
    expect(normalized.kind).toBe("solid");
    expect(normalized.destructible).toBe(true);
  });

  it("uses mesh defaults that block movement but not vision", () => {
    expect(wallKindDefaults("mesh")).toMatchObject({ blocksMovement: true, blocksVision: false, destructible: false });
  });

  it("accepts destructible as a property on all wall kinds", () => {
    const walls = [
      createWall("solid", "solid", { x: 0, y: 0 }, { x: 10, y: 0 }, 10, { destructible: true }),
      createWall("transparent", "transparent", { x: 0, y: 10 }, { x: 10, y: 10 }, 10, { destructible: true }),
      createWall("mesh", "mesh", { x: 0, y: 20 }, { x: 10, y: 20 }, 10, { destructible: true }),
      createWall("door", "door", { x: 0, y: 30 }, { x: 10, y: 30 }, 10, { destructible: true })
    ];
    const parsed = parseMap({ ...sampleMap, walls });
    expect(parsed.walls.every((wall) => wall.destructible)).toBe(true);
    expect(parsed.walls.map((wall) => wall.kind)).toEqual(["solid", "transparent", "mesh", "door"]);
  });

  it("blocks and opens line of sight after destruction", () => {
    const blocked = hasLineOfSight(sampleMap, { x: 430, y: 420 }, { x: 530, y: 420 });
    expect(blocked).toBe(false);

    const breached = {
      ...sampleMap,
      walls: sampleMap.walls.map((wall) => wall.id === "breach-panel" ? { ...wall, destroyed: true } : wall)
    };
    expect(hasLineOfSight(breached, { x: 430, y: 420 }, { x: 530, y: 420 })).toBe(true);
  });

  it("inserts a door by creating a real geometry gap", () => {
    const walls = [createWall("wall-1", "solid", { x: 0, y: 0 }, { x: 100, y: 0 }, 10)];
    const next = insertDoorGap(walls, "wall-1", { x: 50, y: 0 }, 30, "door-1");
    expect(next.map((wall) => wall.kind).sort()).toEqual(["door", "solid", "solid"]);
    expect(next.some((wall) => wall.id === "wall-1")).toBe(false);
    expect(next.find((wall) => wall.kind === "door")?.blocksMovement).toBe(false);
  });

  it("deletes all selected geometry ids", () => {
    const walls = [
      createWall("keep", "solid", { x: 0, y: 0 }, { x: 20, y: 0 }),
      createWall("delete-a", "solid", { x: 0, y: 10 }, { x: 20, y: 10 }),
      createWall("delete-b", "transparent", { x: 0, y: 20 }, { x: 20, y: 20 })
    ];
    expect(deleteWallsById(walls, new Set(["delete-a", "delete-b"])).map((wall) => wall.id)).toEqual(["keep"]);
  });

  it("replaces an overlapped wall section with special geometry", () => {
    const walls = [createWall("wall-1", "solid", { x: 0, y: 0 }, { x: 100, y: 0 })];
    const replacement = createWall("mesh-1", "mesh", { x: 40, y: 0 }, { x: 70, y: 0 });
    const next = replaceWallSection(walls, replacement);
    expect(next.map((wall) => wall.kind).sort()).toEqual(["mesh", "solid", "solid"]);
    expect(next.find((wall) => wall.id === "mesh-1")?.blocksVision).toBe(false);
  });

  it("normalizes save names to valid map ids", () => {
    expect(slugifyMapName("  My Cool Map!! ")).toBe("my-cool-map");
  });
});
