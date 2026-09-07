import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Check, Copy } from 'lucide-react';
import { toast } from 'sonner';

interface CopyButtonProps {
  value: string;
  label?: string;
  variant?: 'ghost' | 'outline' | 'secondary' | 'default';
  size?: 'xs' | 'sm' | 'default' | 'icon';
  className?: string;
}

export function CopyButton({
  value,
  label = 'Copy to clipboard',
  variant = 'ghost',
  size = 'sm',
  className,
}: CopyButtonProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      toast.success('Copied to clipboard');
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error('Failed to copy');
    }
  };

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant={variant}
          size={size}
          onClick={handleCopy}
          aria-label={label}
          className={className}
        >
          {copied ? (
            <Check data-icon="inline-start" className="text-emerald-500" />
          ) : (
            <Copy data-icon="inline-start" />
          )}
          <span className="sr-only">{label}</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        <p>{copied ? 'Copied!' : label}</p>
      </TooltipContent>
    </Tooltip>
  );
}
