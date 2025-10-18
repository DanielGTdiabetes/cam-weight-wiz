import { storage, type FeatureFlags, type FeatureFlagKey, DEFAULT_FEATURE_FLAGS } from './storage';

export const FEATURE_FLAG_DEFINITIONS: Array<{
  key: FeatureFlagKey;
  title: string;
  description: string;
}> = [
  {
    key: 'navSafeExit',
    title: 'Navegación segura',
    description: 'Muestra controles extra para salir de temporizador y recetas.',
  },
  {
    key: 'voiceSelector',
    title: 'Selector de voz real',
    description: 'Permite elegir voces reales y ejecutar pruebas de TTS.',
  },
  {
    key: 'timerAlarms',
    title: 'Alarmas de temporizador',
    description: 'Activa beeps y avisos por voz al finalizar el temporizador.',
  },
  {
    key: 'calibrationV2',
    title: 'Calibración asistida v2',
    description: 'Habilita la nueva experiencia de tara y asistente en dos pasos.',
  },
  {
    key: 'networkModal',
    title: 'Modal de Wi-Fi',
    description: 'Usa un modal interno para cambiar la red Wi-Fi.',
  },
  {
    key: 'miniEbStable',
    title: 'MINI-EB estable',
    description: 'Aplica reintentos y estados claros en el acceso MINI-EB.',
  },
  {
    key: 'otaCheck',
    title: 'OTA check',
    description: 'Habilita la comprobación de actualizaciones OTA desde ajustes.',
  },
  {
    key: 'otaApply',
    title: 'OTA apply',
    description: 'Permite lanzar la aplicación de actualizaciones OTA.',
  },
  {
    key: 'remoteMirror',
    title: 'Acceso remoto completo',
    description: 'Ofrece la misma interfaz de la báscula en clientes remotos (modo espejo).',
  },
  {
    key: 'debugLogs',
    title: 'Logs de depuración',
    description: 'Muestra logs adicionales en consola para diagnósticos.',
  },
  {
    key: 'mascotMotion',
    title: 'Animación de mascota',
    description: 'Activa movimiento suave y reacciones animadas de Basculin.',
  },
];

const cloneFlags = (flags: FeatureFlags): FeatureFlags => ({
  navSafeExit: flags.navSafeExit,
  voiceSelector: flags.voiceSelector,
  timerAlarms: flags.timerAlarms,
  calibrationV2: flags.calibrationV2,
  networkModal: flags.networkModal,
  miniEbStable: flags.miniEbStable,
  otaCheck: flags.otaCheck,
  otaApply: flags.otaApply,
  debugLogs: flags.debugLogs,
  mascotMotion: flags.mascotMotion,
  remoteMirror: flags.remoteMirror,
});

export const getFeatureFlags = (): FeatureFlags => {
  try {
    const settings = storage.getSettings();
    return cloneFlags(settings.ui.flags);
  } catch (error) {
    console.error('Error loading feature flags', error);
    return { ...DEFAULT_FEATURE_FLAGS };
  }
};

export const isFeatureEnabled = (flag: FeatureFlagKey): boolean => {
  const flags = getFeatureFlags();
  return Boolean(flags[flag]);
};

export const setFeatureFlag = (
  flag: FeatureFlagKey,
  enabled: boolean
): FeatureFlags => {
  const current = getFeatureFlags();
  const updated = cloneFlags(current);
  updated[flag] = enabled;

  storage.saveSettings({
    ui: {
      flags: updated,
    },
  });

  return updated;
};

export type { FeatureFlagKey, FeatureFlags };
