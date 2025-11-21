import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getConceptNetwork } from './get-concept-network.js';
import { LogseqClient } from '../client.js';
import * as httpImpl from './get-concept-network-http.js';
import * as datalogImpl from './get-concept-network-datalog.js';

// Mock the implementations
vi.mock('./get-concept-network-http.js', () => ({
  getConceptNetworkHTTP: vi.fn(),
  ConceptNetworkResult: {}
}));

vi.mock('./get-concept-network-datalog.js', () => ({
  getConceptNetworkDatalog: vi.fn()
}));

describe('getConceptNetwork router', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  it('should use HTTP implementation when Datalog is not enabled', async () => {
    const mockClient = {
      config: {
        apiUrl: 'http://localhost:12315',
        authToken: 'test'
      },
      callAPI: vi.fn()
    } as unknown as LogseqClient;

    const mockResult = {
      concept: 'Test',
      nodes: [],
      edges: []
    };

    (httpImpl.getConceptNetworkHTTP as any).mockResolvedValue(mockResult);

    const result = await getConceptNetwork(mockClient, 'Test', 2);

    expect(httpImpl.getConceptNetworkHTTP).toHaveBeenCalledWith(mockClient, 'Test', 2);
    expect(datalogImpl.getConceptNetworkDatalog).not.toHaveBeenCalled();
    expect(result).toBe(mockResult);
  });

  it('should use HTTP implementation when Datalog is explicitly disabled', async () => {
    const mockClient = {
      config: {
        apiUrl: 'http://localhost:12315',
        authToken: 'test',
        features: {
          useDatalog: false
        }
      },
      callAPI: vi.fn()
    } as unknown as LogseqClient;

    const mockResult = {
      concept: 'Test',
      nodes: [],
      edges: []
    };

    (httpImpl.getConceptNetworkHTTP as any).mockResolvedValue(mockResult);

    await getConceptNetwork(mockClient, 'Test', 2);

    expect(httpImpl.getConceptNetworkHTTP).toHaveBeenCalled();
    expect(datalogImpl.getConceptNetworkDatalog).not.toHaveBeenCalled();
  });

  it('should use Datalog implementation when globally enabled', async () => {
    const mockClient = {
      config: {
        apiUrl: 'http://localhost:12315',
        authToken: 'test',
        features: {
          useDatalog: true
        }
      },
      executeDatalogQuery: vi.fn()
    } as unknown as LogseqClient;

    const mockResult = {
      concept: 'Test',
      nodes: [],
      edges: []
    };

    (datalogImpl.getConceptNetworkDatalog as any).mockResolvedValue(mockResult);

    const result = await getConceptNetwork(mockClient, 'Test', 2);

    expect(datalogImpl.getConceptNetworkDatalog).toHaveBeenCalledWith(mockClient, 'Test', 2);
    expect(httpImpl.getConceptNetworkHTTP).not.toHaveBeenCalled();
    expect(result).toBe(mockResult);
  });

  it('should use Datalog implementation when enabled for conceptNetwork specifically', async () => {
    const mockClient = {
      config: {
        apiUrl: 'http://localhost:12315',
        authToken: 'test',
        features: {
          useDatalog: {
            conceptNetwork: true,
            buildContext: false
          }
        }
      },
      executeDatalogQuery: vi.fn()
    } as unknown as LogseqClient;

    const mockResult = {
      concept: 'Test',
      nodes: [],
      edges: []
    };

    (datalogImpl.getConceptNetworkDatalog as any).mockResolvedValue(mockResult);

    await getConceptNetwork(mockClient, 'Test', 2);

    expect(datalogImpl.getConceptNetworkDatalog).toHaveBeenCalled();
    expect(httpImpl.getConceptNetworkHTTP).not.toHaveBeenCalled();
  });

  it('should use HTTP implementation when conceptNetwork is disabled in per-tool config', async () => {
    const mockClient = {
      config: {
        apiUrl: 'http://localhost:12315',
        authToken: 'test',
        features: {
          useDatalog: {
            conceptNetwork: false,
            buildContext: true
          }
        }
      },
      callAPI: vi.fn()
    } as unknown as LogseqClient;

    const mockResult = {
      concept: 'Test',
      nodes: [],
      edges: []
    };

    (httpImpl.getConceptNetworkHTTP as any).mockResolvedValue(mockResult);

    await getConceptNetwork(mockClient, 'Test', 2);

    expect(httpImpl.getConceptNetworkHTTP).toHaveBeenCalled();
    expect(datalogImpl.getConceptNetworkDatalog).not.toHaveBeenCalled();
  });
});
