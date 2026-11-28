import { ViewBoundary } from '../components/view-boundary';
import React from 'react';
import { Experiment } from '../features/experiments/experiment-detail';
import { Experiments } from '../features/experiments/experiment-list';
import { useRoute } from './use-route';
import { WorkspaceLayout } from './workspace-layout';
export function App(): React.JSX.Element {
  const navigation = useRoute();
  const { id, view, candidate, artifact, call, measurement, file, directory } =
    navigation;
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
