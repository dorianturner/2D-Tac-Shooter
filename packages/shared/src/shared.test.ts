import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createSegmentFromPreset, createWall, deleteWallsById, hasLineOfSight, insertDoorGap, normalizeWallKind, parseMap, playerClassPresets, replaceWallSection, sampleMap, segmentPresetDefaults, slugifyMapName, validateDoorSwing, wallKindDefaults, weaponPresets } from "./index.js";

describe("shared tactical primitives", () => {
  it("validates the sample map", () => {
    expect(parseMap(sampleMap).id).toBe("prototype-one");
    expect(parseMap(sampleMap).rooms?.[0]?.name).toBe("Blue Setup");
  });

  it("accepts editor wall metadata while keeping older maps valid", () => {
    expect(parseMap({ ...sampleMap, gridSize: 32, walls: [{ ...sampleMap.walls[0]!, kind: "mesh", label: "mesh" }] }).walls[0]?.preset).toBe("mesh");
    const singleObjectiveMap = { ...sampleMap, objective: { id: "objective", position: { x: 320, y: 240 }, radius: 60 } } as Record<string, unknown>;
    delete singleObjectiveMap.objectives;
    expect(parseMap(singleObjectiveMap).objective?.radius).toBe(60);
    const multiObjective = parseMap({
      ...sampleMap,
      objective: undefined,
      objectives: [
        { id: "alpha", position: { x: 320, y: 240 }, radius: 48 },
        { id: "bravo", position: { x: 640, y: 240 }, radius: 52 }
      ]
    });
    expect(multiObjective.objectives?.map((objective) => objective.id)).toEqual(["alpha", "bravo"]);
    expect(multiObjective.objective?.id).toBe("alpha");
    const { gridSize: _gridSize, ...legacyMap } = sampleMap;
    expect(parseMap({ ...legacyMap, walls: legacyMap.walls.map(({ kind: _kind, ...wall }) => wall) }).id).toBe("prototype-one");
  });

  it("accepts additional team spawns for nvn maps", () => {
    const parsed = parseMap({
      ...sampleMap,
      spawns: [
        { id: "p1", team: "blue", position: { x: 10, y: 10 }, angle: 0 },
        { id: "p2", team: "blue", position: { x: 10, y: 30 }, angle: 0 },
        { id: "p3", team: "orange", position: { x: 90, y: 10 }, angle: Math.PI },
        { id: "p4", team: "orange", position: { x: 90, y: 30 }, angle: Math.PI }
      ]
    });
    expect(parsed.spawns.map((spawn) => spawn.id)).toEqual(["p1", "p2", "p3", "p4"]);
  });

  it("keeps shotgun vision aligned with the assault rifle and defines pellets", () => {
    expect(weaponPresets.shotgun.visionRange).toBe(weaponPresets.assault.visionRange);
    expect(weaponPresets.shotgun.visionFov).toBe(weaponPresets.assault.visionFov);
    expect(weaponPresets.shotgun.damage).toBe(1);
    expect(weaponPresets.shotgun.pelletCount).toBeGreaterThan(1);
    expect(weaponPresets.shotgun.spreadRadians).toBeGreaterThan((20 * Math.PI) / 180);
    expect(weaponPresets.sniper.effectiveRange).toBe(Number.POSITIVE_INFINITY);
    expect(weaponPresets.sniper.moveSpeed).toBeLessThan(weaponPresets.assault.moveSpeed);
    expect(weaponPresets.assault.moveSpeed).toBeLessThan(weaponPresets.shotgun.moveSpeed);
    expect(weaponPresets.shotgun.moveSpeed).toBe(200);
  });

  it("defines class abilities for operator, scout, and breacher presets", () => {
    expect(playerClassPresets.operator.ability.id).toBe("tactical-ping");
    expect(playerClassPresets.scout.ability.id).toBe("dash");
    expect(playerClassPresets.breacher.ability.id).toBe("breach-any");
    expect(playerClassPresets.operator.ability.cooldownTicks).toBeGreaterThan(0);
  });

  it("normalizes legacy destructible wall kinds into a property", () => {
    const normalized = normalizeWallKind({ ...sampleMap.walls[0]!, kind: "destructible" as "solid", label: "destructible", destructible: false });
    expect(normalized.preset).toBe("breakable-wall");
    expect(normalized.destructible).toBe(true);
  });

  it("uses mesh defaults that block movement but not vision", () => {
    expect(wallKindDefaults("mesh")).toMatchObject({ blocksMovement: true, blocksVision: false, blocksShooting: false, destructible: false });
  });

  it("creates segment presets with explicit gameplay properties", () => {
    expect(segmentPresetDefaults.window).toMatchObject({ blocksVision: false, blocksMovement: true, blocksShooting: true });
    expect(segmentPresetDefaults.mesh).toMatchObject({ blocksVision: false, blocksMovement: true, blocksShooting: false, thickness: 5 });
    expect(createSegmentFromPreset("breakable", "breakable-wall", { x: 0, y: 0 }, { x: 10, y: 0 })).toMatchObject({ preset: "breakable-wall", destructible: true, blocksShooting: true });
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
    expect(parsed.walls.map((wall) => wall.preset)).toEqual(["breakable-wall", "window", "mesh", "door"]);
    expect(parsed.walls.map((wall) => wall.blocksShooting)).toEqual([true, true, false, true]);
    expect(parseMap({ ...sampleMap, walls: [createWall("custom-hp", "solid", { x: 0, y: 0 }, { x: 10, y: 0 }, 10, { destructible: true, maxHp: 3 })] }).walls[0]?.maxHp).toBe(3);
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
    expect(next.map((wall) => wall.preset).sort()).toEqual(["door", "wall", "wall"]);
    expect(next.some((wall) => wall.id === "wall-1")).toBe(false);
    expect(next.find((wall) => wall.preset === "door")?.blocksMovement).toBe(false);
  });

  it("validates door swing clearance against blocking geometry", () => {
    const clearWalls = insertDoorGap([createWall("wall-1", "solid", { x: 0, y: 50 }, { x: 120, y: 50 }, 10)], "wall-1", { x: 60, y: 50 }, 30, "door-clear");
    expect(validateDoorSwing(clearWalls, clearWalls.find((wall) => wall.preset === "door")!)).toEqual({ valid: true });

    const northBlocked = [
      createWall("north", "solid", { x: 0, y: 0 }, { x: 160, y: 0 }, 18),
      createWall("door", "door", { x: 80, y: 72 }, { x: 80, y: 8 }, 6)
    ];
    expect(validateDoorSwing(northBlocked, northBlocked[1]!).blockerId).toBe("north");

    const westBlocked = [
      createWall("west", "solid", { x: 0, y: 0 }, { x: 0, y: 160 }, 18),
      createWall("door", "door", { x: 8, y: 80 }, { x: 72, y: 80 }, 6)
    ];
    expect(validateDoorSwing(westBlocked, westBlocked[1]!).blockerId).toBe("west");
  });

  it("keeps the saved test map free of door swing blockers", () => {
    const map = parseMap(JSON.parse(readFileSync(resolve(process.cwd(), "../../maps/test-map.json"), "utf8")));
    const blockedDoor = map.walls.find((wall) => wall.preset === "door" && !validateDoorSwing(map.walls, wall).valid);
    expect(blockedDoor).toBeUndefined();
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
    expect(next.map((wall) => wall.preset).sort()).toEqual(["mesh", "wall", "wall"]);
    expect(next.find((wall) => wall.id === "mesh-1")?.blocksVision).toBe(false);
  });

  it("normalizes save names to valid map ids", () => {
    expect(slugifyMapName("  My Cool Map!! ")).toBe("my-cool-map");
  });
});
