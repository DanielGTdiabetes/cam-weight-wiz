import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Loader2, Mic, Play, Save, StopCircle } from "lucide-react";
import { playSound, preloadAllSounds } from "@/lib/audio";
import { useRecorder } from "@/hooks/useRecorder";
import { api, type VoiceInfo, type VoiceTranscriptionResult } from "@/services/api";

const SOUND_BUTTONS: { label: string; sound: "beep" | "success" | "error" }[] = [
  { label: "Beep", sound: "beep" },
  { label: "Éxito", sound: "success" },
  { label: "Error", sound: "error" },
];

export const VoiceTester = () => {
  const [voices, setVoices] = useState<VoiceInfo[]>([]);
  const [defaultVoice, setDefaultVoice] = useState<string | undefined>();
  const [loadingVoices, setLoadingVoices] = useState(true);
  const [text, setText] = useState("Hola, esto es una prueba de voz desde la báscula digital.");
  const [ttsLoading, setTtsLoading] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [transcribing, setTranscribing] = useState(false);
  const [savingClip, setSavingClip] = useState(false);
  const recorder = useRecorder();

  useEffect(() => {
    preloadAllSounds();
    let cancelled = false;

    const fetchVoices = async () => {
      try {
        const response = await api.getVoices();
        if (cancelled) {
          return;
        }
        setVoices(response.voices);
        setDefaultVoice(response.defaultVoice ?? response.voices[0]?.id);
      } catch (error) {
        console.error("Failed to load voices", error);
        setErrorMessage("No se pudieron obtener las voces disponibles");
      } finally {
        if (!cancelled) {
          setLoadingVoices(false);
        }
      }
    };

    void fetchVoices();
    return () => {
      cancelled = true;
    };
  }, []);

  const selectedVoice = useMemo(() => defaultVoice ?? voices[0]?.id ?? "", [defaultVoice, voices]);

  const handlePlaySound = async (sound: "beep" | "success" | "error") => {
    setErrorMessage(null);
    setStatusMessage(null);
    await playSound(sound);
  };

  const handleSpeak = async () => {
    if (!text.trim()) {
      setErrorMessage("Escribe un texto para sintetizar");
      return;
    }
    if (!selectedVoice) {
      setErrorMessage("No hay voces disponibles");
      return;
    }

    setTtsLoading(true);
    setErrorMessage(null);
    setStatusMessage("Generando audio...");

    try {
      const audioBuffer = await api.synthesizeVoice(text, selectedVoice);
      const blob = new Blob([audioBuffer], { type: "audio/wav" });
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.onended = () => URL.revokeObjectURL(url);
      await audio.play();
      setStatusMessage("Reproducción completada");
    } catch (error) {
      console.error("Failed to synthesize text", error);
      setErrorMessage("No se pudo sintetizar el texto");
    } finally {
      setTtsLoading(false);
    }
  };

  const handleToggleRecording = async () => {
    setErrorMessage(null);

    if (!recorder.isRecording) {
      const started = await recorder.startRecording();
      if (started) {
        setStatusMessage("Grabando... pulsa detener para transcribir");
      }
      return;
    }

    const blob = await recorder.stopRecording();
    if (!blob) {
      setStatusMessage("Grabación cancelada");
      return;
    }

    setStatusMessage("Procesando audio...");
    setTranscribing(true);

    try {
      const result: VoiceTranscriptionResult = await api.transcribeVoice(blob);
      if (result.ok && result.transcript) {
        setText(result.transcript);
        setStatusMessage("Transcripción completada");
      } else if (result.reason === "whisper_not_installed") {
        setStatusMessage("Reconocimiento no disponible: instala whisper.cpp");
      } else {
        setStatusMessage("Audio recibido, pero no se pudo transcribir");
      }
    } catch (error) {
      console.error("Failed to transcribe audio", error);
      setErrorMessage("No se pudo transcribir la grabación");
    } finally {
      setTranscribing(false);
    }
  };

  const handleUploadClip = async () => {
    if (!recorder.audioBlob) {
      setErrorMessage("No hay ninguna grabación disponible");
      return;
    }

    setSavingClip(true);
    setErrorMessage(null);
    setStatusMessage("Guardando clip en el dispositivo...");

    try {
      await api.uploadVoiceClip(recorder.audioBlob, "voice-tester.webm");
      setStatusMessage("Clip guardado en /opt/bascula/data/voice");
    } catch (error) {
      console.error("Failed to upload clip", error);
      setErrorMessage("No se pudo guardar el clip");
    } finally {
      setSavingClip(false);
    }
  };

  return (
    <Card className="space-y-6 p-6">
      <div className="space-y-2">
        <h2 className="text-2xl font-bold">Pruebas de Voz y Sonido</h2>
        <p className="text-sm text-muted-foreground">
          Reproduce sonidos, sintetiza texto con TTS y prueba el reconocimiento de voz del dispositivo.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-3">
          <Label>Sonidos rápidos</Label>
          <div className="flex flex-wrap gap-2">
            {SOUND_BUTTONS.map(({ label, sound }) => (
              <Button key={sound} variant="secondary" onClick={() => handlePlaySound(sound)}>
                {label}
              </Button>
            ))}
          </div>
        </div>

        <div className="space-y-3">
          <Label htmlFor="voice-select">Voz de síntesis</Label>
          <Select
            value={selectedVoice}
            onValueChange={(value) => {
              setDefaultVoice(value);
              setStatusMessage(null);
            }}
            disabled={loadingVoices || voices.length === 0}
          >
            <SelectTrigger id="voice-select">
              <SelectValue placeholder={loadingVoices ? "Cargando voces..." : "Selecciona una voz"} />
            </SelectTrigger>
            <SelectContent>
              {voices.map((voice) => (
                <SelectItem key={voice.id} value={voice.id}>
                  {voice.name ?? voice.id}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="space-y-3">
        <Label htmlFor="tts-text">Texto a sintetizar</Label>
        <Textarea
          id="tts-text"
          value={text}
          onChange={(event) => setText(event.target.value)}
          rows={4}
          placeholder="Escribe aquí el texto que quieras reproducir"
        />
        <Button onClick={handleSpeak} disabled={ttsLoading || !selectedVoice} className="w-full md:w-auto">
          {ttsLoading ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Generando
            </>
          ) : (
            <>
              <Play className="mr-2 h-4 w-4" /> Hablar
            </>
          )}
        </Button>
      </div>

      <div className="space-y-3">
        <Label>Grabación y transcripción</Label>
        <div className="flex flex-wrap gap-2">
          <Button
            variant={recorder.isRecording ? "destructive" : "outline"}
            onClick={handleToggleRecording}
            disabled={!recorder.isSupported || transcribing}
          >
            {recorder.isRecording ? (
              <>
                <StopCircle className="mr-2 h-4 w-4" /> Detener y transcribir
              </>
            ) : (
              <>
                <Mic className="mr-2 h-4 w-4" /> Grabar y transcribir
              </>
            )}
          </Button>

          <Button
            variant="secondary"
            onClick={handleUploadClip}
            disabled={!recorder.audioBlob || savingClip || transcribing}
          >
            {savingClip ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Procesando
              </>
            ) : (
              <>
                <Save className="mr-2 h-4 w-4" /> Guardar último clip
              </>
            )}
          </Button>
        </div>
        {!recorder.isSupported && (
          <p className="text-sm text-muted-foreground">El navegador no soporta grabación de audio.</p>
        )}
      </div>

      {statusMessage && <p className="text-sm text-muted-foreground">{statusMessage}</p>}
      {errorMessage && <p className="text-sm text-destructive">{errorMessage}</p>}
    </Card>
  );
};
