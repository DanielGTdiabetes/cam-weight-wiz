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
    <div className={cn("grid gap-2", className)}>
      {keys.map((row, rowIndex) => (
        <div key={rowIndex} className="grid grid-cols-3 gap-2">
          {row.map((key, keyIndex) => {
            if (!key) return <div key={keyIndex} />;
            
            if (key === "⌫") {
              return (
                <Button
                  key={keyIndex}
                  variant="outline"
                  size="xl"
                  onClick={onBackspace}
                  className="h-16 text-2xl"
                >
                  <Delete className="h-6 w-6" />
                </Button>
              );
            }

            return (
              <Button
                key={keyIndex}
                variant="outline"
                size="xl"
                onClick={() => onKeyPress(key)}
                className="h-16 text-2xl font-bold"
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
          size="xl"
          onClick={onClear}
          className="h-16 text-xl"
        >
          Borrar Todo
        </Button>
      )}
    </div>
  );
};
