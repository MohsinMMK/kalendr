/**
 * Virus scanning with ClamAV's clamd, over its TCP protocol (INSTREAM).
 *
 * Every uploaded file is scanned by the worker before anyone can open or share it. The bytes
 * scanned are the plain file, sent over the private network to clamd and never stored by it.
 *
 * - With CLAMAV_HOST set, uploads wait as "pending" until the worker scans them.
 * - Without it, development marks uploads "skipped" (not scanned), and production refuses
 *   uploads: a clinic should never receive an unscanned file by accident.
 *
 * No "server-only" import: the worker uses this module.
 */
import { Socket } from "node:net";

import { env } from "../env";

export type ScanResult = { status: "clean" } | { status: "infected"; signature: string };

export interface Scanner {
  scan(bytes: Uint8Array): Promise<ScanResult>;
  ping(): Promise<boolean>;
}

export interface ClamavOptions {
  host: string;
  port: number;
  timeoutMs?: number;
  chunkBytes?: number;
}

/** Sends one command and collects clamd's reply up to its terminating NUL. */
function talk(options: ClamavOptions, write: (socket: Socket) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = new Socket();
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = (error: Error | null, reply?: string) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(reply ?? "");
    };
    socket.setTimeout(options.timeoutMs ?? 60_000, () => finish(new Error("The virus scanner did not answer in time")));
    socket.on("error", (error) => finish(new Error(`The virus scanner is unreachable: ${error.message}`)));
    socket.on("data", (data: Buffer) => {
      chunks.push(data);
      const all = Buffer.concat(chunks);
      const end = all.indexOf(0);
      if (end >= 0) finish(null, all.subarray(0, end).toString("utf8").trim());
    });
    socket.on("end", () => finish(null, Buffer.concat(chunks).toString("utf8").replace(/\0+$/, "").trim()));
    socket.connect(options.port, options.host, () => write(socket));
  });
}

export function parseScanReply(reply: string): ScanResult {
  if (reply === "stream: OK") return { status: "clean" };
  const found = /^stream: (.+) FOUND$/.exec(reply);
  if (found?.[1]) return { status: "infected", signature: found[1] };
  // "... ERROR" (size limit, unreadable stream) and anything unexpected: not a verdict.
  throw new Error("The virus scanner could not scan this file");
}

export function createClamavScanner(options: ClamavOptions): Scanner {
  const chunkBytes = options.chunkBytes ?? 64 * 1024;
  return {
    async scan(bytes) {
      const reply = await talk(options, (socket) => {
        socket.write("zINSTREAM\0");
        for (let offset = 0; offset < bytes.byteLength; offset += chunkBytes) {
          const chunk = bytes.subarray(offset, Math.min(offset + chunkBytes, bytes.byteLength));
          const length = Buffer.alloc(4);
          length.writeUInt32BE(chunk.byteLength);
          socket.write(length);
          socket.write(chunk);
        }
        socket.write(Buffer.alloc(4));
      });
      return parseScanReply(reply);
    },
    async ping() {
      try {
        return (await talk({ ...options, timeoutMs: options.timeoutMs ?? 5_000 }, (socket) => socket.write("zPING\0"))) === "PONG";
      } catch {
        return false;
      }
    },
  };
}

/** The configured scanner, or null when CLAMAV_HOST is not set. */
export function configuredScanner(): Scanner | null {
  const { CLAMAV_HOST: host, CLAMAV_PORT: port } = env();
  return host ? createClamavScanner({ host, port }) : null;
}

/**
 * What an upload does about scanning: "scan" (wait as pending for the worker), "skip"
 * (development with no scanner: usable at once, marked not scanned) or "refuse"
 * (production with no scanner).
 */
export function uploadScanMode(): "scan" | "skip" | "refuse" {
  const { CLAMAV_HOST: host, NODE_ENV } = env();
  if (host) return "scan";
  return NODE_ENV === "production" ? "refuse" : "skip";
}
