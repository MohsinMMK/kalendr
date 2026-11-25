/**
 * The small interface every video provider implements: make a room, make one person's meeting token, close a room.
 * Daily is the first (daily.ts); fake.ts is local test mode. A provider never decides who may join: the visit
 * routes check the booking and the time first, then ask for a token.
 *
 * No "server-only" import: the worker makes rooms.
 */
export type VideoProviderName = "daily" | "fake";

export interface VideoRoom {
  /** The provider's own name for the room. Not a secret. */
  name: string;
  /** Where the call is: https://<domain>.daily.co/<name>, or a local marker in test mode. */
  url: string;
}

export interface CreateRoomRequest {
  /** Stable for this booking, so a retry after a crash finds the same room. */
  name: string;
  /** The room stops working at this time. */
  expiresAt: Date;
}

export interface CreateTokenRequest {
  roomName: string;
  /** Staff join as owners and can admit people; customers never are. */
  isOwner: boolean;
  /** Shown to the other person in the call. */
  displayName: string;
  /** The token works from here... */
  notBefore: Date;
  /** ...until here. */
  expiresAt: Date;
}

export interface VideoProvider {
  readonly name: VideoProviderName;
  createRoom(request: CreateRoomRequest): Promise<VideoRoom>;
  createToken(request: CreateTokenRequest): Promise<{ token: string }>;
  /** Closes a room early. A room that is already gone is not an error. */
  deleteRoom(roomName: string): Promise<void>;
}

/** The provider may accept the same call later: a timeout, a rate limit, a 5xx. The worker retries. */
export class VideoTransientError extends Error {
  constructor(readonly code: string) {
    super(`The video provider is unavailable (${code}).`);
    this.name = "VideoTransientError";
  }
}

/** The provider will never accept this request as it is. */
export class VideoPermanentError extends Error {
  constructor(readonly code: string) {
    super(`The video provider refused the request (${code}).`);
    this.name = "VideoPermanentError";
  }
}
