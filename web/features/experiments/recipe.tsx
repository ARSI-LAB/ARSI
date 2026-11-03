import React from 'react';
import { parseDetails } from '../../api/observation-client';
import { Feedback } from '../../components/observation-feedback';
import { Card, CardContent, CardHeader } from '../../components/ui/card';
import { RecipeSnapshot } from './recipe-snapshot';
import { useObservation } from './use-observation';

export function Recipe({ id }: { id: string }): React.JSX.Element {
  const result = useObservation(
    `/${encodeURIComponent(id)}/details`,
    parseDetails,
  );
  return (
    <Card>
      <CardHeader>
        <h2>Recipe</h2>
      </CardHeader>
      <CardContent>
        <Feedback {...result} />
        {result.data ? (
          <RecipeSnapshot value={result.data.configuration} />
        ) : null}
      </CardContent>
    </Card>
  );
}
