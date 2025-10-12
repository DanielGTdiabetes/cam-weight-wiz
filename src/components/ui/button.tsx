import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

// eslint-disable-next-line react-refresh/only-export-components
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md font-medium ring-offset-background transition-smooth focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 active:scale-95",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground supports-[hover:hover]:hover:bg-primary/90 glow-cyan",
        destructive: "bg-destructive text-destructive-foreground supports-[hover:hover]:hover:bg-destructive/90",
        outline: "border-2 border-border bg-card supports-[hover:hover]:hover:bg-accent supports-[hover:hover]:hover:text-accent-foreground",
        secondary: "bg-secondary text-secondary-foreground supports-[hover:hover]:hover:bg-secondary/80 glow-magenta",
        ghost: "supports-[hover:hover]:hover:bg-accent supports-[hover:hover]:hover:text-accent-foreground",
        link: "text-primary underline-offset-4 supports-[hover:hover]:hover:underline",
        success: "bg-success text-success-foreground supports-[hover:hover]:hover:bg-success/90 glow-green",
        warning: "bg-warning text-warning-foreground supports-[hover:hover]:hover:bg-warning/90",
        glow: "bg-gradient-to-r from-primary to-primary-glow text-primary-foreground supports-[hover:hover]:hover:opacity-90 glow-cyan",
      },
      size: {
        default: "h-12 px-5 py-3 text-base [&_svg]:size-5",
        sm: "h-10 rounded-md px-4 text-sm [&_svg]:size-4",
        lg: "h-14 rounded-lg px-8 text-lg [&_svg]:size-6",
        icon: "h-12 w-12 [&_svg]:size-6",
        xl: "h-16 rounded-lg px-12 text-xl [&_svg]:size-7",
        xxl: "h-20 rounded-xl px-16 text-2xl [&_svg]:size-8",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />;
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
