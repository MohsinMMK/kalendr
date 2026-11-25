/**
 * Local test mode: rooms and tokens live in memory, nothing leaves the machine, and the call screen shows
 * only the person's own camera. Tests inspect what was asked of it.
 */
import { randomBytes } from "node:crypto";

import type { CreateRoomRequest, CreateTokenRequest, VideoProvider, VideoRoom } from "./provider";

export interface FakeVideoProvider extends VideoProvider {
  readonly rooms: Map<string, { room: VideoRoom; expiresAt: Date }>;
  readonly tokens: Array<CreateTokenRequest & { token: string }>;
  readonly deleted: string[];
  reset(): void;
}

export const FAKE_ROOM_URL_PREFIX = "kalendr-test-room://";

export function createFakeVideoProvider(): FakeVideoProvider {
  const rooms = new Map<string, { room: VideoRoom; expiresAt: Date }>();
  const tokens: Array<CreateTokenRequest & { token: string }> = [];
  const deleted: string[] = [];
  return {
    name: "fake",
    rooms,
    tokens,
    deleted,
    reset() {
      rooms.clear();
      tokens.length = 0;
      deleted.length = 0;
    },
    async createRoom({ name, expiresAt }: CreateRoomRequest) {
      const room = { name, url: `${FAKE_ROOM_URL_PREFIX}${name}` };
      rooms.set(name, { room, expiresAt });
      return room;
    },
    async createToken(request: CreateTokenRequest) {
      const token = `fake.${randomBytes(24).toString("base64url")}`;
      tokens.push({ ...request, token });
      return { token };
    },
    async deleteRoom(roomName: string) {
      rooms.delete(roomName);
      deleted.push(roomName);
    },
  };
}
