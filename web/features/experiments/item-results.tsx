import React from 'react';
import type { MetricRecord } from '../../api/observation-client';
import { Status } from '../../components/observation-feedback';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../components/ui/table';
import { MeasurementMetrics } from './measurement-metrics';

/** Item status and coverage come from the item, never its aggregate measurement. */
export function ItemResults({
  measurementRef,
  records,
}: {
  measurementRef: string;
  records: readonly MetricRecord[];
}): React.JSX.Element {
  const items = records.filter(
    (record) => record.ref === measurementRef && record.item !== null,
  );
  if (!items.length)
    return (
      <p className="empty-state">
        No item results recorded. Aggregate metrics are shown above.
      </p>
    );
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Item</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Coverage</TableHead>
          <TableHead>Result</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((record) => (
          <TableRow key={JSON.stringify([record.ref, record.item!.id])}>
            <TableCell>
              <span>{record.item!.subjectId}</span>
              <span className="muted"> · {record.item!.subjectKind}</span>
            </TableCell>
            <TableCell>
              <Status value={record.status} />
            </TableCell>
            <TableCell>{record.coverage}</TableCell>
            <TableCell>
              {record.status === 'succeeded' ? (
                <MeasurementMetrics metrics={record.metrics} />
              ) : (
                <span className="muted">No valid score recorded.</span>
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
