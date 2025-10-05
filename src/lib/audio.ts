export type SoundName = "beep" | "success" | "error";

const SOUND_FILES: Record<SoundName, string> = {
  beep: "/sounds/beep.mp3",
  success: "/sounds/success.mp3",
  error: "/sounds/error.mp3",
};

const cache = new Map<SoundName, HTMLAudioElement>();

const getOrCreateAudio = (name: SoundName): HTMLAudioElement => {
  let audio = cache.get(name);
  if (!audio) {
    audio = new Audio(SOUND_FILES[name]);
    audio.preload = "auto";
    cache.set(name, audio);
  }
  return audio;
};

export const preloadSound = (name: SoundName): void => {
  void getOrCreateAudio(name);
};

export const preloadAllSounds = (): void => {
  (Object.keys(SOUND_FILES) as SoundName[]).forEach((name) => preloadSound(name));
};

export const playSound = async (name: SoundName): Promise<void> => {
  try {
    const audio = getOrCreateAudio(name).cloneNode(true) as HTMLAudioElement;
    audio.currentTime = 0;
    await audio.play();
  } catch (error) {
    console.error("Failed to play sound", name, error);
  }
};
