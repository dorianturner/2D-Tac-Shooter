import type { MapDefinition } from "./types.js";

export const sampleMap: MapDefinition = {
  id: "prototype-one",
  version: 1,
  name: "Signal Split",
  bounds: { width: 960, height: 640 },
  gridSize: 40,
  rooms: [
    { id: "west-room", name: "Blue Setup", position: { x: 96, y: 96 }, size: { x: 344, y: 424 } },
    { id: "east-room", name: "Orange Setup", position: { x: 520, y: 96 }, size: { x: 344, y: 424 } }
  ],
  walls: [
    { id: "north", a: { x: 80, y: 80 }, b: { x: 880, y: 80 }, thickness: 18, blocksVision: true, blocksMovement: true, blocksShooting: true, destructible: false },
    { id: "south", a: { x: 80, y: 560 }, b: { x: 880, y: 560 }, thickness: 18, blocksVision: true, blocksMovement: true, blocksShooting: true, destructible: false },
    { id: "west", a: { x: 80, y: 80 }, b: { x: 80, y: 560 }, thickness: 18, blocksVision: true, blocksMovement: true, blocksShooting: true, destructible: false },
    { id: "east", a: { x: 880, y: 80 }, b: { x: 880, y: 560 }, thickness: 18, blocksVision: true, blocksMovement: true, blocksShooting: true, destructible: false },
    { id: "mid-vertical", a: { x: 480, y: 110 }, b: { x: 480, y: 300 }, thickness: 16, blocksVision: true, blocksMovement: true, blocksShooting: true, destructible: false },
    { id: "breach-panel", a: { x: 480, y: 340 }, b: { x: 480, y: 500 }, thickness: 16, blocksVision: true, blocksMovement: true, blocksShooting: true, destructible: true },
    { id: "left-cover", a: { x: 240, y: 240 }, b: { x: 360, y: 240 }, thickness: 14, blocksVision: true, blocksMovement: true, blocksShooting: true, destructible: false },
    { id: "right-cover", a: { x: 600, y: 400 }, b: { x: 720, y: 400 }, thickness: 14, blocksVision: true, blocksMovement: true, blocksShooting: true, destructible: false }
  ],
  spawns: [
    { id: "p1", team: "blue", position: { x: 180, y: 320 }, angle: 0 },
    { id: "p2", team: "orange", position: { x: 780, y: 320 }, angle: Math.PI }
  ],
  objective: { id: "objective", position: { x: 480, y: 320 }, radius: 56 },
  sensors: [
    { id: "blue-camera", owner: "p1", kind: "camera", position: { x: 330, y: 150 }, angle: 0.35, range: 260, fov: Math.PI / 2.6 },
    { id: "orange-motion", owner: "p2", kind: "motion", position: { x: 650, y: 490 }, angle: Math.PI, range: 210, fov: Math.PI * 2 }
  ],
  utilityPlacements: [
    { id: "demo-breach", kind: "breach", position: { x: 438, y: 420 }, radius: 46, owner: "p1" },
    { id: "demo-smoke", kind: "smoke", position: { x: 560, y: 260 }, radius: 72, owner: "p2" }
  ],
  lighting: [
    { id: "west-light", position: { x: 260, y: 170 }, radius: 150, intensity: 0.8, destructible: true },
    { id: "east-light", position: { x: 710, y: 470 }, radius: 150, intensity: 0.8, destructible: true }
  ],
  notes: "Prototype map for tactical readability, breach routes, and sensor overlap."
};
