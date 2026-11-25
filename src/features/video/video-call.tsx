"use client";

import { LogOut, TriangleAlert, VideoOff } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import type { VisitEnterView } from "@/lib/video-contracts";

import { PhoneFallback } from "./video-shared";

const TEST_ROOM_PREFIX = "kalendr-test-room://";

export function isTestRoom(enter: Pick<VisitEnterView, "provider" | "roomUrl">): boolean {
  return enter.provider === "test" || enter.roomUrl.startsWith(TEST_ROOM_PREFIX);
}

/** Frames are destroyed asynchronously; a new frame waits for the last one so Daily never sees two. */
let lastDestroy: Promise<unknown> = Promise.resolve();

/**
 * The call. With a real video account it shows Daily's call frame. In local test mode it only shows
 * your own camera, because nobody else can join a test room.
 */
export function VideoCall({
  enter,
  onLeave,
  businessPhone,
}: {
  enter: VisitEnterView;
  onLeave: () => void;
  businessPhone?: string | null;
}) {
  return isTestRoom(enter) ? (
    <TestCall onLeave={onLeave} businessPhone={businessPhone} />
  ) : (
    <DailyCall enter={enter} onLeave={onLeave} businessPhone={businessPhone} />
  );
}

function DailyCall({ enter, onLeave, businessPhone }: { enter: VisitEnterView; onLeave: () => void; businessPhone?: string | null }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const onLeaveRef = useRef(onLeave);
  const [state, setState] = useState<"connecting" | "joined" | "error">("connecting");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    onLeaveRef.current = onLeave;
  });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let cancelled = false;
    let frame: { destroy(): Promise<void> } | null = null;

    async function start(target: HTMLDivElement) {
      try {
        await lastDestroy;
        const { default: Daily } = await import("@daily-co/daily-js");
        if (cancelled) return;
        const call = Daily.createFrame(target, {
          showLeaveButton: true,
          showFullscreenButton: true,
          iframeStyle: { width: "100%", height: "100%", border: "0", borderRadius: "12px" },
        });
        frame = call;
        call.on("joined-meeting", () => {
          if (!cancelled) setState("joined");
        });
        call.on("left-meeting", () => {
          if (!cancelled) onLeaveRef.current();
        });
        call.on("error", () => {
          if (!cancelled) setState("error");
        });
        await call.join({ url: enter.roomUrl, token: enter.meetingToken });
        if (cancelled) return;
        setState((current) => (current === "error" ? current : "joined"));
      } catch {
        if (cancelled) return;
        setState("error");
        // Free the frame so "Try again" can make a new one.
        if (frame) {
          lastDestroy = frame.destroy().catch(() => undefined);
          frame = null;
        }
      }
    }
    void start(container);

    return () => {
      cancelled = true;
      if (frame) lastDestroy = frame.destroy().catch(() => undefined);
    };
  }, [enter.roomUrl, enter.meetingToken, attempt]);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3" data-testid="video-call">
      {state === "connecting" ? (
        <p role="status" className="flex items-center gap-2 text-muted-foreground text-sm">
          <Spinner aria-hidden="true" className="motion-reduce:animate-none" /> Connecting to the call…
        </p>
      ) : null}
      {state === "error" ? (
        <>
          <Alert variant="error">
            <TriangleAlert aria-hidden="true" />
            <AlertTitle>The call could not connect</AlertTitle>
            <AlertDescription className="flex flex-col gap-3">
              <span>Check your internet and that this page may use your camera and microphone.</span>
              <span>
                <Button variant="outline" onClick={() => { setState("connecting"); setAttempt((current) => current + 1); }}>Try again</Button>
              </span>
            </AlertDescription>
          </Alert>
          <PhoneFallback phone={businessPhone} />
        </>
      ) : null}
      <div
        ref={containerRef}
        aria-label="Video call"
        className={state === "error" ? "hidden" : "min-h-[22rem] w-full flex-1 overflow-hidden rounded-xl bg-muted"}
      />
    </div>
  );
}

function TestCall({ onLeave, businessPhone }: { onLeave: () => void; businessPhone?: string | null }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [problem, setProblem] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let opened: MediaStream | null = null;
    async function open() {
      if (!navigator.mediaDevices?.getUserMedia) {
        setProblem("This browser cannot show your camera.");
        return;
      }
      try {
        // Video only: the self-view never plays your own microphone.
        const media = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        if (cancelled) {
          media.getTracks().forEach((track) => track.stop());
          return;
        }
        opened = media;
        setProblem("");
        setStream(media);
      } catch {
        if (!cancelled) setProblem("We could not turn on your camera. Allow the camera for this page, then try again.");
      }
    }
    void open();
    return () => {
      cancelled = true;
      opened?.getTracks().forEach((track) => track.stop());
    };
  }, [attempt]);

  useEffect(() => {
    const element = videoRef.current;
    if (element) element.srcObject = stream;
  }, [stream]);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3" data-testid="video-call">
      <Alert variant="warning">
        <TriangleAlert aria-hidden="true" />
        <AlertDescription>Test mode: nobody else can join. Connect a video account to talk to others.</AlertDescription>
      </Alert>
      {problem ? (
        <>
          <Alert variant="error">
            <VideoOff aria-hidden="true" />
            <AlertDescription className="flex flex-col gap-3">
              <span>{problem}</span>
              <span><Button variant="outline" onClick={() => { setStream(null); setAttempt((current) => current + 1); }}>Try again</Button></span>
            </AlertDescription>
          </Alert>
          <PhoneFallback phone={businessPhone} />
        </>
      ) : (
        <div className="relative aspect-video w-full max-w-2xl self-center overflow-hidden rounded-xl bg-muted">
          {/* muted: your own microphone is never played back */}
          <video ref={videoRef} autoPlay muted playsInline aria-label="Your camera" className="size-full -scale-x-100 object-cover" />
        </div>
      )}
      <div>
        <Button variant="outline" size="lg" onClick={onLeave}>
          <LogOut aria-hidden="true" /> Leave the call
        </Button>
      </div>
    </div>
  );
}
