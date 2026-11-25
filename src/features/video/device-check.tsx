"use client";

import { ArrowRight, Camera, Mic, Volume2, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Meter, MeterIndicator, MeterTrack } from "@/components/ui/meter";

type Access = "idle" | "asking" | "ready" | "denied" | "missing" | "unsupported";

interface Devices {
  stream: MediaStream | null;
  hasVideo: boolean;
  hasAudio: boolean;
}

/** Asks for camera and microphone together, then each alone, so one missing device does not block the other. */
async function openDevices(): Promise<{ devices: Devices; access: Access }> {
  const media = navigator.mediaDevices;
  if (!media?.getUserMedia) return { devices: { stream: null, hasVideo: false, hasAudio: false }, access: "unsupported" };
  const attempts: Array<{ constraints: MediaStreamConstraints; hasVideo: boolean; hasAudio: boolean }> = [
    { constraints: { video: true, audio: true }, hasVideo: true, hasAudio: true },
    { constraints: { video: true }, hasVideo: true, hasAudio: false },
    { constraints: { audio: true }, hasVideo: false, hasAudio: true },
  ];
  let denied = false;
  for (const attempt of attempts) {
    try {
      const stream = await media.getUserMedia(attempt.constraints);
      return { devices: { stream, hasVideo: attempt.hasVideo, hasAudio: attempt.hasAudio }, access: "ready" };
    } catch (cause: unknown) {
      const name = cause instanceof DOMException ? cause.name : "";
      if (name === "NotAllowedError" || name === "SecurityError") {
        denied = true;
        break;
      }
    }
  }
  return { devices: { stream: null, hasVideo: false, hasAudio: false }, access: denied ? "denied" : "missing" };
}

/** A short tone through the speakers, made in the browser. */
async function playBeep(): Promise<void> {
  const Context = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Context) throw new Error("no audio");
  const context = new Context();
  await context.resume();
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.frequency.value = 523.25;
  gain.gain.setValueAtTime(0.0001, context.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.2, context.currentTime + 0.04);
  gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.6);
  oscillator.connect(gain).connect(context.destination);
  oscillator.start();
  oscillator.stop(context.currentTime + 0.65);
  await new Promise<void>((resolve) => {
    oscillator.onended = () => resolve();
  });
  await context.close().catch(() => undefined);
}

function Row({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 rounded-xl border bg-card p-4">
      <div className="flex items-center gap-2 font-medium text-sm">
        <span aria-hidden="true" className="text-muted-foreground">{icon}</span>
        <h3>{title}</h3>
      </div>
      {children}
    </div>
  );
}

/**
 * Camera preview, microphone level and a speaker test. Continue is always on: someone who says no to
 * the camera can still join by sound, or phone the business.
 */
export function DeviceCheck({
  onContinue,
  continueLabel = "I'm ready",
  continuing = false,
}: {
  /** Absent on the "Test your camera" page, which never joins. */
  onContinue?: () => void;
  continueLabel?: string;
  continuing?: boolean;
}) {
  const [access, setAccess] = useState<Access>("idle");
  const [devices, setDevices] = useState<Devices>({ stream: null, hasVideo: false, hasAudio: false });
  const [level, setLevel] = useState(0);
  const [speaker, setSpeaker] = useState<"idle" | "playing" | "done" | "error">("idle");
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const stopAll = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  useEffect(() => stopAll, [stopAll]);

  async function turnOn() {
    stopAll();
    setAccess("asking");
    const result = await openDevices();
    streamRef.current = result.devices.stream;
    setDevices(result.devices);
    setAccess(result.access);
  }

  useEffect(() => {
    const element = videoRef.current;
    if (element) element.srcObject = devices.hasVideo ? devices.stream : null;
  }, [devices]);

  // Microphone level: read the loudness a few times a second.
  useEffect(() => {
    if (!devices.stream || !devices.hasAudio) return;
    const Context = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Context) return;
    const context = new Context();
    const source = context.createMediaStreamSource(devices.stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    const samples = new Uint8Array(analyser.fftSize);
    const id = window.setInterval(() => {
      analyser.getByteTimeDomainData(samples);
      let sum = 0;
      for (const sample of samples) {
        const centred = (sample - 128) / 128;
        sum += centred * centred;
      }
      const rms = Math.sqrt(sum / samples.length);
      setLevel(Math.min(100, Math.round(rms * 400)));
    }, 100);
    return () => {
      window.clearInterval(id);
      source.disconnect();
      void context.close().catch(() => undefined);
      setLevel(0);
    };
  }, [devices]);

  async function testSpeaker() {
    setSpeaker("playing");
    try {
      await playBeep();
      setSpeaker("done");
    } catch {
      setSpeaker("error");
    }
  }

  const trouble = access === "denied" || access === "missing" || access === "unsupported";

  return (
    <div className="flex flex-col gap-4" data-testid="device-check">
      {access === "idle" || access === "asking" ? (
        <div className="flex flex-col items-start gap-2">
          <p className="text-muted-foreground text-sm">Your browser will ask to use your camera and microphone. We only use them for the call, and calls are never recorded.</p>
          <Button size="lg" onClick={() => void turnOn()} loading={access === "asking"}>
            <Camera aria-hidden="true" /> Turn on camera and microphone
          </Button>
        </div>
      ) : null}

      {access === "denied" ? (
        <Alert variant="warning">
          <TriangleAlert aria-hidden="true" />
          <AlertTitle>We can&rsquo;t use your camera or microphone</AlertTitle>
          <AlertDescription className="flex flex-col gap-3">
            <span>Tap the lock or camera icon next to the web address and allow the camera and microphone. Then try again. You can also carry on without them and join by sound only, or phone us.</span>
            <span><Button variant="outline" onClick={() => void turnOn()}>Try again</Button></span>
          </AlertDescription>
        </Alert>
      ) : null}
      {access === "missing" ? (
        <Alert variant="warning">
          <TriangleAlert aria-hidden="true" />
          <AlertTitle>We couldn&rsquo;t find a camera or microphone</AlertTitle>
          <AlertDescription className="flex flex-col gap-3">
            <span>Plug one in or check that another app is not using it, then try again. You can still carry on.</span>
            <span><Button variant="outline" onClick={() => void turnOn()}>Try again</Button></span>
          </AlertDescription>
        </Alert>
      ) : null}
      {access === "unsupported" ? (
        <Alert variant="warning">
          <TriangleAlert aria-hidden="true" />
          <AlertTitle>This browser can&rsquo;t check your camera</AlertTitle>
          <AlertDescription>Try Chrome, Safari or Edge, or phone us.</AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2">
        <Row icon={<Camera className="size-4" />} title="Camera">
          <div className="relative aspect-video w-full overflow-hidden rounded-lg bg-muted">
            {/* muted: you never hear yourself */}
            <video ref={videoRef} autoPlay muted playsInline aria-label="Your camera preview" className="size-full -scale-x-100 object-cover" />
            {!devices.hasVideo ? (
              <p className="absolute inset-0 flex items-center justify-center p-3 text-center text-muted-foreground text-sm">
                {access === "ready" ? "No camera found." : "Your camera shows here."}
              </p>
            ) : null}
          </div>
        </Row>
        <div className="flex flex-col gap-3">
          <Row icon={<Mic className="size-4" />} title="Microphone">
            <Meter value={level} min={0} max={100} aria-label="Microphone level">
              <MeterTrack className="h-2.5 rounded-full">
                <MeterIndicator className="motion-reduce:transition-none" />
              </MeterTrack>
            </Meter>
            <p className="text-muted-foreground text-xs">
              {!devices.hasAudio ? (access === "ready" ? "No microphone found." : "Say something once it is on. The bar should move.") : level > 5 ? "We can hear you." : "Say something. The bar should move."}
            </p>
          </Row>
          <Row icon={<Volume2 className="size-4" />} title="Speakers">
            <div className="flex flex-wrap items-center gap-3">
              <Button variant="outline" onClick={() => void testSpeaker()} disabled={speaker === "playing"}>
                <Volume2 aria-hidden="true" /> Play a test sound
              </Button>
              <p role="status" className="text-muted-foreground text-xs">
                {speaker === "playing" ? "Playing…" : speaker === "done" ? "Did you hear it? If not, turn your volume up." : speaker === "error" ? "This browser could not play a sound." : ""}
              </p>
            </div>
          </Row>
        </div>
      </div>

      {onContinue ? (
        <div className="flex flex-col gap-2">
          <Button size="lg" className="w-full sm:w-auto sm:self-start" onClick={onContinue} loading={continuing}>
            {continueLabel}
            <ArrowRight aria-hidden="true" />
          </Button>
          {trouble ? <p className="text-muted-foreground text-xs">You can carry on without your camera or microphone.</p> : null}
        </div>
      ) : null}
    </div>
  );
}
