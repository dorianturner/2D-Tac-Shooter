import type { MapDefinition } from "@tac/shared";
import type { RoomSummary } from "@tac/shared";
import { apiBaseUrl } from "./serverConfig";

export interface MapSummary {
  id: string;
  name: string;
  version: number;
}

export async function listMaps(): Promise<MapSummary[]> {
  const response = await fetch(`${apiBaseUrl()}/maps`);
  const payload = await readJson<{ maps: MapSummary[] }>(response, "Map list");
  return payload.maps;
}

export async function loadMap(id: string): Promise<MapDefinition> {
  const response = await fetch(`${apiBaseUrl()}/maps/${id}`);
  return await readJson<MapDefinition>(response, `Map ${id}`);
}

export async function saveMap(map: MapDefinition): Promise<MapDefinition> {
  const response = await fetch(`${apiBaseUrl()}/maps/${map.id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(map)
  });
  return await readJson<MapDefinition>(response, `Save ${map.id}`);
}

export async function listRooms(): Promise<RoomSummary[]> {
  const response = await fetch(`${apiBaseUrl()}/rooms`);
  const payload = await readJson<{ rooms: RoomSummary[] }>(response, "Room list");
  return payload.rooms;
}

async function readJson<T>(response: Response, label: string): Promise<T> {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${label} failed (${response.status}): ${text || response.statusText}`);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    const preview = text.trim().slice(0, 160) || "<empty response>";
    throw new Error(`${label} returned non-JSON from ${response.url}: ${preview}`);
  }
}
