import type { GymActivation } from './schema.js';

const ENVIRONMENT_REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

export function expandGymEnvironment(
  value: string,
  field: string,
  environment: Readonly<Record<string, string | undefined>>,
): string {
  return value.replace(ENVIRONMENT_REFERENCE, (_match, name: string) => {
    const replacement = environment[name];
    if (replacement === undefined)
      throw new Error(
        `gym ${field} references missing environment variable ${name}`,
      );
    return replacement;
  });
}

export function resolveGymActivation(
  activation: GymActivation | undefined,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): GymActivation | undefined {
  if (activation?.kind === 'directory')
    return {
      ...activation,
      directory: expandGymEnvironment(
        activation.directory,
        'activation.directory',
        environment,
      ),
    };
  if (activation?.kind === 'dsh-user-layer')
    return {
      ...activation,
      dshHome: expandGymEnvironment(
        activation.dshHome,
        'activation.dshHome',
        environment,
      ),
      ...(activation.profileName === undefined
        ? {}
        : {
            profileName: expandGymEnvironment(
              activation.profileName,
              'activation.profileName',
              environment,
            ),
          }),
      ...(activation.basePatch === undefined
        ? {}
        : {
            basePatch: expandGymEnvironment(
              activation.basePatch,
              'activation.basePatch',
              environment,
            ),
          }),
    };
  if (activation?.kind === 'remote-http')
    return {
      ...activation,
      activateUrl: expandGymEnvironment(
        activation.activateUrl,
        'activation.activateUrl',
        environment,
      ),
    };
  return activation;
}
