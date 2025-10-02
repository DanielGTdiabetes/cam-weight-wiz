import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { NumericKeyboard } from "./NumericKeyboard";
import { AlphanumericKeyboard } from "./AlphanumericKeyboard";
import { validateUrl, validateNumber, validateText, validateApiKey, type ValidationResult } from "@/lib/validation";
import { AlertCircle } from "lucide-react";

interface KeyboardDialogProps {
  open: boolean;
  onClose: () => void;
  value: string;
  onChange: (value: string) => void;
  onConfirm: () => void;
  title: string;
  type?: "numeric" | "text" | "password" | "url" | "apikey";
  showDecimal?: boolean;
  min?: number;
  max?: number;
  maxLength?: number;
}

export const KeyboardDialog = ({
  open,
  onClose,
  value,
  onChange,
  onConfirm,
  title,
  type = "text",
  showDecimal = false,
  min,
  max,
  maxLength = 500,
}: KeyboardDialogProps) => {
  const [validationError, setValidationError] = useState<string | null>(null);
  const isNumeric = type === "numeric";

  // Validate input based on type
  const validateInput = (input: string): ValidationResult => {
    switch (type) {
      case "numeric":
        return validateNumber(input, min, max, showDecimal);
      case "url":
        return validateUrl(input);
      case "apikey":
        return validateApiKey(input);
      case "text":
      case "password":
        return validateText(input, undefined, maxLength);
      default:
        return { isValid: true };
    }
  };

  const handleKeyPress = (key: string) => {
    const newValue = value + key;
    
    // Enforce max length for text inputs
    if (!isNumeric && newValue.length > maxLength) {
      setValidationError(`Máximo ${maxLength} caracteres`);
      // Haptic feedback
      if (navigator.vibrate) {
        navigator.vibrate(50);
      }
      return;
    }
    
    onChange(newValue);
    setValidationError(null);
  };

  const handleBackspace = () => {
    onChange(value.slice(0, -1));
    setValidationError(null);
  };

  const handleClear = () => {
    onChange("");
    setValidationError(null);
  };

  const handleConfirm = () => {
    const validation = validateInput(value);
    
    if (!validation.isValid) {
      setValidationError(validation.error || "Valor inválido");
      // Haptic feedback for error
      if (navigator.vibrate) {
        navigator.vibrate([50, 100, 50]);
      }
      return;
    }
    
    // Haptic feedback for success
    if (navigator.vibrate) {
      navigator.vibrate(30);
    }
    
    onConfirm();
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle className="text-3xl">{title}</DialogTitle>
        </DialogHeader>
        
        <div className="space-y-5">
          <div className="space-y-2">
            <Input
              type={type === "password" ? "password" : "text"}
              value={value}
              readOnly
              className={`text-2xl h-16 border-2 ${validationError ? 'border-destructive' : ''}`}
            />
            {validationError && (
              <div className="flex items-center gap-2 text-destructive text-sm animate-fade-in">
                <AlertCircle className="h-4 w-4" />
                <span>{validationError}</span>
              </div>
            )}
          </div>
          
          {isNumeric ? (
            <NumericKeyboard
              onKeyPress={handleKeyPress}
              onBackspace={handleBackspace}
              onClear={handleClear}
              showDecimal={showDecimal}
            />
          ) : (
            <AlphanumericKeyboard
              onKeyPress={handleKeyPress}
              onBackspace={handleBackspace}
              onClear={handleClear}
            />
          )}

          <div className="grid grid-cols-2 gap-4">
            <Button
              variant="outline"
              size="xxl"
              onClick={onClose}
              className="active:scale-95"
            >
              Cancelar
            </Button>
            <Button
              variant="glow"
              size="xxl"
              onClick={handleConfirm}
              className="active:scale-95"
            >
              Confirmar
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};
