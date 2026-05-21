import type { MapDefinition } from "@tac/shared";
import type { RoomSummary } from "@tac/shared";

const API_BASE = "http://localhost:8787/api";

export interface MapSummary {
  id: string;
  name: string;
  version: number;
}

export async function listMaps(): Promise<MapSummary[]> {
  const response = await fetch(`${API_BASE}/maps`);
  if (!response.ok) throw new Error(await response.text());
  const payload = await response.json() as { maps: MapSummary[] };
  return payload.maps;
}

export async function loadMap(id: string): Promise<MapDefinition> {
  const response = await fetch(`${API_BASE}/maps/${id}`);
  if (!response.ok) throw new Error(await response.text());
  return await response.json() as MapDefinition;
}

export async function saveMap(map: MapDefinition): Promise<MapDefinition> {
  const response = await fetch(`${API_BASE}/maps/${map.id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(map)
  });
  if (!response.ok) throw new Error(await response.text());
  return await response.json() as MapDefinition;
}

export async function listRooms(): Promise<RoomSummary[]> {
  const response = await fetch(`${API_BASE}/rooms`);
  if (!response.ok) throw new Error(await response.text());
  const payload = await response.json() as { rooms: RoomSummary[] };
  return payload.rooms;
}
