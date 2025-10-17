import type { AppSettingsUpdate } from "@/services/storage";

const PLACEHOLDER = "__stored__";

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const toNumber = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed || trimmed === PLACEHOLDER) {
      return undefined;
    }
    const parsed = Number(trimmed);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
};

const toBoolean = (value: unknown): boolean | undefined => {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === PLACEHOLDER) {
      return undefined;
    }
    if (["1", "true", "yes", "on"].includes(normalized)) {
      return true;
    }
    if (["0", "false", "no", "off"].includes(normalized)) {
      return false;
    }
  }
  return undefined;
};

const normalizeDecimals = (value: number | undefined): 0 | 1 | undefined => {
  if (value === undefined) {
    return undefined;
  }
  if (value <= 0) {
    return 0;
  }
  return 1;
};

export const buildAppSettingsUpdateFromBackend = (
  payload: Record<string, unknown> | null | undefined,
): AppSettingsUpdate => {
  const updates: AppSettingsUpdate = {};
  if (!payload || typeof payload !== "object") {
    return updates;
  }

  const network = payload.network as Record<string, unknown> | undefined;
  const openAiKey = network?.openai_api_key;
  if (isNonEmptyString(openAiKey) && openAiKey !== PLACEHOLDER) {
    updates.chatGptKey = openAiKey.trim();
  }

  const nightscout = payload.nightscout as Record<string, unknown> | undefined;
  const nightscoutUrl = nightscout?.url;
  if (isNonEmptyString(nightscoutUrl) && nightscoutUrl !== PLACEHOLDER) {
    updates.nightscoutUrl = nightscoutUrl.trim();
  }
  const nightscoutToken = nightscout?.token;
  if (isNonEmptyString(nightscoutToken) && nightscoutToken !== PLACEHOLDER) {
    updates.nightscoutToken = nightscoutToken.trim();
  }

  const diabetes = payload.diabetes as Record<string, unknown> | undefined;
  if (diabetes) {
    const enabled = toBoolean(diabetes.diabetes_enabled);
    if (enabled !== undefined) {
      updates.diabetesMode = enabled;
    }

    const correction = toNumber(diabetes.correction_factor);
    if (correction !== undefined) {
      updates.correctionFactor = correction;
    }

    const ratio = toNumber(diabetes.carb_ratio);
    if (ratio !== undefined) {
      updates.carbRatio = ratio;
    }

    const target = toNumber(diabetes.target_glucose);
    if (target !== undefined) {
      updates.targetGlucose = target;
    }

    const hypo = toNumber(diabetes.hypo_alarm);
    if (hypo !== undefined) {
      updates.hypoAlarm = hypo;
    }

    const hyper = toNumber(diabetes.hyper_alarm);
    if (hyper !== undefined) {
      updates.hyperAlarm = hyper;
    }
  }

  const scale = payload.scale as Record<string, unknown> | undefined;
  if (scale) {
    const factor = toNumber(scale.calibration_factor);
    if (factor !== undefined) {
      updates.calibrationFactor = factor;
    }
    const decimalsCandidate = normalizeDecimals(toNumber(scale.decimals));
    if (decimalsCandidate !== undefined) {
      updates.scale = {
        ...(updates.scale ?? {}),
        decimals: decimalsCandidate,
      };
    }
  }

  const ui = payload.ui as Record<string, unknown> | undefined;
  if (ui) {
    const soundEnabled = toBoolean(ui.sound_enabled);
    if (soundEnabled !== undefined) {
      updates.isVoiceActive = soundEnabled;
    }

    const flags = ui.flags as Record<string, unknown> | undefined;
    if (flags && typeof flags === "object") {
      const normalizedFlags: Record<string, boolean> = {};
      Object.entries(flags).forEach(([key, value]) => {
        const flagValue = toBoolean(value);
        if (flagValue !== undefined) {
          normalizedFlags[key] = flagValue;
        }
      });
      if (Object.keys(normalizedFlags).length > 0) {
        updates.ui = {
          ...(updates.ui ?? {}),
          flags: normalizedFlags,
        };
      }
    }
  }

  const tts = payload.tts as Record<string, unknown> | undefined;
  const voiceId = tts?.voice_id;
  if (isNonEmptyString(voiceId) && voiceId !== PLACEHOLDER) {
    updates.voiceId = voiceId.trim();
  }

  return updates;
};
