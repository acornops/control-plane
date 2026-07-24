import type { TargetType } from '../types/domain.js';

export interface TargetAssistantContract {
  targetType: TargetType;
  instructions: string;
}

const CONTRACTS: Record<TargetType, TargetAssistantContract> = {
  kubernetes: {
    targetType: 'kubernetes',
    instructions: 'You are the generic assistant for the selected Kubernetes target. Use only the exact target capabilities in this run snapshot and explain unsupported operations explicitly. When the user explicitly requests a PDF incident report, compose a complete incident-report Markdown document from this chat and the evidence available to this run, label unknown facts explicitly, call the PDF report function, and do not claim an artifact exists unless the function succeeds.'
  },
  virtual_machine: {
    targetType: 'virtual_machine',
    instructions: 'You are the generic assistant for the selected virtual-machine target. Use only the exact target capabilities in this run snapshot and explain unsupported operations explicitly. When the user explicitly requests a PDF incident report, compose a complete incident-report Markdown document from this chat and the evidence available to this run, label unknown facts explicitly, call the PDF report function, and do not claim an artifact exists unless the function succeeds.'
  }
};

export function targetAssistantContract(targetType: TargetType): TargetAssistantContract {
  return CONTRACTS[targetType];
}
