import {
  Evaluator,
  type DoctorOptions,
  type DoctorReport,
} from 'arsi-evaluator';

export type SdkDoctorOptions = Required<
  Pick<DoctorOptions, 'configPath' | 'networkConfigPath' | 'env' | 'signal'>
>;

export type SdkDoctorRunner = (options: SdkDoctorOptions) => Promise<unknown>;

export function sdkDoctor(options: DoctorOptions): Promise<DoctorReport> {
  return new Evaluator().doctor(options);
}
