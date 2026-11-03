import { cn } from 'cn';
import * as React from 'react';

function Table({
  className,
  ...props
}: React.ComponentProps<'table'>): React.JSX.Element {
  const container = React.useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = React.useState(false);
  React.useLayoutEffect(() => {
    const element = container.current;
    if (!element) return;
    const measure = (): void =>
      setOverflow(element.scrollWidth > element.clientWidth + 1);
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    const table = element.querySelector('table');
    if (table) observer.observe(table);
    measure();
    return () => observer.disconnect();
  }, []);
  return (
    <div
      ref={container}
      data-slot="table-container"
      data-overflow={overflow || undefined}
      tabIndex={overflow ? 0 : undefined}
      role={overflow ? 'region' : undefined}
      aria-label={
        overflow
          ? 'Data table, scroll horizontally to view all columns'
          : undefined
      }
      className="relative w-full overflow-x-auto"
    >
      <table
        data-slot="table"
        className={cn('w-full caption-bottom text-sm', className)}
        {...props}
      />
    </div>
  );
}

function TableHeader({
  className,
  ...props
}: React.ComponentProps<'thead'>): React.JSX.Element {
  return (
    <thead
      data-slot="table-header"
      className={cn('[&_tr]:border-b', className)}
      {...props}
    />
  );
}

function TableBody({
  className,
  ...props
}: React.ComponentProps<'tbody'>): React.JSX.Element {
  return (
    <tbody
      data-slot="table-body"
      className={cn('[&_tr:last-child]:border-0', className)}
      {...props}
    />
  );
}

function TableFooter({
  className,
  ...props
}: React.ComponentProps<'tfoot'>): React.JSX.Element {
  return (
    <tfoot
      data-slot="table-footer"
      className={cn(
        'border-t bg-muted/50 font-medium [&>tr]:last:border-b-0',
        className,
      )}
      {...props}
    />
  );
}

function TableRow({
  className,
  ...props
}: React.ComponentProps<'tr'>): React.JSX.Element {
  return (
    <tr
      data-slot="table-row"
      className={cn(
        'border-b transition-colors hover:bg-muted/50 has-aria-expanded:bg-muted/50 data-[state=selected]:bg-muted',
        className,
      )}
      {...props}
    />
  );
}

function TableHead({
  className,
  ...props
}: React.ComponentProps<'th'>): React.JSX.Element {
  return (
    <th
      data-slot="table-head"
      className={cn('ui-table-head', className)}
      {...props}
    />
  );
}

function TableCell({
  className,
  ...props
}: React.ComponentProps<'td'>): React.JSX.Element {
  return (
    <td
      data-slot="table-cell"
      className={cn('ui-table-cell', className)}
      {...props}
    />
  );
}

function TableCaption({
  className,
  ...props
}: React.ComponentProps<'caption'>): React.JSX.Element {
  return (
    <caption
      data-slot="table-caption"
      className={cn('mt-4 text-sm text-muted-foreground', className)}
      {...props}
    />
  );
}

export {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
};
