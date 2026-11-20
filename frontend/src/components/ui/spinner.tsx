import { cn } from "@/lib/utils";
import { Loader2Icon } from "lucide-react";

function Spinner({
  className,
  ...props
}: React.ComponentProps<typeof Loader2Icon>) {
  return (
    <Loader2Icon
      aria-label="Loading"
      className={cn("animate-spin text-brand-accent motion-reduce:animate-none", className)}
      role="status"
      {...props}
    />
  );
}

export { Spinner };
