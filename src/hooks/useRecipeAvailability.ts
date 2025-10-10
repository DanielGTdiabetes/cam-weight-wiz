import { useEffect, useState } from "react";
import { api, type RecipeStatus } from "@/services/api";
import { ApiError } from "@/services/apiWrapper";

interface RecipeAvailabilityState {
  loading: boolean;
  enabled: boolean;
  reason: string | null;
  model: string | null;
}

const initialState: RecipeAvailabilityState = {
  loading: true,
  enabled: false,
  reason: null,
  model: null,
};

const parseStatus = (status: RecipeStatus): RecipeAvailabilityState => ({
  loading: false,
  enabled: Boolean(status.enabled),
  reason: status.reason ?? null,
  model: status.model ?? null,
});

export const useRecipeAvailability = (): RecipeAvailabilityState => {
  const [state, setState] = useState<RecipeAvailabilityState>(initialState);

  useEffect(() => {
    let cancelled = false;

    const fetchStatus = async () => {
      try {
        const status = await api.getRecipeStatus();
        if (cancelled) {
          return;
        }
        setState(parseStatus(status));
      } catch (error) {
        if (cancelled) {
          return;
        }

        let message = "No se pudo comprobar la disponibilidad del asistente de recetas.";
        if (error instanceof ApiError && error.message) {
          message = error.message;
        }

        setState({ loading: false, enabled: false, reason: message, model: null });
      }
    };

    void fetchStatus();

    return () => {
      cancelled = true;
    };
  }, []);

  return state;
};

