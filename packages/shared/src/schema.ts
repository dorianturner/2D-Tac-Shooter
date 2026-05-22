import { z } from "zod";
import { normalizeMapDefinition } from "./editorGeometry.js";
import type { MapDefinition } from "./types.js";

const vec2 = z.object({ x: z.number(), y: z.number() });
const playerId = z.string().regex(/^p[1-9][0-9]*$/);

export const wallSchema = z.object({
  id: z.string().min(1),
  preset: z.enum(["wall", "window", "mesh", "breakable-wall", "door", "deployable-wall"]).optional(),
  kind: z.enum(["solid", "destructible", "transparent", "door", "mesh"]).optional(),
  label: z.string().optional(),
  roomId: z.string().optional(),
  hinge: vec2.optional(),
  closedA: vec2.optional(),
  closedB: vec2.optional(),
  openAngle: z.number().optional(),
  currentAngle: z.number().optional(),
  angularVelocity: z.number().optional(),
  a: vec2,
  b: vec2,
  thickness: z.number().positive(),
  blocksVision: z.boolean(),
  blocksMovement: z.boolean(),
  blocksShooting: z.boolean().optional(),
  destructible: z.boolean(),
  hp: z.number().optional(),
  maxHp: z.number().optional(),
  destroyed: z.boolean().optional()
});

export const roomSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  position: vec2,
  size: vec2
});

export const utilityPlacementSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["emp", "breach", "fake-noise", "smoke", "flash", "signal-spoof"]),
  position: vec2,
  radius: z.number().positive(),
  owner: playerId.optional()
});

export const lightNodeSchema = z.object({
  id: z.string().min(1),
  position: vec2,
  radius: z.number().positive(),
  intensity: z.number().min(0).max(1),
  destructible: z.boolean(),
  destroyed: z.boolean().optional()
});

export const mapSchema = z.object({
  id: z.string().min(1),
  version: z.number().int().positive(),
  name: z.string().min(1),
  bounds: z.object({
    width: z.number().positive(),
    height: z.number().positive()
  }),
  gridSize: z.number().positive().optional(),
  rooms: z.array(roomSchema).optional(),
  walls: z.array(wallSchema),
  spawns: z.array(
    z.object({
      id: playerId,
      team: z.enum(["blue", "orange"]),
      position: vec2,
      angle: z.number()
    })
  ).min(2),
  sensors: z.array(
    z.object({
      id: z.string().min(1),
      owner: playerId,
      kind: z.enum(["camera", "motion", "sound"]),
      position: vec2,
      angle: z.number(),
      range: z.number().positive(),
      fov: z.number().positive(),
      corrupted: z.boolean().optional(),
      destroyed: z.boolean().optional()
    })
  ),
  utilityPlacements: z.array(utilityPlacementSchema).optional(),
  lighting: z.array(lightNodeSchema).optional(),
  notes: z.string().optional()
});

export function parseMap(value: unknown): MapDefinition {
  return normalizeMapDefinition(mapSchema.parse(value) as MapDefinition);
}
