import type { JsonSchema } from '../../contracts/index.js';
import {
  fileConfigProperties,
  type FileApplicationConfig,
} from '../shared/file-application/files.js';

export type KernelApplicationConfig = FileApplicationConfig & {
  entryFile: string;
};

export const configSchema: JsonSchema = {
  type: 'object',
  properties: {
    ...fileConfigProperties,
    entryFile: { type: 'string', minLength: 1 },
  },
  required: ['target', 'baseline', 'entryFile'],
  additionalProperties: false,
};
