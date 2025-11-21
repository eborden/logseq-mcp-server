// Entity reference (can be numeric ID or full entity)
export interface IEntityID {
  id: number;
}

// Block entity structure
export interface BlockEntity {
  id: number;
  uuid: string;
  content: string;
  format?: 'markdown' | 'org';
  page: IEntityID;
  parent: IEntityID;
  left: IEntityID;
  level?: number;
  children?: BlockEntity[];
  properties?: Record<string, any>;
  unordered?: boolean;
  meta?: {
    startPos?: number;
    endPos?: number;
    properties?: any;
    timestamps?: any;
  };
}

// Page entity structure
export interface PageEntity {
  id: number;
  uuid: string;
  name: string;
  originalName: string;
  properties?: Record<string, any>;
  journal?: boolean;
  'journal?'?: boolean; // Logseq uses this property name
  journalDay?: number;
  namespace?: IEntityID;
  children?: (PageEntity | BlockEntity)[];
  updatedAt?: number;
}

// LogSeq API request/response types
export interface LogseqAPIRequest {
  method: string;
  args?: any[];
}

export interface LogseqAPIResponse<T = any> {
  data?: T;
  error?: {
    message: string;
    code?: string;
  };
}

// Configuration
export interface LogseqMCPConfig {
  apiUrl: string;
  authToken: string;
  features?: {
    useDatalog?: boolean | {
      conceptNetwork?: boolean;
      buildContext?: boolean;
      searchByRelationship?: boolean;
    };
  };
}
