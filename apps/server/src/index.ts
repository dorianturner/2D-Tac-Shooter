import { createServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { ClientHello, ClientMessage, PlayerId, RoomSummary, ServerMessage } from "@tac/shared";
import { listMaps, readMap, writeMap } from "./mapStore.js";
import { applyClientMessage, createRoom, isExpiredUnfilledLobby, joinRoom, snapshotFor, stepRoom, TICK_MS, type RoomState } from "./sim.js";

const PORT = Number(process.env.PORT ?? 8787);
const rooms = new Map<string, RoomState>();
const sockets = new Map<WebSocket, { roomId: string; playerId: PlayerId }>();
const reconnect = new Map<string, { roomId: string; playerId: PlayerId }>();

const server = createServer((request, response) => {
  void handleHttp(request, response);
});
const wss = new WebSocketServer({ server });

wss.on("connection", (socket) => {
  socket.on("message", (raw) => {
    const message = parseMessage(raw.toString());
    if (!message) {
      send(socket, { type: "error", message: "Invalid message" });
      return;
    }
    if (message.type === "hello") {
      void handleHello(socket, message);
      return;
    }
    const session = sockets.get(socket);
    if (!session) {
      send(socket, { type: "error", message: "Send hello before commands" });
      return;
    }
    const room = rooms.get(session.roomId);
    if (room) applyClientMessage(room, session.playerId, message);
  });

  socket.on("close", () => {
    const session = sockets.get(socket);
    sockets.delete(socket);
    if (!session) return;
    const room = rooms.get(session.roomId);
    if (room) room.slots[session.playerId].connected = false;
  });
});

setInterval(() => {
  cleanupExpiredRooms();
  for (const room of rooms.values()) {
    stepRoom(room);
  }
  cleanupEndedRooms();
  for (const [socket, session] of sockets.entries()) {
    const room = rooms.get(session.roomId);
    if (!room || socket.readyState !== socket.OPEN) continue;
    send(socket, snapshotFor(room, session.playerId));
  }
}, TICK_MS);

server.listen(PORT, () => {
  console.log(`Authoritative tactical server listening on ws://localhost:${PORT}`);
  console.log(`Map editor API listening on http://localhost:${PORT}/api/maps`);
});

async function handleHttp(request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse): Promise<void> {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET,PUT,OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (request.method === "OPTIONS") {
    response.writeHead(204).end();
    return;
  }

  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  try {
    if (request.method === "GET" && url.pathname === "/api/maps") {
      sendJson(response, 200, { maps: await listMaps() });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/rooms") {
      cleanupExpiredRooms();
      sendJson(response, 200, { rooms: listRooms() });
      return;
    }
    const match = /^\/api\/maps\/([a-z0-9-]+)$/.exec(url.pathname);
    if (match?.[1] && request.method === "GET") {
      sendJson(response, 200, await readMap(match[1]));
      return;
    }
    if (match?.[1] && request.method === "PUT") {
      const body = await readBody(request);
      sendJson(response, 200, await writeMap(match[1], JSON.parse(body)));
      return;
    }
    sendJson(response, 404, { error: "Not found" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    sendJson(response, 400, { error: message });
  }
}

function readBody(request: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolveBody, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) reject(new Error("Request body too large"));
    });
    request.on("end", () => resolveBody(body));
    request.on("error", reject);
  });
}

function sendJson(response: import("node:http").ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(value));
}

async function handleHello(socket: WebSocket, hello: ClientHello): Promise<void> {
  let preferred: PlayerId | undefined;
  let roomId = hello.mode === "create" ? createRoomId() : hello.roomId || "local";
  if (hello.reconnectToken) {
    const existing = reconnect.get(hello.reconnectToken);
    if (existing) {
      roomId = existing.roomId;
      preferred = existing.playerId;
    }
  }
  let room = rooms.get(roomId);
  if (!room && hello.mode === "join") {
    send(socket, { type: "error", message: `Room ${roomId} does not exist` });
    return;
  }
  if (room && (room.round.phase === "ended" || room.round.matchWinner)) {
    send(socket, { type: "error", message: `Room ${roomId} has ended` });
    return;
  }
  if (!room) {
    const map = hello.mapId ? await readMap(hello.mapId) : undefined;
    room = createAndStoreRoom(roomId, map);
  }
  const welcome = joinRoom(room, Boolean(hello.debug), preferred, hello.loadout);
  if (!welcome) {
    send(socket, { type: "error", message: "Room is full" });
    return;
  }
  sockets.set(socket, { roomId: welcome.roomId, playerId: welcome.playerId });
  reconnect.set(welcome.reconnectToken, { roomId: welcome.roomId, playerId: welcome.playerId });
  send(socket, welcome);
}

function createAndStoreRoom(roomId: string, map?: Parameters<typeof createRoom>[1]): RoomState {
  const room = createRoom(roomId, map);
  rooms.set(roomId, room);
  return room;
}

function listRooms(): RoomSummary[] {
  cleanupExpiredRooms();
  cleanupEndedRooms();
  return [...rooms.values()]
    .filter((room) => room.round.phase !== "ended" && !room.round.matchWinner)
    .map((room) => ({
      id: room.id,
      mapId: room.map.id,
      mapName: room.map.name,
      playerCount: Object.values(room.slots).filter((slot) => slot.connected).length,
      phase: room.round.phase
    }));
}

function cleanupEndedRooms(): void {
  for (const [roomId, room] of rooms.entries()) {
    if (room.round.phase !== "ended" && !room.round.matchWinner) continue;
    for (const [token, session] of reconnect.entries()) {
      if (session.roomId === roomId) reconnect.delete(token);
    }
    if ([...sockets.values()].some((session) => session.roomId === roomId)) continue;
    rooms.delete(roomId);
  }
}

function cleanupExpiredRooms(nowMs = Date.now()): void {
  for (const [roomId, room] of rooms.entries()) {
    if (!isExpiredUnfilledLobby(room, nowMs)) continue;
    for (const [socket, session] of sockets.entries()) {
      if (session.roomId !== roomId) continue;
      send(socket, { type: "error", message: "Lobby expired" });
      sockets.delete(socket);
      socket.close();
    }
    for (const [token, session] of reconnect.entries()) {
      if (session.roomId === roomId) reconnect.delete(token);
    }
    rooms.delete(roomId);
  }
}

function createRoomId(): string {
  let id = "";
  do {
    id = Math.random().toString(36).slice(2, 7).toUpperCase();
  } while (rooms.has(id));
  return id;
}

function parseMessage(raw: string): ClientMessage | null {
  try {
    return JSON.parse(raw) as ClientMessage;
  } catch {
    return null;
  }
}

function send(socket: WebSocket, message: ServerMessage): void {
  socket.send(JSON.stringify(message));
}
