import { createServer, type Server } from "node:net";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { createClamavScanner, parseScanReply } from "./clamav";

/** The EICAR test string: harmless, and every scanner reports it as a virus. Built from parts so this file is not itself flagged. */
const eicar = ["X5O!P%@AP[4\\PZX54(P^)7CC)7}$", "EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*"].join("");

/** A tiny clamd: answers zPING and decodes zINSTREAM chunks the way clamd does. */
function fakeClamd(options: { silent?: boolean; reply?: (body: Buffer) => string } = {}) {
  const received: { command: string; body: Buffer; chunks: number }[] = [];
  const server: Server = createServer((socket) => {
    let buffer = Buffer.alloc(0);
    socket.on("data", (data: Buffer) => {
      buffer = Buffer.concat([buffer, data]);
      if (options.silent) return;
      if (buffer.subarray(0, 6).toString() === "zPING\0") {
        socket.end("PONG\0");
        return;
      }
      const head = "zINSTREAM\0";
      if (buffer.subarray(0, head.length).toString() !== head) return;
      let offset = head.length;
      const parts: Buffer[] = [];
      while (buffer.length >= offset + 4) {
        const size = buffer.readUInt32BE(offset);
        if (size === 0) {
          const body = Buffer.concat(parts);
          received.push({ command: "INSTREAM", body, chunks: parts.length });
          const verdict = options.reply?.(body) ?? (body.includes(eicar) ? "stream: Win.Test.EICAR_HDB-1 FOUND" : "stream: OK");
          socket.end(`${verdict}\0`);
          return;
        }
        if (buffer.length < offset + 4 + size) return;
        parts.push(buffer.subarray(offset + 4, offset + 4 + size));
        offset += 4 + size;
      }
    });
  });
  return new Promise<{ port: number; received: typeof received; server: Server }>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ port: (server.address() as AddressInfo).port, received, server }));
  });
}

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

async function scannerWith(options: Parameters<typeof fakeClamd>[0] = {}, extra: { timeoutMs?: number; chunkBytes?: number } = {}) {
  const clamd = await fakeClamd(options);
  servers.push(clamd.server);
  return { clamd, scanner: createClamavScanner({ host: "127.0.0.1", port: clamd.port, ...extra }) };
}

describe("ClamAV scanner", () => {
  it("reads clamd's verdicts", () => {
    expect(parseScanReply("stream: OK")).toEqual({ status: "clean" });
    expect(parseScanReply("stream: Win.Test.EICAR_HDB-1 FOUND")).toEqual({ status: "infected", signature: "Win.Test.EICAR_HDB-1" });
    expect(() => parseScanReply("INSTREAM size limit exceeded. ERROR")).toThrow(/could not scan/);
    expect(() => parseScanReply("")).toThrow(/could not scan/);
  });

  it("streams a file in chunks and reports a clean file", async () => {
    const { clamd, scanner } = await scannerWith({}, { chunkBytes: 1_000 });
    const file = Buffer.alloc(4_500, 1);
    expect(await scanner.scan(file)).toEqual({ status: "clean" });
    expect(clamd.received[0]!.chunks).toBe(5);
    expect(clamd.received[0]!.body.equals(file)).toBe(true);
  });

  it("reports EICAR as infected", async () => {
    const { scanner } = await scannerWith();
    expect(await scanner.scan(Buffer.from(eicar))).toEqual({ status: "infected", signature: "Win.Test.EICAR_HDB-1" });
  });

  it("treats a scanner error, a silent scanner and a closed port as no verdict", async () => {
    const failing = await scannerWith({ reply: () => "stream: Can't allocate memory ERROR" });
    await expect(failing.scanner.scan(Buffer.from("x"))).rejects.toThrow(/could not scan/);
    const silent = await scannerWith({ silent: true }, { timeoutMs: 100 });
    await expect(silent.scanner.scan(Buffer.from("x"))).rejects.toThrow(/did not answer/);
    const closed = createClamavScanner({ host: "127.0.0.1", port: 1, timeoutMs: 500 });
    await expect(closed.scan(Buffer.from("x"))).rejects.toThrow(/unreachable/);
    expect(await closed.ping()).toBe(false);
  });

  it("pings", async () => {
    const { scanner } = await scannerWith();
    expect(await scanner.ping()).toBe(true);
  });
});
