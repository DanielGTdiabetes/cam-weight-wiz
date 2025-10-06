import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { isFeatureEnabled } from "@/services/featureFlags";

type NavSafeExitContext = "page" | "modal";

interface UseNavSafeExitOptions {
  context?: NavSafeExitContext;
  onClose?: () => void;
}

export const useNavSafeExit = ({ context = "page", onClose }: UseNavSafeExitOptions = {}) => {
  const navigate = useNavigate();
  const [isTouchDevice, setIsTouchDevice] = useState(false);
  const navEnabled = useMemo(() => isFeatureEnabled("navSafeExit"), []);

  useEffect(() => {
    if (typeof window !== "undefined") {
      setIsTouchDevice("ontouchstart" in window);
    }
  }, []);

  const goBack = useCallback(() => {
    if (!navEnabled) {
      return;
    }

    if (typeof window !== "undefined" && window.history.length > 1) {
      navigate(-1);
      return;
    }

    navigate("/", { replace: true });
  }, [navEnabled, navigate]);

  const handleClose = useCallback(() => {
    if (onClose) {
      onClose();
      return;
    }
    goBack();
  }, [goBack, onClose]);

  return {
    navEnabled,
    isTouchDevice,
    goBack,
    handleClose,
    isModal: context === "modal",
  };
};
