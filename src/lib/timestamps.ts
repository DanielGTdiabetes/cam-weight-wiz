export const normalizeToIsoTimestamp = (value: unknown): string => {
  const fallback = new Date().toISOString();

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return fallback;
    }

    const parsed = Date.parse(trimmed);
    if (Number.isNaN(parsed)) {
      return fallback;
    }

    return new Date(parsed).toISOString();
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    try {
      return new Date(value).toISOString();
    } catch {
      return fallback;
    }
  }

  return fallback;
};

