import React from 'react';
import { parseExperiments } from '../../api/observation-client';
import { route } from '../../app/routing';
import { useRoute, replaceRouteSelection } from '../../app/use-route';
import {
  Feedback,
  Pagination,
  Status,
  Timestamp,
} from '../../components/observation-feedback';
import { Card, CardContent } from '../../components/ui/card';
import { Input } from '../../components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../components/ui/table';
import { useObservation } from './use-observation';
export function Experiments(): React.JSX.Element {
  const location = useRoute();
  const offset = location.offset ?? 0,
    search = location.search ?? '';
  const setOffset = (value: number): void =>
    replaceRouteSelection({ offset: value });
  const result = useObservation(`?offset=${offset}`, parseExperiments);
  const visible = result.data?.items.filter((entry) =>
    `${entry.id} ${entry.recipeId ?? ''} ${entry.status}`
      .toLowerCase()
      .includes(search.trim().toLowerCase()),
  );
  return (
    <div className="page-stack">
      <header className="page-heading">
        <div>
          <span className="eyebrow">OBSERVATION WORKSPACE</span>
          <h1>Experiments</h1>
          <p>
            Follow execution, inspect calls, and review recorded measurements.
          </p>
        </div>
      </header>
      <div className="section-heading">
        <div className="search-field">
          <label htmlFor="search">Filter this page</label>
          <Input
            id="search"
            value={search}
            onChange={(event) =>
              replaceRouteSelection({ search: event.target.value })
            }
            placeholder="Experiment, recipe, or status"
          />
        </div>
        <span className="muted">{result.data?.total ?? '—'} experiments</span>
      </div>
      <Feedback {...result} />
      {result.data ? (
        <Card>
          <CardContent>
            {visible?.length ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Experiment</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Recipe</TableHead>
                    <TableHead>Started</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visible.map((entry) => (
                    <TableRow key={entry.id}>
                      <TableCell>
                        <a className="text-link" href={route(entry.id)}>
                          {entry.id}
                        </a>
                      </TableCell>
                      <TableCell>
                        <Status value={entry.status} />
                      </TableCell>
                      <TableCell>{entry.recipeId ?? 'Not recorded'}</TableCell>
                      <TableCell>
                        <Timestamp value={entry.startedAt} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <div className="empty-state">
                <h2>
                  {search
                    ? 'No matching experiments on this page'
                    : 'No experiments recorded'}
                </h2>
                <p>
                  {search
                    ? 'Change the filter or browse another page.'
                    : 'Experiments started through your existing workflow will appear here.'}
                </p>
              </div>
            )}
            <Pagination
              page={result.data}
              offset={offset}
              setOffset={setOffset}
            />
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
