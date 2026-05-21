import { describe, expect, it } from "vitest";
import { createWall, type MapDefinition } from "@tac/shared";
import { applyClientMessage, createRoom, joinRoom, snapshotFor, stepRoom } from "../src/sim.js";

describe("authoritative simulation", () => {
  it("filters hidden opponents out of snapshots", () => {
    const room = createRoom("test");
    joinRoom(room, false, "p1");
    joinRoom(room, false, "p2");
    for (let i = 0; i < 61; i += 1) stepRoom(room);
    const snapshot = snapshotFor(room, "p1");
    expect(snapshot.visiblePlayers).toHaveLength(0);
    expect(snapshot.debug).toBeUndefined();
  });

  it("reveals opponents in direct line of sight", () => {
    const room = createRoom("test");
    joinRoom(room, false, "p1");
    joinRoom(room, false, "p2");
    room.map.walls = room.map.walls.map((wall) => wall.id.includes("mid") || wall.id === "breach-panel" ? { ...wall, destroyed: true } : wall);
    room.players.p2.position = { x: 360, y: 320 };
    for (let i = 0; i < 61; i += 1) stepRoom(room);
    expect(snapshotFor(room, "p1").visiblePlayers[0]?.id).toBe("p2");
  });

  it("records breach events and changes wall state", () => {
    const room = createRoom("test");
    joinRoom(room, false, "p1");
    joinRoom(room, false, "p2");
    room.players.p1.position = { x: 430, y: 420 };
    for (let i = 0; i < 61; i += 1) stepRoom(room);
    applyClientMessage(room, "p1", { type: "command", seq: 1, tick: room.tick, move: { x: 0, y: 0 }, aim: 0, fire: false, use: "breach" });
    stepRoom(room);
    expect(room.map.walls.find((wall) => wall.id === "breach-panel")?.destroyed).toBe(true);
    expect(room.replay.events.some((event) => event.type === "wall-destroyed")).toBe(true);
  });

  it("uses supplied map and spawn positions", () => {
    const map = testMap();
    map.spawns[0]!.position = { x: 40, y: 50 };
    const room = createRoom("custom", map);
    expect(room.map.id).toBe("custom-map");
    expect(room.players.p1.position).toEqual({ x: 40, y: 50 });
  });

  it("initializes and moves hinged doors when pushed", () => {
    const map = testMap();
    map.walls.push(createWall("door-1", "door", { x: 120, y: 90 }, { x: 120, y: 150 }, 8));
    const room = createRoom("doors", map);
    joinRoom(room, false, "p1");
    joinRoom(room, false, "p2");
    room.players.p1.position = { x: 100, y: 120 };
    for (let i = 0; i < 61; i += 1) stepRoom(room);
    applyClientMessage(room, "p1", { type: "command", seq: 1, tick: room.tick, move: { x: 1, y: 0 }, aim: 0, fire: false, use: "none" });
    for (let i = 0; i < 8; i += 1) stepRoom(room);
    const door = room.map.walls.find((wall) => wall.id === "door-1");
    expect(door?.hinge).toEqual({ x: 120, y: 90 });
    expect(Math.abs(door?.currentAngle ?? 0)).toBeGreaterThan(0);
  });

  it("enforces assault rifle cadence and kills a player in five hits", () => {
    const room = activeRoom(testMap());
    applyClientMessage(room, "p1", { type: "command", seq: 1, tick: room.tick, move: { x: 0, y: 0 }, aim: 0, fire: true, use: "none" });
    stepRoom(room);
    expect(room.players.p2.hp).toBe(4);
    stepRoom(room);
    stepRoom(room);
    expect(room.players.p2.hp).toBe(4);
    for (let i = 0; i < 15; i += 1) stepRoom(room);
    expect(room.round.winner).toBe("p1");
    expect(room.round.scores.p1).toBe(1);
    expect(room.replay.events.some((event) => event.type === "kill" && event.target === "p2")).toBe(true);
  });

  it("ends the match when a player wins two rounds", () => {
    const room = activeRoom(testMap());
    shootUntilRoundEnds(room);
    expect(room.round.phase).toBe("countdown");
    for (let i = 0; i < 46; i += 1) stepRoom(room);
    shootUntilRoundEnds(room);
    expect(room.round.phase).toBe("ended");
    expect(room.round.matchWinner).toBe("p1");
  });

  it("expires the timer as a draw without awarding a point", () => {
    const room = activeRoom(testMap());
    room.tick = room.round.endsAtTick - 1;
    stepRoom(room);
    expect(room.round.winner).toBe("draw");
    expect(room.round.scores).toEqual({ p1: 0, p2: 0 });
  });

  it("destroys transparent and mesh surfaces in one shot", () => {
    const map = testMap();
    map.walls.push(createWall("glass", "transparent", { x: 100, y: 80 }, { x: 100, y: 160 }, 8, { destructible: true }));
    map.walls.push(createWall("mesh", "mesh", { x: 160, y: 80 }, { x: 160, y: 160 }, 8, { destructible: true }));
    const room = activeRoom(map);
    applyClientMessage(room, "p1", { type: "command", seq: 1, tick: room.tick, move: { x: 0, y: 0 }, aim: 0, fire: true, use: "none" });
    stepRoom(room);
    expect(room.map.walls.find((wall) => wall.id === "glass")?.destroyed).toBe(true);
    expect(room.map.walls.find((wall) => wall.id === "mesh")?.destroyed).toBe(true);
  });

  it("destroys destructible solid walls after five shots and never destroys doors", () => {
    const map = testMap();
    map.spawns[1]!.position = { x: 260, y: 180 };
    map.walls.push(createWall("panel", "solid", { x: 110, y: 80 }, { x: 110, y: 160 }, 8, { destructible: true }));
    map.walls.push(createWall("door-target", "door", { x: 170, y: 80 }, { x: 170, y: 160 }, 8, { destructible: true }));
    const room = activeRoom(map);
    applyClientMessage(room, "p1", { type: "command", seq: 1, tick: room.tick, move: { x: 0, y: 0 }, aim: 0, fire: true, use: "none" });
    for (let i = 0; i < 13; i += 1) stepRoom(room);
    expect(room.map.walls.find((wall) => wall.id === "panel")?.destroyed).toBe(true);
    for (let i = 0; i < 4; i += 1) stepRoom(room);
    expect(room.map.walls.find((wall) => wall.id === "door-target")?.destroyed).not.toBe(true);
  });

  it("requires both players to request a rematch before resetting scores", () => {
    const room = activeRoom(testMap());
    shootUntilRoundEnds(room);
    for (let i = 0; i < 46; i += 1) stepRoom(room);
    shootUntilRoundEnds(room);
    applyClientMessage(room, "p1", { type: "rematch" });
    expect(room.round.phase).toBe("ended");
    applyClientMessage(room, "p2", { type: "rematch" });
    expect(room.round.phase).toBe("countdown");
    expect(room.round.scores).toEqual({ p1: 0, p2: 0 });
    expect(room.players.p1.hp).toBe(5);
  });
});

function activeRoom(map: MapDefinition) {
  const room = createRoom("combat", map);
  joinRoom(room, false, "p1");
  joinRoom(room, false, "p2");
  for (let i = 0; i < 46; i += 1) stepRoom(room);
  return room;
}

function shootUntilRoundEnds(room: ReturnType<typeof activeRoom>): void {
  applyClientMessage(room, "p1", { type: "command", seq: room.tick, tick: room.tick, move: { x: 0, y: 0 }, aim: 0, fire: true, use: "none" });
  for (let i = 0; i < 14 && room.round.phase === "active"; i += 1) stepRoom(room);
}

function testMap(): MapDefinition {
  return {
    id: "custom-map",
    version: 1,
    name: "Custom Map",
    bounds: { width: 300, height: 240 },
    gridSize: 40,
    walls: [],
    spawns: [
      { id: "p1", team: "blue", position: { x: 50, y: 120 }, angle: 0 },
      { id: "p2", team: "orange", position: { x: 250, y: 120 }, angle: Math.PI }
    ],
    sensors: []
  };
}
