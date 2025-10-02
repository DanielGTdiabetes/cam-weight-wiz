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
    <div className={cn("space-y-3", className)}>
      {rows.map((row, rowIndex) => (
        <div key={rowIndex} className="flex gap-2 justify-center">
          {rowIndex === 2 && (
            <Button
              variant="outline"
              size="xl"
              onClick={() => setIsUpperCase(!isUpperCase)}
              className={cn(
                "px-4 font-bold active:scale-95",
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
              size="xl"
              onClick={() => onKeyPress(isUpperCase ? key.toUpperCase() : key)}
              className="min-w-[3rem] px-3 text-xl font-medium active:scale-95"
            >
              {isUpperCase ? key.toUpperCase() : key}
            </Button>
          ))}
          {rowIndex === 2 && (
            <Button
              variant="outline"
              size="xl"
              onClick={onBackspace}
              className="px-4 active:scale-95"
            >
              <Delete className="h-6 w-6" />
            </Button>
          )}
        </div>
      ))}
      
      <div className="flex gap-2 justify-center">
        <Button
          variant="outline"
          size="xl"
          onClick={() => setShowSymbols(!showSymbols)}
          className="px-5 active:scale-95"
        >
          {showSymbols ? "ABC" : "123"}
        </Button>
        <Button
          variant="outline"
          size="xl"
          onClick={() => onKeyPress(" ")}
          className="flex-1 active:scale-95"
        >
          Espacio
        </Button>
        <Button
          variant="outline"
          size="xl"
          onClick={() => onKeyPress(".")}
          className="px-5 active:scale-95"
        >
          .
        </Button>
        {onClear && (
          <Button
            variant="destructive"
            size="xl"
            onClick={onClear}
            className="px-5 active:scale-95"
          >
            Borrar
          </Button>
        )}
      </div>
    </div>
  );
};
