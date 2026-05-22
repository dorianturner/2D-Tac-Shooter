import { describe, expect, it } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { handleCorsPreflight } from "../src/cors.js";

describe("cors preflight", () => {
  it("responds to OPTIONS with requested headers and no body", () => {
    const headers = new Map<string, string | number | readonly string[]>();
    let status = 0;
    let ended = false;
    const request = {
      method: "OPTIONS",
      headers: {
        origin: "http://localhost:5173",
        "access-control-request-headers": "content-type,x-test"
      }
    } as IncomingMessage;
    const response = {
      setHeader: (key: string, value: number | string | readonly string[]) => {
        headers.set(key, value);
        return response as ServerResponse;
      },
      writeHead: (code: number) => {
        status = code;
        return response as ServerResponse;
      },
      end: () => {
        ended = true;
        return response as ServerResponse;
      }
    } as ServerResponse;

    expect(handleCorsPreflight(request, response)).toBe(true);
    expect(status).toBe(204);
    expect(ended).toBe(true);
    expect(headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(headers.get("Access-Control-Allow-Methods")).toContain("OPTIONS");
    expect(headers.get("Access-Control-Allow-Headers")).toBe("content-type,x-test");
    expect(headers.get("Access-Control-Max-Age")).toBe("86400");
  });
});
