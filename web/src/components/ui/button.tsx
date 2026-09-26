import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"
import { Slot } from "radix-ui"

const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-full border border-transparent text-sm font-medium whitespace-nowrap transition-all outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:bg-surface-2 disabled:text-subtle aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-accent-2 disabled:bg-primary-disabled disabled:text-[#e6d9e8]",
        outline:
          "border-border bg-surface-2 hover:bg-surface-3 hover:text-foreground aria-expanded:bg-surface-3",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-surface-3 aria-expanded:bg-surface-3",
        ghost:
          "bg-surface hover:bg-surface-2 hover:text-foreground aria-expanded:bg-surface-2",
        up: "bg-up-soft text-up hover:bg-up-soft-hover",
        down: "bg-down-soft text-down hover:bg-down-soft-hover",
        destructive:
          "bg-down-soft text-destructive hover:bg-down-soft-hover focus-visible:border-destructive",
      },
      size: {
        default:
          "h-9 gap-1.5 px-4 has-data-[icon=inline-end]:pr-3 has-data-[icon=inline-start]:pl-3",
        xs: "h-6 gap-1 px-2.5 text-xs [&_svg:not([class*='size-'])]:size-3",
        sm: "h-8 gap-1 px-3 text-[0.8rem] [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-11 gap-2 px-6 text-base",
        xl: "h-14 gap-2 px-8 text-lg font-semibold",
        icon: "size-9",
        "icon-xs": "size-6 [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-8",
        "icon-lg": "size-11",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
