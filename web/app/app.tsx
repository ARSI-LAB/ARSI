import { ViewBoundary } from '../components/view-boundary';
import React, { useEffect } from 'react';
import { route } from './routing';
import { rememberView } from './view-memory';
import { Experiment } from '../features/experiments/experiment-detail';
import { Experiments } from '../features/experiments/experiment-list';
import { useRoute } from './use-route';
import { WorkspaceLayout } from './workspace-layout';
export function App(): React.JSX.Element {
  const navigation = useRoute();
  const { id, view, candidate, artifact, call, measurement, file, directory } =
    navigation;
  const hash = route(id, view, candidate, artifact, navigation);
  useEffect(() => rememberView(hash), [hash]);
  return (
    <WorkspaceLayout routeKey={`${id ?? ''}:${view}`} isList={!id}>
      <ViewBoundary resetKey={`${id ?? ''}:${view}`}>
        {id ? (
          <Experiment
            key={id}
            id={id}
            view={view}
            candidate={candidate}
            artifact={artifact}
            call={call}
            measurement={measurement}
            file={file}
            directory={directory}
          />
        ) : (
          <Experiments />
        )}
      </ViewBoundary>
    </WorkspaceLayout>
  );
}
