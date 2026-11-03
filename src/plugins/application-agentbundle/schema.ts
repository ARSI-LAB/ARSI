import type { JsonSchema } from '../../contracts/index.js';
import {
  fileConfigProperties,
  type FileApplicationConfig,
} from '../shared/file-application/files.js';

export type AgentbundleConfig = FileApplicationConfig;

export const configSchema: JsonSchema = {
  type: 'object',
  properties: fileConfigProperties,
  required: ['target', 'baseline'],
  additionalProperties: false,
};
