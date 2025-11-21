import { LogseqClient } from '../client.js';
import {
  RelationshipType,
  SearchByRelationshipResult,
  searchByRelationshipHTTP
} from './search-by-relationship-http.js';

/**
 * Search for blocks based on relationship between topics
 * Routes to HTTP or Datalog implementation based on feature flag
 * @param client - LogseqClient instance
 * @param topicA - Primary topic to search for
 * @param topicB - Related topic that defines the relationship
 * @param relationshipType - Type of relationship to search
 * @param maxDistance - Maximum graph distance (for connected-within)
 * @returns SearchByRelationshipResult with matching blocks
 */
export async function searchByRelationship(
  client: LogseqClient,
  topicA: string,
  topicB: string,
  relationshipType: RelationshipType,
  maxDistance: number = 2
): Promise<SearchByRelationshipResult> {
  // For now, always use HTTP (Datalog implementation complex due to 4 relationship types)
  return searchByRelationshipHTTP(client, topicA, topicB, relationshipType, maxDistance);
}

// Re-export types
export type { RelationshipType, SearchByRelationshipResult };
