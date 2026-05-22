const localHosts = new Set(["localhost", "127.0.0.1", "::1"]);
const defaultServerPort = "8787";

export function apiBaseUrl(): string {
  const configured = import.meta.env.VITE_API_BASE_URL ?? import.meta.env.VITE_API_BASE;
  if (configured) return stripTrailingSlash(configured);
  if (usesSeparateDevServer()) {
    return `${window.location.protocol}//${window.location.hostname}:${serverPort()}/api`;
  }
  return `${window.location.origin}/api`;
}

export function websocketUrl(): string {
  const configured = import.meta.env.VITE_WS_URL ?? import.meta.env.VITE_WS_BASE_URL;
  if (configured) return configured;
  if (usesSeparateDevServer()) {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${window.location.hostname}:${serverPort()}`;
  }
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}`;
}

function usesSeparateDevServer(): boolean {
  return import.meta.env.DEV || window.location.port === "5173" || localHosts.has(window.location.hostname);
}

function serverPort(): string {
  return import.meta.env.VITE_SERVER_PORT ?? defaultServerPort;
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
