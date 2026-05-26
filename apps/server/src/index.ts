import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import type { ClientHello, ClientMessage, PlayerId, RoomSummary, ServerMessage } from "@tac/shared";
import { handleCorsPreflight } from "./cors.js";
import { listMaps, readMap, writeMap } from "./mapStore.js";
import { applyClientMessage, createRoom, isExpiredUnfilledLobby, joinRoom, snapshotFor, stepRoom, TICK_MS, type RoomState } from "./sim.js";
import { MAX_SOCKET_BUFFERED_AMOUNT, SNAPSHOT_INTERVAL_TICKS } from "./sim/config.js";

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? "0.0.0.0";
const clientDist = resolve(process.cwd(), "apps/client/dist");
const rooms = new Map<string, RoomState>();
const sockets = new Map<WebSocket, { roomId: string; playerId: PlayerId }>();
const reconnect = new Map<string, { roomId: string; playerId: PlayerId }>();
let simulationTimer: ReturnType<typeof setInterval> | undefined;
let serverTick = 0;
let lastTickDurationMs = 0;
let averageTickDurationMs = 0;
const staticFileCache = new Map<string, string | null>();

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
    const slot = room?.slots[session.playerId];
    if (slot) slot.connected = false;
  });
});

function startSimulationLoop(): void {
  if (simulationTimer) return;
  simulationTimer = setInterval(runSimulationTick, TICK_MS);
}

function stopSimulationLoopIfIdle(): void {
  if (!simulationTimer || rooms.size > 0) return;
  clearInterval(simulationTimer);
  simulationTimer = undefined;
}

function runSimulationTick(): void {
  const startedAt = performance.now();
  serverTick += 1;
  cleanupExpiredRooms();
  for (const room of rooms.values()) {
    stepRoom(room);
  }
  cleanupEndedRooms();
  if (serverTick % SNAPSHOT_INTERVAL_TICKS !== 0) {
    recordTickDuration(startedAt);
    stopSimulationLoopIfIdle();
    return;
  }
  const socketsByRoom = new Map<string, Array<[WebSocket, PlayerId]>>();
  for (const [socket, session] of sockets.entries()) {
    if (socket.readyState !== socket.OPEN || !shouldSendSnapshot(socket)) continue;
    const group = socketsByRoom.get(session.roomId);
    if (group) group.push([socket, session.playerId]);
    else socketsByRoom.set(session.roomId, [[socket, session.playerId]]);
  }
  for (const [roomId, group] of socketsByRoom.entries()) {
    const room = rooms.get(roomId);
    if (!room) continue;
    for (const [socket, playerId] of group) send(socket, snapshotFor(room, playerId));
  }
  recordTickDuration(startedAt);
  stopSimulationLoopIfIdle();
}

server.listen(PORT, HOST, () => {
  console.log(`Authoritative tactical server listening on ws://${HOST}:${PORT}`);
  console.log(`Map editor API listening on http://${HOST}:${PORT}/api/maps`);
});

async function handleHttp(request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse): Promise<void> {
  if (handleCorsPreflight(request, response)) return;

  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  try {
    if (request.method === "GET" && url.pathname === "/api/maps") {
      sendJson(response, 200, { maps: await listMaps() });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/health") {
      sendJson(response, 200, healthPayload());
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
    if (request.method === "GET" || request.method === "HEAD") {
      await sendStaticClient(response, url.pathname, request.method === "HEAD");
      return;
    }
    sendJson(response, 404, { error: "Not found" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    sendJson(response, 400, { error: message });
  }
}

async function sendStaticClient(response: import("node:http").ServerResponse, pathname: string, headOnly: boolean): Promise<void> {
  const filePath = await staticFileForPath(pathname);
  if (!filePath) {
    sendJson(response, 404, { error: "Not found" });
    return;
  }
  response.writeHead(200, staticHeaders(filePath));
  if (headOnly) {
    response.end();
    return;
  }
  createReadStream(filePath).pipe(response);
}

async function staticFileForPath(pathname: string): Promise<string | null> {
  const cached = staticFileCache.get(pathname);
  if (cached !== undefined) return cached;
  const decoded = decodeURIComponent(pathname);
  const requested = normalize(decoded).replace(/^(\.\.(\/|\\|$))+/, "");
  const filePath = resolve(clientDist, requested === "/" ? "index.html" : requested.slice(1));
  if (!filePath.startsWith(clientDist)) {
    staticFileCache.set(pathname, null);
    return null;
  }
  if (await isFile(filePath)) {
    staticFileCache.set(pathname, filePath);
    return filePath;
  }
  const indexPath = join(clientDist, "index.html");
  const resolvedIndex = await isFile(indexPath) ? indexPath : null;
  staticFileCache.set(pathname, resolvedIndex);
  return resolvedIndex;
}

function staticHeaders(filePath: string): Record<string, string> {
  const immutableAsset = filePath.includes(`${clientDist}/assets/`);
  return {
    "Content-Type": contentType(filePath),
    "Cache-Control": immutableAsset ? "public, max-age=31536000, immutable" : "no-cache"
  };
}

async function isFile(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

function contentType(filePath: string): string {
  switch (extname(filePath)) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".png":
      return "image/png";
    case ".svg":
      return "image/svg+xml";
    default:
      return "application/octet-stream";
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
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  response.end(JSON.stringify(value));
}

function healthPayload(): Record<string, unknown> {
  const heap = process.memoryUsage().heapUsed / (1024 * 1024);
  return {
    ok: true,
    uptimeSeconds: Math.round(process.uptime()),
    rooms: rooms.size,
    activeRooms: [...rooms.values()].filter((room) => room.round.phase === "active" || room.round.phase === "overtime").length,
    sockets: sockets.size,
    heapUsedMb: Math.round(heap * 10) / 10,
    tick: {
      rateHz: Math.round(1000 / TICK_MS),
      snapshotRateHz: Math.round(1000 / (TICK_MS * SNAPSHOT_INTERVAL_TICKS)),
      lastDurationMs: Math.round(lastTickDurationMs * 1000) / 1000,
      averageDurationMs: Math.round(averageTickDurationMs * 1000) / 1000
    }
  };
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
  startSimulationLoop();
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
      playerCount: room.slotList.filter((slot) => slot.connected).length,
      maxPlayers: room.slotList.length,
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

function shouldSendSnapshot(socket: WebSocket): boolean {
  return socket.bufferedAmount <= MAX_SOCKET_BUFFERED_AMOUNT;
}

function recordTickDuration(startedAt: number): void {
  lastTickDurationMs = performance.now() - startedAt;
  averageTickDurationMs = averageTickDurationMs === 0 ? lastTickDurationMs : averageTickDurationMs * 0.95 + lastTickDurationMs * 0.05;
}
