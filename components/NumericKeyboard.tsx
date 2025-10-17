import { Delete } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface NumericKeyboardProps {
  onKeyPress: (key: string) => void;
  onBackspace: () => void;
  onClear?: () => void;
  showDecimal?: boolean;
  className?: string;
}

export const NumericKeyboard = ({
  onKeyPress,
  onBackspace,
  onClear,
  showDecimal = false,
  className,
}: NumericKeyboardProps) => {
  const keys = [
    ["1", "2", "3"],
    ["4", "5", "6"],
    ["7", "8", "9"],
    [showDecimal ? "." : "", "0", "⌫"],
  ];

  return (
    <div className={cn("grid gap-3", className)}>
      {keys.map((row, rowIndex) => (
        <div key={rowIndex} className="grid grid-cols-3 gap-3">
          {row.map((key, keyIndex) => {
            if (!key) return <div key={keyIndex} />;
            
            if (key === "⌫") {
              return (
                <Button
                  key={keyIndex}
                  variant="outline"
                  size="xxl"
                  onClick={onBackspace}
                  className="active:scale-95"
                >
                  <Delete className="h-7 w-7" />
                </Button>
              );
            }

            return (
              <Button
                key={keyIndex}
                variant="outline"
                size="xxl"
                onClick={() => onKeyPress(key)}
                className="font-bold active:scale-95"
              >
                {key}
              </Button>
            );
          })}
        </div>
      ))}
      {onClear && (
        <Button
          variant="destructive"
          size="xxl"
          onClick={onClear}
          className="active:scale-95"
        >
          Borrar Todo
        </Button>
      )}
    </div>
  );
};
