import { useCallback, useEffect, useRef, useState } from "react";

export interface UseRecorderResult {
  isSupported: boolean;
  isRecording: boolean;
  audioBlob: Blob | null;
  error: string | null;
  startRecording: () => Promise<boolean>;
  stopRecording: () => Promise<Blob | null>;
  clearRecording: () => void;
  requestPermission: () => Promise<boolean>;
}

const DEFAULT_MIME_TYPES = [
  "audio/webm;codecs=opus",
  "audio/ogg;codecs=opus",
  "audio/webm",
  "audio/ogg",
];

const pickSupportedMimeType = (): string | undefined => {
  if (typeof window === "undefined" || typeof MediaRecorder === "undefined") {
    return undefined;
  }

  return DEFAULT_MIME_TYPES.find((type) => MediaRecorder.isTypeSupported(type));
};

export const useRecorder = (): UseRecorderResult => {
  const [isRecording, setIsRecording] = useState(false);
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const streamRef = useRef<MediaStream | null>(null);

  const isSupported = typeof window !== "undefined" && typeof MediaRecorder !== "undefined";

  const cleanupStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => {
      try {
        track.stop();
      } catch {
        // ignore
      }
    });
    streamRef.current = null;
  }, []);

  const requestPermission = useCallback(async () => {
    if (!isSupported || !navigator.mediaDevices?.getUserMedia) {
      setError("Grabación no soportada en este navegador");
      return false;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      return true;
    } catch (err) {
      console.error("Failed to get user media", err);
      setError("Permiso de micrófono denegado");
      return false;
    }
  }, [isSupported]);

  const startRecording = useCallback(async () => {
    setError(null);

    if (!isSupported) {
      setError("Grabación no soportada");
      return false;
    }

    try {
      if (!streamRef.current) {
        const permitted = await requestPermission();
        if (!permitted) {
          return false;
        }
      }

      const mimeType = pickSupportedMimeType();
      const recorder = mimeType
        ? new MediaRecorder(streamRef.current as MediaStream, { mimeType })
        : new MediaRecorder(streamRef.current as MediaStream);

      chunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data?.size) {
          chunksRef.current.push(event.data);
        }
      };
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType });
        setAudioBlob(blob);
      };

      recorder.start();
      mediaRecorderRef.current = recorder;
      setIsRecording(true);
      setAudioBlob(null);
      return true;
    } catch (err) {
      console.error("Failed to start recording", err);
      setError("No se pudo iniciar la grabación");
      cleanupStream();
      return false;
    }
  }, [cleanupStream, isSupported, requestPermission]);

  const stopRecording = useCallback(async () => {
    return await new Promise<Blob | null>((resolve) => {
      const recorder = mediaRecorderRef.current;
      if (!recorder) {
        resolve(audioBlob);
        return;
      }

      const handleStop = () => {
        recorder.removeEventListener("stop", handleStop);
        setIsRecording(false);
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType });
        setAudioBlob(blob);
        resolve(blob);
      };

      recorder.addEventListener("stop", handleStop);
      try {
        recorder.stop();
      } catch (err) {
        console.error("Failed to stop recording", err);
        setError("No se pudo detener la grabación");
        resolve(null);
      }
    });
  }, [audioBlob]);

  const clearRecording = useCallback(() => {
    setAudioBlob(null);
    chunksRef.current = [];
  }, []);

  useEffect(() => () => {
    cleanupStream();
  }, [cleanupStream]);

  return {
    isSupported,
    isRecording,
    audioBlob,
    error,
    startRecording,
    stopRecording,
    clearRecording,
    requestPermission,
  };
};
