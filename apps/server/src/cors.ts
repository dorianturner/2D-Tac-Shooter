import type { IncomingMessage, ServerResponse } from "node:http";

const defaultAllowedHeaders = "Content-Type, Authorization";
const allowedMethods = "GET, PUT, OPTIONS";

export function applyCorsHeaders(request: IncomingMessage, response: ServerResponse): void {
  const configuredOrigin = process.env.CORS_ORIGIN ?? "*";
  const requestOrigin = request.headers.origin;
  const allowOrigin = configuredOrigin === "echo" ? requestOrigin ?? "*" : configuredOrigin;
  response.setHeader("Access-Control-Allow-Origin", allowOrigin);
  response.setHeader("Access-Control-Allow-Methods", allowedMethods);
  response.setHeader("Access-Control-Allow-Headers", request.headers["access-control-request-headers"] ?? defaultAllowedHeaders);
  response.setHeader("Access-Control-Max-Age", "86400");
  response.setHeader("Vary", "Origin, Access-Control-Request-Headers");
}

export function handleCorsPreflight(request: IncomingMessage, response: ServerResponse): boolean {
  applyCorsHeaders(request, response);
  if (request.method !== "OPTIONS") return false;
  response.writeHead(204);
  response.end();
  return true;
}
