import { LogseqClient } from '../client.js';
import { TopicContext, ContextOptions, buildContextForTopicHTTP } from './build-context-http.js';
import { buildContextForTopicDatalog } from './build-context-datalog.js';

/**
 * Build comprehensive context for a topic
 * Routes to HTTP or Datalog implementation based on feature flag
 * @param client - LogseqClient instance
 * @param topicName - Name of the topic
 * @param options - Options for context building
 * @returns TopicContext with all relevant information
 */
export async function buildContextForTopic(
  client: LogseqClient,
  topicName: string,
  options: ContextOptions = {}
): Promise<TopicContext> {
  const useDatalog = client.config.features?.useDatalog;

  // Check if Datalog is enabled (either globally or for this specific tool)
  const toolEnabled = typeof useDatalog === 'object'
    ? useDatalog.buildContext
    : useDatalog;

  if (toolEnabled) {
    return buildContextForTopicDatalog(client, topicName, options);
  }

  return buildContextForTopicHTTP(client, topicName, options);
}

// Re-export types
export type { TopicContext, ContextOptions };
