"""Explicit real-Optuna checks; excluded from default TypeScript unit tests."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest

worker_path = Path(os.environ.get('RSI_OPTUNA_WORKER', Path(__file__).resolve().parents[2] / 'src/plugins/proposer-optuna/python/worker.py'))
spec = importlib.util.spec_from_file_location('optuna_worker', worker_path)
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class OptunaIntegration(unittest.TestCase):
  def test_replay_matches_uninterrupted_study(self):
    for sampler in [
      {'type': 'tpe', 'seed': 17, 'options': {'startupTrials': 2, 'eiCandidates': 24, 'multivariate': False}},
      {'type': 'random', 'seed': 17, 'options': {}},
    ]:
      with self.subTest(sampler=sampler['type']):
        space = [
          {'name': 'x', 'distribution': 'float', 'low': -2.0, 'high': 2.0},
          {'name': 'y', 'distribution': 'int', 'low': 1, 'high': 4},
          {'name': 'kind', 'distribution': 'categorical', 'values': ['a', 'b']},
        ]
        native = sampler['type'] == 'tpe'
        study = worker.optuna.create_study(direction='minimize', sampler=worker.sampler_for(sampler, native))
        history = []
        for i in range(12):
          request = {'action': 'suggest', 'sampler': sampler, 'searchSpace': space, 'constraintHandling': 'native' if native else 'selection-only', 'history': history}
          response = worker.respond(request)
          trial = study.ask()
          actual = worker.suggest(trial, space)
          self.assertEqual(response['parameters'], actual)
          # A repeated/failed attempt must still consume its RNG draws.
          if i == 3:
            history.append({'parameters': actual, 'status': 'duplicate', 'loss': None, 'constraints': []})
            study.tell(trial, state=worker.optuna.trial.TrialState.FAIL)
          else:
            constraints = [actual['y'] - 2]
            loss = (actual['x'] - 0.4) ** 2
            history.append({'parameters': actual, 'status': 'complete', 'loss': loss, 'constraints': constraints})
            trial.set_user_attr('constraints', constraints)
            study.tell(trial, loss)
            if native:
              self.assertEqual(study.trials[-1].system_attrs['constraints'], tuple(constraints))
        corrupted = json.loads(json.dumps(request))
        corrupted['history'][0]['parameters']['x'] = 999
        with self.assertRaisesRegex(ValueError, 'replay differs'):
          worker.respond(corrupted)

  def test_packaged_process_protocol(self):
    result = subprocess.run([sys.executable, str(worker_path)], input=json.dumps({'action': 'check'}), text=True, capture_output=True, check=True, timeout=30)
    environment = json.loads(result.stdout)['environment']
    self.assertEqual(environment['optuna'], '4.5.0')
    self.assertEqual(environment['numpy'], '2.2.6')


if __name__ == '__main__':
  unittest.main()
