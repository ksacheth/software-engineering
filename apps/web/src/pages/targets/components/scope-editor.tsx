import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from '@/components/ui/card';
import { FieldGroup, Field, FieldLabel, FieldDescription } from '@/components/ui/field';
import { InputGroup, InputGroupInput } from '@/components/ui/input-group';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Spinner } from '@/components/ui/spinner';
import { Plus, X, ListFilter } from 'lucide-react';
import { updateTargetScope, type Target, TargetApiError } from '@/services/targets';
import { toast } from 'sonner';

interface ScopeEditorProps {
  target: Target;
}

export function ScopeEditor({ target }: ScopeEditorProps) {
  const queryClient = useQueryClient();

  const [includedPaths, setIncludedPaths] = useState<string[]>(target.includedPaths ?? []);
  const [excludedPaths, setExcludedPaths] = useState<string[]>(target.excludedPaths ?? []);
  const [newIncludedPath, setNewIncludedPath] = useState('');
  const [newExcludedPath, setNewExcludedPath] = useState('');
  const [validationError, setValidationError] = useState<string | null>(null);

  const scopeMutation = useMutation({
    mutationFn: (scope: { includedPaths: string[]; excludedPaths: string[] }) =>
      updateTargetScope(target.id, scope),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['target', target.id] });
      queryClient.invalidateQueries({ queryKey: ['targets'] });
      toast.success('Scope updated successfully');
      setValidationError(null);
    },
    onError: (err: unknown) => {
      if (err instanceof TargetApiError) {
        toast.error(err.message);
      } else {
        toast.error('Failed to update scope');
      }
    },
  });

  const handleAddIncludedPath = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = newIncludedPath.trim();
    if (!trimmed) return;
    if (!trimmed.startsWith('/')) {
      setValidationError('Path must start with / (e.g. /api or /blog)');
      return;
    }
    if (trimmed.length > 512) {
      setValidationError('Path exceeds maximum length of 512 characters');
      return;
    }
    if (!includedPaths.includes(trimmed)) {
      setIncludedPaths([...includedPaths, trimmed]);
    }
    setNewIncludedPath('');
    setValidationError(null);
  };

  const handleAddExcludedPath = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = newExcludedPath.trim();
    if (!trimmed) return;
    if (!trimmed.startsWith('/')) {
      setValidationError('Path must start with / (e.g. /admin or /logout)');
      return;
    }
    if (trimmed.length > 512) {
      setValidationError('Path exceeds maximum length of 512 characters');
      return;
    }
    if (!excludedPaths.includes(trimmed)) {
      setExcludedPaths([...excludedPaths, trimmed]);
    }
    setNewExcludedPath('');
    setValidationError(null);
  };

  const removeIncluded = (path: string) => {
    setIncludedPaths(includedPaths.filter((p) => p !== path));
  };

  const removeExcluded = (path: string) => {
    setExcludedPaths(excludedPaths.filter((p) => p !== path));
  };

  const handleSave = () => {
    scopeMutation.mutate({
      includedPaths,
      excludedPaths,
    });
  };

  const hasChanges =
    JSON.stringify(includedPaths) !== JSON.stringify(target.includedPaths ?? []) ||
    JSON.stringify(excludedPaths) !== JSON.stringify(target.excludedPaths ?? []);

  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ListFilter className="size-5 text-primary" />
          Scope Configuration
        </CardTitle>
        <CardDescription>
          Specify path prefixes to restrict or exclude from crawler and detector execution. Empty included paths defaults to scanning the entire origin.
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-6">
        {validationError && (
          <p className="text-sm text-destructive">{validationError}</p>
        )}

        {/* Included Paths */}
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="new-included">Included Path Prefixes</FieldLabel>
            <FieldDescription>
              Only URLs matching these prefixes will be crawled and scanned.
            </FieldDescription>
            <div className="flex gap-2">
              <InputGroup className="flex-1">
                <InputGroupInput
                  id="new-included"
                  placeholder="/app, /api, /v1"
                  value={newIncludedPath}
                  onChange={(e) => setNewIncludedPath(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      handleAddIncludedPath(e);
                    }
                  }}
                  disabled={target.isArchived}
                  className="font-mono text-xs"
                />
              </InputGroup>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleAddIncludedPath}
                disabled={target.isArchived || !newIncludedPath.trim()}
              >
                <Plus data-icon="inline-start" />
                Add
              </Button>
            </div>

            <div className="flex flex-wrap gap-2 pt-1">
              {includedPaths.length === 0 ? (
                <span className="text-xs text-muted-foreground italic">
                  No specific path restrictions (all origin paths are in scope).
                </span>
              ) : (
                includedPaths.map((path) => (
                  <Badge
                    key={path}
                    variant="secondary"
                    className="font-mono text-xs py-1 px-2 flex items-center gap-1.5"
                  >
                    <span>{path}</span>
                    {!target.isArchived && (
                      <button
                        type="button"
                        onClick={() => removeIncluded(path)}
                        className="text-muted-foreground hover:text-foreground cursor-pointer"
                        aria-label={`Remove ${path}`}
                      >
                        <X className="size-3" />
                      </button>
                    )}
                  </Badge>
                ))
              )}
            </div>
          </Field>

          {/* Excluded Paths */}
          <Field>
            <FieldLabel htmlFor="new-excluded">Excluded Path Prefixes</FieldLabel>
            <FieldDescription>
              Paths matching these prefixes will be blocked and never requested by crawler or active detectors.
            </FieldDescription>
            <div className="flex gap-2">
              <InputGroup className="flex-1">
                <InputGroupInput
                  id="new-excluded"
                  placeholder="/auth/logout, /admin, /sensitive"
                  value={newExcludedPath}
                  onChange={(e) => setNewExcludedPath(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      handleAddExcludedPath(e);
                    }
                  }}
                  disabled={target.isArchived}
                  className="font-mono text-xs"
                />
              </InputGroup>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleAddExcludedPath}
                disabled={target.isArchived || !newExcludedPath.trim()}
              >
                <Plus data-icon="inline-start" />
                Add
              </Button>
            </div>

            <div className="flex flex-wrap gap-2 pt-1">
              {excludedPaths.length === 0 ? (
                <span className="text-xs text-muted-foreground italic">
                  No paths excluded.
                </span>
              ) : (
                excludedPaths.map((path) => (
                  <Badge
                    key={path}
                    variant="outline"
                    className="font-mono text-xs py-1 px-2 flex items-center gap-1.5 text-destructive border-destructive/30"
                  >
                    <span>{path}</span>
                    {!target.isArchived && (
                      <button
                        type="button"
                        onClick={() => removeExcluded(path)}
                        className="text-muted-foreground hover:text-foreground cursor-pointer"
                        aria-label={`Remove ${path}`}
                      >
                        <X className="size-3" />
                      </button>
                    )}
                  </Badge>
                ))
              )}
            </div>
          </Field>
        </FieldGroup>
      </CardContent>

      <CardFooter className="flex items-center justify-between border-t bg-muted/30">
        <span className="text-xs text-muted-foreground">
          {hasChanges ? 'Unsaved changes' : 'Scope is up to date'}
        </span>
        <Button
          type="button"
          onClick={handleSave}
          disabled={!hasChanges || scopeMutation.isPending || target.isArchived}
        >
          {scopeMutation.isPending && <Spinner data-icon="inline-start" />}
          Save Scope
        </Button>
      </CardFooter>
    </Card>
  );
}
