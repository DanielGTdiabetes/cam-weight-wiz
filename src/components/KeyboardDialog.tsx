import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { NumericKeyboard } from "./NumericKeyboard";
import { AlphanumericKeyboard } from "./AlphanumericKeyboard";

interface KeyboardDialogProps {
  open: boolean;
  onClose: () => void;
  value: string;
  onChange: (value: string) => void;
  onConfirm: () => void;
  title: string;
  type?: "numeric" | "text" | "password" | "url";
  showDecimal?: boolean;
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
}: KeyboardDialogProps) => {
  const isNumeric = type === "numeric";

  const handleKeyPress = (key: string) => {
    onChange(value + key);
  };

  const handleBackspace = () => {
    onChange(value.slice(0, -1));
  };

  const handleClear = () => {
    onChange("");
  };

  const handleConfirm = () => {
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
          <Input
            type={type === "password" ? "password" : "text"}
            value={value}
            readOnly
            className="text-2xl h-16 border-2"
          />
          
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
