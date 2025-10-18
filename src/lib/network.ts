import { storage } from "@/services/storage";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

const configuredHosts = (() => {
  const entries = [
    import.meta.env.VITE_PI_HOST,
    import.meta.env.VITE_PI_HOSTS,
    import.meta.env.VITE_PI_IP,
    import.meta.env.VITE_DEVICE_HOST,
  ];

  const hosts: string[] = [];
  for (const entry of entries) {
    if (typeof entry !== "string") {
      continue;
    }
    const pieces = entry
      .split(",")
      .map(part => part.trim())
      .filter(Boolean);
    hosts.push(...pieces);
  }
  return hosts;
})();

export const isLocalClient = (): boolean => {
  if (typeof window === "undefined") {
    return true;
  }

  try {
    const settings = storage.getSettings();
    if (settings.ui?.flags?.remoteMirror) {
      return true;
    }
  } catch {
    // Ignore storage access issues and fall back to host-based detection
  }

  const hostname = window.location.hostname || "";
  const normalised = hostname.trim().toLowerCase();

  if (!normalised) {
    return true;
  }

  if (LOCAL_HOSTS.has(normalised)) {
    return true;
  }

  return configuredHosts.some(host => host.toLowerCase() === normalised);
};

export const getConfiguredHosts = (): string[] => [...configuredHosts];
