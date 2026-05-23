import { describe, expect, it } from "vitest";
import { createWall, distanceToSegment, type MapDefinition } from "@tac/shared";
import { applyClientMessage, createRoom, isExpiredUnfilledLobby, joinRoom, snapshotFor, stepRoom } from "../src/sim.js";
import { OBJECTIVE_CAPTURE_TICKS, ROUND_TICKS } from "../src/sim/config.js";

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

  it("sizes lobbies from map spawns and waits for all team members", () => {
    const map = testMap();
    map.spawns = [
      { id: "p1", team: "blue", position: { x: 40, y: 90 }, angle: 0 },
      { id: "p2", team: "blue", position: { x: 40, y: 150 }, angle: 0 },
      { id: "p3", team: "orange", position: { x: 260, y: 90 }, angle: Math.PI },
      { id: "p4", team: "orange", position: { x: 260, y: 150 }, angle: Math.PI }
    ];
    const room = createRoom("team-room", map);
    expect(Object.keys(room.slots)).toHaveLength(4);
    expect(joinRoom(room, false)?.playerId).toBe("p1");
    expect(joinRoom(room, false)?.playerId).toBe("p2");
    expect(joinRoom(room, false)?.playerId).toBe("p3");
    expect(room.round.phase).toBe("lobby");
    expect(joinRoom(room, false)?.playerId).toBe("p4");
    expect(room.round.phase).toBe("countdown");
  });

  it("keeps one-player rooms in the lobby phase while waiting", () => {
    const room = createRoom("waiting", testMap());
    const welcome = joinRoom(room, false, "p1");
    expect(welcome?.playerId).toBe("p1");
    for (let i = 0; i < 90; i += 1) stepRoom(room);
    expect(room.round.phase).toBe("lobby");
    expect(snapshotFor(room, "p1").round.phase).toBe("lobby");
    expect(room.round.matchWinner).toBeUndefined();
  });

  it("enters objective overtime after sixty seconds and awards a capture after eight seconds", () => {
    const map = testMap();
    map.objective = { id: "objective", position: { x: 150, y: 120 }, radius: 32 };
    const room = activeRoom(map);
    expect(room.round.endsAtTick - room.round.startsAtTick).toBe(ROUND_TICKS);
    room.tick = room.round.endsAtTick - 1;
    stepRoom(room);
    expect(room.round.phase).toBe("overtime");
    expect(room.round.objective?.requiredTicks).toBe(OBJECTIVE_CAPTURE_TICKS);

    room.players.p1.position = { x: 150, y: 120 };
    room.players.p2.position = { x: 260, y: 120 };
    for (let i = 0; i < OBJECTIVE_CAPTURE_TICKS; i += 1) stepRoom(room);

    expect(room.round.winner).toBe("p1");
    expect(room.round.reason).toBe("objective");
    expect(room.round.scores.p1).toBe(1);
  });

  it("ends overtime as a draw when no objective is captured", () => {
    const map = testMap();
    map.objective = { id: "objective", position: { x: 150, y: 120 }, radius: 32 };
    const room = activeRoom(map);
    room.tick = room.round.endsAtTick - 1;
    stepRoom(room);
    room.tick = room.round.overtimeEndsAtTick! - 1;
    stepRoom(room);
    expect(room.round.winner).toBe("draw");
    expect(room.round.reason).toBe("timer");
  });

  it("selects an authored overtime objective from multiple map points", () => {
    const picks = new Set<string>();
    for (let roundNumber = 1; roundNumber <= 8; roundNumber += 1) {
      const map = testMap();
      map.objectives = [
        { id: "alpha", position: { x: 120, y: 120 }, radius: 28 },
        { id: "bravo", position: { x: 180, y: 120 }, radius: 28 }
      ];
      delete map.objective;
      const room = activeRoom(map);
      room.round.roundNumber = roundNumber;
      room.tick = room.round.endsAtTick - 1;
      stepRoom(room);
      expect(["alpha", "bravo"]).toContain(room.round.objective?.id);
      picks.add(room.round.objective!.id!);
    }
    expect(picks.size).toBeGreaterThan(1);
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

  it("opens hinged doors from walking-speed contact", () => {
    const map = testMap();
    map.walls.push(createWall("walk-door", "door", { x: 120, y: 90 }, { x: 120, y: 150 }, 8));
    const room = activeRoom(map);
    room.players.p1.position = { x: 100, y: 120 };
    applyClientMessage(room, "p1", { type: "command", seq: 1, tick: room.tick, move: { x: 1, y: 0 }, aim: 0, fire: false, walk: true, use: "none" });
    for (let i = 0; i < 12; i += 1) stepRoom(room);
    const door = room.map.walls.find((wall) => wall.id === "walk-door")!;
    expect(Math.abs(door.currentAngle ?? 0)).toBeGreaterThan(0.03);
    expect(Math.abs(door.angularVelocity ?? 0)).toBeLessThanOrEqual(0.06);
  });

  it("opens doors smoothly in both directions based on push side", () => {
    const leftMap = testMap();
    leftMap.walls.push(createWall("door-left", "door", { x: 120, y: 90 }, { x: 120, y: 150 }, 8));
    const leftRoom = activeRoom(leftMap);
    leftRoom.players.p1.position = { x: 100, y: 120 };
    applyClientMessage(leftRoom, "p1", { type: "command", seq: 1, tick: leftRoom.tick, move: { x: 1, y: 0 }, aim: 0, fire: false, use: "none" });
    for (let i = 0; i < 16; i += 1) stepRoom(leftRoom);
    const leftDoor = leftRoom.map.walls.find((wall) => wall.id === "door-left")!;
    expect(leftDoor.currentAngle ?? 0).toBeLessThan(-0.05);
    expect(Math.abs(leftDoor.angularVelocity ?? 0)).toBeLessThanOrEqual(0.06);

    const rightMap = testMap();
    rightMap.walls.push(createWall("door-right", "door", { x: 120, y: 90 }, { x: 120, y: 150 }, 8));
    const rightRoom = activeRoom(rightMap);
    rightRoom.players.p1.position = { x: 140, y: 120 };
    applyClientMessage(rightRoom, "p1", { type: "command", seq: 1, tick: rightRoom.tick, move: { x: -1, y: 0 }, aim: Math.PI, fire: false, use: "none" });
    for (let i = 0; i < 16; i += 1) stepRoom(rightRoom);
    const rightDoor = rightRoom.map.walls.find((wall) => wall.id === "door-right")!;
    expect(rightDoor.currentAngle ?? 0).toBeGreaterThan(0.05);
    expect(Math.abs(rightDoor.angularVelocity ?? 0)).toBeLessThanOrEqual(0.06);
  });

  it("allows pushing an already-open door back the other way", () => {
    const map = testMap();
    map.walls.push(createWall("reverse-door", "door", { x: 120, y: 90 }, { x: 120, y: 150 }, 8));
    const room = activeRoom(map);
    const door = room.map.walls.find((wall) => wall.id === "reverse-door")!;
    door.currentAngle = -0.7;
    door.angularVelocity = 0;
    door.a = door.hinge!;
    door.b = { x: 120 + Math.sin(0.7) * 60, y: 90 + Math.cos(0.7) * 60 };
    room.players.p1.position = { x: 165, y: 135 };
    applyClientMessage(room, "p1", { type: "command", seq: 1, tick: room.tick, move: { x: -1, y: 0 }, aim: Math.PI, fire: false, use: "none" });
    for (let i = 0; i < 8; i += 1) stepRoom(room);
    expect(door.angularVelocity ?? 0).toBeGreaterThan(0);
  });

  it("does not violently reverse doors from one tick of opposite contact", () => {
    const map = testMap();
    map.walls.push(createWall("tap-door", "door", { x: 120, y: 90 }, { x: 120, y: 150 }, 8));
    const room = activeRoom(map);
    const door = room.map.walls.find((wall) => wall.id === "tap-door")!;
    door.currentAngle = -0.7;
    door.angularVelocity = -0.04;
    door.a = door.hinge!;
    door.b = { x: 120 + Math.sin(0.7) * 60, y: 90 + Math.cos(0.7) * 60 };
    room.players.p1.position = { x: 165, y: 135 };
    applyClientMessage(room, "p1", { type: "command", seq: 1, tick: room.tick, move: { x: -1, y: 0 }, aim: Math.PI, fire: false, use: "none" });
    stepRoom(room);
    expect(Math.abs(door.angularVelocity ?? 0)).toBeLessThanOrEqual(0.06);
    expect(door.angularVelocity ?? 0).toBeLessThanOrEqual(0);
  });

  it("keeps players outside the current door panel while pushing", () => {
    const map = testMap();
    map.walls.push(createWall("solid-door", "door", { x: 150, y: 90 }, { x: 150, y: 150 }, 8));
    const room = activeRoom(map);
    room.players.p1.position = { x: 139, y: 120 };
    applyClientMessage(room, "p1", { type: "command", seq: 1, tick: room.tick, move: { x: 1, y: 0 }, aim: 0, fire: false, use: "none" });
    for (let i = 0; i < 6; i += 1) stepRoom(room);
    const door = room.map.walls.find((wall) => wall.id === "solid-door")!;
    expect(distanceToSegment(room.players.p1.position, door.a, door.b)).toBeGreaterThanOrEqual(10 + door.thickness / 2);
  });

  it("damps door velocity without springing back after push input stops", () => {
    const map = testMap();
    map.walls.push(createWall("door-damped", "door", { x: 120, y: 90 }, { x: 120, y: 150 }, 8));
    const room = activeRoom(map);
    room.players.p1.position = { x: 100, y: 120 };
    applyClientMessage(room, "p1", { type: "command", seq: 1, tick: room.tick, move: { x: 1, y: 0 }, aim: 0, fire: false, use: "none" });
    for (let i = 0; i < 20; i += 1) stepRoom(room);
    const door = room.map.walls.find((wall) => wall.id === "door-damped")!;
    applyClientMessage(room, "p1", { type: "command", seq: 2, tick: room.tick, move: { x: 0, y: 0 }, aim: 0, fire: false, use: "none" });
    for (let i = 0; i < 90; i += 1) stepRoom(room);
    expect(Math.abs(door.currentAngle ?? 0)).toBeGreaterThan(0.3);
    expect(Math.abs(door.angularVelocity ?? 0)).toBeLessThan(0.03);
  });

  it("normalizes runtime doors to block vision", () => {
    const map = testMap();
    map.walls.push(createWall("door-los", "door", { x: 120, y: 90 }, { x: 120, y: 150 }, 8));
    const room = createRoom("door-los", map);
    expect(room.map.walls.find((wall) => wall.id === "door-los")?.blocksVision).toBe(true);
  });

  it("blocks visibility through closed doors and allows sight through the opened gap", () => {
    const map = testMap();
    map.walls.push(createWall("door-los", "door", { x: 150, y: 90 }, { x: 150, y: 150 }, 8));
    const room = activeRoom(map);
    room.players.p1.aim = 0;
    expect(snapshotFor(room, "p1").visiblePlayers).toHaveLength(0);
    const door = room.map.walls.find((wall) => wall.id === "door-los")!;
    door.currentAngle = -Math.PI / 2;
    door.a = door.hinge!;
    door.b = { x: 210, y: 90 };
    expect(snapshotFor(room, "p1").visiblePlayers[0]?.id).toBe("p2");
  });

  it("reveals nearby opponents in close vision outside the forward cone", () => {
    const room = activeRoom(testMap());
    room.players.p1.aim = Math.PI;
    room.players.p2.position = { x: 95, y: 120 };
    const snapshot = snapshotFor(room, "p1");
    expect(snapshot.visiblePlayers[0]?.id).toBe("p2");
    expect(snapshot.visibleCircles).toContainEqual({ position: room.players.p1.position, radius: 80 });
  });

  it("blocks close vision through solid walls and smoke", () => {
    const wallMap = testMap();
    wallMap.walls.push(createWall("close-blocker", "solid", { x: 75, y: 80 }, { x: 75, y: 160 }, 8));
    const wallRoom = activeRoom(wallMap);
    wallRoom.players.p1.aim = Math.PI;
    wallRoom.players.p2.position = { x: 95, y: 120 };
    expect(snapshotFor(wallRoom, "p1").visiblePlayers).toHaveLength(0);

    const smokeRoom = activeRoom(testMap());
    smokeRoom.players.p1.aim = Math.PI;
    smokeRoom.players.p2.position = { x: 95, y: 120 };
    smokeRoom.smokes.push({ id: "close-smoke", owner: "p2", position: { x: 75, y: 120 }, radius: 20, createdAtTick: smokeRoom.tick, expiresAtTick: smokeRoom.tick + 100 });
    expect(snapshotFor(smokeRoom, "p1").visiblePlayers).toHaveLength(0);
  });

  it("blocks hinged doors from rotating through another player", () => {
    const map = testMap();
    map.walls.push(createWall("door-1", "door", { x: 120, y: 90 }, { x: 120, y: 150 }, 8));
    const room = createRoom("blocked-door", map);
    joinRoom(room, false, "p1");
    joinRoom(room, false, "p2");
    room.players.p2.position = { x: 114, y: 150 };
    const door = room.map.walls.find((wall) => wall.id === "door-1")!;
    door.angularVelocity = 0.12;
    stepRoom(room);
    expect(door.currentAngle).toBe(0);
    expect(door.angularVelocity).toBe(0);
    expect(door.b).toEqual({ x: 120, y: 150 });
  });

  it("blocks hinged doors from rotating through movement-blocking walls", () => {
    const map = testMap();
    map.walls.push(createWall("door-1", "door", { x: 120, y: 90 }, { x: 120, y: 150 }, 8));
    map.walls.push(createWall("wall-blocker", "solid", { x: 92, y: 128 }, { x: 152, y: 128 }, 8));
    const room = createRoom("blocked-door-wall", map);
    const door = room.map.walls.find((wall) => wall.id === "door-1")!;
    door.angularVelocity = 0.8;
    stepRoom(room);
    expect(door.currentAngle).toBe(0);
    expect(door.angularVelocity).toBe(0);
    expect(door.b).toEqual({ x: 120, y: 150 });
  });

  it("ignores destroyed and non-movement-blocking walls when rotating doors", () => {
    const map = testMap();
    map.walls.push(createWall("door-1", "door", { x: 120, y: 90 }, { x: 120, y: 150 }, 8));
    map.walls.push(createWall("destroyed-blocker", "solid", { x: 92, y: 128 }, { x: 152, y: 128 }, 8, { destroyed: true }));
    map.walls.push(createWall("ghost-blocker", "transparent", { x: 92, y: 132 }, { x: 152, y: 132 }, 8, { blocksMovement: false }));
    const room = createRoom("open-door-wall", map);
    const door = room.map.walls.find((wall) => wall.id === "door-1")!;
    door.angularVelocity = 0.08;
    stepRoom(room);
    expect(Math.abs(door.currentAngle ?? 0)).toBeGreaterThan(0);
  });

  it("ignores adjacent door frame wall pieces when rotating doors", () => {
    const map = testMap();
    map.walls.push(createWall("door-1", "door", { x: 120, y: 90 }, { x: 120, y: 150 }, 8));
    map.walls.push(createWall("frame-top", "solid", { x: 70, y: 90 }, { x: 120, y: 90 }, 8));
    map.walls.push(createWall("frame-bottom", "solid", { x: 70, y: 150 }, { x: 120, y: 150 }, 8));
    const room = createRoom("door-frame", map);
    const door = room.map.walls.find((wall) => wall.id === "door-1")!;
    door.angularVelocity = 0.08;
    stepRoom(room);
    expect(Math.abs(door.currentAngle ?? 0)).toBeGreaterThan(0);
  });

  it("lets players pass through an opened doorway gap but blocks the current panel", () => {
    const closedMap = testMap();
    closedMap.walls.push(createWall("door-closed", "door", { x: 150, y: 90 }, { x: 150, y: 150 }, 8));
    const closedRoom = activeRoom(closedMap);
    closedRoom.players.p1.position = { x: 139, y: 120 };
    applyClientMessage(closedRoom, "p1", { type: "command", seq: 1, tick: closedRoom.tick, move: { x: 1, y: 0 }, aim: 0, fire: false, use: "none" });
    stepRoom(closedRoom);
    expect(closedRoom.players.p1.position.x).toBeLessThan(145);

    const openMap = testMap();
    openMap.walls.push(createWall("door-open", "door", { x: 150, y: 90 }, { x: 150, y: 150 }, 8));
    const openRoom = activeRoom(openMap);
    const door = openRoom.map.walls.find((wall) => wall.id === "door-open")!;
    door.currentAngle = -Math.PI / 2;
    door.angularVelocity = 0;
    door.a = door.hinge!;
    door.b = { x: 210, y: 90 };
    openRoom.players.p1.position = { x: 130, y: 120 };
    applyClientMessage(openRoom, "p1", { type: "command", seq: 1, tick: openRoom.tick, move: { x: 1, y: 0 }, aim: 0, fire: false, use: "none" });
    for (let i = 0; i < 8; i += 1) stepRoom(openRoom);
    expect(openRoom.players.p1.position.x).toBeGreaterThan(150);

    const mirroredMap = testMap();
    mirroredMap.walls.push(createWall("door-open-right", "door", { x: 150, y: 90 }, { x: 150, y: 150 }, 8));
    const mirroredRoom = activeRoom(mirroredMap);
    const mirroredDoor = mirroredRoom.map.walls.find((wall) => wall.id === "door-open-right")!;
    mirroredDoor.currentAngle = Math.PI / 2;
    mirroredDoor.angularVelocity = 0;
    mirroredDoor.a = mirroredDoor.hinge!;
    mirroredDoor.b = { x: 90, y: 90 };
    mirroredRoom.players.p1.position = { x: 170, y: 120 };
    applyClientMessage(mirroredRoom, "p1", { type: "command", seq: 1, tick: mirroredRoom.tick, move: { x: -1, y: 0 }, aim: Math.PI, fire: false, use: "none" });
    for (let i = 0; i < 8; i += 1) stepRoom(mirroredRoom);
    expect(mirroredRoom.players.p1.position.x).toBeLessThan(150);
  });

  it("toggles the nearest door open and closed with a queued use action", () => {
    const map = testMap();
    map.walls.push(createWall("toggle-door", "door", { x: 120, y: 90 }, { x: 120, y: 150 }, 8));
    const room = activeRoom(map);
    const door = room.map.walls.find((wall) => wall.id === "toggle-door")!;
    room.players.p1.position = { x: 100, y: 120 };
    applyClientMessage(room, "p1", { type: "command", seq: 1, tick: room.tick, move: { x: 0, y: 0 }, aim: 0, fire: false, use: "door-toggle" });
    applyClientMessage(room, "p1", { type: "command", seq: 2, tick: room.tick, move: { x: 0, y: 0 }, aim: 0, fire: false, use: "none" });
    stepRoom(room);
    expect(snapshotFor(room, "p1").actionResults).toContainEqual({ seq: 1, action: "use", accepted: true });
    expect(door.targetAngle).toBeLessThan(0);
    for (let i = 0; i < 120; i += 1) stepRoom(room);
    expect(door.currentAngle ?? 0).toBeLessThan(-1.6);

    applyClientMessage(room, "p1", { type: "command", seq: 3, tick: room.tick, move: { x: 0, y: 0 }, aim: 0, fire: false, use: "door-toggle" });
    stepRoom(room);
    expect(door.targetAngle).toBe(0);
    for (let i = 0; i < 120; i += 1) stepRoom(room);
    expect(Math.abs(door.currentAngle ?? 1)).toBeLessThan(0.08);
  });

  it("applies bullet impulse to hinged doors", () => {
    const map = testMap();
    map.walls.push(createWall("shot-door", "door", { x: 120, y: 70 }, { x: 120, y: 170 }, 8));
    const room = activeRoomWithLoadout(map, { weaponId: "assault" });
    room.players.p1.position = { x: 50, y: 120 };
    room.players.p2.position = { x: 250, y: 220 };
    const door = room.map.walls.find((wall) => wall.id === "shot-door")!;
    applyClientMessage(room, "p1", { type: "command", seq: 1, tick: room.tick, move: { x: 0, y: 0 }, aim: 0, fire: true, use: "none" });
    stepRoom(room);
    expect(room.replay.events.some((event) => event.type === "shot" && event.impact.wallId === "shot-door")).toBe(true);
    expect(Math.abs(door.angularVelocity ?? 0)).toBeGreaterThan(0);
    expect(Math.abs(door.targetAngle ?? 0)).toBeGreaterThan(0.3);
    expect(Math.abs(door.targetAngle ?? 0)).toBeLessThan(1);
    for (let i = 0; i < 4; i += 1) stepRoom(room);
    expect(Math.abs(door.currentAngle ?? 0)).toBeGreaterThan(0.02);
  });

  it("fully opens doors from one sniper hit or enough shotgun pellets", () => {
    const sniperMap = testMap();
    sniperMap.walls.push(createWall("sniper-door", "door", { x: 120, y: 70 }, { x: 120, y: 170 }, 8));
    const sniperRoom = activeRoomWithLoadout(sniperMap, { weaponId: "sniper" });
    sniperRoom.players.p1.position = { x: 50, y: 120 };
    sniperRoom.players.p2.position = { x: 250, y: 220 };
    const sniperDoor = sniperRoom.map.walls.find((wall) => wall.id === "sniper-door")!;
    applyClientMessage(sniperRoom, "p1", { type: "command", seq: 1, tick: sniperRoom.tick, move: { x: 0, y: 0 }, aim: 0, fire: true, use: "none" });
    stepRoom(sniperRoom);
    expect(Math.abs(sniperDoor.targetAngle ?? 0)).toBeCloseTo(1.92, 2);

    const shotgunMap = testMap();
    shotgunMap.walls.push(createWall("shotgun-door", "door", { x: 120, y: 70 }, { x: 120, y: 170 }, 8));
    const shotgunRoom = activeRoomWithLoadout(shotgunMap, { weaponId: "shotgun" });
    shotgunRoom.players.p1.position = { x: 50, y: 120 };
    shotgunRoom.players.p2.position = { x: 250, y: 220 };
    const shotgunDoor = shotgunRoom.map.walls.find((wall) => wall.id === "shotgun-door")!;
    applyClientMessage(shotgunRoom, "p1", { type: "command", seq: 1, tick: shotgunRoom.tick, move: { x: 0, y: 0 }, aim: 0, fire: true, use: "none" });
    stepRoom(shotgunRoom);
    expect(shotgunRoom.replay.events.filter((event) => event.type === "shot" && event.impact.wallId === "shotgun-door").length).toBeGreaterThanOrEqual(5);
    expect(Math.abs(shotgunDoor.targetAngle ?? 0)).toBeCloseTo(1.92, 2);
  });

  it("rejects door toggle when no door is nearby", () => {
    const map = testMap();
    map.walls.push(createWall("far-door", "door", { x: 220, y: 40 }, { x: 220, y: 100 }, 8));
    const room = activeRoom(map);
    applyClientMessage(room, "p1", { type: "command", seq: 1, tick: room.tick, move: { x: 0, y: 0 }, aim: 0, fire: false, use: "door-toggle" });
    stepRoom(room);
    expect(snapshotFor(room, "p1").actionResults).toContainEqual({ seq: 1, action: "use", accepted: false, reason: "invalid" });
  });

  it("filters opponents outside the forward vision cone", () => {
    const room = activeRoom(testMap());
    room.players.p2.position = { x: 50, y: 210 };
    room.players.p1.aim = 0;
    expect(snapshotFor(room, "p1").visiblePlayers).toHaveLength(0);
  });

  it("reveals opponents inside the forward vision cone with clear line of sight", () => {
    const room = activeRoom(testMap());
    room.players.p1.aim = 0;
    expect(snapshotFor(room, "p1").visiblePlayers[0]?.id).toBe("p2");
  });

  it("blocks forward vision with solid walls", () => {
    const map = testMap();
    map.walls.push(createWall("solid-blocker", "solid", { x: 120, y: 80 }, { x: 120, y: 160 }, 8));
    const room = activeRoom(map);
    room.players.p1.aim = 0;
    expect(snapshotFor(room, "p1").visiblePlayers).toHaveLength(0);
  });

  it("allows forward vision through transparent and mesh surfaces", () => {
    const transparentMap = testMap();
    transparentMap.walls.push(createWall("transparent-window", "transparent", { x: 120, y: 80 }, { x: 120, y: 160 }, 8));
    const meshMap = testMap();
    meshMap.walls.push(createWall("mesh-window", "mesh", { x: 120, y: 80 }, { x: 120, y: 160 }, 8));
    const transparentRoom = activeRoom(transparentMap);
    const meshRoom = activeRoom(meshMap);
    transparentRoom.players.p1.aim = 0;
    meshRoom.players.p1.aim = 0;
    expect(snapshotFor(transparentRoom, "p1").visiblePlayers[0]?.id).toBe("p2");
    expect(snapshotFor(meshRoom, "p1").visiblePlayers[0]?.id).toBe("p2");
  });

  it("uses the shorter vision range", () => {
    const room = activeRoom(testMap());
    room.players.p2.position = { x: 330, y: 120 };
    room.players.p1.aim = 0;
    expect(snapshotFor(room, "p1").visiblePlayers).toHaveLength(0);
  });

  it("keeps doors at the last seen state while out of vision", () => {
    const map = testMap();
    map.walls.push(createWall("door-memory", "door", { x: 120, y: 90 }, { x: 120, y: 150 }, 8));
    const room = activeRoom(map);
    room.players.p1.aim = 0;
    const firstDoor = snapshotFor(room, "p1").map.walls.find((wall) => wall.id === "door-memory")!;
    const liveDoor = room.map.walls.find((wall) => wall.id === "door-memory")!;
    liveDoor.currentAngle = 1;
    liveDoor.b = { x: 170, y: 120 };
    room.players.p1.aim = Math.PI;
    const hiddenDoor = snapshotFor(room, "p1").map.walls.find((wall) => wall.id === "door-memory")!;
    expect(hiddenDoor.b).toEqual(firstDoor.b);
  });

  it("consumes ammo and supports manual and automatic reloads", () => {
    const room = activeRoom(testMap());
    room.players.p2.position = { x: 250, y: 200 };
    applyClientMessage(room, "p1", { type: "command", seq: 1, tick: room.tick, move: { x: 0, y: 0 }, aim: 0, fire: true, use: "none" });
    stepRoom(room);
    expect(room.players.p1.ammo).toBe(9);
    applyClientMessage(room, "p1", { type: "command", seq: 2, tick: room.tick, move: { x: 0, y: 0 }, aim: 0, fire: false, use: "none", reload: true });
    stepRoom(room);
    expect(room.players.p1.isReloading).toBe(true);
    for (let i = 0; i < 60; i += 1) stepRoom(room);
    expect(room.players.p1.ammo).toBe(10);
    expect(room.players.p1.isReloading).toBe(false);
    room.players.p1.ammo = 0;
    applyClientMessage(room, "p1", { type: "command", seq: 3, tick: room.tick, move: { x: 0, y: 0 }, aim: 0, fire: true, use: "none" });
    stepRoom(room);
    expect(room.players.p1.isReloading).toBe(true);
  });

  it("processes reload even when movement commands arrive before the next tick", () => {
    const room = activeRoom(testMap());
    room.players.p1.ammo = 4;
    applyClientMessage(room, "p1", { type: "command", seq: 10, tick: room.tick, move: { x: 0, y: 0 }, aim: 0, fire: false, use: "none", reload: true });
    applyClientMessage(room, "p1", { type: "command", seq: 11, tick: room.tick, move: { x: 1, y: 0 }, aim: 0, fire: false, use: "none" });
    stepRoom(room);
    expect(room.players.p1.isReloading).toBe(true);
    expect(snapshotFor(room, "p1").actionResults).toContainEqual({ seq: 10, action: "reload", accepted: true });
    expect(room.players.p1.position.x).toBeGreaterThan(50);
  });

  it("deploys cameras that grant vision and die to one shot", () => {
    const room = activeRoom(testMap());
    room.players.p1.aim = Math.PI;
    room.players.p2.position = { x: 250, y: 120 };
    applyClientMessage(room, "p1", { type: "command", seq: 1, tick: room.tick, move: { x: 0, y: 0 }, aim: Math.PI, fire: false, use: "none", gadget: "camera", gadgetTarget: { x: 170, y: 120 } });
    stepRoom(room);
    expect(room.players.p1.gadgets.camera).toBe(0);
    expect(snapshotFor(room, "p1").visiblePlayers[0]?.id).toBe("p2");
    const camera = room.deployedCameras[0]!;
    room.players.p2.aim = Math.PI;
    applyClientMessage(room, "p2", { type: "command", seq: 2, tick: room.tick, move: { x: 0, y: 0 }, aim: Math.PI, fire: true, use: "none" });
    for (let i = 0; i < 3; i += 1) stepRoom(room);
    expect(camera.destroyed).toBe(true);
  });

  it("processes gadget deploy even when later movement updates overwrite continuous input", () => {
    const room = activeRoom(testMap());
    applyClientMessage(room, "p1", { type: "command", seq: 20, tick: room.tick, move: { x: 0, y: 0 }, aim: 0, fire: false, use: "none", gadget: "camera", gadgetTarget: { x: 80, y: 80 } });
    applyClientMessage(room, "p1", { type: "command", seq: 21, tick: room.tick, move: { x: 1, y: 0 }, aim: 0, fire: false, use: "none" });
    stepRoom(room);
    expect(room.deployedCameras).toHaveLength(1);
    expect(snapshotFor(room, "p1").actionResults).toContainEqual({ seq: 20, action: "gadget", accepted: true });
  });

  it("hides enemy cameras until seen while preserving owner camera vision", () => {
    const map = testMap();
    const room = activeRoom(map);
    room.players.p1.aim = Math.PI;
    room.players.p2.position = { x: 250, y: 120 };
    room.players.p2.aim = 0;
    applyClientMessage(room, "p1", { type: "command", seq: 1, tick: room.tick, move: { x: 0, y: 0 }, aim: Math.PI, fire: false, use: "none", gadget: "camera", gadgetTarget: { x: 140, y: 120 } });
    stepRoom(room);
    expect(snapshotFor(room, "p1").gadgets.cameras).toHaveLength(1);
    expect(snapshotFor(room, "p1").visiblePlayers[0]?.id).toBe("p2");
    expect(snapshotFor(room, "p2").gadgets.cameras).toHaveLength(0);
    room.players.p2.aim = Math.PI;
    expect(snapshotFor(room, "p2").gadgets.cameras[0]?.id).toBe(room.deployedCameras[0]?.id);
  });

  it("blocks camera placement through transparent windows but allows placement through mesh", () => {
    const windowMap = testMap();
    windowMap.walls.push(createWall("window", "transparent", { x: 120, y: 70 }, { x: 120, y: 170 }, 8));
    const windowRoom = activeRoom(windowMap);
    applyClientMessage(windowRoom, "p1", { type: "command", seq: 1, tick: windowRoom.tick, move: { x: 0, y: 0 }, aim: 0, fire: false, use: "none", gadget: "camera", gadgetTarget: { x: 150, y: 120 } });
    stepRoom(windowRoom);
    expect(windowRoom.deployedCameras).toHaveLength(0);
    expect(windowRoom.players.p1.gadgets.camera).toBe(1);

    const meshMap = testMap();
    meshMap.walls.push(createWall("mesh", "mesh", { x: 120, y: 70 }, { x: 120, y: 170 }, 8));
    const meshRoom = activeRoom(meshMap);
    applyClientMessage(meshRoom, "p1", { type: "command", seq: 1, tick: meshRoom.tick, move: { x: 0, y: 0 }, aim: 0, fire: false, use: "none", gadget: "camera", gadgetTarget: { x: 150, y: 120 } });
    stepRoom(meshRoom);
    expect(meshRoom.deployedCameras).toHaveLength(1);
    expect(meshRoom.players.p1.gadgets.camera).toBe(0);
  });

  it("clamps camera and molotov targets only when beyond range", () => {
    const cameraRoom = activeRoom(testMap());
    applyClientMessage(cameraRoom, "p1", { type: "command", seq: 1, tick: cameraRoom.tick, move: { x: 0, y: 0 }, aim: 0, fire: false, use: "none", gadget: "camera", gadgetTarget: { x: 80, y: 120 } });
    stepRoom(cameraRoom);
    expect(cameraRoom.deployedCameras[0]?.position).toEqual({ x: 80, y: 120 });

    const molotovRoom = activeRoom(testMap());
    applyClientMessage(molotovRoom, "p1", { type: "command", seq: 1, tick: molotovRoom.tick, move: { x: 0, y: 0 }, aim: 0, fire: false, use: "none", gadget: "molotov", gadgetTarget: { x: 500, y: 120 } });
    stepRoom(molotovRoom);
    expect(molotovRoom.molotovs[0]?.position).toEqual({ x: 270, y: 120 });
  });

  it("preserves the placement line when clamping to range and bounds", () => {
    const rangeRoom = activeRoom(testMap());
    rangeRoom.players.p1.position = { x: 50, y: 50 };
    applyClientMessage(rangeRoom, "p1", { type: "command", seq: 1, tick: rangeRoom.tick, move: { x: 0, y: 0 }, aim: 0, fire: false, use: "none", gadget: "camera", gadgetTarget: { x: 500, y: 500 } });
    stepRoom(rangeRoom);
    const diagonal = 50 + 180 / Math.sqrt(2);
    expect(rangeRoom.deployedCameras[0]!.position.x).toBeCloseTo(diagonal, 4);
    expect(rangeRoom.deployedCameras[0]!.position.y).toBeCloseTo(diagonal, 4);

    const boundsRoom = activeRoom(testMap());
    boundsRoom.players.p1.position = { x: 250, y: 120 };
    applyClientMessage(boundsRoom, "p1", { type: "command", seq: 1, tick: boundsRoom.tick, move: { x: 0, y: 0 }, aim: 0, fire: false, use: "none", gadget: "camera", gadgetTarget: { x: 500, y: 500 } });
    stepRoom(boundsRoom);
    expect(boundsRoom.deployedCameras[0]!.position.x).toBeCloseTo(290, 4);
    expect(boundsRoom.deployedCameras[0]!.position.y).toBeCloseTo(180.8, 1);
  });

  it("bounces thrown smoke and molotovs once from blocking geometry", () => {
    const map = testMap();
    map.walls.push(createWall("throw-block", "solid", { x: 150, y: 70 }, { x: 150, y: 170 }, 8));
    const room = activeRoom(map);
    applyClientMessage(room, "p1", { type: "command", seq: 1, tick: room.tick, move: { x: 0, y: 0 }, aim: 0, fire: false, use: "none", gadget: "molotov", gadgetTarget: { x: 250, y: 120 } });
    stepRoom(room);
    expect(room.molotovs[0]!.position.x).toBeCloseTo(40, 4);
    expect(room.molotovs[0]!.position.y).toBeCloseTo(120, 4);
  });

  it("stops a bounced throw before a second blocker", () => {
    const map = testMap();
    map.walls.push(createWall("throw-block", "solid", { x: 150, y: 70 }, { x: 150, y: 170 }, 8));
    map.walls.push(createWall("second-block", "solid", { x: 20, y: 70 }, { x: 20, y: 170 }, 8));
    const room = activeRoom(map);
    applyClientMessage(room, "p1", { type: "command", seq: 1, tick: room.tick, move: { x: 0, y: 0 }, aim: 0, fire: false, use: "none", gadget: "molotov", gadgetTarget: { x: 270, y: 120 } });
    stepRoom(room);
    expect(room.molotovs[0]!.position.x).toBeCloseTo(30, 4);
    expect(room.molotovs[0]!.position.y).toBeCloseTo(120, 4);
  });

  it("blocks thrown utility placement through transparent windows but allows mesh", () => {
    const windowMap = testMap();
    windowMap.walls.push(createWall("window", "transparent", { x: 120, y: 70 }, { x: 120, y: 170 }, 8));
    const windowRoom = activeRoom(windowMap);
    applyClientMessage(windowRoom, "p1", { type: "command", seq: 1, tick: windowRoom.tick, move: { x: 0, y: 0 }, aim: 0, fire: false, use: "none", gadget: "smoke", gadgetTarget: { x: 150, y: 120 } });
    stepRoom(windowRoom);
    expect(windowRoom.smokes).toHaveLength(0);
    expect(windowRoom.players.p1.gadgets.smoke).toBe(2);

    const meshMap = testMap();
    meshMap.walls.push(createWall("mesh", "mesh", { x: 120, y: 70 }, { x: 120, y: 170 }, 8));
    const meshRoom = activeRoom(meshMap);
    applyClientMessage(meshRoom, "p1", { type: "command", seq: 1, tick: meshRoom.tick, move: { x: 0, y: 0 }, aim: 0, fire: false, use: "none", gadget: "smoke", gadgetTarget: { x: 150, y: 120 } });
    stepRoom(meshRoom);
    expect(meshRoom.smokes).toHaveLength(1);
    expect(meshRoom.players.p1.gadgets.smoke).toBe(1);
  });

  it("applies placement LOS to sound sensors and deployable walls", () => {
    const map = testMap();
    map.walls.push(createWall("window", "transparent", { x: 120, y: 70 }, { x: 120, y: 170 }, 8));
    const soundRoom = activeRoom(map);
    applyClientMessage(soundRoom, "p1", { type: "command", seq: 1, tick: soundRoom.tick, move: { x: 0, y: 0 }, aim: 0, fire: false, use: "none", gadget: "sound", gadgetTarget: { x: 150, y: 120 } });
    stepRoom(soundRoom);
    expect(soundRoom.soundSensors).toHaveLength(0);
    expect(soundRoom.players.p1.gadgets.sound).toBe(1);

    const wallRoom = activeRoom(map);
    applyClientMessage(wallRoom, "p1", { type: "command", seq: 1, tick: wallRoom.tick, move: { x: 0, y: 0 }, aim: 0, fire: false, use: "none", gadget: "wall", gadgetTarget: { x: 150, y: 120 } });
    stepRoom(wallRoom);
    expect(wallRoom.map.walls.filter((wall) => wall.id.includes("-wall-"))).toHaveLength(0);
    expect(wallRoom.players.p1.gadgets.wall).toBe(2);
  });

  it("does not consume failed gadget placements and allows a later retry", () => {
    const map = testMap();
    map.walls.push(createWall("window", "transparent", { x: 120, y: 70 }, { x: 120, y: 170 }, 8));
    const room = activeRoom(map);
    applyClientMessage(room, "p1", { type: "command", seq: 1, tick: room.tick, move: { x: 0, y: 0 }, aim: 0, fire: false, use: "none", gadget: "camera", gadgetTarget: { x: 150, y: 120 } });
    stepRoom(room);
    expect(room.deployedCameras).toHaveLength(0);
    expect(room.players.p1.gadgets.camera).toBe(1);
    expect(snapshotFor(room, "p1").actionResults).toContainEqual({ seq: 1, action: "gadget", accepted: false, reason: "blocked-los" });
    applyClientMessage(room, "p1", { type: "command", seq: 2, tick: room.tick, move: { x: 0, y: 0 }, aim: 0, fire: false, use: "none", gadget: "camera", gadgetTarget: { x: 80, y: 80 } });
    stepRoom(room);
    expect(room.deployedCameras).toHaveLength(1);
    expect(room.players.p1.gadgets.camera).toBe(0);
  });

  it("deduplicates repeated action sequence numbers but keeps later distinct actions", () => {
    const room = activeRoom(testMap());
    applyClientMessage(room, "p1", { type: "command", seq: 1, tick: room.tick, move: { x: 0, y: 0 }, aim: 0, fire: false, use: "none", gadget: "wall", gadgetTarget: { x: 150, y: 120 } });
    applyClientMessage(room, "p1", { type: "command", seq: 1, tick: room.tick, move: { x: 0, y: 0 }, aim: 0, fire: false, use: "none", gadget: "wall", gadgetTarget: { x: 170, y: 120 } });
    stepRoom(room);
    for (let i = 0; i < 24; i += 1) stepRoom(room);
    applyClientMessage(room, "p1", { type: "command", seq: 2, tick: room.tick, move: { x: 0, y: 0 }, aim: 0, fire: false, use: "none", gadget: "wall", gadgetTarget: { x: 80, y: 80 } });
    stepRoom(room);
    expect(room.map.walls.filter((wall) => wall.id.includes("-wall-"))).toHaveLength(2);
    expect(room.players.p1.gadgets.wall).toBe(0);
  });

  it("applies a short weapon lockout after successful gadget deployment", () => {
    const room = activeRoom(testMap());
    applyClientMessage(room, "p1", { type: "command", seq: 1, tick: room.tick, move: { x: 0, y: 0 }, aim: 0, fire: false, use: "none", gadget: "camera", gadgetTarget: { x: 80, y: 80 } });
    stepRoom(room);
    applyClientMessage(room, "p1", { type: "command", seq: 2, tick: room.tick, move: { x: 0, y: 0 }, aim: 0, fire: true, use: "none" });
    for (let i = 0; i < 23; i += 1) stepRoom(room);
    expect(room.players.p2.hp).toBe(5);
    stepRoom(room);
    expect(room.players.p2.hp).toBe(4);
  });

  it("deploys molotovs that damage players over time", () => {
    const room = activeRoom(testMap());
    applyClientMessage(room, "p1", { type: "command", seq: 1, tick: room.tick, move: { x: 0, y: 0 }, aim: 0, fire: false, use: "none", gadget: "molotov", gadgetTarget: { x: 250, y: 120 } });
    stepRoom(room);
    expect(room.players.p1.gadgets.molotov).toBe(0);
    expect(room.molotovs).toHaveLength(1);
    for (let i = 0; i < 30; i += 1) stepRoom(room);
    expect(room.players.p2.hp).toBe(4);
    for (let i = 0; i < 300; i += 1) stepRoom(room);
    expect(room.molotovs).toHaveLength(0);
  });

  it("keeps molotov damage ticking without fresh client commands", () => {
    const room = activeRoom(testMap());
    applyClientMessage(room, "p1", { type: "command", seq: 1, tick: room.tick, move: { x: 0, y: 0 }, aim: 0, fire: false, use: "none", gadget: "molotov", gadgetTarget: { x: 250, y: 120 } });
    stepRoom(room);
    for (let i = 0; i < 30; i += 1) stepRoom(room);
    expect(room.players.p2.hp).toBe(4);
  });

  it("deploys smoke that blocks vision but not bullets", () => {
    const room = activeRoom(testMap());
    room.players.p1.aim = 0;
    applyClientMessage(room, "p1", { type: "command", seq: 1, tick: room.tick, move: { x: 0, y: 0 }, aim: 0, fire: false, use: "none", gadget: "smoke", gadgetTarget: { x: 150, y: 120 } });
    stepRoom(room);
    expect(room.players.p1.gadgets.smoke).toBe(1);
    expect(room.smokes).toHaveLength(1);
    expect(snapshotFor(room, "p1").visiblePlayers).toHaveLength(0);

    applyClientMessage(room, "p1", { type: "command", seq: 2, tick: room.tick, move: { x: 0, y: 0 }, aim: 0, fire: true, use: "none" });
    for (let i = 0; i < 24; i += 1) stepRoom(room);
    expect(room.players.p2.hp).toBe(4);
  });

  it("requires molotov line of effect for damage", () => {
    const map = testMap();
    map.walls.push(createWall("fire-block", "solid", { x: 150, y: 70 }, { x: 150, y: 170 }, 8));
    const room = activeRoom(map);
    room.molotovs.push({ id: "blocked-fire", owner: "p1", position: { x: 120, y: 120 }, radius: 160, createdAtTick: room.tick, expiresAtTick: room.tick + 300 });
    for (let i = 0; i < 30; i += 1) stepRoom(room);
    expect(room.players.p2.hp).toBe(5);
  });

  it("deploys sound sensors that trigger through walls on running movement but not walking", () => {
    const map = testMap();
    map.walls.push(createWall("sound-wall", "solid", { x: 150, y: 70 }, { x: 150, y: 170 }, 8));
    const room = activeRoom(map);
    applyClientMessage(room, "p1", { type: "command", seq: 1, tick: room.tick, move: { x: 0, y: 0 }, aim: 0, fire: false, use: "none", gadget: "sound", gadgetTarget: { x: 120, y: 120 } });
    stepRoom(room);
    expect(room.players.p1.gadgets.sound).toBe(0);
    applyClientMessage(room, "p2", { type: "command", seq: 2, tick: room.tick, move: { x: -1, y: 0 }, aim: Math.PI, fire: false, use: "none", walk: true });
    stepRoom(room);
    expect(snapshotFor(room, "p1").detections.filter((detection) => detection.kind === "sound-area")).toHaveLength(0);
    applyClientMessage(room, "p2", { type: "command", seq: 3, tick: room.tick, move: { x: -1, y: 0 }, aim: Math.PI, fire: false, use: "none", walk: false });
    stepRoom(room);
    const soundDetections = snapshotFor(room, "p1").detections.filter((detection) => detection.kind === "sound-area");
    expect(soundDetections).toHaveLength(1);
    expect(soundDetections[0]!.radius).toBeGreaterThan(100);
  });

  it("walk mode uses the old movement speed while running is faster", () => {
    const runRoom = activeRoom(testMap());
    applyClientMessage(runRoom, "p1", { type: "command", seq: 1, tick: runRoom.tick, move: { x: 1, y: 0 }, aim: 0, fire: false, use: "none" });
    stepRoom(runRoom);
    const runDistance = runRoom.players.p1.position.x - 50;

    const walkRoom = activeRoom(testMap());
    applyClientMessage(walkRoom, "p1", { type: "command", seq: 1, tick: walkRoom.tick, move: { x: 1, y: 0 }, aim: 0, fire: false, use: "none", walk: true });
    stepRoom(walkRoom);
    const walkDistance = walkRoom.players.p1.position.x - 50;
    expect(walkDistance).toBeLessThan(runDistance);
    expect(runDistance).toBeCloseTo(185 / 60, 3);
    expect(walkDistance).toBeCloseTo(2.75, 3);
  });

  it("uses weapon movement speed presets while keeping walk speed stable", () => {
    const sniperRoom = activeRoomWithLoadout(testMap(), { weaponId: "sniper" });
    applyClientMessage(sniperRoom, "p1", { type: "command", seq: 1, tick: sniperRoom.tick, move: { x: 1, y: 0 }, aim: 0, fire: false, use: "none" });
    stepRoom(sniperRoom);
    const sniperDistance = sniperRoom.players.p1.position.x - 50;

    const shotgunRoom = activeRoomWithLoadout(testMap(), { weaponId: "shotgun" });
    applyClientMessage(shotgunRoom, "p1", { type: "command", seq: 1, tick: shotgunRoom.tick, move: { x: 1, y: 0 }, aim: 0, fire: false, use: "none" });
    stepRoom(shotgunRoom);
    const shotgunDistance = shotgunRoom.players.p1.position.x - 50;

    expect(sniperDistance).toBeCloseTo(170 / 60, 3);
    expect(shotgunDistance).toBeCloseTo(200 / 60, 3);
    expect(sniperDistance).toBeLessThan(shotgunDistance);
  });

  it("sound sensors persist until destroyed by one bullet", () => {
    const map = testMap();
    map.spawns[1]!.position = { x: 250, y: 180 };
    const room = activeRoom(map);
    applyClientMessage(room, "p1", { type: "command", seq: 1, tick: room.tick, move: { x: 0, y: 0 }, aim: 0, fire: false, use: "none", gadget: "sound", gadgetTarget: { x: 150, y: 120 } });
    stepRoom(room);
    const sensor = room.soundSensors[0]!;
    for (let i = 0; i < 900; i += 1) stepRoom(room);
    expect(room.soundSensors[0]).toBe(sensor);
    expect(sensor.destroyed).not.toBe(true);
    applyClientMessage(room, "p1", { type: "command", seq: 2, tick: room.tick, move: { x: 0, y: 0 }, aim: 0, fire: true, use: "none" });
    for (let i = 0; i < 24; i += 1) stepRoom(room);
    applyClientMessage(room, "p1", { type: "command", seq: 3, tick: room.tick, move: { x: 0, y: 0 }, aim: 0, fire: true, use: "none" });
    stepRoom(room);
    expect(sensor.destroyed).toBe(true);
  });

  it("places deployable walls with angle and destroys them after eight shots", () => {
    const map = testMap();
    map.spawns[1]!.position = { x: 250, y: 120 };
    const room = activeRoom(map);
    applyClientMessage(room, "p1", { type: "command", seq: 1, tick: room.tick, move: { x: 0, y: 0 }, aim: 0, fire: false, use: "none", gadget: "wall", gadgetTarget: { x: 150, y: 120 }, gadgetAngle: Math.PI / 2 });
    stepRoom(room);
    const wall = room.map.walls.find((candidate) => candidate.id.includes("-wall-"))!;
    expect(room.players.p1.gadgets.wall).toBe(1);
    expect(wall.maxHp).toBe(8);
    expect(Math.abs(wall.a.x - wall.b.x)).toBeLessThan(0.001);
    expect(snapshotFor(room, "p1").visiblePlayers).toHaveLength(0);
    for (let i = 0; i < 24; i += 1) stepRoom(room);

    for (let shot = 0; shot < 8; shot += 1) {
      applyClientMessage(room, "p1", { type: "command", seq: 2 + shot, tick: room.tick, move: { x: 0, y: 0 }, aim: 0, fire: true, use: "none" });
      for (let i = 0; i < 6; i += 1) stepRoom(room);
    }
    expect(wall.destroyed).toBe(true);
  });

  it("does not consume unavailable gadget counts", () => {
    const room = activeRoom(testMap());
    applyClientMessage(room, "p1", { type: "command", seq: 1, tick: room.tick, move: { x: 0, y: 0 }, aim: 0, fire: false, use: "none", gadget: "wall", gadgetTarget: { x: 150, y: 120 } });
    stepRoom(room);
    for (let i = 0; i < 24; i += 1) stepRoom(room);
    applyClientMessage(room, "p1", { type: "command", seq: 2, tick: room.tick, move: { x: 0, y: 0 }, aim: 0, fire: false, use: "none", gadget: "wall", gadgetTarget: { x: 180, y: 120 } });
    stepRoom(room);
    for (let i = 0; i < 24; i += 1) stepRoom(room);
    applyClientMessage(room, "p1", { type: "command", seq: 3, tick: room.tick, move: { x: 0, y: 0 }, aim: 0, fire: false, use: "none", gadget: "wall", gadgetTarget: { x: 200, y: 120 } });
    stepRoom(room);
    expect(room.players.p1.gadgets.wall).toBe(0);
    expect(room.map.walls.filter((wall) => wall.id.includes("-wall-"))).toHaveLength(2);
  });

  it("enforces assault rifle cadence and kills a player in five hits", () => {
    const room = activeRoom(testMap());
    applyClientMessage(room, "p1", { type: "command", seq: 1, tick: room.tick, move: { x: 0, y: 0 }, aim: 0, fire: true, use: "none" });
    stepRoom(room);
    expect(room.players.p2.hp).toBe(4);
    stepRoom(room);
    stepRoom(room);
    expect(room.players.p2.hp).toBe(4);
    for (let i = 0; i < 30; i += 1) stepRoom(room);
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

  it("fully resets tactical map state after a non-final round", () => {
    const map = testMap();
    map.walls.push(createWall("panel", "solid", { x: 120, y: 180 }, { x: 160, y: 180 }, 8, { destructible: true }));
    map.walls.push(createWall("door-reset", "door", { x: 150, y: 20 }, { x: 150, y: 80 }, 8));
    const room = activeRoom(map);
    const panel = room.map.walls.find((wall) => wall.id === "panel")!;
    const door = room.map.walls.find((wall) => wall.id === "door-reset")!;
    panel.destroyed = true;
    door.currentAngle = 1;
    door.b = { x: 190, y: 80 };
    room.deployedCameras.push({ id: "cam", owner: "p1", position: { x: 100, y: 100 }, radius: 120, hp: 1 });
    room.molotovs.push({ id: "molotov", owner: "p1", position: { x: 100, y: 100 }, radius: 55, createdAtTick: room.tick, expiresAtTick: room.tick + 100 });
    room.smokes.push({ id: "smoke", owner: "p1", position: { x: 100, y: 100 }, radius: 62, createdAtTick: room.tick, expiresAtTick: room.tick + 100 });
    room.soundSensors.push({ id: "sound", owner: "p1", position: { x: 100, y: 100 }, radius: 135, hp: 1, createdAtTick: room.tick, triggeredUntilTick: room.tick + 10 });
    room.map.walls.push(createWall("deployable-reset", "solid", { x: 90, y: 90 }, { x: 126, y: 90 }, 10, { destructible: true }));
    room.slots.p1.lastSeenWalls.set("stale", createWall("stale", "solid", { x: 10, y: 10 }, { x: 20, y: 10 }, 8));
    expect(room.slots.p1.lastSeenWalls.size).toBeGreaterThan(0);
    room.players.p2.hp = 1;
    applyClientMessage(room, "p1", { type: "command", seq: 1, tick: room.tick, move: { x: 0, y: 0 }, aim: 0, fire: true, use: "none" });
    stepRoom(room);
    expect(room.round.phase).toBe("countdown");
    expect(room.map.walls.find((wall) => wall.id === "panel")?.destroyed).not.toBe(true);
    expect(room.map.walls.find((wall) => wall.id === "door-reset")?.currentAngle).toBe(0);
    expect(room.deployedCameras).toHaveLength(0);
    expect(room.molotovs).toHaveLength(0);
    expect(room.smokes).toHaveLength(0);
    expect(room.soundSensors).toHaveLength(0);
    expect(room.map.walls.find((wall) => wall.id === "deployable-reset")).toBeUndefined();
    expect(room.players.p1.gadgets).toEqual({ camera: 1, molotov: 1, smoke: 2, wall: 2, sound: 1 });
    expect(room.slots.p1.lastSeenWalls.size).toBe(0);
  });

  it("expires only unfilled lobbies older than sixty seconds", () => {
    const lobby = createRoom("old");
    lobby.createdAtMs -= 60_001;
    expect(isExpiredUnfilledLobby(lobby)).toBe(true);

    const full = createRoom("full");
    full.createdAtMs -= 60_001;
    joinRoom(full, false, "p1");
    joinRoom(full, false, "p2");
    expect(isExpiredUnfilledLobby(full)).toBe(false);
  });

  it("expires the timer as a draw without awarding a point", () => {
    const room = activeRoom(testMap());
    room.tick = room.round.endsAtTick - 1;
    stepRoom(room);
    expect(room.round.winner).toBe("draw");
    expect(room.round.scores).toEqual({ p1: 0, p2: 0 });
  });

  it("blocks bullets on intact transparent windows and destroys destructible windows before later shots pass through", () => {
    const map = testMap();
    map.walls.push(createWall("glass", "transparent", { x: 100, y: 80 }, { x: 100, y: 160 }, 8, { destructible: true }));
    const room = activeRoom(map);
    applyClientMessage(room, "p1", { type: "command", seq: 1, tick: room.tick, move: { x: 0, y: 0 }, aim: 0, fire: true, use: "none" });
    stepRoom(room);
    expect(room.map.walls.find((wall) => wall.id === "glass")?.destroyed).toBe(true);
    expect(room.players.p2.hp).toBe(5);
    for (let i = 0; i < 6; i += 1) stepRoom(room);
    applyClientMessage(room, "p1", { type: "command", seq: 2, tick: room.tick, move: { x: 0, y: 0 }, aim: 0, fire: true, use: "none" });
    stepRoom(room);
    expect(room.players.p2.hp).toBe(4);
  });

  it("blocks bullets on non-destructible transparent windows", () => {
    const map = testMap();
    map.walls.push(createWall("window", "transparent", { x: 100, y: 80 }, { x: 100, y: 160 }, 8));
    const room = activeRoom(map);
    applyClientMessage(room, "p1", { type: "command", seq: 1, tick: room.tick, move: { x: 0, y: 0 }, aim: 0, fire: true, use: "none" });
    stepRoom(room);
    expect(room.players.p2.hp).toBe(5);
    expect(room.map.walls.find((wall) => wall.id === "window")?.destroyed).not.toBe(true);
  });

  it("keeps mesh surfaces shoot-through", () => {
    const map = testMap();
    map.walls.push(createWall("mesh", "mesh", { x: 160, y: 80 }, { x: 160, y: 160 }, 8, { destructible: true }));
    const room = activeRoom(map);
    applyClientMessage(room, "p1", { type: "command", seq: 1, tick: room.tick, move: { x: 0, y: 0 }, aim: 0, fire: true, use: "none" });
    stepRoom(room);
    expect(room.map.walls.find((wall) => wall.id === "mesh")?.destroyed).toBe(true);
    expect(room.players.p2.hp).toBe(4);
  });

  it("applies class factory gadget loadouts and preserves them on round reset", () => {
    const room = createRoom("loadouts", testMap());
    joinRoom(room, false, "p1", { classId: "scout", weaponId: "assault" });
    joinRoom(room, false, "p2", { classId: "breacher", weaponId: "assault" });
    expect(room.players.p1.className).toBe("Scout");
    expect(room.players.p1.gadgets).toMatchObject({ camera: 2, molotov: 0, sound: 2 });
    expect(room.players.p2.gadgets).toMatchObject({ camera: 0, molotov: 2, wall: 3 });
    for (let i = 0; i < 46; i += 1) stepRoom(room);
    room.players.p1.gadgets.camera = 0;
    shootUntilRoundEnds(room);
    expect(room.players.p1.gadgets.camera).toBe(2);
  });

  it("operator tactical ping reveals enemies through walls and enters cooldown", () => {
    const map = testMap();
    map.walls.push(createWall("ping-wall", "solid", { x: 150, y: 80 }, { x: 150, y: 160 }, 8));
    const room = activeRoomWithLoadout(map, { classId: "operator", weaponId: "assault" });

    applyClientMessage(room, "p1", { type: "command", seq: 1, tick: room.tick, move: { x: 0, y: 0 }, aim: 0, fire: false, use: "none", ability: true });
    stepRoom(room);

    const snapshot = snapshotFor(room, "p1");
    const pings = snapshot.detections.filter((detection) => detection.kind === "tactical-ping");
    expect(pings).toHaveLength(1);
    expect(pings[0]?.targetId).toBe("p2");
    expect(snapshot.self.abilityReadyAtTick).toBeGreaterThan(snapshot.tick);

    applyClientMessage(room, "p1", { type: "command", seq: 2, tick: room.tick, move: { x: 0, y: 0 }, aim: 0, fire: false, use: "none", ability: true });
    stepRoom(room);
    const result = snapshotFor(room, "p1").actionResults.find((action) => action.seq === 2 && action.action === "ability");
    expect(result).toMatchObject({ accepted: false, reason: "action-lockout" });
  });

  it("scout dash moves through collision without leaving map bounds", () => {
    const room = activeRoomWithLoadout(testMap(), { classId: "scout", weaponId: "assault" });
    applyClientMessage(room, "p1", { type: "command", seq: 1, tick: room.tick, move: { x: 0, y: 0 }, aim: 0, fire: false, use: "none", ability: true });
    stepRoom(room);
    expect(room.players.p1.position.x).toBeGreaterThan(120);

    const boundsRoom = activeRoomWithLoadout(testMap(), { classId: "scout", weaponId: "assault" });
    boundsRoom.players.p1.position = { x: 288, y: 120 };
    applyClientMessage(boundsRoom, "p1", { type: "command", seq: 1, tick: boundsRoom.tick, move: { x: 0, y: 0 }, aim: 0, fire: false, use: "none", ability: true });
    stepRoom(boundsRoom);
    expect(boundsRoom.players.p1.position.x).toBeLessThanOrEqual(boundsRoom.map.bounds.width - 10);
  });

  it("breacher ability destroys non-level walls but preserves boundary walls", () => {
    const map = testMap();
    map.walls.push(createWall("hard-wall", "solid", { x: 92, y: 80 }, { x: 92, y: 160 }, 8, { destructible: false }));
    const room = activeRoomWithLoadout(map, { classId: "breacher", weaponId: "assault" });
    applyClientMessage(room, "p1", { type: "command", seq: 1, tick: room.tick, move: { x: 0, y: 0 }, aim: 0, fire: false, use: "none", ability: true });
    stepRoom(room);
    expect(room.map.walls.find((wall) => wall.id === "hard-wall")?.destroyed).toBe(true);

    const boundsMap = testMap();
    boundsMap.walls.push(createWall("west", "solid", { x: 0, y: 0 }, { x: 0, y: 240 }, 8, { destructible: false }));
    const boundsRoom = activeRoomWithLoadout(boundsMap, { classId: "breacher", weaponId: "assault" });
    applyClientMessage(boundsRoom, "p1", { type: "command", seq: 1, tick: boundsRoom.tick, move: { x: 0, y: 0 }, aim: Math.PI, fire: false, use: "none", ability: true });
    stepRoom(boundsRoom);
    expect(boundsRoom.map.walls.find((wall) => wall.id === "west")?.destroyed).not.toBe(true);
    expect(snapshotFor(boundsRoom, "p1").actionResults.find((action) => action.seq === 1 && action.action === "ability")).toMatchObject({ accepted: false });
  });

  it("queues in-game loadout changes and applies them on the next round", () => {
    const room = activeRoomWithLoadout(testMap(), { classId: "operator", weaponId: "assault" });
    applyClientMessage(room, "p1", { type: "loadout", loadout: { classId: "scout", weaponId: "shotgun" } });

    expect(room.players.p1.classId).toBe("operator");
    expect(room.players.p1.weaponId).toBe("assault");
    expect(snapshotFor(room, "p1").nextLoadout).toEqual({ classId: "scout", weaponId: "shotgun" });

    shootUntilRoundEnds(room);

    expect(room.players.p1.classId).toBe("scout");
    expect(room.players.p1.weaponId).toBe("shotgun");
    expect(room.players.p1.magSize).toBe(6);
    expect(room.players.p1.ammo).toBe(6);
    expect(room.players.p1.gadgets).toMatchObject({ camera: 2, molotov: 0, sound: 2 });
    expect(snapshotFor(room, "p1").nextLoadout).toBeUndefined();
  });

  it("applies queued loadout changes before the first active round starts", () => {
    const room = createRoom("pre-round-loadout", testMap());
    joinRoom(room, false, "p1", { classId: "scout", weaponId: "sniper" });
    joinRoom(room, false, "p2");
    applyClientMessage(room, "p1", { type: "loadout", loadout: { classId: "breacher", weaponId: "assault" } });

    for (let i = 0; i < 46; i += 1) stepRoom(room);

    expect(room.round.phase).toBe("active");
    expect(room.players.p1.classId).toBe("breacher");
    expect(room.players.p1.weaponId).toBe("assault");
    expect(room.players.p1.magSize).toBe(10);
    expect(room.players.p1.ammo).toBe(10);
    expect(room.players.p1.gadgets).toMatchObject({ camera: 0, molotov: 2, wall: 3 });
  });

  it("uses selected gun factories for vision and shotgun pellet damage", () => {
    const longMap = testMap();
    longMap.bounds.width = 900;
    longMap.spawns[1]!.position = { x: 430, y: 120 };
    const assaultRoom = createRoom("assault-vision", longMap);
    joinRoom(assaultRoom, false, "p1", { weaponId: "assault" });
    joinRoom(assaultRoom, false, "p2");
    for (let i = 0; i < 46; i += 1) stepRoom(assaultRoom);
    expect(snapshotFor(assaultRoom, "p1").visiblePlayers).toHaveLength(0);

    const sniperRoom = createRoom("sniper-vision", longMap);
    joinRoom(sniperRoom, false, "p1", { weaponId: "sniper" });
    joinRoom(sniperRoom, false, "p2");
    for (let i = 0; i < 46; i += 1) stepRoom(sniperRoom);
    expect(snapshotFor(sniperRoom, "p1").visiblePlayers[0]?.id).toBe("p2");

    const shotgunMap = testMap();
    shotgunMap.spawns[1]!.position = { x: 160, y: 120 };
    const shotgunRoom = activeRoomWithLoadout(shotgunMap, { weaponId: "shotgun" });
    expect(shotgunRoom.players.p1.weaponId).toBe("shotgun");
    expect(shotgunRoom.players.p1.magSize).toBe(6);
    expect(shotgunRoom.round.phase).toBe("active");
    expect(shotgunRoom.players.p1.ammo).toBe(6);
    applyClientMessage(shotgunRoom, "p1", { type: "command", seq: 1, tick: shotgunRoom.tick, move: { x: 0, y: 0 }, aim: 0, fire: true, use: "none" });
    stepRoom(shotgunRoom);
    expect(shotgunRoom.replay.events.filter((event) => event.type === "shot").length).toBeGreaterThan(1);
    expect(shotgunRoom.players.p2.hp).toBeLessThan(5);
    expect(shotgunRoom.players.p2.hp).toBeGreaterThan(0);
    expect(shotgunRoom.round.scores.p1 ?? 0).toBe(0);

    const sniperShotMap = testMap();
    sniperShotMap.bounds.width = 1600;
    sniperShotMap.spawns[1]!.position = { x: 1300, y: 120 };
    const sniperShotRoom = activeRoomWithLoadout(sniperShotMap, { weaponId: "sniper" });
    applyClientMessage(sniperShotRoom, "p1", { type: "command", seq: 1, tick: sniperShotRoom.tick, move: { x: 0, y: 0 }, aim: 0, fire: true, use: "none" });
    stepRoom(sniperShotRoom);
    expect(sniperShotRoom.replay.events.some((event) => event.type === "kill" && event.shooter === "p1" && event.target === "p2")).toBe(true);
  });

  it("destroys destructible solid walls after five shots and never destroys doors", () => {
    const map = testMap();
    map.spawns[1]!.position = { x: 260, y: 180 };
    map.walls.push(createWall("panel", "solid", { x: 110, y: 80 }, { x: 110, y: 160 }, 8, { destructible: true }));
    map.walls.push(createWall("door-target", "door", { x: 170, y: 80 }, { x: 170, y: 160 }, 8, { destructible: true }));
    const room = activeRoom(map);
    applyClientMessage(room, "p1", { type: "command", seq: 1, tick: room.tick, move: { x: 0, y: 0 }, aim: 0, fire: true, use: "none" });
    for (let i = 0; i < 31; i += 1) stepRoom(room);
    expect(room.map.walls.find((wall) => wall.id === "panel")?.destroyed).toBe(true);
    for (let i = 0; i < 4; i += 1) stepRoom(room);
    expect(room.map.walls.find((wall) => wall.id === "door-target")?.destroyed).not.toBe(true);
  });

  it("uses authored destructible health for segment damage", () => {
    const map = testMap();
    map.spawns[1]!.position = { x: 260, y: 180 };
    map.walls.push(createWall("custom-panel", "solid", { x: 110, y: 80 }, { x: 110, y: 160 }, 8, { destructible: true, maxHp: 4 }));
    const room = activeRoom(map);
    applyClientMessage(room, "p1", { type: "command", seq: 1, tick: room.tick, move: { x: 0, y: 0 }, aim: 0, fire: true, use: "none" });
    for (let i = 0; i < 13; i += 1) stepRoom(room);
    expect(room.map.walls.find((wall) => wall.id === "custom-panel")?.destroyed).not.toBe(true);
    for (let i = 0; i < 7; i += 1) stepRoom(room);
    expect(room.map.walls.find((wall) => wall.id === "custom-panel")?.destroyed).toBe(true);
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
  return activeRoomWithLoadout(map);
}

function activeRoomWithLoadout(map: MapDefinition, p1Loadout?: Parameters<typeof joinRoom>[3]) {
  const room = createRoom("combat", map);
  joinRoom(room, false, "p1", p1Loadout);
  joinRoom(room, false, "p2");
  for (let i = 0; i < 46; i += 1) stepRoom(room);
  return room;
}

function shootUntilRoundEnds(room: ReturnType<typeof activeRoom>): void {
  applyClientMessage(room, "p1", { type: "command", seq: room.tick, tick: room.tick, move: { x: 0, y: 0 }, aim: 0, fire: true, use: "none" });
  for (let i = 0; i < 31 && room.round.phase === "active"; i += 1) stepRoom(room);
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
