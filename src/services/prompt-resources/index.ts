import { PromptResourceRegistry } from './registry.js';
import { ChatPromptResourceProvider } from './providers/chat-provider.js';
import { RepositoryPromptResourceProvider } from './providers/repository-provider.js';
import { TargetPromptResourceProvider } from './providers/target-provider.js';
import { WorkflowSessionPromptResourceProvider } from './providers/workflow-session-provider.js';

export const promptResourceRegistry = new PromptResourceRegistry()
  .register(new TargetPromptResourceProvider())
  .register(new ChatPromptResourceProvider())
  .register(new RepositoryPromptResourceProvider())
  .register(new WorkflowSessionPromptResourceProvider());

export { formatPromptReference, parsePromptReferences } from './parser.js';
export { digestBindings, digestPrompt, PromptResourceRegistry } from './registry.js';
export { PromptResourceProviderError } from './errors.js';
