/**
 * Minimal HTTP-over-unix-socket POST, for inference endpoints exposed as a
 * socket (the host-side Claude relay is bind-mounted into the container, so
 * no TCP port is opened). Base URLs look like `unix:/run/relay/relay.sock`.
 */
import http from "http";

export function isUnixBaseUrl(baseUrl: string): boolean {
  return baseUrl.startsWith("unix:");
}

export interface UnixResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

export function postUnix(
  baseUrl: string,
  path: string,
  headers: Record<string, string>,
  body: string,
  timeoutMs: number,
): Promise<UnixResponse> {
  const socketPath = baseUrl.slice("unix:".length);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath,
        path,
        method: "POST",
        headers: { ...headers, "Content-Length": Buffer.byteLength(body) },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf-8");
          const status = res.statusCode ?? 0;
          resolve({
            ok: status >= 200 && status < 300,
            status,
            text: async () => text,
            json: async () => JSON.parse(text),
          });
        });
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error(`unix socket request timed out after ${timeoutMs}ms`)));
    req.on("error", reject);
    req.end(body);
  });
}
