import { useState } from "react";
import { Delete } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface AlphanumericKeyboardProps {
  onKeyPress: (key: string) => void;
  onBackspace: () => void;
  onClear?: () => void;
  className?: string;
}

export const AlphanumericKeyboard = ({
  onKeyPress,
  onBackspace,
  onClear,
  className,
}: AlphanumericKeyboardProps) => {
  const [isUpperCase, setIsUpperCase] = useState(false);
  const [showSymbols, setShowSymbols] = useState(false);

  const letterRows = [
    ["q", "w", "e", "r", "t", "y", "u", "i", "o", "p"],
    ["a", "s", "d", "f", "g", "h", "j", "k", "l"],
    ["z", "x", "c", "v", "b", "n", "m"],
  ];

  const symbolRows = [
    ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"],
    ["@", "#", "$", "_", "&", "-", "+", "(", ")", "/"],
    ["*", '"', "'", ":", ";", "!", "?", ".", ","],
  ];

  const rows = showSymbols ? symbolRows : letterRows;

  return (
    <div className={cn("space-y-2", className)}>
      {rows.map((row, rowIndex) => (
        <div key={rowIndex} className="flex gap-1 justify-center">
          {rowIndex === 2 && (
            <Button
              variant="outline"
              size="lg"
              onClick={() => setIsUpperCase(!isUpperCase)}
              className={cn(
                "h-12 px-3 font-bold",
                isUpperCase && "bg-primary/20"
              )}
            >
              {isUpperCase ? "Aa" : "aa"}
            </Button>
          )}
          {row.map((key, keyIndex) => (
            <Button
              key={keyIndex}
              variant="outline"
              size="lg"
              onClick={() => onKeyPress(isUpperCase ? key.toUpperCase() : key)}
              className="h-12 min-w-[2.5rem] px-2 text-lg font-medium"
            >
              {isUpperCase ? key.toUpperCase() : key}
            </Button>
          ))}
          {rowIndex === 2 && (
            <Button
              variant="outline"
              size="lg"
              onClick={onBackspace}
              className="h-12 px-3"
            >
              <Delete className="h-5 w-5" />
            </Button>
          )}
        </div>
      ))}
      
      <div className="flex gap-1 justify-center">
        <Button
          variant="outline"
          size="lg"
          onClick={() => setShowSymbols(!showSymbols)}
          className="h-12 px-4"
        >
          {showSymbols ? "ABC" : "123"}
        </Button>
        <Button
          variant="outline"
          size="lg"
          onClick={() => onKeyPress(" ")}
          className="h-12 flex-1"
        >
          Espacio
        </Button>
        <Button
          variant="outline"
          size="lg"
          onClick={() => onKeyPress(".")}
          className="h-12 px-4"
        >
          .
        </Button>
        {onClear && (
          <Button
            variant="destructive"
            size="lg"
            onClick={onClear}
            className="h-12 px-4"
          >
            Borrar
          </Button>
        )}
      </div>
    </div>
  );
};
