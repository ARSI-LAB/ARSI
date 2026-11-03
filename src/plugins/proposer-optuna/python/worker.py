"""One-shot Optuna adapter. RSI owns measurements, state artifacts and resources."""
import json
import platform
import sys

import numpy
import optuna

optuna.logging.set_verbosity(optuna.logging.ERROR)
if not (3, 10) <= sys.version_info[:2] <= (3, 13):
  raise RuntimeError('Optuna adapter requires Python 3.10 through 3.13')
if numpy.__version__ != '2.2.6':
  raise RuntimeError('Expected numpy==2.2.6; install the packaged requirements.txt')
if optuna.__version__ != '4.5.0':
  raise RuntimeError('Expected optuna==4.5.0; install the packaged requirements.txt')


def sampler_for(config, native):
  if config['type'] == 'random':
    return optuna.samplers.RandomSampler(seed=config['seed'])
  if config['type'] != 'tpe':
    raise ValueError('Unsupported sampler')
  options = config['options']
  return optuna.samplers.TPESampler(
    seed=config['seed'],
    n_startup_trials=options['startupTrials'],
    n_ei_candidates=options['eiCandidates'],
    multivariate=options['multivariate'],
    group=False,
    constant_liar=False,
    constraints_func=(lambda trial: trial.user_attrs['constraints']) if native else None,
  )


def suggest(trial, space):
  parameters = {}
  for axis in space:
    name = axis['name']
    kind = axis['distribution']
    if kind == 'categorical':
      parameters[name] = trial.suggest_categorical(name, axis['values'])
    elif kind == 'int':
      parameters[name] = trial.suggest_int(name, axis['low'], axis['high'], step=axis.get('step', 1), log=axis.get('log', False))
    elif kind == 'float':
      parameters[name] = trial.suggest_float(name, axis['low'], axis['high'], step=axis.get('step'), log=axis.get('log', False))
    else:
      raise ValueError('Unsupported distribution')
  return parameters


def respond(request):
  environment = {'python': platform.python_version(), 'optuna': optuna.__version__, 'numpy': numpy.__version__}
  if request['action'] == 'check':
    return {'environment': environment}
  study = optuna.create_study(direction='minimize', sampler=sampler_for(request['sampler'], request['constraintHandling'] == 'native'))
  for entry in request['history']:
    trial = study.ask()
    actual = suggest(trial, request['searchSpace'])
    if actual != entry['parameters']:
      raise ValueError('Optuna history replay differs from stored parameters')
    if entry['status'] == 'complete':
      trial.set_user_attr('constraints', entry['constraints'])
      study.tell(trial, entry['loss'])
    elif entry['status'] == 'duplicate':
      study.tell(trial, state=optuna.trial.TrialState.FAIL)
    else:
      raise ValueError('Cannot sample with a pending trial')
  trial = study.ask()
  return {'environment': environment, 'parameters': suggest(trial, request['searchSpace'])}


if __name__ == '__main__':
  json.dump(respond(json.load(sys.stdin)), sys.stdout, allow_nan=False, separators=(',', ':'))
  sys.stdout.write('\n')
