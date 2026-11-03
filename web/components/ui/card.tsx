import { cn } from 'cn';
import * as React from 'react';

function Card({
  className,
  ...props
}: React.ComponentProps<'div'>): React.JSX.Element | null {
  return (
    <div data-slot="card" className={cn('ui-card', className)} {...props} />
  );
}

function CardHeader({
  className,
  ...props
}: React.ComponentProps<'div'>): React.JSX.Element | null {
  return (
    <div
      data-slot="card-header"
      className={cn('ui-card-header', className)}
      {...props}
    />
  );
}

function CardTitle({
  className,
  ...props
}: React.ComponentProps<'div'>): React.JSX.Element | null {
  return (
    <div
      data-slot="card-title"
      className={cn('leading-snug font-semibold', className)}
      {...props}
    />
  );
}

function CardDescription({
  className,
  ...props
}: React.ComponentProps<'div'>): React.JSX.Element | null {
  return (
    <div
      data-slot="card-description"
      className={cn('text-sm text-muted-foreground', className)}
      {...props}
    />
  );
}

function CardAction({
  className,
  ...props
}: React.ComponentProps<'div'>): React.JSX.Element | null {
  return (
    <div
      data-slot="card-action"
      className={cn(
        'col-start-2 row-span-2 row-start-1 self-start justify-self-end',
        className,
      )}
      {...props}
    />
  );
}

function CardContent({
  className,
  ...props
}: React.ComponentProps<'div'>): React.JSX.Element | null {
  return (
    <div
      data-slot="card-content"
      className={cn('ui-card-content', className)}
      {...props}
    />
  );
}

function CardFooter({
  className,
  ...props
}: React.ComponentProps<'div'>): React.JSX.Element | null {
  return (
    <div
      data-slot="card-footer"
      className={cn('ui-card-footer', className)}
      {...props}
    />
  );
}

export {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
};
